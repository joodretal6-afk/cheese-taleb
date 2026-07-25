/**
 * End-to-end test of the photo → PBR material pipeline, in the real browser.
 *
 * Synthesises a "photo of a brick wall under hard sun", runs it through the
 * whole pipeline, and measures whether de-lighting actually removed the baked
 * sun gradient — the one claim that is easy to assert and easy to get wrong.
 */
import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/?quality=low'
const outDir = process.argv[3] ?? '/tmp'

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } })
const errs = []
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()) })

await page.goto(url, { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
while (Date.now() - t0 < 240000) {
  if (await page.evaluate(() => window.__simStore?.getState().engineReady).catch(() => false)) break
  await page.waitForTimeout(1000)
}

const report = await page.evaluate(async () => {
  const { createImage, setPixel } = await import('/src/engine/photo/types.ts')
  const { processPhoto, defaultsForKind } = await import('/src/engine/photo/pipeline.ts')
  const { autoDetectQuad } = await import('/src/engine/photo/rectify.ts')
  const { segment } = await import('/src/engine/photo/segment.ts')

  const W = 640
  const H = 480
  const img = createImage(W, H)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const row = Math.floor(y / 34)
      const off = (row % 2) * 40
      const mortar = ((x + off) % 80) < 4 || y % 34 < 4
      let r = mortar ? 168 : 148
      let g = mortar ? 160 : 74
      let b = mortar ? 150 : 56
      // Baked sun: bright top-left falling off to dark bottom-right.
      const light = 1.55 - (x / W) * 0.55 - (y / H) * 0.62
      setPixel(img, x, y, r * light, g * light, b * light, 255)
    }
  }

  const stages = []
  const quad = autoDetectQuad(img)
  const result = await processPhoto(
    img,
    { id: 'wall', label: 'جدار', quad, kind: 'wall' },
    { ...defaultsForKind('wall'), size: 512, realWorldWidthM: 2.5 },
    (u) => stages.push(`${u.stage} ${Math.round(u.fraction * 100)}%`),
  )

  const meanOf = (im, x0, x1, y0, y1) => {
    let s = 0
    let n = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * im.width + x) * 4
        s += 0.2126 * im.data[i] + 0.7152 * im.data[i + 1] + 0.0722 * im.data[i + 2]
        n++
      }
    }
    return s / n
  }
  const q = 120
  const beforeRatio = meanOf(img, 0, q, 0, q) / meanOf(img, W - q, W, H - q, H)
  const a = result.maps.albedo
  const s2 = Math.floor(a.width / 5)
  const afterRatio =
    meanOf(a, 0, s2, 0, s2) / meanOf(a, a.width - s2, a.width, a.height - s2, a.height)

  const regions = segment(img, { maxRegions: 6, minAreaFraction: 0.01 })
  const R = (v) => Math.round(v * 100) / 100

  return {
    stages,
    mapSizes: Object.fromEntries(
      Object.entries(result.maps).map(([k, v]) => [k, `${v.width}x${v.height}`]),
    ),
    previews: Object.entries(result.previews)
      .map(([k, v]) => `${k}:${typeof v === 'string' && v.startsWith('data:image') ? 'ok' : 'BAD'}`)
      .join(' '),
    tilingScore: R(result.tilingScore),
    tileMetres: result.tileMetres,
    warnings: result.warnings,
    sunGradientBefore: R(beforeRatio),
    sunGradientAfter: R(afterRatio),
    regionsFound: regions.length,
    regionKinds: [...new Set(regions.map((r) => r.kind))],
    albedoPreview: result.previews.albedo,
    normalPreview: result.previews.normal,
  }
})

const { albedoPreview, normalPreview, ...printable } = report
console.log(JSON.stringify(printable, null, 1))

const applied = await page.evaluate(
  (u) => window.sim.applyGroundTexture(u, 2.5, 'dirt'),
  albedoPreview,
)
console.log('applyGroundTexture ->', applied)

await page.evaluate(() => {
  window.__simStore.getState().set('running', true)
  window.sim.camDist = 12
  window.sim.camPitch = 0.5
})
await page.waitForTimeout(6000)
const box = await page.locator('canvas').boundingBox()
await page.screenshot({ path: `${outDir}/photoground.png`, clip: box, timeout: 180000 })

for (const [name, data] of [['albedo', albedoPreview], ['normal', normalPreview]]) {
  if (data) await writeFile(`${outDir}/map-${name}.png`, Buffer.from(data.split(',')[1], 'base64'))
}
console.log('errors:', errs.length ? errs.slice(0, 5) : 'none')
await browser.close()

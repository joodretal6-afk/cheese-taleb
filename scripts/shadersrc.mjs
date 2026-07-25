/** Dumps the compiled terrain shader and reports which custom blocks made it in. */
import { chromium } from 'playwright'
import { writeFile } from 'node:fs/promises'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/?quality=low'
const out = process.argv[3] ?? '/tmp/terrain.frag.glsl'

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 400, height: 300 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(url, { waitUntil: 'domcontentloaded' })

const started = Date.now()
while (Date.now() - started < 240000) {
  if (await page.evaluate(() => !!window.sim?.terrain).catch(() => false)) break
  await page.waitForTimeout(1000)
}
await page.waitForTimeout(4000)

const res = await page.evaluate(() => {
  const mat = window.sim.terrain.material
  const fx = mat.getEffect()
  const src = fx?._fragmentSourceCode ?? fx?._fragmentSourceCodeOverride ?? ''
  const vsrc = fx?._vertexSourceCode ?? ''
  const markers = {
    'blendGround defined': src.includes('vec3 blendGround('),
    'albedo hook (dbg switch)': src.includes('dbg == 1'),
    'albedo hook assigns surfaceAlbedo': src.includes('surfaceAlbedo = ground'),
    'metallicRoughness hook': src.includes('metallicRoughness.g = clamp(rough2'),
    'before-lights hook': src.includes('normalW = normalize(n +'),
    'CUSTOM_FRAGMENT_UPDATE_ALBEDO still a bare define':
      /#define\s+CUSTOM_FRAGMENT_UPDATE_ALBEDO\s*$/m.test(src),
    'pbrBlockAlbedoOpacity include unexpanded': src.includes('#include<pbrBlockAlbedoOpacity>'),
    'vertex displacement hook': vsrc.includes('positionUpdated.y += -mSample.r'),
  }
  return { markers, src, vlen: vsrc.length, len: src.length, shaderName: mat._createdShaderName }
})

await browser.close()
await writeFile(out, res.src)
console.log('shader:', res.shaderName, 'fragment chars:', res.len, 'vertex chars:', res.vlen)
for (const [k, v] of Object.entries(res.markers)) console.log(v ? ' ✓' : ' ✗', k)
console.log('written to', out)

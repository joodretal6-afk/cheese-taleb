/**
 * Headless verification for the real-world region.
 *
 * Boots the app, waits for the sim, then reports what actually got built —
 * elevation range, road and building counts, mesh and draw-call cost — and
 * writes two screenshots: one from the driver's seat and one from a few hundred
 * metres up, which is the only view where you can tell whether the street
 * network really is the street network of the place.
 *
 *   node scripts/region.mjs --out scratch/region --alt 700
 *
 * The aerial shot uses its own camera. The chase camera is driven every frame
 * by Sim.tick(), so moving it from outside would be undone before the next
 * present; swapping scene.activeCamera is the only stable way in. That camera
 * has no post-processing attached, so the aerial frame is deliberately flatter
 * than the game looks.
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, []),
)

const url = args.url ?? 'http://127.0.0.1:5173'
const outDir = args.out ?? 'scratch/region'
const altitude = Number(args.alt ?? 700)
const bootTimeout = Number(args.timeout ?? 300000)

await mkdir(outDir, { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--ignore-gpu-blocklist',
    // A 2 km region at 2048² mud resolution needs more heap than the default.
    '--js-flags=--max-old-space-size=4096',
  ],
})

const page = await browser.newPage({
  viewport: { width: Number(args.width ?? 1536), height: Number(args.height ?? 1024) },
  deviceScaleFactor: 1,
})

const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`))
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} — ${r.failure()?.errorText}`))
page.on('response', (r) => {
  if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`)
})

let status = 'ok'
let report = null

try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })

  const started = Date.now()
  let last = -1
  while (Date.now() - started < bootTimeout) {
    const state = await page
      .evaluate(() => {
        const el = document.querySelector('[data-boot-progress]')
        return {
          ready: !!window.sim?.scene && !!window.sim?.vehicle,
          progress: el ? Number(el.getAttribute('data-boot-progress')) : null,
          fatal: document.body.innerText.includes('Engine failed to start'),
        }
      })
      .catch(() => ({ ready: false, progress: null, fatal: false }))
    if (state.fatal) {
      status = 'boot-error'
      break
    }
    if (state.ready) break
    if (state.progress !== null && state.progress !== last) {
      last = state.progress
      process.stderr.write(`  boot ${Math.round(state.progress * 100)}%\n`)
    }
    await page.waitForTimeout(1000)
  }

  if (status === 'ok') {
    await page.waitForTimeout(6000)
    await page.screenshot({ path: `${outDir}/ground.png`, timeout: 240000, animations: 'disabled' })

    report = await page.evaluate(() => {
      const sim = window.sim
      const r = sim.region ?? null
      const p = sim.vehicle.position
      const round = (v) => Math.round(v * 100) / 100
      return {
        worldSize: sim.field.worldSize,
        mudRes: sim.field.res,
        texelM: round(sim.field.texel),
        realWorld: !!sim.field.isRealWorld,
        region: r
          ? {
              name: r.data?.name ?? null,
              attribution: r.data?.attribution ?? null,
              roads: r.data?.roads?.length ?? null,
              osmBuildings: r.data?.buildings?.length ?? null,
              placedBuildings: r.buildingCount ?? null,
              baseElevationM: r.height?.baseElevationM ?? null,
              range: r.height?.range ? r.height.range() : null,
            }
          : null,
        vehicle: {
          pos: [round(p.x), round(p.y), round(p.z)],
          groundY: round(sim.field.surfaceHeight(p.x, p.z)),
          clearance: round(p.y - sim.field.surfaceHeight(p.x, p.z)),
        },
        scene: {
          meshes: sim.scene.meshes.length,
          activeMeshes: sim.scene.getActiveMeshes().length,
          totalVertices: sim.scene.getTotalVertices(),
          drawCalls: sim.engine._drawCalls?.current ?? null,
        },
      }
    })

    // --- aerial ----------------------------------------------------------
    await page.evaluate((alt) => {
      const sim = window.sim
      const BJS = sim.scene.getEngine().constructor
      void BJS
      const cam = new sim.camera.constructor(
        'aerial',
        new sim.camera.position.constructor(0, alt, -alt * 0.55),
        sim.scene,
      )
      cam.minZ = 1
      cam.maxZ = 6000
      cam.fov = 1.05
      cam.setTarget(new sim.camera.position.constructor(0, 0, 0))
      sim.scene.activeCamera = cam
    }, altitude)
    await page.waitForTimeout(6000)
    await page.screenshot({ path: `${outDir}/aerial.png`, timeout: 240000, animations: 'disabled' })
  }
} catch (err) {
  status = 'error'
  logs.push(`[fatal] ${err.message}\n${err.stack ?? ''}`)
}

await browser.close()

console.log('--- console ---')
for (const l of logs.slice(-60)) console.log(l)
console.log('--- report ---')
console.log(JSON.stringify(report, null, 2))
console.log('--- status ---')
console.log(status)
console.log(`screenshots: ${outDir}/ground.png ${outDir}/aerial.png`)

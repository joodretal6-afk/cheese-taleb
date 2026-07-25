/**
 * Headless smoke test + screenshot.
 *
 * Boots the app in Chromium, waits for the sim to report ready, optionally
 * drives the truck for a few seconds, then writes a PNG and dumps every console
 * message and page error. Chromium here has no GPU, so WebGL runs on
 * SwiftShader — frame rate is meaningless, but everything else is real.
 *
 *   node scripts/shot.mjs --out shot.png --drive 6 --url http://127.0.0.1:5173
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, []),
)

const url = args.url ?? 'http://127.0.0.1:5173'
const out = args.out ?? 'scratch/shot.png'
const driveSeconds = Number(args.drive ?? 0)
const width = Number(args.width ?? 1536)
const height = Number(args.height ?? 1024)
const bootTimeout = Number(args.timeout ?? 180000)

await mkdir(dirname(out), { recursive: true })

const browser = await chromium.launch({
  // Use the Chromium already present in the image rather than the build this
  // playwright release expects; the versions don't have to match for our use.
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--ignore-gpu-blocklist',
  ],
})

const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })

const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`))
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} — ${r.failure()?.errorText}`))
page.on('response', (r) => {
  if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`)
})

let status = 'ok'
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })

  // Report boot progress while we wait — SwiftShader compiles shaders slowly.
  const started = Date.now()
  let lastProgress = -1
  while (Date.now() - started < bootTimeout) {
    const state = await page.evaluate(() => {
      const el = document.querySelector('[data-boot-progress]')
      return {
        ready: !!window.sim?.scene && window.sim?.engine?.getFps?.() !== undefined && !!window.sim?.vehicle,
        progress: el ? Number(el.getAttribute('data-boot-progress')) : null,
        fatal: document.body.innerText.includes('Engine failed to start'),
      }
    }).catch(() => ({ ready: false, progress: null, fatal: false }))

    if (state.fatal) { status = 'boot-error'; break }
    if (state.ready) break
    if (state.progress !== null && state.progress !== lastProgress) {
      lastProgress = state.progress
      process.stderr.write(`  boot ${Math.round(state.progress * 100)}%\n`)
    }
    await page.waitForTimeout(1000)
  }

  if (status === 'ok') {
    // Let the first frames render and shaders finish compiling.
    await page.waitForTimeout(4000)

    // Software GL renders ~1 fps, so wall-clock driving barely advances the sim.
    // Run the physics headless instead to get real distance covered.
    const physDrive = Number(args.physdrive ?? 0)
    if (physDrive > 0) {
      await page.evaluate((secs) => {
        const sim = window.sim
        window.__simStore.getState().set('running', true)
        sim.input.throttle = 1
        sim.input.steer = 0
        // Split the run so the truck follows the meandering track rather than
        // driving straight off the valley floor.
        sim.warmup(secs * 0.45)
        sim.input.steer = 0.35
        sim.warmup(secs * 0.2)
        sim.input.steer = -0.2
        sim.warmup(secs * 0.35)
        sim.input.throttle = 0
        sim.input.steer = 0
      }, physDrive)
      await page.waitForTimeout(3000)
    }

    if (driveSeconds > 0) {
      await page.evaluate(() => {
        // Start the sim without needing the UI button.
        const s = window.__simStore
        if (s) s.getState().set('running', true)
      })
      await page.mouse.click(width * 0.4, height * 0.35)
      await page.keyboard.down('KeyW')
      await page.waitForTimeout(driveSeconds * 1000 * 0.6)
      await page.keyboard.down('KeyD')
      await page.waitForTimeout(driveSeconds * 1000 * 0.4)
      await page.keyboard.up('KeyD')
      await page.keyboard.up('KeyW')
      await page.waitForTimeout(1200)
    }
  }

  // SwiftShader renders a frame in ~1 s, so the default 30 s cap is too tight.
  await page.screenshot({ path: out, fullPage: false, timeout: 180000, animations: 'disabled' })
} catch (err) {
  status = 'error'
  logs.push(`[fatal] ${err.message}`)
}

const telemetry = await page
  .evaluate(() => {
    const sim = window.sim
    if (!sim?.vehicle) return null
    const t = sim.vehicle.getTelemetry()
    const p = sim.vehicle.position
    const ground = sim.field.surfaceHeight(p.x, p.z)
    return {
      fps: Math.round(sim.engine.getFps()),
      pos: [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100],
      groundY: Math.round(ground * 100) / 100,
      clearance: Math.round((p.y - ground) * 100) / 100,
      speedKmh: Math.round(t.speedKmh),
      rpm: Math.round(t.rpm),
      gear: t.gearLabel,
      sink: t.wheelSink.map((v) => Math.round(v * 100) / 100),
      bodyMud: Math.round(t.bodyMud * 100) / 100,
      meshes: sim.scene.meshes.length,
      activeMeshes: sim.scene.getActiveMeshes().length,
      drawCalls: sim.engine._drawCalls?.current ?? null,
    }
  })
  .catch(() => null)

await browser.close()

console.log('--- console ---')
for (const l of logs.slice(-80)) console.log(l)
console.log('--- telemetry ---')
console.log(JSON.stringify(telemetry, null, 2))
console.log('--- status ---')
console.log(status)
console.log('screenshot:', out)

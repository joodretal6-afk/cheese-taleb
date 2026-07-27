/**
 * Screenshot the Khalidiya scene with the real PBR materials + HDRI sky.
 *
 *   node scripts/shot-khalidiya.mjs --out scratch/khal.png --url http://127.0.0.1:5173
 *
 * Boots the app, triggers window.__khalidiya(true), waits for the HDR sky and
 * textures to stream in, frames the camera down the street, and writes a PNG.
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
const out = args.out ?? 'scratch/khal.png'
const width = Number(args.width ?? 1600)
const height = Number(args.height ?? 900)
const bootTimeout = Number(args.timeout ?? 180000)
// Camera framing, overridable from the CLI while iterating.
const eye = (args.eye ?? '4.5,3.2,-156').split(',').map(Number)
const look = (args.look ?? '4.5,1.5,-90').split(',').map(Number)

await mkdir(dirname(out), { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
page.on('requestfailed', (r) => logs.push(`[requestfailed] ${r.url()} — ${r.failure()?.errorText}`))
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`) })

let status = 'ok'
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  const started = Date.now()
  while (Date.now() - started < bootTimeout) {
    const ready = await page.evaluate(() => !!window.sim?.scene && !!window.sim?.vehicle).catch(() => false)
    if (ready) break
    await page.waitForTimeout(1000)
  }
  await page.waitForTimeout(3000)

  // Build the Khalidiya scene.
  await page.evaluate(() => window.__khalidiya?.(true))
  // Let the 8 MB HDR sky + PBR textures stream in and shaders compile.
  await page.waitForTimeout(14000)

  // Frame the shot by reusing the sim's chase camera (so the ACES tone-mapping
  // pipeline attached to it stays active) but neutralising the per-frame chase
  // update so our position sticks.
  await page.evaluate(({ eye, look }) => {
    const sim = window.sim
    const store = window.__simStore
    if (store) store.getState().set('running', false)
    sim.updateCamera = () => {} // stop tick() from re-driving the chase rig
    const V = sim.camera.position.constructor
    sim.camera.position.set(eye[0], eye[1], eye[2])
    sim.camera.setTarget(new V(look[0], look[1], look[2]))
    sim.scene.render()
  }, { eye, look }).catch((e) => logs.push('[frame] ' + e.message))

  await page.waitForTimeout(2500)
  await page.screenshot({ path: out, fullPage: false, timeout: 180000, animations: 'disabled' })
} catch (err) {
  status = 'error'
  logs.push(`[fatal] ${err.message}`)
}

const info = await page.evaluate(() => {
  const sim = window.sim
  if (!sim?.scene) return null
  return {
    meshes: sim.scene.meshes.length,
    activeMeshes: sim.scene.getActiveMeshes?.().length ?? null,
    hasKhal: !!sim.khalidiyaRoad?.built,
    camPos: sim.scene.activeCamera ? [sim.scene.activeCamera.position.x, sim.scene.activeCamera.position.y, sim.scene.activeCamera.position.z].map((v) => Math.round(v * 10) / 10) : null,
  }
}).catch(() => null)

await browser.close()
console.log('--- console (tail) ---')
for (const l of logs.slice(-40)) console.log(l)
console.log('--- info ---', JSON.stringify(info))
console.log('--- status ---', status, '->', out)

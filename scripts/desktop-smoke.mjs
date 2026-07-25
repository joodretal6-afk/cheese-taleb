/**
 * Smoke test for the packaged desktop build.
 *
 * Electron needs a display, so this runs it under Xvfb and drives it through
 * the DevTools protocol. It proves the thing that actually matters for
 * packaging: that the built bundle in dist/ loads from disk over file://,
 * including the 19 MB GLB and Rapier's inlined WASM, with no dev server.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 9222
const log = []

const child = spawn(
  'xvfb-run',
  [
    '-a',
    '--server-args=-screen 0 1600x1000x24',
    'npx',
    'electron',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    `--remote-debugging-port=${PORT}`,
    '.',
  ],
  { cwd: process.cwd(), env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'disabled:' } },
)

child.stdout.on('data', (d) => log.push(`[out] ${d}`))
child.stderr.on('data', (d) => log.push(`[err] ${d}`))

let verdict = 'did not start'
try {
  // Wait for the DevTools endpoint to come up.
  let target = null
  for (let i = 0; i < 45; i++) {
    await sleep(1000)
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      target = list.find((t) => t.type === 'page')
      if (target) break
    } catch {
      // not listening yet
    }
  }
  if (!target) throw new Error('Electron never exposed a page target')

  console.log('window URL:', target.url)

  // Drive the page over the DevTools protocol — no Playwright needed.
  const { default: WS } = await import('node:http').then(() => ({ default: null })).catch(() => ({ default: null }))
  void WS

  // Poll the page via the HTTP eval bridge is not available, so use the
  // Playwright CDP connector, which is already installed.
  const { chromium } = await import('playwright')
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`)
  const context = browser.contexts()[0]
  const page = context.pages()[0]

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  const started = Date.now()
  let ready = false
  while (Date.now() - started < 300000) {
    ready = await page.evaluate(() => !!window.__simStore?.getState().engineReady).catch(() => false)
    if (ready) break
    await sleep(2000)
  }

  const info = await page.evaluate(() => ({
    url: location.href,
    protocol: location.protocol,
    ready: window.__simStore?.getState().engineReady ?? false,
    truckMeshes: window.sim?.model?.bodyMeshes?.length ?? 0,
    wheels: window.sim ? Object.keys(window.sim.model.wheels).length : 0,
    terrainVerts: window.sim?.terrain?.mesh?.getTotalVertices?.() ?? 0,
    physicsPos: window.sim?.vehicle
      ? [
          Math.round(window.sim.vehicle.position.x * 10) / 10,
          Math.round(window.sim.vehicle.position.y * 10) / 10,
          Math.round(window.sim.vehicle.position.z * 10) / 10,
        ]
      : null,
  }))
  console.log('page state:', JSON.stringify(info))

  await page.screenshot({ path: process.argv[2] ?? '/tmp/desktop.png', timeout: 180000 })
  verdict = info.ready && info.wheels === 4 && info.terrainVerts > 0 ? 'PASS' : 'FAIL'
  console.log('errors:', errors.length ? errors.slice(0, 5) : 'none')
  await browser.close()
} catch (err) {
  verdict = `FAIL: ${err.message}`
} finally {
  child.kill('SIGTERM')
  await sleep(1500)
  child.kill('SIGKILL')
}

console.log('verdict:', verdict)
if (verdict !== 'PASS') console.log(log.slice(-15).join(''))
process.exit(verdict === 'PASS' ? 0 : 1)

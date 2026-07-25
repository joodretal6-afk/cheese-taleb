import { chromium } from 'playwright'
const url = process.argv[2], out = process.argv[3]
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto(url, { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
while (Date.now() - t0 < 240000) { if (await page.evaluate(() => window.__simStore?.getState().engineReady).catch(()=>false)) break; await page.waitForTimeout(1000) }
await page.evaluate(() => {
  const sim = window.sim
  window.__simStore.getState().set('running', true)
  sim.toggleVehicle()                       // step out
  // Walk a few metres away from the truck so both are in frame.
  const fake = { moveForward: 1, moveRight: 0.35, running: true, jump: false }
  for (let i = 0; i < 150; i++) sim.character.update(1/60, fake, sim.camYaw, [])
  // Mid-stride pose for the screenshot.
  const idle = { moveForward: 1, moveRight: 0, running: false, jump: false }
  for (let i = 0; i < 12; i++) sim.character.update(1/60, idle, sim.camYaw, [])
  sim.camDist = 5.5
  sim.camPitch = 0.16
})
await page.waitForTimeout(6000)
const box = await page.locator('canvas').boundingBox()
await page.screenshot({ path: out, clip: box, timeout: 180000 })
console.log('character at', await page.evaluate(() => {
  const p = window.sim.character.position
  return [Math.round(p.x*10)/10, Math.round(p.y*10)/10, Math.round(p.z*10)/10]
}))
await browser.close()

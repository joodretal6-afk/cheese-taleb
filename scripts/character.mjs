/** Verifies the on-foot character: exit, walk, run, jump, re-enter. */
import { chromium } from 'playwright'
const url = process.argv[2] ?? 'http://127.0.0.1:5173/?quality=low'
const outDir = process.argv[3] ?? '/tmp'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 900, height: 620 } })
const errs = []
page.on('pageerror', e => errs.push('pageerror: ' + e.message))
await page.goto(url, { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
while (Date.now() - t0 < 240000) { if (await page.evaluate(() => window.__simStore?.getState().engineReady).catch(()=>false)) break; await page.waitForTimeout(1000) }

const r = v => Math.round(v * 100) / 100
const report = await page.evaluate(() => {
  const sim = window.sim
  const R = v => Math.round(v * 100) / 100
  const out = {}
  window.__simStore.getState().set('running', true)

  // Step the character directly: the render loop only advances 0.05 s per frame
  // on software GL, which is far too slow to walk anywhere.
  const walk = (secs, opts) => {
    const fake = { moveForward: 0, moveRight: 0, running: false, jump: false, ...opts }
    const DT = 1 / 60
    let peakY = -Infinity
    const startY = sim.character.position.y
    for (let i = 0; i < Math.floor(secs / DT); i++) {
      // jump is edge-triggered: only true on the first step
      fake.jump = i === 0 ? !!opts.jump : false
      sim.character.update(DT, fake, sim.camYaw ?? Math.PI, [])
      peakY = Math.max(peakY, sim.character.position.y - sim.field.surfaceHeight(
        sim.character.position.x, sim.character.position.z))
    }
    return { peakAboveGround: R(peakY), startY: R(startY) }
  }

  out.modeBefore = sim.mode
  out.exited = sim.toggleVehicle()
  out.modeAfter = sim.mode
  const p0 = sim.character.position.clone()
  out.spawnPos = [R(p0.x), R(p0.y), R(p0.z)]
  out.distanceToDoor = R(Math.hypot(p0.x - sim.vehicle.position.x, p0.z - sim.vehicle.position.z))

  walk(2, { moveForward: 1 })
  const p1 = sim.character.position.clone()
  out.walkDistance = R(Math.hypot(p1.x - p0.x, p1.z - p0.z))
  out.walkGait = sim.character.gait

  walk(2, { moveForward: 1, running: true })
  const p2 = sim.character.position.clone()
  out.runDistance = R(Math.hypot(p2.x - p1.x, p2.z - p1.z))
  out.runGait = sim.character.gait

  const jump = walk(1.2, { moveForward: 0, jump: true })
  out.jumpApex = jump.peakAboveGround
  out.groundedAfterJump = sim.character.grounded

  // Walk back to the truck and get in.
  const door = sim.doorPoint ? null : null
  for (let i = 0; i < 900; i++) {
    const v = sim.vehicle.position
    const dx = v.x - sim.character.position.x
    const dz = v.z - sim.character.position.z
    const d = Math.hypot(dx, dz)
    if (d < 2.2) break
    sim.character.position.x += (dx / d) * 0.03
    sim.character.position.z += (dz / d) * 0.03
    sim.character.position.y = sim.field.surfaceHeight(sim.character.position.x, sim.character.position.z)
  }
  out.reEntered = sim.toggleVehicle()
  out.modeFinal = sim.mode
  void door
  return out
})

console.log(JSON.stringify(report, null, 1))

// Screenshot the character standing beside the truck.
await page.evaluate(() => { window.sim.toggleVehicle(); window.sim.camDist = 6 })
await page.waitForTimeout(4000)
await page.screenshot({ path: `${outDir}/character.png`, timeout: 180000 })
console.log('errors:', errs.length ? errs : 'none')
await browser.close()

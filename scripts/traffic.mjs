import { chromium } from 'playwright'
const url = process.argv[2] ?? 'http://127.0.0.1:5173/?quality=low'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } })
page.on('pageerror', e => console.log('[pageerror]', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('[console.error]', m.text()) })
await page.goto(url, { waitUntil: 'domcontentloaded' })

// Wait for the world.
const t0 = Date.now()
while (Date.now() - t0 < 240000) { if (await page.evaluate(() => !!window.sim?.field).catch(()=>false)) break; await page.waitForTimeout(1000) }
await page.waitForTimeout(1500)

// Open أدوات → المرور so the panel creates the traffic system.
await page.getByText('أدوات', { exact: true }).click().catch(()=>{})
await page.waitForTimeout(400)
await page.getByText('المرور', { exact: true }).first().click().catch(()=>{})
await page.waitForTimeout(400)

const setup = await page.evaluate(() => {
  const sim = window.sim
  const t = sim.traffic
  if (!t) return { ok: false, why: 'no traffic system created' }
  const R = (sim.field.worldSize ?? 200) * 0.14
  t.beginLane()
  const N = 10
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2
    t.addWaypoint(Math.cos(a) * R, Math.sin(a) * R)
  }
  const ended = t.endLane()
  t.setCount(6)
  t.setSpeed(10)
  t.play()
  return { ok: true, ended, lanes: t.laneCount(), cars: t.carCount(), running: t.running, R: +R.toFixed(1) }
})
console.log('setup', JSON.stringify(setup))

function readCars() {
  return page.evaluate(() => {
    const sim = window.sim
    const nodes = sim.scene.transformNodes.filter(n => n.name.startsWith('traffic_car_'))
    return nodes.map(n => {
      n.computeWorldMatrix(true)
      const p = n.getAbsolutePosition()
      const gy = sim.field.surfaceHeight(p.x, p.z)
      // one wheel pivot spin
      const wheel = sim.scene.transformNodes.find(w => w.name.startsWith('traffic_wheelpivot_') && w.parent === n)
      return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), clr: +(p.y - gy).toFixed(2), spin: +(wheel?.rotation.x ?? 0).toFixed(2) }
    })
  })
}

const a = await readCars()
await page.waitForTimeout(1800)
const b = await readCars()

let moved = 0, maxClr = 0
for (let i = 0; i < a.length; i++) {
  const d = Math.hypot(b[i].x - a[i].x, b[i].z - a[i].z)
  if (d > 0.3) moved++
  maxClr = Math.max(maxClr, Math.abs(a[i].clr), Math.abs(b[i].clr))
}
const spun = a.filter((c, i) => Math.abs(b[i].spin - c.spin) > 0.2).length

console.log('cars t=0 :', JSON.stringify(a))
console.log('cars t=1.8:', JSON.stringify(b))
console.log(`moved=${moved}/${a.length}  wheels-spun=${spun}/${a.length}  max|clearance|=${maxClr.toFixed(2)}m`)

// Pause and confirm they stop.
await page.evaluate(() => window.sim.traffic.pause())
const c1 = await readCars()
await page.waitForTimeout(800)
const c2 = await readCars()
let movedWhilePaused = 0
for (let i = 0; i < c1.length; i++) if (Math.hypot(c2[i].x - c1[i].x, c2[i].z - c1[i].z) > 0.05) movedWhilePaused++
console.log(`while paused: moved=${movedWhilePaused}/${c1.length}`)

await browser.close()
const pass = setup.ok && setup.ended && moved === a.length && spun === a.length && maxClr < 0.6 && movedWhilePaused === 0
console.log(pass ? 'PASS' : 'FAIL')
process.exit(pass ? 0 : 1)

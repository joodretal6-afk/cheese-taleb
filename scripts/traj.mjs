import { chromium } from 'playwright'
const url = process.argv[2] ?? 'http://127.0.0.1:5173/?quality=low'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 320, height: 240 } })
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto(url, { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
while (Date.now() - t0 < 240000) { if (await page.evaluate(() => !!window.sim?.vehicle).catch(()=>false)) break; await page.waitForTimeout(1000) }
await page.waitForTimeout(2000)

const out = await page.evaluate(() => {
  const sim = window.sim
  const v = sim.vehicle
  const s = window.__simStore.getState().settings
  const tune = { mudIntensity: s.mudIntensity, humidity: s.humidity, ambientC: 20, awd: true }
  v.reset()
  const rows = []
  const DT = 1/120
  for (let i = 0; i < 600; i++) {
    v.step(DT, sim.input, tune)
    sim.world.step()
    if (i % 15 === 0) {
      const p = v.body.translation(), vel = v.body.linvel()
      const g = sim.field.surfaceHeight(p.x, p.z)
      rows.push({
        t: +(i*DT).toFixed(2),
        y: +p.y.toFixed(2), gy: +g.toFixed(2), clr: +(p.y-g).toFixed(2),
        vy: +vel.y.toFixed(2), spd: +Math.hypot(vel.x, vel.z).toFixed(2),
        dbg: v.debugWheels(),
      })
    }
  }
  // Peek at internal wheel state via the telemetry-free path.
  return { rows, spawn: [v.spawn?.x, v.spawn?.y, v.spawn?.z] }
})
await browser.close()
console.log('spawn', JSON.stringify(out.spawn))
console.log('body mass:', out.rows[0]?.dbg?.mass)
for (const r of out.rows) {
  console.log(`t=${String(r.t).padStart(5)} y=${String(r.y).padStart(8)} clr=${String(r.clr).padStart(7)} vy=${String(r.vy).padStart(7)}  ` +
    r.dbg.wheels.map(w => `${w.id}${w.grounded?'*':' '}L=${String(w.load).padStart(6)} c=${w.compression}`).join(' '))
}

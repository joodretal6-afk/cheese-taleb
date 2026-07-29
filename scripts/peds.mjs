import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 640, height: 420 } })
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:5173/?quality=low', { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
while (Date.now() - t0 < 90000) { if (await page.evaluate(() => !!window.sim?.field).catch(()=>false)) break; await page.waitForTimeout(1000) }
await page.getByText('أدوات', { exact: true }).click().catch(()=>{})
await page.waitForTimeout(150)
await page.getByText('المشاة', { exact: true }).first().click().catch(()=>{})
await page.waitForTimeout(150)
async function pump(n){ for(let i=0;i<n;i++){ await page.evaluate(()=>window.sim.scene.render()) } }
const setup = await page.evaluate(() => {
  const t = window.sim.pedestrians, R=16, N=16
  t.beginPath(); for (let i=0;i<N;i++){const a=(i/N)*Math.PI*2; t.addWaypoint(Math.cos(a)*R, Math.sin(a)*R)}
  t.endPath(); t.setCount(6); t.setSpeed(1.6); t.play()
  return { walkers: t.walkerCount(), running: t.running }
})
console.log('setup:', JSON.stringify(setup))
function snap(){ return page.evaluate(() => {
  const sim = window.sim
  const holders = sim.scene.transformNodes.filter(n=>/^ped_\d+$/.test(n.name))
  const legPivot = sim.scene.transformNodes.find(n=>n.name.startsWith('ped_hip_'))
  return {
    positions: holders.map(n=>{n.computeWorldMatrix(true);const p=n.getAbsolutePosition();const gy=sim.field.surfaceHeight(p.x,p.z);return {x:+p.x.toFixed(2),z:+p.z.toFixed(2),clr:+(p.y-gy).toFixed(2)}}),
    legX: legPivot ? +legPivot.rotation.x.toFixed(3) : null,
  }
})}
await pump(2)
const a = await snap()
await pump(8)
const b = await snap()
let moved=0, maxClr=0
for(let i=0;i<a.positions.length;i++){ if(Math.hypot(b.positions[i].x-a.positions[i].x,b.positions[i].z-a.positions[i].z)>0.15) moved++; maxClr=Math.max(maxClr,Math.abs(a.positions[i].clr),Math.abs(b.positions[i].clr)) }
const legSwung = a.legX !== null && b.legX !== null && Math.abs(a.legX-b.legX) > 0.02
console.log('walkers=', a.positions.length, 'moved=', moved, 'maxClr=', maxClr.toFixed(2), 'legA=', a.legX, 'legB=', b.legX, 'legSwung=', legSwung)
await browser.close()
const pass = setup.walkers===6 && moved===a.positions.length && maxClr<0.4 && legSwung
console.log(pass?'PEDS-PASS':'PEDS-FAIL')

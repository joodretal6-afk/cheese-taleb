import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', e => console.log('[pageerror]', e.message))
page.on('console', m => { if (m.type()==='error' && !/404/.test(m.text())) console.log('[cerr]', m.text()) })
await page.goto('http://127.0.0.1:5173/?quality=low', { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
while (Date.now() - t0 < 240000) { if (await page.evaluate(() => !!window.sim?.field).catch(()=>false)) break; await page.waitForTimeout(1000) }
await page.waitForTimeout(1500)
await page.getByText('أدوات', { exact: true }).click().catch(()=>{})
await page.waitForTimeout(300)
await page.getByText('المرور', { exact: true }).first().click().catch(()=>{})
await page.waitForTimeout(300)

async function pump(n, gap=20){ for(let i=0;i<n;i++){ await page.evaluate(()=>window.sim.scene.render()); await page.waitForTimeout(gap) } }

// Draw a ring lane, then add the Frontier as a car type with count 3, and set generated to 2.
const setup = await page.evaluate(async () => {
  const sim = window.sim, t = sim.traffic
  const R = 24, N = 14
  t.beginLane()
  for (let i=0;i<N;i++){const a=(i/N)*Math.PI*2; t.addWaypoint(Math.cos(a)*R, Math.sin(a)*R)}
  t.endLane()
  t.setCount(2)
  const id = await t.addModel('models/frontier.glb', 'Frontier', '.glb')
  t.setModelCount(id, 3)
  t.setSpeed(10); t.play()
  return { id, models: t.listModels(), cars: t.carCount() }
})
console.log('setup:', JSON.stringify(setup))

// Count model-based cars: holders with child meshes (generated cars have box/cyl children too;
// distinguish by name of children — model clones are traffic_modelgeo_*).
const breakdown = await page.evaluate(() => {
  const sim = window.sim
  const holders = sim.scene.transformNodes.filter(n => n.name.startsWith('traffic_car_'))
  let model=0, gen=0
  for (const h of holders){
    const kids = h.getChildren ? h.getChildren() : []
    const hasModel = h.getChildTransformNodes?.().some(n=>n.name.includes('modelgeo')) ||
                     h.getChildMeshes?.().some(m=>m.name.includes('modelgeo'))
    if (hasModel) model++; else gen++
  }
  return { holders: holders.length, model, gen }
})
console.log('breakdown:', JSON.stringify(breakdown))

// Verify they move.
function pos(){ return page.evaluate(()=>window.sim.scene.transformNodes.filter(n=>n.name.startsWith('traffic_car_')).map(n=>{n.computeWorldMatrix(true);const p=n.getAbsolutePosition();const gy=window.sim.field.surfaceHeight(p.x,p.z);return {x:+p.x.toFixed(2),z:+p.z.toFixed(2),clr:+(p.y-gy).toFixed(2)}})) }
const a = await pos()
await pump(40)
const b = await pos()
let moved=0, maxAbsClr=0
for(let i=0;i<a.length;i++){ if(Math.hypot(b[i].x-a[i].x,b[i].z-a[i].z)>0.3) moved++; maxAbsClr=Math.max(maxAbsClr, Math.abs(b[i].clr)) }
console.log(`moved=${moved}/${a.length} maxAbsClr=${maxAbsClr.toFixed(2)}`)
await browser.close()
const pass = setup.cars===5 && breakdown.model===3 && breakdown.gen===2 && moved===a.length && maxAbsClr<0.8
console.log(pass?'PASS':'FAIL')
process.exit(pass?0:1)

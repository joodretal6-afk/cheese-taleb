import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } })
await page.goto('http://127.0.0.1:5173/?quality=low', { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
while (Date.now() - t0 < 240000) { if (await page.evaluate(() => !!window.sim?.field).catch(()=>false)) break; await page.waitForTimeout(1000) }
await page.waitForTimeout(1500)
await page.getByText('أدوات', { exact: true }).click().catch(()=>{})
await page.waitForTimeout(300)
await page.getByText('المرور', { exact: true }).first().click().catch(()=>{})
await page.waitForTimeout(300)
await page.evaluate(async () => {
  const sim = window.sim, t = sim.traffic
  const R = 16, N = 14
  t.beginLane(); for (let i=0;i<N;i++){const a=(i/N)*Math.PI*2; t.addWaypoint(Math.cos(a)*R, Math.sin(a)*R)}
  t.endLane(); t.setCount(3)
  const id = await t.addModel('models/frontier.glb', 'Frontier', '.glb')
  t.setModelCount(id, 5); t.setSpeed(6); t.play()
  // Editor camera up above looking down.
  const cam = sim.editorCam
})
// enable editor cam and fly it up/back for an overview
await page.getByText('تفعيل', { exact: true }).first().click().catch(()=>{})
async function pump(n, gap=20){ for(let i=0;i<n;i++){ await page.evaluate(()=>window.sim.scene.render()); await page.waitForTimeout(gap) } }
await page.keyboard.down('s'); await pump(25); await page.keyboard.up('s')
await page.keyboard.down('e'); await pump(30); await page.keyboard.up('e')
await pump(10)
await page.screenshot({ path: '/tmp/claude-0/-home-user-cheese-taleb/63b9737e-6494-5727-9ba9-bb837c1c1fce/scratchpad/carlib.png' })
await browser.close()
console.log('shot saved')

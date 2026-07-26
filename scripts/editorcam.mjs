import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
page.on('pageerror', e => console.log('[pageerror]', e.message))
await page.goto('http://127.0.0.1:5173/?quality=low', { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
while (Date.now() - t0 < 240000) { if (await page.evaluate(() => !!window.sim?.field).catch(()=>false)) break; await page.waitForTimeout(1000) }
await page.waitForTimeout(1500)
await page.getByText('أدوات', { exact: true }).click().catch(()=>{})
await page.waitForTimeout(300)
await page.getByText('المرور', { exact: true }).first().click().catch(()=>{})
await page.waitForTimeout(300)

// Pump N real frames (headless throttles rAF, so drive render() ourselves).
async function pump(n, gap=20) { for (let i=0;i<n;i++){ await page.evaluate(()=>window.sim.scene.render()); await page.waitForTimeout(gap) } }

await page.getByText('تفعيل', { exact: true }).first().click().catch(e=>console.log('no button', e.message))
await page.waitForTimeout(200)
const camOn = await page.evaluate(() => !!window.sim.editorCam?.active)
const paused = await page.evaluate(() => !window.__simStore.getState().settings.running)
await pump(3)
const before = await page.evaluate(() => { const p = window.sim.camera.position; return {x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2)} })
await page.keyboard.down('w'); await pump(30); await page.keyboard.up('w')
const afterW = await page.evaluate(() => { const p = window.sim.camera.position; return {x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2)} })
await page.keyboard.down('e'); await pump(20); await page.keyboard.up('e')
const afterE = await page.evaluate(() => { const p = window.sim.camera.position; return {x:+p.x.toFixed(2),y:+p.y.toFixed(2),z:+p.z.toFixed(2)} })
const frames = await page.evaluate(() => window.sim.editorCam._dbg.frames)

await page.getByText('رسم مسار جديد', { exact: true }).click().catch(()=>{})
await page.waitForTimeout(300)
const box = await (await page.$('canvas')).boundingBox()
await page.mouse.click(box.x + box.width*0.5, box.y + box.height*0.62, { button: 'left' })
await page.waitForTimeout(150)
await page.mouse.click(box.x + box.width*0.6, box.y + box.height*0.66, { button: 'left' })
await page.waitForTimeout(200)
const pts = await page.evaluate(() => window.sim.traffic.activePointCount)

const movedW = Math.hypot(afterW.x-before.x, afterW.z-before.z)
const roseE = afterE.y - afterW.y
console.log('camOn=', camOn, 'paused=', paused, 'frames=', frames)
console.log('before', JSON.stringify(before), 'afterW', JSON.stringify(afterW), 'afterE', JSON.stringify(afterE))
console.log('movedW=', movedW.toFixed(2), 'roseE=', roseE.toFixed(2), 'drawPoints=', pts)
await browser.close()
const pass = camOn && paused && movedW > 2 && roseE > 1 && pts >= 2
console.log(pass ? 'PASS' : 'FAIL')
process.exit(pass?0:1)

/** Exercises the dashboard's interactive paths: generate, apply, weather, sliders. */
import { chromium } from 'playwright'
const url = process.argv[2], out = process.argv[3]
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } })
const errs = []
page.on('pageerror', e => errs.push('pageerror: ' + e.message))
page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()) })
await page.goto(url, { waitUntil: 'domcontentloaded' })
const t0 = Date.now()
while (Date.now() - t0 < 240000) { if (await page.evaluate(() => window.__simStore?.getState().engineReady).catch(()=>false)) break; await page.waitForTimeout(1000) }

await page.evaluate(() => { const s = window.sim; window.__simStore.getState().set('running', true)
  s.input.throttle = 1; s.warmup(5); s.input.throttle = 0 })

console.log('1. generate textures')
await page.getByRole('button', { name: /توليد الصورة/ }).click()
await page.waitForFunction(() => {
  const st = window.__simStore.getState()
  return (st.generated[st.selectedPartId] ?? []).length >= 4
}, { timeout: 30000 })
const gen = await page.evaluate(() => {
  const st = window.__simStore.getState()
  return (st.generated[st.selectedPartId] ?? []).length
})
console.log('   generated results:', gen)

console.log('2. apply the first result to the 3D model')
await page.locator('img[alt=""]').first().waitFor({ timeout: 10000 }).catch(() => {})
const applyBtns = page.locator('h3:has-text("النتائج") + div button')
await applyBtns.first().click()
await page.waitForTimeout(1500)
console.log('   status:', await page.evaluate(() => document.body.innerText.match(/تم تطبيق[^\n]*/)?.[0] ?? '(none)'))

console.log('3. switch weather to rain')
await page.getByRole('button', { name: 'ممطر' }).click()
await page.waitForTimeout(2500)
console.log('   weather now:', await page.evaluate(() => window.__simStore.getState().settings.weather))

console.log('4. move the mud slider')
const slider = page.getByLabel('شدة الطين')
await slider.fill('0.35')
await page.waitForTimeout(500)
console.log('   mudIntensity:', await page.evaluate(() => window.__simStore.getState().settings.mudIntensity))

console.log('5. switch material tab')
await page.getByRole('button', { name: 'الحجارة' }).click()
await page.waitForTimeout(800)

await page.screenshot({ path: out, timeout: 180000 })
console.log('errors:', errs.length ? errs.slice(0,10) : 'none')
await browser.close()

/** Screenshots the terrain shader's debug channels to find where the look breaks. */
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/?quality=low'
const outDir = process.argv[3] ?? '/tmp/dbg'

const MODES = {
  0: 'normal',
  1: 'slope',
  2: 'disturb',
  3: 'depth',
  4: 'dirtTex',
  5: 'grassTex',
  6: 'rockTex',
  7: 'normalW',
  8: 'snow',
  9: 'mudTex',
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 520, height: 340 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))
await page.goto(url, { waitUntil: 'domcontentloaded' })

const started = Date.now()
while (Date.now() - started < 240000) {
  if (await page.evaluate(() => !!window.sim?.terrain).catch(() => false)) break
  await page.waitForTimeout(1000)
}
await page.waitForTimeout(3000)

// Pull the camera back and up so the landscape is readable, not one hillside.
// Deliberately NOT using material.unlit — Babylon's UNLIT path takes a shortcut
// through the PBR shader and can skip the custom blocks we're inspecting.
await page.evaluate(() => {
  const sim = window.sim
  sim.camDist = 34
  sim.camPitch = 0.62
  sim.scene.fogMode = 0
})
await page.waitForTimeout(3000)

for (const [mode, name] of Object.entries(MODES)) {
  await page.evaluate((m) => { window.sim.terrain.debugMode = Number(m) }, mode)
  await page.waitForTimeout(2200)
  await page.screenshot({ path: `${outDir}/${String(mode).padStart(2, '0')}-${name}.png`, timeout: 120000 })
  console.log('shot', mode, name)
}

await browser.close()

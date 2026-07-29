/**
 * Headless smoke test + screenshot for the Map Editor.
 *
 * Boots the editor in Chromium (SwiftShader), sculpts a few hills and a valley
 * programmatically through window.__editor, then writes a PNG.
 *
 *   node scripts/shot.mjs --out scratch/editor.png --url http://127.0.0.1:5273
 */
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, []),
)
const url = args.url ?? 'http://127.0.0.1:5273'
const out = args.out ?? 'scratch/editor.png'
const width = Number(args.width ?? 1400)
const height = Number(args.height ?? 900)

await mkdir(dirname(out), { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--no-sandbox', '--ignore-gpu-blocklist'],
})
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

let status = 'ok'
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // Wait for the editor to attach.
  await page.waitForFunction(() => !!window.__editor?.terrain, { timeout: 60000 })
  await page.waitForTimeout(2500)

  // Sculpt a small terrain: a ridge of hills and a carved valley.
  const info = await page.evaluate(() => {
    const ed = window.__editor
    const t = ed.terrain
    // Hills
    const hills = [
      [-500, -300, 12], [-200, 100, 16], [300, -200, 20], [600, 300, 14], [0, 500, 10],
    ]
    for (const [x, z, s] of hills) {
      for (let k = 0; k < 30; k++) t.sculpt(x, z, 'raise', 180, s * 0.15)
    }
    // A river valley across the middle
    for (let x = -900; x <= 900; x += 40) {
      for (let k = 0; k < 8; k++) t.sculpt(x, Math.sin(x * 0.004) * 120, 'lower', 90, 1.2)
    }
    // Smooth pass
    for (const [x, z] of hills) for (let k = 0; k < 6; k++) t.sculpt(x, z, 'smooth', 220, 1)
    // Frame the camera a bit lower for a nicer angle
    ed.camera.beta = 1.15
    ed.camera.alpha = -Math.PI / 2 + 0.5
    ed.camera.radius = 2400
    ed.scene.render()
    return { verts: t.grid * t.grid, hills: hills.length }
  })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: out, timeout: 120000, animations: 'disabled' })
  logs.push(`[info] sculpted ${info.hills} hills over ${info.verts} verts`)
} catch (err) {
  status = 'error'
  logs.push(`[fatal] ${err.message}`)
}

await browser.close()
console.log('--- console (tail) ---')
for (const l of logs.slice(-30)) console.log(l)
console.log('--- status ---', status, '->', out)

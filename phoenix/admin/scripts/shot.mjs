import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, []),
)
const url = args.url ?? 'http://127.0.0.1:5373'
const out = args.out ?? 'scratch/admin.png'
const page_ = args.page ?? 'overview'
await mkdir(dirname(out), { recursive: true })

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

let status = 'ok'
try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(1500)
  if (page_ !== 'overview') {
    await page.getByText(new RegExp(page_, 'i')).first().click().catch(() => {})
    await page.waitForTimeout(800)
  }
  await page.screenshot({ path: out, timeout: 60000 })
} catch (err) {
  status = 'error'
  logs.push(`[fatal] ${err.message}`)
}
await browser.close()
console.log('--- console ---')
for (const l of logs.slice(-15)) console.log(l)
console.log('--- status ---', status, '->', out)

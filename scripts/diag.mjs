/** Boots the app and dumps scene diagnostics — no screenshot, so it's fast. */
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/?quality=low'

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 900, height: 600 } })
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
page.on('response', (r) => { if (r.status() >= 400) logs.push(`[http ${r.status()}] ${r.url()}`) })

await page.goto(url, { waitUntil: 'domcontentloaded' })

const started = Date.now()
while (Date.now() - started < 240000) {
  const ok = await page.evaluate(() => !!window.sim?.vehicle).catch(() => false)
  if (ok) break
  await page.waitForTimeout(1000)
}
await page.waitForTimeout(3000)

const diag = await page.evaluate(() => {
  const sim = window.sim
  if (!sim) return { error: 'no sim' }
  const r3 = (v) => (v === undefined || v === null ? null : Math.round(v * 100) / 100)
  const vec = (v) => (v ? [r3(v.x), r3(v.y), r3(v.z)] : null)

  const terrain = sim.terrain.mesh
  terrain.computeWorldMatrix(true)
  const tb = terrain.getBoundingInfo().boundingBox
  const cam = sim.camera
  const truck = sim.model.root
  truck.computeWorldMatrix(true)

  const inFrustum = cam.isInFrustum ? cam.isInFrustum(terrain) : null

  // Sample the terrain height field where the truck sits.
  const f = sim.field
  const samples = [[0, -35], [0, 0], [20, 20], [-20, -20]].map(([x, z]) => ({
    at: [x, z],
    base: r3(f.baseHeight(x, z)),
    surface: r3(f.surfaceHeight(x, z)),
  }))

  const wheels = Object.entries(sim.model.wheels).map(([id, w]) => ({
    id,
    rest: vec(w.restPosition),
    radius: r3(w.radius),
    width: r3(w.width),
    meshes: w.meshes.length,
  }))

  return {
    camera: {
      pos: vec(cam.position),
      target: vec(cam.getTarget()),
      rotation: vec(cam.rotation),
      hasQuat: !!cam.rotationQuaternion,
      forward: vec(cam.getForwardRay().direction),
      // March the view ray and report the first terrain hit.
      hit: (() => {
        const o = cam.position
        const d = cam.getForwardRay().direction
        for (let t = 0.5; t < 300; t += 0.5) {
          const x = o.x + d.x * t
          const y = o.y + d.y * t
          const z = o.z + d.z * t
          if (Math.abs(x) > 110 || Math.abs(z) > 110) return `out of bounds at t=${r3(t)}`
          if (y <= sim.field.surfaceHeight(x, z)) return `terrain at t=${r3(t)} y=${r3(y)}`
        }
        return 'no hit within 300 m'
      })(),
      fov: r3(cam.fov),
      minZ: cam.minZ,
      maxZ: cam.maxZ,
    },
    truck: { pos: vec(truck.position), bodyMeshes: sim.model.bodyMeshes.length },
    physics: { pos: vec(sim.vehicle.position) },
    terrain: {
      verts: terrain.getTotalVertices(),
      indices: terrain.getTotalIndices(),
      bbMin: vec(tb.minimumWorld),
      bbMax: vec(tb.maximumWorld),
      visible: terrain.isVisible,
      enabled: terrain.isEnabled(),
      inFrustum,
      material: terrain.material?.name,
      backFaceCulling: terrain.material?.backFaceCulling,
      sideOrientation: terrain.material?.sideOrientation,
      ready: terrain.material?.isReady(terrain),
    },
    field: { worldSize: f.worldSize, res: f.res, samples },
    wheels,
    scene: {
      meshes: sim.scene.meshes.length,
      active: sim.scene.getActiveMeshes().length,
      lights: sim.scene.lights.map((l) => `${l.name}:${r3(l.intensity)}`),
      fog: [sim.scene.fogMode, r3(sim.scene.fogDensity)],
      envTex: !!sim.scene.environmentTexture,
    },
  }
})

await browser.close()
console.log(JSON.stringify(diag, null, 2))
console.log('--- logs ---')
for (const l of logs.slice(-25)) console.log(l)

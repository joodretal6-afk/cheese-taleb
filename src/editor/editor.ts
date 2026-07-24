import './editor.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { buildTruck, TRUCK_PART_IDS, TRUCK_PART_LABELS, type TruckPartId } from '../vehicle/truck-mesh'
import { createScene } from '../world/scene'
import { Terrain } from '../world/terrain'
import { TerrainMesh } from '../world/terrain-mesh'
import {
  DEFAULT_PIPELINE_OPTIONS,
  canvasToDataUrl,
  generatePbrMaps,
  loadImage,
  readFileAsDataUrl,
  type PipelineOptions,
} from './texture-pipeline'

/**
 * The authoring tool.
 *
 * The game itself has no way to import art; everything visual is bound here and
 * written to a scene file the game loads at boot. Textures are stored inline as
 * data URLs so a saved scene is a single self-contained file that survives being
 * emailed, dropped in a chat, or committed.
 */

/** Per-part material settings the editor owns. */
interface PartSettings {
  /** Source image as a data URL, before any derived maps. */
  sourceImage: string | null
  tiling: number
  metalness: number
  roughness: number
  normalScale: number
  colour: string
  pipeline: PipelineOptions
}

interface SceneFile {
  version: 1
  savedAt: string
  sun: { azimuth: number; elevation: number; intensity: number }
  exposure: number
  parts: Partial<Record<TruckPartId, PartSettings>>
}

const STORAGE_KEY = 'zone-royale.scene'

const defaultSettings = (): PartSettings => ({
  sourceImage: null,
  tiling: 1,
  metalness: 0.5,
  roughness: 0.45,
  normalScale: 1,
  colour: '#f2f4f7',
  pipeline: { ...DEFAULT_PIPELINE_OPTIONS },
})

async function boot(): Promise<void> {
  const app = document.querySelector<HTMLElement>('#app')!
  app.innerHTML = layout()

  const canvas = app.querySelector<HTMLCanvasElement>('#viewport')!
  const { renderer, scene, camera, sun } = createScene(canvas)

  // A patch of the real ground so materials are judged against the surface
  // they will actually sit on, rather than against a neutral grey void.
  const terrain = new Terrain(4242)
  const terrainMesh = new TerrainMesh(terrain)
  scene.add(terrainMesh.mesh)

  const truck = buildTruck()
  const groundY = terrain.heightAt(25, 25)
  truck.group.position.set(25, groundY + 1.05, 25)
  scene.add(truck.group)

  camera.position.set(29.5, groundY + 3.2, 30.5)
  const orbit = new OrbitControls(camera, canvas)
  orbit.target.set(25, groundY + 0.9, 25)
  orbit.enableDamping = true
  orbit.dampingFactor = 0.08
  orbit.minDistance = 3
  orbit.maxDistance = 22
  // Stop the camera dropping below the ground plane.
  orbit.maxPolarAngle = Math.PI * 0.495
  orbit.update()

  const settings = new Map<TruckPartId, PartSettings>()
  for (const id of TRUCK_PART_IDS) settings.set(id, defaultSettings())

  let selected: TruckPartId = 'body'
  let sunAzimuth = 0.9
  let sunElevation = 0.85
  let sunIntensity = 2.9
  let exposure = 1.05

  // --- Element handles ------------------------------------------------------
  const $ = <T extends HTMLElement>(selector: string): T => app.querySelector<T>(selector)!
  const partList = $<HTMLElement>('#part-list')
  const dropZone = $<HTMLElement>('#drop-zone')
  const fileInput = $<HTMLInputElement>('#file-input')
  const previews = {
    albedo: $<HTMLElement>('#preview-albedo'),
    normal: $<HTMLElement>('#preview-normal'),
    roughness: $<HTMLElement>('#preview-roughness'),
  }
  const status = $<HTMLElement>('#status')

  // --- Part list ------------------------------------------------------------
  for (const id of TRUCK_PART_IDS) {
    const button = document.createElement('button')
    button.className = 'part-item'
    button.dataset.part = id
    button.innerHTML = `<span class="part-name">${TRUCK_PART_LABELS[id]}</span><span class="part-dot"></span>`
    button.addEventListener('click', () => selectPart(id))
    partList.appendChild(button)
  }

  function selectPart(id: TruckPartId): void {
    selected = id
    for (const button of partList.querySelectorAll<HTMLElement>('.part-item')) {
      button.classList.toggle('selected', button.dataset.part === id)
    }
    $<HTMLElement>('#selected-name').textContent = TRUCK_PART_LABELS[id]
    syncControlsFromSettings()
    highlightSelection()
  }

  /** Pulses the chosen part so it is obvious which surface is being edited. */
  let highlightTimer = 0
  function highlightSelection(): void {
    highlightTimer = 1.4
  }

  // --- Picking in the viewport ---------------------------------------------
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  canvas.addEventListener('dblclick', (event) => {
    const rect = canvas.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const hits = raycaster.intersectObject(truck.group, true)
    for (const hit of hits) {
      const name = hit.object.name as TruckPartId
      if (settings.has(name)) {
        selectPart(name)
        return
      }
    }
  })

  // --- Texture application --------------------------------------------------
  async function applyImage(dataUrl: string): Promise<void> {
    const current = settings.get(selected)!
    current.sourceImage = dataUrl
    setStatus('جاري توليد الخرائط…')
    // Yield once so the status text paints before the synchronous pipeline runs.
    await new Promise((resolve) => setTimeout(resolve, 16))

    try {
      const image = await loadImage(dataUrl)
      const maps = generatePbrMaps(image, current.pipeline)
      const material = truck.materials[selected]

      disposeMaps(material)
      material.map = canvasTexture(maps.albedo, current.tiling, THREE.SRGBColorSpace)
      material.normalMap = canvasTexture(maps.normal, current.tiling)
      material.roughnessMap = canvasTexture(maps.roughness, current.tiling)
      material.normalScale.set(current.normalScale, current.normalScale)
      // A tinted base would multiply into the texture and muddy it.
      material.color.set('#ffffff')
      material.needsUpdate = true

      previews.albedo.replaceChildren(maps.albedo)
      previews.normal.replaceChildren(maps.normal)
      previews.roughness.replaceChildren(maps.roughness)
      markPartTextured(selected, true)
      setStatus(`تم تطبيق الخامة على: ${TRUCK_PART_LABELS[selected]}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'فشل توليد الخامة', true)
    }
  }

  function canvasTexture(
    source: HTMLCanvasElement,
    tiling: number,
    colorSpace: THREE.ColorSpace = THREE.NoColorSpace,
  ): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(source)
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.repeat.set(tiling, tiling)
    texture.colorSpace = colorSpace
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy()
    return texture
  }

  function disposeMaps(material: THREE.MeshStandardMaterial): void {
    material.map?.dispose()
    material.normalMap?.dispose()
    material.roughnessMap?.dispose()
    material.map = null
    material.normalMap = null
    material.roughnessMap = null
  }

  function markPartTextured(id: TruckPartId, textured: boolean): void {
    partList
      .querySelector<HTMLElement>(`.part-item[data-part="${id}"]`)
      ?.classList.toggle('textured', textured)
  }

  // --- Drop zone ------------------------------------------------------------
  const acceptFiles = async (files: FileList | null): Promise<void> => {
    const file = files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setStatus('الملف ليس صورة', true)
      return
    }
    await applyImage(await readFileAsDataUrl(file))
  }

  dropZone.addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', () => void acceptFiles(fileInput.files))
  for (const type of ['dragenter', 'dragover'] as const) {
    dropZone.addEventListener(type, (e) => {
      e.preventDefault()
      dropZone.classList.add('over')
    })
  }
  for (const type of ['dragleave', 'drop'] as const) {
    dropZone.addEventListener(type, (e) => {
      e.preventDefault()
      dropZone.classList.remove('over')
    })
  }
  dropZone.addEventListener('drop', (e) => void acceptFiles((e as DragEvent).dataTransfer?.files ?? null))

  // Pasting straight from an image generator is the fastest path of all.
  window.addEventListener('paste', (event) => {
    const item = Array.from(event.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'))
    const file = item?.getAsFile()
    if (file) void acceptFiles({ 0: file, length: 1, item: () => file } as unknown as FileList)
  })

  // --- Sliders --------------------------------------------------------------
  const bindSlider = (
    id: string,
    write: (s: PartSettings, value: number) => void,
    onChange: (s: PartSettings) => void,
    regenerates = false,
  ): void => {
    const input = $<HTMLInputElement>(`#${id}`)
    const label = $<HTMLElement>(`#${id}-value`)
    input.addEventListener('input', () => {
      const current = settings.get(selected)!
      write(current, Number(input.value))
      label.textContent = input.value
      if (regenerates && current.sourceImage) void applyImage(current.sourceImage)
      else onChange(current)
    })
  }

  const material = (): THREE.MeshStandardMaterial => truck.materials[selected]

  bindSlider('tiling', (s, v) => (s.tiling = v), (s) => {
    for (const map of [material().map, material().normalMap, material().roughnessMap]) {
      map?.repeat.set(s.tiling, s.tiling)
    }
  })
  bindSlider('metalness', (s, v) => (s.metalness = v), (s) => {
    material().metalness = s.metalness
  })
  bindSlider('roughness', (s, v) => (s.roughness = v), (s) => {
    material().roughness = s.roughness
  })
  bindSlider('normal-scale', (s, v) => (s.normalScale = v), (s) => {
    material().normalScale.set(s.normalScale, s.normalScale)
  })
  bindSlider(
    'normal-strength',
    (s, v) => (s.pipeline.normalStrength = v),
    () => {},
    true,
  )
  bindSlider(
    'seamless',
    (s, v) => (s.pipeline.seamlessBlend = v),
    () => {},
    true,
  )

  const colourInput = $<HTMLInputElement>('#colour')
  colourInput.addEventListener('input', () => {
    const current = settings.get(selected)!
    current.colour = colourInput.value
    if (!current.sourceImage) material().color.set(current.colour)
  })

  function syncControlsFromSettings(): void {
    const s = settings.get(selected)!
    const set = (id: string, value: number): void => {
      $<HTMLInputElement>(`#${id}`).value = String(value)
      $<HTMLElement>(`#${id}-value`).textContent = String(value)
    }
    set('tiling', s.tiling)
    set('metalness', s.metalness)
    set('roughness', s.roughness)
    set('normal-scale', s.normalScale)
    set('normal-strength', s.pipeline.normalStrength)
    set('seamless', s.pipeline.seamlessBlend)
    colourInput.value = s.colour
    for (const key of ['albedo', 'normal', 'roughness'] as const) previews[key].replaceChildren()
  }

  // --- Lighting -------------------------------------------------------------
  const bindLight = (id: string, apply: (value: number) => void): void => {
    const input = $<HTMLInputElement>(`#${id}`)
    input.addEventListener('input', () => {
      apply(Number(input.value))
      $<HTMLElement>(`#${id}-value`).textContent = input.value
      updateSun()
    })
  }
  bindLight('sun-azimuth', (v) => (sunAzimuth = v))
  bindLight('sun-elevation', (v) => (sunElevation = v))
  bindLight('sun-intensity', (v) => (sunIntensity = v))
  bindLight('exposure', (v) => (exposure = v))

  function updateSun(): void {
    const distance = 40
    sun.position.set(
      25 + Math.cos(sunAzimuth) * Math.cos(sunElevation) * distance,
      Math.sin(sunElevation) * distance,
      25 + Math.sin(sunAzimuth) * Math.cos(sunElevation) * distance,
    )
    sun.target.position.set(25, groundY, 25)
    sun.intensity = sunIntensity
    renderer.toneMappingExposure = exposure
  }
  updateSun()

  // --- Save / load ----------------------------------------------------------
  function serialise(): SceneFile {
    const parts: Partial<Record<TruckPartId, PartSettings>> = {}
    for (const [id, value] of settings) {
      // Only persist parts the author actually touched; a file full of
      // defaults is noise and bloats the download with nothing.
      if (value.sourceImage || value.colour !== defaultSettings().colour) parts[id] = value
    }
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      sun: { azimuth: sunAzimuth, elevation: sunElevation, intensity: sunIntensity },
      exposure,
      parts,
    }
  }

  async function restore(file: SceneFile): Promise<void> {
    sunAzimuth = file.sun.azimuth
    sunElevation = file.sun.elevation
    sunIntensity = file.sun.intensity
    exposure = file.exposure
    updateSun()

    for (const [id, value] of Object.entries(file.parts) as [TruckPartId, PartSettings][]) {
      if (!settings.has(id)) continue
      settings.set(id, { ...defaultSettings(), ...value })
      const previous = selected
      selected = id
      if (value.sourceImage) await applyImage(value.sourceImage)
      else truck.materials[id].color.set(value.colour)
      selected = previous
    }
    selectPart(selected)
    setStatus('تم تحميل المشهد')
  }

  $<HTMLElement>('#btn-save').addEventListener('click', () => {
    const json = JSON.stringify(serialise())
    localStorage.setItem(STORAGE_KEY, json)
    const blob = new Blob([json], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = 'zone-royale-scene.json'
    link.click()
    URL.revokeObjectURL(link.href)
    setStatus('تم الحفظ — والمشهد صار جاهز للعبة')
  })

  const loadInput = $<HTMLInputElement>('#load-input')
  $<HTMLElement>('#btn-load').addEventListener('click', () => loadInput.click())
  loadInput.addEventListener('change', async () => {
    const file = loadInput.files?.[0]
    if (!file) return
    try {
      await restore(JSON.parse(await file.text()) as SceneFile)
    } catch {
      setStatus('ملف المشهد غير صالح', true)
    }
  })

  $<HTMLElement>('#btn-reset').addEventListener('click', () => {
    const current = settings.get(selected)!
    settings.set(selected, defaultSettings())
    disposeMaps(material())
    material().color.set(defaultSettings().colour)
    material().needsUpdate = true
    markPartTextured(selected, false)
    syncControlsFromSettings()
    setStatus(`تمت إعادة ضبط: ${TRUCK_PART_LABELS[selected]}`)
    void current
  })

  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored) {
    try {
      await restore(JSON.parse(stored) as SceneFile)
    } catch {
      localStorage.removeItem(STORAGE_KEY)
    }
  }

  function setStatus(message: string, isError = false): void {
    status.textContent = message
    status.classList.toggle('error', isError)
  }

  // --- Render loop ----------------------------------------------------------
  const resize = (): void => {
    const rect = canvas.getBoundingClientRect()
    renderer.setSize(rect.width, rect.height, false)
    camera.aspect = rect.width / Math.max(1, rect.height)
    camera.updateProjectionMatrix()
  }
  resize()
  window.addEventListener('resize', resize)

  let previousTime = performance.now()
  const tick = (now: number): void => {
    const dt = Math.min(0.05, (now - previousTime) / 1000)
    previousTime = now
    orbit.update()

    if (highlightTimer > 0) {
      highlightTimer -= dt
      const pulse = 0.5 + Math.sin(highlightTimer * 14) * 0.5
      truck.materials[selected].emissive.setRGB(pulse * 0.25, pulse * 0.16, 0)
    } else {
      truck.materials[selected].emissive.setRGB(0, 0, 0)
    }

    renderer.render(scene, camera)
    requestAnimationFrame(tick)
  }

  selectPart('body')
  setStatus('اسحب صورة، أو الصقها مباشرة (Ctrl+V)')
  requestAnimationFrame(tick)

  void canvasToDataUrl
}

function layout(): string {
  const slider = (id: string, label: string, min: number, max: number, step: number, value: number): string => `
    <label class="control">
      <span class="control-label">${label}<b id="${id}-value">${value}</b></span>
      <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">
    </label>`

  return `
    <div class="editor">
      <aside class="panel panel-parts">
        <h2>أجزاء المركبة</h2>
        <p class="hint">اضغط على الجزء، أو انقر مرتين عليه في المشهد</p>
        <div class="part-list" id="part-list"></div>
      </aside>

      <main class="stage">
        <canvas id="viewport"></canvas>
        <div class="status" id="status"></div>
        <div class="stage-hint">اسحب للدوران · عجلة الفأرة للتقريب · نقرتان لاختيار جزء</div>
      </main>

      <aside class="panel panel-controls">
        <h2>الجزء المحدد: <span id="selected-name"></span></h2>

        <div class="drop-zone" id="drop-zone">
          <strong>أفلت صورة هنا</strong>
          <span>أو اضغط للاختيار · أو الصق Ctrl+V</span>
        </div>
        <input type="file" id="file-input" accept="image/*" hidden>

        <h3>الخرائط المولّدة تلقائياً</h3>
        <div class="previews">
          <figure><div class="preview" id="preview-albedo"></div><figcaption>اللون</figcaption></figure>
          <figure><div class="preview" id="preview-normal"></div><figcaption>النتوءات</figcaption></figure>
          <figure><div class="preview" id="preview-roughness"></div><figcaption>الخشونة</figcaption></figure>
        </div>

        <h3>الخامة</h3>
        ${slider('tiling', 'التكرار', 1, 8, 1, 1)}
        ${slider('normal-strength', 'قوة النتوءات', 0, 8, 0.2, 2.4)}
        ${slider('normal-scale', 'عمق النتوءات', 0, 3, 0.1, 1)}
        ${slider('seamless', 'إخفاء الحواف', 0, 0.4, 0.02, 0.14)}
        ${slider('metalness', 'المعدنية', 0, 1, 0.05, 0.5)}
        ${slider('roughness', 'الخشونة', 0, 1, 0.05, 0.45)}
        <label class="control">
          <span class="control-label">اللون (بدون خامة)</span>
          <input type="color" id="colour" value="#f2f4f7">
        </label>

        <h3>الإضاءة</h3>
        ${slider('sun-azimuth', 'اتجاه الشمس', 0, 6.28, 0.05, 0.9)}
        ${slider('sun-elevation', 'ارتفاع الشمس', 0.1, 1.55, 0.05, 0.85)}
        ${slider('sun-intensity', 'شدة الشمس', 0, 6, 0.1, 2.9)}
        ${slider('exposure', 'التعريض', 0.3, 2, 0.05, 1.05)}

        <div class="actions">
          <button id="btn-save" class="primary">حفظ المشهد</button>
          <button id="btn-load">تحميل ملف</button>
          <button id="btn-reset" class="danger">إعادة ضبط الجزء</button>
        </div>
        <input type="file" id="load-input" accept="application/json" hidden>
      </aside>
    </div>`
}

boot().catch((error: unknown) => {
  console.error(error)
  document.querySelector('#app')!.textContent = `تعذّر تشغيل اللوحة: ${String(error)}`
})

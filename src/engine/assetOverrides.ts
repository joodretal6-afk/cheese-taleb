import { Texture, type Scene } from '@babylonjs/core'

/**
 * Drop-in asset overrides.
 *
 * The simulator ships fully procedural (see proceduralTextures.ts and
 * Environment.scatterProps) so it runs with zero art assets. This layer lets a
 * user improve that without touching code: drop a file into public/ with the
 * right name and it wins; leave the folder empty and nothing changes.
 *
 *   public/textures/<kind>_albedo.<jpg|jpeg|png|webp>
 *   public/textures/<kind>_normal.<jpg|jpeg|png|webp>
 *   public/models/props/tree.glb
 *   public/models/props/rock.glb
 *
 * A missing file is the expected case, not an error — probing is silent.
 */

export type GroundKind = 'dirt' | 'mud' | 'rock' | 'grass'

export interface TextureOverride {
  albedo: Texture
  /** RGB tangent-space normal. Null when the user supplied albedo only. */
  normalHeight: Texture | null
}

export interface OverrideManifest {
  ground: Partial<Record<GroundKind, TextureOverride>>
  /** Ready-to-import URLs, or null to keep the procedural primitive. */
  props: { tree: string | null; rock: string | null }
}

const GROUND_KINDS: GroundKind[] = ['dirt', 'mud', 'rock', 'grass']

/** Probed in this order, so a jpg beats a png of the same name. */
const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp']

// Vite is configured with base './', so every URL here stays relative — the
// same strings work under the dev server and under file:// in the Electron build.
const TEXTURE_DIR = 'textures'
const PROP_DIR = 'models/props'

/** Ground is always seen at a grazing angle; 4x is the cheap sweet spot. */
const GROUND_ANISOTROPY = 4

// ---------------------------------------------------------------- existence

/**
 * True only if the URL resolves to a real file.
 *
 * Two transports are needed because the app runs in two very different places:
 * `fetch` under the dev server / any http origin, and XHR under the packaged
 * Electron build, where the page itself is on file:// and fetch refuses that
 * scheme outright. Every failure — network, 404, bad scheme, blocked request —
 * collapses to `false`, because "the user did not provide this file" is the
 * normal outcome and must never surface as an error.
 */
export async function urlExists(url: string): Promise<boolean> {
  if (!isFileOrigin()) {
    try {
      const res = await fetch(url, { method: 'HEAD', cache: 'no-store' })
      if (!res.ok) return false
      // Vite answers unknown paths with the SPA shell instead of a 404, so an
      // HTML content type means the asset is absent, not present.
      const type = res.headers.get('content-type') ?? ''
      return !type.toLowerCase().startsWith('text/html')
    } catch {
      return false
    }
  }
  return probeXhr(url)
}

function isFileOrigin(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'file:'
}

/**
 * file:// probe. Chromium reports status 0 for a successful file read and fires
 * `error` when the path does not exist, so status is only meaningful for http.
 */
function probeXhr(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('HEAD', url, true)
      xhr.timeout = 4000
      xhr.onload = () => resolve(xhr.status === 0 || (xhr.status >= 200 && xhr.status < 300))
      xhr.onerror = () => resolve(false)
      xhr.onabort = () => resolve(false)
      xhr.ontimeout = () => resolve(false)
      xhr.send()
    } catch {
      resolve(false)
    }
  })
}

// ------------------------------------------------------------------ ground

/**
 * Load one texture, resolving null if the bytes turn out to be undecodable.
 * Existence was already checked; this catches the corrupt/truncated file case
 * so a bad drop-in degrades to procedural instead of rendering black.
 */
function loadTexture(scene: Scene, url: string, isNormal: boolean): Promise<Texture | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (tex: Texture | null) => {
      if (settled) return
      settled = true
      resolve(tex)
    }
    const tex = new Texture(url, scene, {
      noMipmap: false,
      samplingMode: Texture.TRILINEAR_SAMPLINGMODE,
      // Albedo is authored in sRGB; a normal map is raw vector data and must
      // not be gamma-decoded on the way in.
      gammaSpace: !isNormal,
      onLoad: () => done(tex),
      onError: () => {
        tex.dispose()
        done(null)
      },
    })
    tex.name = url
    tex.wrapU = Texture.WRAP_ADDRESSMODE
    tex.wrapV = Texture.WRAP_ADDRESSMODE
    tex.anisotropicFilteringLevel = GROUND_ANISOTROPY
  })
}

/**
 * Find `<kind>_<suffix>` in any accepted extension. All extensions are probed
 * concurrently — four HEADs cost the same wall time as one, and doing this
 * sequentially for 4 kinds x 2 maps x 4 extensions would add a visible stall to
 * startup on a cold dev server.
 */
async function findTexture(
  scene: Scene,
  kind: GroundKind,
  suffix: 'albedo' | 'normal',
): Promise<Texture | null> {
  const urls = EXTENSIONS.map((ext) => `${TEXTURE_DIR}/${kind}_${suffix}.${ext}`)
  const present = await Promise.all(urls.map(urlExists))
  const hit = present.indexOf(true)
  if (hit < 0) return null
  return loadTexture(scene, urls[hit], suffix === 'normal')
}

export async function loadGroundOverrides(
  scene: Scene,
): Promise<Partial<Record<GroundKind, TextureOverride>>> {
  const found = await Promise.all(
    GROUND_KINDS.map(async (kind) => {
      const [albedo, normalHeight] = await Promise.all([
        findTexture(scene, kind, 'albedo'),
        findTexture(scene, kind, 'normal'),
      ])
      // Albedo is the gate: a custom normal over the procedural albedo would
      // shade relief that isn't in the colour, which reads worse than either
      // set on its own. A lone normal map is dropped, and the whole procedural
      // pair is kept.
      if (!albedo) {
        normalHeight?.dispose()
        return null
      }
      return [kind, { albedo, normalHeight }] as const
    }),
  )

  const out: Partial<Record<GroundKind, TextureOverride>> = {}
  for (const entry of found) {
    if (entry) out[entry[0]] = entry[1]
  }
  return out
}

// ------------------------------------------------------------------- props

export async function loadPropOverrides(): Promise<{ tree: string | null; rock: string | null }> {
  const treeUrl = `${PROP_DIR}/tree.glb`
  const rockUrl = `${PROP_DIR}/rock.glb`
  const [tree, rock] = await Promise.all([urlExists(treeUrl), urlExists(rockUrl)])
  // URLs rather than meshes: the caller owns instancing and scaling, and models
  // are only worth importing once the prop count is known.
  return { tree: tree ? treeUrl : null, rock: rock ? rockUrl : null }
}

export async function loadOverrides(scene: Scene): Promise<OverrideManifest> {
  const [ground, props] = await Promise.all([loadGroundOverrides(scene), loadPropOverrides()])
  return { ground, props }
}

// ----------------------------------------------------------------- summary

export function overrideSummary(m: OverrideManifest): string {
  const parts: string[] = []
  const n = Object.keys(m.ground).length

  // Arabic counts by singular / dual / plural, so a bare "1 خامات" would read
  // wrong. There are only four ground kinds, so n never leaves the 3-10 plural.
  if (n === 1) parts.push('خامة مخصّصة واحدة')
  else if (n === 2) parts.push('خامتان مخصّصتان')
  else if (n >= 3) parts.push(`${n} خامات مخصّصة`)

  if (m.props.tree) parts.push('موديل شجرة مخصّص')
  if (m.props.rock) parts.push('موديل صخرة مخصّص')

  return parts.length ? parts.join(' · ') : 'لا توجد أصول مخصّصة'
}

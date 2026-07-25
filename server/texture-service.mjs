/**
 * AI texture generation backend for the parts/wear panel.
 *
 * The dashboard already speaks this protocol (see src/ui/partTextures.ts,
 * requestWearTexture): POST JSON {prompt, part, seed} -> 200 {image}. An
 * extended body {prompt, part, seed, width, height, image} is also accepted,
 * where `image` is a source-photo data URL used for img2img.
 *
 * Zero dependencies, ESM, plain node:http. Run it with:
 *
 *   node server/texture-service.mjs
 *
 * then point the dashboard at it:
 *
 *   VITE_TEXTURE_API=http://127.0.0.1:8787/generate
 *
 * ---------------------------------------------------------------- providers
 * TEXTURE_PROVIDER picks the adapter. It defaults to `echo`, so a fresh clone
 * runs with no configuration at all and the client keeps using its local
 * canvas synthesis.
 *
 *   TEXTURE_PROVIDER=echo          (default — no external service)
 *
 *   TEXTURE_PROVIDER=comfy         local ComfyUI
 *     COMFY_URL=http://127.0.0.1:8188
 *     COMFY_CKPT=sd_xl_base_1.0.safetensors
 *     COMFY_STEPS=24  COMFY_CFG=6.5
 *     COMFY_SAMPLER=dpmpp_2m  COMFY_SCHEDULER=karras
 *     COMFY_DENOISE=0.62             (img2img only)
 *
 *   TEXTURE_PROVIDER=replicate
 *     REPLICATE_API_TOKEN=r8_...
 *     REPLICATE_MODEL=black-forest-labs/flux-schnell
 *                                    (or owner/name:version, or a bare version id)
 *
 *   TEXTURE_PROVIDER=openai        any OpenAI-compatible images endpoint
 *     OPENAI_BASE_URL=https://api.openai.com
 *     OPENAI_API_KEY=sk-...
 *     OPENAI_IMAGE_MODEL=gpt-image-1
 *
 * ------------------------------------------------------------------ shared
 *   TEXTURE_HOST=127.0.0.1  TEXTURE_PORT=8787
 *   TEXTURE_TIMEOUT_MS=120000      total budget for one generation
 *   TEXTURE_ALLOW_ORIGIN=*         CORS origin for the Vite dev server
 *
 * ------------------------------------------------------------------- routes
 *   GET  /health    -> {ok, provider, configured}
 *   POST /generate  -> {image} | 202 {fallback:'local'} | 502 {error}
 *   POST /pbr       -> 501, on purpose (see handlePbr)
 */
import http from 'node:http'
import https from 'node:https'
import { createHash, randomUUID } from 'node:crypto'

/** Request bodies above this are rejected outright so a huge photo cannot exhaust memory. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** Cap on what we will buffer from a provider, for the same reason. */
const MAX_RESPONSE_BYTES = 48 * 1024 * 1024

// ------------------------------------------------------------------- config

export function loadConfig(env = process.env) {
  const provider = String(env.TEXTURE_PROVIDER ?? 'echo').trim().toLowerCase()
  return {
    provider: provider in PROVIDERS ? provider : 'echo',
    providerRequested: provider,
    host: env.TEXTURE_HOST ?? '127.0.0.1',
    port: intOr(env.TEXTURE_PORT, 8787),
    allowOrigin: env.TEXTURE_ALLOW_ORIGIN ?? '*',
    // One overall budget per request; individual hops get a slice of it.
    timeoutMs: intOr(env.TEXTURE_TIMEOUT_MS, 120000),
    comfy: {
      url: stripSlash(env.COMFY_URL ?? 'http://127.0.0.1:8188'),
      ckpt: env.COMFY_CKPT ?? 'sd_xl_base_1.0.safetensors',
      steps: intOr(env.COMFY_STEPS, 24),
      cfg: floatOr(env.COMFY_CFG, 6.5),
      sampler: env.COMFY_SAMPLER ?? 'dpmpp_2m',
      scheduler: env.COMFY_SCHEDULER ?? 'karras',
      denoise: floatOr(env.COMFY_DENOISE, 0.62),
      negative: env.COMFY_NEGATIVE ?? DEFAULT_NEGATIVE,
    },
    replicate: {
      token: env.REPLICATE_API_TOKEN ?? '',
      model: env.REPLICATE_MODEL ?? 'black-forest-labs/flux-schnell',
      // Overridable so a proxy or a test double can stand in for the real API.
      baseUrl: stripSlash(env.REPLICATE_BASE_URL ?? 'https://api.replicate.com'),
    },
    openai: {
      baseUrl: stripSlash(env.OPENAI_BASE_URL ?? 'https://api.openai.com'),
      key: env.OPENAI_API_KEY ?? '',
      model: env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1',
    },
  }
}

const DEFAULT_NEGATIVE =
  'text, watermark, logo, signature, people, vehicle, perspective, vignette, blurry, frame, border'

function intOr(v, d) {
  const n = Number.parseInt(String(v ?? ''), 10)
  return Number.isFinite(n) ? n : d
}

function floatOr(v, d) {
  const n = Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : d
}

function stripSlash(u) {
  return String(u).replace(/\/+$/, '')
}

// ---------------------------------------------------------- request shaping

/**
 * Validate and normalise the client body.
 *
 * The seed is deliberately never left undefined: when the client omits it we
 * derive one from the prompt+part hash, so the same request keeps producing the
 * same image across restarts. That matches the determinism guarantee the local
 * canvas synthesis already gives the dashboard.
 */
export function normalizeRequest(body) {
  if (!body || typeof body !== 'object') throw new BadRequest('body must be a JSON object')

  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (!prompt) throw new BadRequest('prompt is required')
  if (prompt.length > 4000) throw new BadRequest('prompt is too long')

  const part = typeof body.part === 'string' && body.part.trim() ? body.part.trim().slice(0, 64) : 'unknown'

  let seed = Number(body.seed)
  if (!Number.isFinite(seed)) seed = hashSeed(`${prompt}|${part}`)
  // Keep it inside a range every backend accepts as a 32-bit unsigned int.
  seed = Math.abs(Math.trunc(seed)) % 4294967296

  const width = snapDim(body.width, 512)
  const height = snapDim(body.height, 512)

  let source = null
  if (typeof body.image === 'string' && body.image) {
    source = parseDataUrl(body.image)
    if (!source) throw new BadRequest('image must be a data: URL')
  }

  return { prompt, part, seed, width, height, source }
}

/** Diffusion backends want multiples of 8; clamp to a sane range too. */
function snapDim(v, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(2048, Math.max(64, Math.round(n / 8) * 8))
}

function hashSeed(text) {
  return createHash('sha256').update(text).digest().readUInt32BE(0)
}

/**
 * Wrap the user prompt in texture-specific direction.
 *
 * Image models default to photographs with a subject, a horizon and baked
 * lighting; a game texture needs the opposite. Stating the framing explicitly
 * is far cheaper than trying to correct a hero shot afterwards.
 */
export function buildPrompt(req) {
  const subject = PART_SUBJECT[req.part] ?? 'vehicle body panel'
  return [
    req.prompt,
    `weathered ${subject} surface`,
    'seamless tileable PBR albedo texture',
    'flat even diffuse lighting, no shadows, no highlights',
    'orthographic top-down flat-on view, surface fills the frame',
    'high detail, photoreal material scan',
  ].join(', ')
}

const PART_SUBJECT = {
  'front-fascia': 'truck front fascia',
  hood: 'truck hood',
  roof: 'truck roof',
  'door-fl': 'truck door', 'door-fr': 'truck door',
  'door-rl': 'truck door', 'door-rr': 'truck door',
  'bumper-f': 'steel bumper', 'bumper-r': 'steel bumper',
  bed: 'pickup bed liner',
  'wheel-fl': 'off-road tyre tread', 'wheel-fr': 'off-road tyre tread',
  'wheel-rl': 'off-road tyre tread', 'wheel-rr': 'off-road tyre tread',
  windshield: 'dirty windshield glass',
  'rear-glass': 'dirty glass',
  mirrors: 'plastic mirror housing',
  headlights: 'headlight lens',
  taillights: 'taillight lens',
}

// --------------------------------------------------------------- data URLs

export function parseDataUrl(text) {
  const m = /^data:([\w.+-]+\/[\w.+-]+)?(;charset=[\w-]+)?;base64,([\s\S]+)$/i.exec(text)
  if (!m) return null
  const buf = Buffer.from(m[3], 'base64')
  if (buf.length === 0 || buf.length > MAX_BODY_BYTES) return null
  return { mime: m[1] ?? 'image/png', buf }
}

export function toDataUrl(buf, mime = 'image/png') {
  return `data:${mime};base64,${buf.toString('base64')}`
}

// ------------------------------------------------------------------ errors

export class BadRequest extends Error {
  constructor(message, httpStatus = 400) {
    super(message)
    this.name = 'BadRequest'
    this.httpStatus = httpStatus
  }
}

/** Anything that went wrong talking to the image backend. Always surfaces as 502. */
export class ProviderError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ProviderError'
    this.httpStatus = 502
    this.detail = detail ?? null
  }
}

// ------------------------------------------------------------ http plumbing

/**
 * One outbound request with a hard timeout and a response size cap.
 *
 * Every provider hop goes through here — a hung ComfyUI or a stalled TLS
 * handshake must never pin a socket open forever.
 */
export function httpRequest(target, opts = {}) {
  const { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = opts
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(target)
    } catch {
      reject(new ProviderError(`invalid provider URL: ${target}`))
      return
    }
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(url, { method, headers }, (res) => {
      const chunks = []
      let total = 0
      res.on('data', (c) => {
        total += c.length
        if (total > MAX_RESPONSE_BYTES) {
          res.destroy(new ProviderError('provider response exceeded size cap'))
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      })
      res.on('error', (err) => reject(wrapNetError(err, url)))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy(new ProviderError(`timed out after ${timeoutMs}ms: ${url.host}${url.pathname}`))
    })
    req.on('error', (err) => reject(wrapNetError(err, url)))
    if (body) req.write(body)
    req.end()
  })
}

function wrapNetError(err, url) {
  if (err instanceof ProviderError) return err
  return new ProviderError(`${err.code ?? 'network error'} contacting ${url.host}`, err.message)
}

async function requestJson(target, opts = {}) {
  const res = await httpRequest(target, {
    ...opts,
    headers: { accept: 'application/json', ...(opts.headers ?? {}) },
  })
  const text = res.body.toString('utf8')
  let json = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  if (res.status >= 400) {
    throw new ProviderError(`provider returned HTTP ${res.status}`, truncate(text, 400))
  }
  if (json === null) throw new ProviderError('provider returned non-JSON body', truncate(text, 400))
  return json
}

function postJson(target, payload, opts = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return requestJson(target, {
    ...opts,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.length),
      ...(opts.headers ?? {}),
    },
    body,
  })
}

function truncate(text, n) {
  return text.length > n ? `${text.slice(0, n)}…` : text
}

/** Poll `probe` until it returns a non-null value, or the deadline passes. */
async function pollUntil(probe, { intervalMs, deadline, what }) {
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new ProviderError(`timed out waiting for ${what}`)
    const value = await probe(remaining)
    if (value !== null && value !== undefined) return value
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())))
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------------------------------------------------------------- providers

/**
 * Each adapter takes (req, cfg, deadline) and resolves to
 * {image, meta} — `image` being a data URL or an http(s) URL the browser can
 * load directly — or rejects with a ProviderError.
 */
export const PROVIDERS = {
  echo: echoProvider,
  comfy: comfyProvider,
  replicate: replicateProvider,
  openai: openaiProvider,
}

/** Which env vars must be present for a provider to actually produce an image. */
export function isConfigured(cfg) {
  switch (cfg.provider) {
    case 'comfy': return Boolean(cfg.comfy.url && cfg.comfy.ckpt)
    case 'replicate': return Boolean(cfg.replicate.token)
    case 'openai': return Boolean(cfg.openai.key && cfg.openai.baseUrl)
    // `echo` is a working default, but it never returns an image — reporting it
    // as unconfigured is what lets the dashboard show "local synthesis" honestly.
    default: return false
  }
}

// -- echo ---------------------------------------------------------------

/**
 * The zero-config default: tell the client to synthesise locally.
 *
 * 202 (not 200) with no `image` field is exactly what requestWearTexture()
 * needs — res.ok is true so it does not log an error, and the missing image
 * makes it fall through to its own deterministic canvas path.
 */
async function echoProvider(req, _cfg, _deadline) {
  return {
    status: 202,
    payload: {
      fallback: 'local',
      provider: 'echo',
      part: req.part,
      seed: req.seed,
      reason: 'no image provider configured; set TEXTURE_PROVIDER to comfy, replicate or openai',
    },
  }
}

// -- ComfyUI ------------------------------------------------------------

/**
 * Build the ComfyUI API-format graph.
 *
 * Written in code rather than loaded from a saved workflow.json so checkpoint,
 * steps, cfg and sampler stay env-configurable without anyone hand-editing a
 * 200-line exported graph. Node ids are stable strings because /history keys
 * its outputs by them.
 */
export function buildComfyWorkflow({
  positive, negative, seed, width, height,
  ckpt, steps, cfg, sampler, scheduler, denoise, sourceName,
}) {
  const graph = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: ckpt } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['1', 1] } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['1', 1] } },
    '4': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '5': {
      class_type: 'KSampler',
      inputs: {
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        // txt2img must denoise fully; img2img keeps the photo's structure.
        denoise: sourceName ? denoise : 1,
        model: ['1', 0],
        positive: ['2', 0],
        negative: ['3', 0],
        latent_image: ['4', 0],
      },
    },
    '6': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['1', 2] } },
    '7': { class_type: 'SaveImage', inputs: { filename_prefix: 'mudsim/texture', images: ['6', 0] } },
  }

  if (sourceName) {
    graph['8'] = { class_type: 'LoadImage', inputs: { image: sourceName, upload: 'image' } }
    graph['9'] = { class_type: 'ImageScale', inputs: { upscale_method: 'lanczos', width, height, crop: 'center', image: ['8', 0] } }
    graph['4'] = { class_type: 'VAEEncode', inputs: { pixels: ['9', 0], vae: ['1', 2] } }
  }

  return graph
}

async function comfyProvider(req, cfg, deadline) {
  const c = cfg.comfy
  const clientId = randomUUID()

  let sourceName = null
  if (req.source) sourceName = await comfyUpload(c.url, req.source, deadline)

  const workflow = buildComfyWorkflow({
    positive: buildPrompt(req),
    negative: c.negative,
    seed: req.seed,
    width: req.width,
    height: req.height,
    ckpt: c.ckpt,
    steps: c.steps,
    cfg: c.cfg,
    sampler: c.sampler,
    scheduler: c.scheduler,
    denoise: c.denoise,
    sourceName,
  })

  const queued = await postJson(`${c.url}/prompt`, { prompt: workflow, client_id: clientId }, {
    timeoutMs: remaining(deadline, 30000),
  })
  const promptId = queued?.prompt_id
  if (!promptId) throw new ProviderError('ComfyUI did not return a prompt_id', truncate(JSON.stringify(queued ?? {}), 300))

  // /history stays empty until the job leaves the queue, so a missing entry is
  // "still running", not an error.
  const image = await pollUntil(async (left) => {
    const hist = await requestJson(`${c.url}/history/${encodeURIComponent(promptId)}`, {
      timeoutMs: Math.min(15000, left),
    })
    const entry = hist?.[promptId]
    if (!entry) return null
    const st = entry.status ?? {}
    if (st.status_str === 'error') {
      throw new ProviderError('ComfyUI reported an execution error', truncate(JSON.stringify(st.messages ?? st), 400))
    }
    for (const out of Object.values(entry.outputs ?? {})) {
      const first = out?.images?.[0]
      if (first?.filename) return first
    }
    return null
  }, { intervalMs: 900, deadline, what: 'ComfyUI to finish' })

  const view = new URL(`${c.url}/view`)
  view.searchParams.set('filename', image.filename)
  view.searchParams.set('subfolder', image.subfolder ?? '')
  view.searchParams.set('type', image.type ?? 'output')
  const res = await httpRequest(view.toString(), { timeoutMs: remaining(deadline, 30000) })
  if (res.status !== 200 || res.body.length === 0) {
    throw new ProviderError(`ComfyUI /view returned HTTP ${res.status}`)
  }

  return {
    status: 200,
    payload: {
      image: toDataUrl(res.body, String(res.headers['content-type'] ?? 'image/png').split(';')[0]),
      provider: 'comfy',
      seed: req.seed,
    },
  }
}

/**
 * Push the source photo into ComfyUI's input folder.
 *
 * LoadImage can only reference a filename on the server, so img2img needs a
 * real multipart upload first. Hand-rolled because the whole service is
 * dependency-free and the payload shape is trivial.
 */
async function comfyUpload(baseUrl, source, deadline) {
  const ext = source.mime.includes('jpeg') ? 'jpg' : source.mime.includes('webp') ? 'webp' : 'png'
  const name = `mudsim-${randomUUID()}.${ext}`
  const boundary = `----mudsim${randomUUID().replace(/-/g, '')}`
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="image"; filename="${name}"\r\n` +
    `Content-Type: ${source.mime}\r\n\r\n`,
    'utf8',
  )
  const tail = Buffer.from(
    `\r\n--${boundary}\r\n` +
    'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n' +
    `--${boundary}--\r\n`,
    'utf8',
  )
  const body = Buffer.concat([head, source.buf, tail])

  const json = await requestJson(`${baseUrl}/upload/image`, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    body,
    timeoutMs: remaining(deadline, 60000),
  })
  // Comfy echoes the stored name, which may differ if it de-duplicated.
  return json?.name ?? name
}

// -- Replicate ----------------------------------------------------------

async function replicateProvider(req, cfg, deadline) {
  const { token, model, baseUrl } = cfg.replicate
  if (!token) throw new ProviderError('REPLICATE_API_TOKEN is not set')

  const headers = { authorization: `Token ${token}` }
  const input = {
    prompt: buildPrompt(req),
    width: req.width,
    height: req.height,
    seed: req.seed,
    num_outputs: 1,
    // Harmless on models that ignore it, and correct on the SD-family ones.
    disable_safety_checker: false,
  }
  if (req.source) input.image = toDataUrl(req.source.buf, req.source.mime)

  // Three accepted spellings of REPLICATE_MODEL: "owner/name" (latest version),
  // "owner/name:version" and a bare 64-char version id.
  let created
  if (/^[0-9a-f]{64}$/i.test(model)) {
    created = await postJson(`${baseUrl}/v1/predictions`, { version: model, input }, {
      headers, timeoutMs: remaining(deadline, 30000),
    })
  } else if (model.includes(':')) {
    const version = model.slice(model.indexOf(':') + 1)
    created = await postJson(`${baseUrl}/v1/predictions`, { version, input }, {
      headers, timeoutMs: remaining(deadline, 30000),
    })
  } else {
    const path = model.split('/').map(encodeURIComponent).join('/')
    created = await postJson(`${baseUrl}/v1/models/${path}/predictions`, { input }, {
      headers, timeoutMs: remaining(deadline, 30000),
    })
  }

  const statusUrl = created?.urls?.get
  if (!statusUrl) throw new ProviderError('Replicate did not return a status URL', truncate(JSON.stringify(created ?? {}), 300))

  const done = await pollUntil(async (left) => {
    const p = await requestJson(statusUrl, { headers, timeoutMs: Math.min(15000, left) })
    if (p?.status === 'succeeded') return p
    if (p?.status === 'failed' || p?.status === 'canceled') {
      throw new ProviderError(`Replicate prediction ${p.status}`, truncate(String(p.error ?? ''), 400))
    }
    return null
  }, { intervalMs: 1200, deadline, what: 'Replicate prediction' })

  const url = firstUrl(done.output)
  if (!url) throw new ProviderError('Replicate returned no image output', truncate(JSON.stringify(done.output ?? null), 300))

  // Returned as an https URL: the browser loads it directly, which keeps a
  // multi-megabyte base64 round-trip out of the dashboard's JSON.
  return { status: 200, payload: { image: url, provider: 'replicate', seed: req.seed } }
}

function firstUrl(output) {
  if (typeof output === 'string') return output.startsWith('http') ? output : null
  if (Array.isArray(output)) {
    for (const item of output) {
      const u = firstUrl(item)
      if (u) return u
    }
  }
  if (output && typeof output === 'object') return firstUrl(output.url ?? output.image ?? null)
  return null
}

// -- OpenAI-compatible ---------------------------------------------------

async function openaiProvider(req, cfg, deadline) {
  const { baseUrl, key, model } = cfg.openai
  if (!key) throw new ProviderError('OPENAI_API_KEY is not set')

  // Accept a base URL with or without the /v1 suffix — both spellings are
  // common in the wild for self-hosted compatible servers.
  const root = /\/v\d+$/.test(baseUrl) ? baseUrl : `${baseUrl}/v1`

  const json = await postJson(`${root}/images/generations`, {
    model,
    prompt: buildPrompt(req),
    n: 1,
    size: `${req.width}x${req.height}`,
    response_format: 'b64_json',
  }, {
    headers: { authorization: `Bearer ${key}` },
    timeoutMs: remaining(deadline, cfg.timeoutMs),
  })

  const first = json?.data?.[0]
  if (first?.b64_json) {
    return {
      status: 200,
      payload: { image: toDataUrl(Buffer.from(first.b64_json, 'base64')), provider: 'openai', seed: req.seed },
    }
  }
  if (typeof first?.url === 'string') {
    return { status: 200, payload: { image: first.url, provider: 'openai', seed: req.seed } }
  }
  throw new ProviderError('image endpoint returned no b64_json or url', truncate(JSON.stringify(json ?? {}), 300))
}

function remaining(deadline, cap) {
  return Math.max(1000, Math.min(cap, deadline - Date.now()))
}

// ---------------------------------------------------------------- generate

/** Run one generation end to end. Always resolves or throws a typed error. */
export async function generate(body, cfg) {
  const req = normalizeRequest(body)
  const adapter = PROVIDERS[cfg.provider] ?? PROVIDERS.echo
  const deadline = Date.now() + cfg.timeoutMs
  return adapter(req, cfg, deadline)
}

// ------------------------------------------------------------------ server

function corsHeaders(cfg) {
  return {
    'access-control-allow-origin': cfg.allowOrigin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  }
}

function sendJson(res, cfg, status, payload) {
  if (res.writableEnded) return
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...corsHeaders(cfg),
  })
  res.end(body)
}

/** Read the body with a hard byte cap, rejecting oversized uploads mid-stream. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let settled = false
    req.on('data', (c) => {
      if (settled) return
      total += c.length
      if (total > MAX_BODY_BYTES) {
        settled = true
        reject(new BadRequest(`request body exceeds ${MAX_BODY_BYTES} bytes`, 413))
        // Drain rather than destroy so the client still receives our 413.
        req.resume()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks))
      }
    })
    req.on('error', (err) => {
      if (!settled) {
        settled = true
        reject(err)
      }
    })
  })
}

async function readJsonBody(req) {
  const buf = await readBody(req)
  if (buf.length === 0) return {}
  try {
    return JSON.parse(buf.toString('utf8'))
  } catch {
    throw new BadRequest('body is not valid JSON')
  }
}

/**
 * PBR channel derivation is a client-side job, on purpose.
 *
 * src/engine/photo/pbr.ts already derives height, normal, roughness and AO from
 * an albedo with pure functions over plain RGBA buffers. Duplicating that here
 * would mean either a second, drifting implementation or shelling out to an
 * image tool — so this endpoint honestly reports 501 and points at the real
 * implementation instead of returning something fake.
 */
function handlePbr(res, cfg) {
  sendJson(res, cfg, 501, {
    error: 'not implemented on the server',
    reason:
      'PBR channels are derived client-side by derivePbr() in src/engine/photo/pbr.ts, ' +
      'which runs on the same RGBA buffers in the browser, a worker or Node. ' +
      'This service only produces the albedo.',
    hint: "import { derivePbr } from 'src/engine/photo/pbr'",
  })
}

function log(evt, fields) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), evt, ...fields }))
}

export function createTextureServer(cfg = loadConfig()) {
  const server = http.createServer((req, res) => {
    handle(req, res, cfg).catch((err) => {
      // Last-resort net: a handler bug must not kill the process.
      log('handler.crash', { message: String(err?.message ?? err) })
      sendJson(res, cfg, 500, { error: 'internal error' })
    })
  })

  // A malformed request line would otherwise emit an unhandled 'clientError'.
  server.on('clientError', (err, socket) => {
    log('client.error', { message: err.message })
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  return server
}

async function handle(req, res, cfg) {
  const started = Date.now()
  const id = randomUUID().slice(0, 8)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const route = url.pathname.replace(/\/+$/, '') || '/'

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(cfg))
    res.end()
    return
  }

  if (req.method === 'GET' && (route === '/health' || route === '/')) {
    sendJson(res, cfg, 200, { ok: true, provider: cfg.provider, configured: isConfigured(cfg) })
    return
  }

  if (req.method === 'POST' && route === '/pbr') {
    // Still drain the body so the socket can be reused.
    await readBody(req).catch(() => null)
    handlePbr(res, cfg)
    log('pbr', { id, outcome: 'not-implemented', ms: Date.now() - started })
    return
  }

  if (req.method === 'POST' && (route === '/generate' || route === '/')) {
    let part = 'unknown'
    try {
      const body = await readJsonBody(req)
      if (body && typeof body.part === 'string') part = body.part
      const result = await generate(body, cfg)
      sendJson(res, cfg, result.status, result.payload)
      log('generate', {
        id,
        provider: cfg.provider,
        part,
        ms: Date.now() - started,
        outcome: result.status === 200 ? 'ok' : 'fallback',
        status: result.status,
      })
    } catch (err) {
      const status = err?.httpStatus ?? 502
      sendJson(res, cfg, status, {
        error: err?.message ?? 'generation failed',
        detail: err?.detail ?? null,
        provider: cfg.provider,
      })
      log('generate', {
        id,
        provider: cfg.provider,
        part,
        ms: Date.now() - started,
        outcome: status < 500 ? 'bad-request' : 'provider-error',
        status,
        message: String(err?.message ?? err),
      })
    }
    return
  }

  sendJson(res, cfg, 404, { error: `no route for ${req.method} ${route}` })
}

export function start(cfg = loadConfig()) {
  const server = createTextureServer(cfg)

  server.listen(cfg.port, cfg.host, () => {
    log('listen', {
      host: cfg.host,
      port: cfg.port,
      provider: cfg.provider,
      configured: isConfigured(cfg),
      endpoint: `http://${cfg.host}:${cfg.port}/generate`,
    })
    if (cfg.providerRequested !== cfg.provider) {
      log('config.warn', { requested: cfg.providerRequested, using: cfg.provider, reason: 'unknown provider' })
    }
  })

  server.on('error', (err) => {
    log('listen.error', { message: err.message, code: err.code ?? null })
    process.exitCode = 1
  })

  const shutdown = (signal) => {
    log('shutdown', { signal })
    server.close(() => process.exit(0))
    // Don't wait forever on keep-alive sockets.
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // A dead provider or a socket reset must never take the service down; log and
  // keep serving so the dashboard just sees a clean 502 on the next call.
  process.on('uncaughtException', (err) => log('uncaught', { message: String(err?.message ?? err) }))
  process.on('unhandledRejection', (err) => log('unhandled', { message: String(err?.message ?? err) }))

  return server
}

// Only auto-start when executed directly, so tests can import the adapters.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) start()

/**
 * Image generation against the local "magpie" OpenAI-compatible gateway.
 *
 * The gateway answers POST /v1/images/generations with base64 pictures; this
 * module owns the whole trip: reading the gateway config, calling the endpoint,
 * validating the response, and writing each picture into the open project.
 * Credentials never leave this module in an error message or a log line.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { GeneratedImage, ImageGenerationRequest } from '@shared/types'
import {
  DEFAULT_IMAGE_OUTPUT_DIR,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE
} from '@shared/types'

export interface MagpieImageConfig {
  baseUrl: string
  apiKey: string
}

export const DEFAULT_IMAGE_BASE_URL = 'http://127.0.0.1:3425/v1'
export const DEFAULT_IMAGE_API_KEY = 'magpie'
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
export const MAX_IMAGE_COUNT = 4

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const OUTPUT_DIR_ERROR = 'Image output directory must stay inside the project'

interface OutputDirectoryTarget {
  base: string
  target: string
}

/**
 * Turn a prompt into a safe, compact filename stem. Only ASCII letters/digits,
 * CJK, '-' and '_' survive, so the result can never carry a path separator or
 * a '..' traversal segment.
 */
export function sanitiseImageName(prompt: string): string {
  const name = String(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return name || 'image'
}

export function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/png':
      return 'png'
    case 'image/jpeg':
      return 'jpg'
    case 'image/webp':
      return 'webp'
    default:
      throw new Error(`Unsupported image type: ${mimeType}`)
  }
}

export function imageFileName(
  prompt: string,
  index: number,
  mimeType: string,
  now: number = Date.now()
): string {
  const ext = extensionForMime(mimeType)
  const random = randomBytes(3).toString('hex')
  return `${sanitiseImageName(prompt)}-${now}-${index + 1}-${random}.${ext}`
}

/** Validate and decode the gateway's `data` array into image buffers. */
export function parseImageResponse(payload: unknown): { data: Buffer; mimeType: string }[] {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Image generation returned an invalid response')
  }
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Image generation returned no images')
  }

  const images: { data: Buffer; mimeType: string }[] = []
  for (const raw of data.slice(0, MAX_IMAGE_COUNT)) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('Image generation returned an invalid image entry')
    }
    const entry = raw as { b64_json?: unknown; mime_type?: unknown }
    if (typeof entry.b64_json !== 'string' || entry.b64_json.length === 0) {
      throw new Error('Image generation returned an empty image')
    }
    const mimeType =
      typeof entry.mime_type === 'string' && entry.mime_type ? entry.mime_type : 'image/png'
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new Error(`Unsupported image type: ${mimeType}`)
    }
    const buffer = Buffer.from(entry.b64_json, 'base64')
    if (buffer.length === 0) {
      throw new Error('Image generation returned an empty image')
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw new Error('Image generation returned an image that is too large')
    }
    images.push({ data: buffer, mimeType })
  }
  return images
}

/** Read the width/height from a PNG's IHDR header, or undefined for anything else. */
export function pngDimensions(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/**
 * Resolve a workspace-relative output directory and create it. Absolute paths,
 * '..' segments and real-path escapes above the project root are rejected
 * before any directory is made. Mirrors `isPathWithin` in ipc.ts.
 */
function outputDirectoryTarget(root: string, outputDir: string): OutputDirectoryTarget {
  if (typeof outputDir !== 'string' || !outputDir.trim()) {
    throw new Error('Image output directory is required')
  }
  const segments = outputDir.split(/[/\\]+/).filter(Boolean)
  if (path.isAbsolute(outputDir) || /^[A-Za-z]:/.test(outputDir) || segments.includes('..')) {
    throw new Error(OUTPUT_DIR_ERROR)
  }
  const base = path.resolve(root)
  const target = path.resolve(base, outputDir)
  const relative = path.relative(base, target)
  const inside =
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  if (!inside) throw new Error(OUTPUT_DIR_ERROR)

  return { base, target }
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function realProjectRoot(base: string): string {
  try {
    const resolved = realpathSync(base)
    if (!statSync(resolved).isDirectory()) throw new Error(OUTPUT_DIR_ERROR)
    return resolved
  } catch {
    throw new Error(OUTPUT_DIR_ERROR)
  }
}

/** Create the directory one component at a time, checking its real path at each step. */
function ensureOutputDirectory(
  { base, target }: OutputDirectoryTarget,
  expectedRoot: string
): string {
  if (!isWithin(base, target) || !isWithin(expectedRoot, realProjectRoot(base))) {
    throw new Error(OUTPUT_DIR_ERROR)
  }

  const relative = path.relative(base, target)
  let current = base
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    const parent = current
    current = path.join(current, segment)

    let resolved: string
    try {
      resolved = realpathSync(current)
    } catch {
      if (!isWithin(expectedRoot, realProjectRoot(parent))) throw new Error(OUTPUT_DIR_ERROR)
      try {
        mkdirSync(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      try {
        resolved = realpathSync(current)
      } catch {
        throw new Error(OUTPUT_DIR_ERROR)
      }
    }

    if (!isWithin(expectedRoot, resolved)) throw new Error(OUTPUT_DIR_ERROR)
    try {
      if (!statSync(resolved).isDirectory()) throw new Error(OUTPUT_DIR_ERROR)
    } catch {
      throw new Error(OUTPUT_DIR_ERROR)
    }
  }

  if (!isWithin(expectedRoot, realProjectRoot(base))) throw new Error(OUTPUT_DIR_ERROR)
  return target
}

export function resolveOutputDirectory(root: string, outputDir: string): string {
  const paths = outputDirectoryTarget(root, outputDir)
  return ensureOutputDirectory(paths, realProjectRoot(paths.base))
}

/**
 * Read the magpie provider's baseUrl/apiKey from models.json. Any missing,
 * unreadable or invalid value falls back to the local defaults, and this never
 * throws or logs the key.
 */
export async function readMagpieImageConfig(modelsFile?: string): Promise<MagpieImageConfig> {
  const fallback: MagpieImageConfig = {
    baseUrl: DEFAULT_IMAGE_BASE_URL,
    apiKey: DEFAULT_IMAGE_API_KEY
  }
  try {
    const agentDir =
      process.env.PI_CODING_AGENT_DIR?.trim() || path.join(homedir(), '.pi', 'agent')
    const file = modelsFile || path.join(agentDir, 'models.json')
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return fallback
    const providers = (parsed as { providers?: unknown }).providers
    if (!providers || typeof providers !== 'object') return fallback
    const magpie = (providers as Record<string, unknown>).magpie
    if (!magpie || typeof magpie !== 'object') return fallback

    let baseUrl = fallback.baseUrl
    const rawBase = (magpie as { baseUrl?: unknown }).baseUrl
    if (typeof rawBase === 'string' && rawBase.trim()) {
      const stripped = rawBase.trim().replace(/\/+$/, '')
      try {
        const url = new URL(stripped)
        if (url.protocol === 'http:' || url.protocol === 'https:') baseUrl = stripped
      } catch {
        // Not a usable URL: keep the default.
      }
    }
    const rawKey = (magpie as { apiKey?: unknown }).apiKey
    const apiKey = typeof rawKey === 'string' && rawKey ? rawKey : fallback.apiKey
    return { baseUrl, apiKey }
  } catch {
    return fallback
  }
}

/**
 * Generate pictures from a prompt and write them into the project folder.
 * The gateway config and fetch can be injected for tests; network failures are
 * surfaced as short, clean messages that never carry the API key.
 */
export async function generateImages(
  request: ImageGenerationRequest,
  root: string,
  options: {
    config?: MagpieImageConfig
    fetchImpl?: typeof globalThis.fetch
    now?: number
  } = {}
): Promise<GeneratedImage[]> {
  const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : ''
  if (!prompt) throw new Error('Image prompt is required')
  if (prompt.length > 4000) throw new Error('Image prompt is too long')

  const requestedCount =
    typeof request.n === 'number' && Number.isFinite(request.n) ? Math.trunc(request.n) : 1
  const n = Math.min(MAX_IMAGE_COUNT, Math.max(1, requestedCount))
  const size = typeof request.size === 'string' && request.size ? request.size : DEFAULT_IMAGE_SIZE
  const quality =
    typeof request.quality === 'string' && request.quality ? request.quality : DEFAULT_IMAGE_QUALITY
  const outputDir =
    typeof request.outputDir === 'string' && request.outputDir
      ? request.outputDir
      : DEFAULT_IMAGE_OUTPUT_DIR
  const outputPaths = outputDirectoryTarget(root, outputDir)
  const expectedRoot = realProjectRoot(outputPaths.base)

  const config = options.config ?? (await readMagpieImageConfig())
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const now = options.now ?? Date.now()
  const model = typeof request.model === 'string' ? request.model.trim() : ''

  const body: Record<string, unknown> = {
    prompt,
    n,
    size,
    quality,
    response_format: 'b64_json'
  }
  if (model) body.model = model

  const url = `${config.baseUrl.replace(/\/+$/, '')}/images/generations`
  let response: Awaited<ReturnType<typeof globalThis.fetch>>
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000)
    })
  } catch {
    throw new Error('Image generation request failed')
  }

  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 500)
    } catch {
      // Ignore a body that cannot be read; the status alone is enough.
    }
    // Redact the key in case a gateway echoes the header back in its error body.
    const safeDetail = config.apiKey ? detail.split(config.apiKey).join('[redacted]') : detail
    throw new Error(`Image generation failed (HTTP ${response.status}): ${safeDetail}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('Image generation returned an invalid response')
  }

  const images = parseImageResponse(payload)
  let dir = ensureOutputDirectory(outputPaths, expectedRoot)
  const responseModel =
    payload && typeof payload === 'object' && typeof (payload as { model?: unknown }).model === 'string'
      ? (payload as { model: string }).model
      : ''
  const effectiveModel = responseModel || model

  const generated: GeneratedImage[] = []
  for (let i = 0; i < images.length; i += 1) {
    const { data, mimeType } = images[i]
    let name = imageFileName(prompt, i, mimeType, now)
    dir = ensureOutputDirectory(outputPaths, expectedRoot)
    let target = path.join(dir, name)
    try {
      writeFileSync(target, data, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      name = imageFileName(prompt, i, mimeType, now)
      dir = ensureOutputDirectory(outputPaths, expectedRoot)
      target = path.join(dir, name)
      writeFileSync(target, data, { flag: 'wx' })
    }

    const dimensions = pngDimensions(data)
    const image: GeneratedImage = {
      path: target,
      name,
      mimeType,
      size: data.length,
      prompt,
      createdAt: now
    }
    if (dimensions) {
      image.width = dimensions.width
      image.height = dimensions.height
    }
    if (effectiveModel) image.model = effectiveModel
    generated.push(image)
  }
  return generated
}

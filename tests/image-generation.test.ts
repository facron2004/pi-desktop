import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  DEFAULT_IMAGE_API_KEY,
  DEFAULT_IMAGE_BASE_URL,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  extensionForMime,
  generateImages,
  imageFileName,
  parseImageResponse,
  pngDimensions,
  readMagpieImageConfig,
  resolveOutputDirectory,
  sanitiseImageName
} from '../src/main/image-generation'

/** A 24-byte PNG header: signature + IHDR length/type + width(2)/height(3). */
const PNG_HEADER = Buffer.alloc(24)
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(PNG_HEADER, 0)
PNG_HEADER.writeUInt32BE(13, 8)
PNG_HEADER.write('IHDR', 12, 'ascii')
PNG_HEADER.writeUInt32BE(2, 16)
PNG_HEADER.writeUInt32BE(3, 20)
const PNG_B64 = PNG_HEADER.toString('base64')

const CONFIG = { baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'magpie' }

function reply(payload: unknown, init: { status?: number; text?: string } = {}) {
  const status = init.status ?? 200
  if (status >= 400 || init.text !== undefined) {
    return new Response(init.text ?? '', { status })
  }
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('sanitiseImageName strips separators/traversal and falls back to image', () => {
  const name = sanitiseImageName('A Small ../../etc/passwd 图片_01!.PNG')
  assert.ok(!/[\\/]/.test(name), 'no path separators')
  assert.ok(!name.includes('..'), 'no traversal dots')
  assert.match(name, /^[a-z0-9\u4e00-\u9fff_-]+$/)
  assert.ok(name.length <= 48)
  assert.equal(sanitiseImageName('!!!'), 'image')
  assert.equal(sanitiseImageName('...'), 'image')
  assert.equal(sanitiseImageName(''), 'image')
  assert.equal(sanitiseImageName('中文 名字'), '中文-名字')
})

test('extensionForMime whitelists the three supported types', () => {
  assert.equal(extensionForMime('image/png'), 'png')
  assert.equal(extensionForMime('image/jpeg'), 'jpg')
  assert.equal(extensionForMime('image/webp'), 'webp')
  assert.throws(() => extensionForMime('image/gif'), /Unsupported image type: image\/gif/)
  assert.throws(() => extensionForMime('application/pdf'), /Unsupported image type/)
})

test('imageFileName has no separators and the right extension', () => {
  const name = imageFileName('A/B C', 0, 'image/jpeg', 1234567890)
  assert.ok(!/[\\/]/.test(name))
  assert.ok(name.endsWith('.jpg'))
  assert.ok(name.includes('-1234567890-1-'))
  assert.match(name, /-1-[0-9a-f]{6}\.jpg$/)

  const traversal = imageFileName('../../etc', 2, 'image/png', 1)
  assert.ok(!/[\\/]/.test(traversal))
  assert.ok(!traversal.includes('..'))
  assert.ok(traversal.endsWith('.png'))
  assert.ok(traversal.includes('-1-3-'))
})

test('parseImageResponse decodes a tiny PNG and defaults the mime type', () => {
  const images = parseImageResponse({ data: [{ b64_json: PNG_B64 }] })
  assert.equal(images.length, 1)
  assert.equal(images[0].mimeType, 'image/png')
  assert.ok(images[0].data.equals(PNG_HEADER))

  const webp = parseImageResponse({ data: [{ b64_json: PNG_B64, mime_type: 'image/webp' }] })
  assert.equal(webp[0].mimeType, 'image/webp')
})

test('parseImageResponse rejects missing or empty data', () => {
  assert.throws(() => parseImageResponse(null), /invalid response/)
  assert.throws(() => parseImageResponse({}), /no images/)
  assert.throws(() => parseImageResponse({ data: [] }), /no images/)
  assert.throws(() => parseImageResponse({ data: [{}] }), /empty image/)
  assert.throws(() => parseImageResponse({ data: [{ b64_json: '' }] }), /empty image/)
  assert.throws(() => parseImageResponse({ data: [null] }), /invalid image entry/)
})

test('parseImageResponse rejects an unsupported mime type', () => {
  assert.throws(
    () => parseImageResponse({ data: [{ b64_json: PNG_B64, mime_type: 'image/gif' }] }),
    /Unsupported image type: image\/gif/
  )
})

test('parseImageResponse rejects an oversized decoded image', () => {
  const big = Buffer.alloc(MAX_IMAGE_BYTES + 1, 1).toString('base64')
  assert.throws(
    () => parseImageResponse({ data: [{ b64_json: big }] }),
    /too large/
  )
})

test('parseImageResponse takes at most MAX_IMAGE_COUNT entries', () => {
  const entries = Array.from({ length: MAX_IMAGE_COUNT + 3 }, () => ({ b64_json: PNG_B64 }))
  const images = parseImageResponse({ data: entries })
  assert.equal(images.length, MAX_IMAGE_COUNT)
})

test('pngDimensions reads width/height from a real PNG header', () => {
  assert.deepEqual(pngDimensions(PNG_HEADER), { width: 2, height: 3 })
  assert.equal(pngDimensions(Buffer.from('not a png at all')), undefined)
  assert.equal(pngDimensions(PNG_HEADER.subarray(0, 20)), undefined)
  const badSignature = Buffer.from(PNG_HEADER)
  badSignature[0] = 0
  assert.equal(pngDimensions(badSignature), undefined)
})

test('resolveOutputDirectory rejects escapes and creates a dir inside the root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-img-root-'))
  try {
    assert.throws(() => resolveOutputDirectory(root, ''), /required/)
    assert.throws(() => resolveOutputDirectory(root, '../escape'), /must stay inside the project/)
    assert.throws(() => resolveOutputDirectory(root, 'a/../b'), /must stay inside the project/)
    assert.throws(() => resolveOutputDirectory(root, '/etc/absolute'), /must stay inside the project/)
    assert.throws(() => resolveOutputDirectory(root, 'C:\\Windows'), /must stay inside the project/)

    const dir = resolveOutputDirectory(root, 'output/generated')
    assert.equal(dir, path.join(root, 'output', 'generated'))
    assert.ok(path.isAbsolute(dir))
    assert.ok(existsSync(dir))
    const relative = path.relative(path.resolve(root), dir)
    assert.ok(relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveOutputDirectory rejects an existing output link that escapes the project', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-img-link-'))
  const root = path.join(parent, 'project')
  const outside = path.join(parent, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  symlinkSync(outside, path.join(root, 'output'), process.platform === 'win32' ? 'junction' : 'dir')
  try {
    assert.throws(() => resolveOutputDirectory(root, 'output/generated'), /must stay inside the project/)
    assert.deepEqual(readdirSync(outside), [], 'resolving an escaped output must not create folders outside the project')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('readMagpieImageConfig reads magpie and falls back cleanly', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-img-cfg-'))
  try {
    const file = path.join(dir, 'models.json')
    writeFileSync(
      file,
      JSON.stringify({ providers: { magpie: { baseUrl: 'http://127.0.0.1:9999/v1/', apiKey: 'secret-key' } } })
    )
    const config = await readMagpieImageConfig(file)
    assert.equal(config.baseUrl, 'http://127.0.0.1:9999/v1', 'trailing slash stripped')
    assert.equal(config.apiKey, 'secret-key')

    // An unsupported protocol falls back while a still-valid key is kept.
    writeFileSync(file, JSON.stringify({ providers: { magpie: { baseUrl: 'ftp://host', apiKey: 'x' } } }))
    const badUrl = await readMagpieImageConfig(file)
    assert.equal(badUrl.baseUrl, DEFAULT_IMAGE_BASE_URL)
    assert.equal(badUrl.apiKey, 'x')

    // A missing/unreadable/malformed file falls back to both defaults and never throws.
    const missing = await readMagpieImageConfig(path.join(dir, 'nope.json'))
    assert.deepEqual(missing, { baseUrl: DEFAULT_IMAGE_BASE_URL, apiKey: DEFAULT_IMAGE_API_KEY })

    writeFileSync(file, '{ not json')
    const malformed = await readMagpieImageConfig(file)
    assert.deepEqual(malformed, { baseUrl: DEFAULT_IMAGE_BASE_URL, apiKey: DEFAULT_IMAGE_API_KEY })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('generateImages writes one picture into the project and returns its metadata', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-img-gen-'))
  const payload = {
    created: 1,
    data: [{ b64_json: PNG_B64, mime_type: 'image/png' }],
    model: 'codex/gpt-image-2'
  }
  let capturedUrl = ''
  let capturedInit: Record<string, unknown> = {}
  const fetchImpl = (async (input: unknown, init?: Record<string, unknown>) => {
    capturedUrl = String(input)
    capturedInit = init ?? {}
    return reply(payload)
  }) as unknown as typeof globalThis.fetch

  try {
    const results = await generateImages(
      { prompt: '  a small red circle  ', n: 1 },
      root,
      { config: CONFIG, fetchImpl, now: 1700000000000 }
    )
    assert.equal(results.length, 1)
    const image = results[0]
    assert.equal(image.mimeType, 'image/png')
    assert.ok(image.name.endsWith('.png'))
    assert.equal(image.name, path.basename(image.path))
    assert.ok(path.isAbsolute(image.path))
    assert.ok(image.path.startsWith(root))
    assert.equal(image.size, PNG_HEADER.length)
    assert.equal(image.width, 2)
    assert.equal(image.height, 3)
    assert.equal(image.model, 'codex/gpt-image-2')
    assert.equal(image.prompt, 'a small red circle')
    assert.equal(image.createdAt, 1700000000000)

    const outDir = path.join(root, 'output', 'generated')
    const files = readdirSync(outDir)
    assert.equal(files.length, 1, 'exactly one file in output/generated')
    assert.equal(files[0], image.name)
    assert.ok(readFileSync(path.join(outDir, files[0])).equals(PNG_HEADER))

    assert.equal(capturedUrl, 'http://127.0.0.1:3425/v1/images/generations')
    assert.equal(capturedInit.method, 'POST')
    const headers = capturedInit.headers as Record<string, string>
    assert.equal(headers['Content-Type'], 'application/json')
    assert.equal(headers.Authorization, 'Bearer magpie')
    const body = JSON.parse(String(capturedInit.body))
    assert.equal(body.prompt, 'a small red circle')
    assert.equal(body.n, 1)
    assert.equal(body.size, '1024x1024')
    assert.equal(body.quality, 'auto')
    assert.equal(body.response_format, 'b64_json')
    assert.equal(body.model, undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generateImages rechecks the output directory after the gateway response', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-img-race-'))
  const root = path.join(parent, 'project')
  const outside = path.join(parent, 'outside')
  const output = path.join(root, 'output')
  mkdirSync(path.join(output, 'generated'), { recursive: true })
  mkdirSync(outside)
  let finishFetch!: (response: Response) => void
  let notifyFetchStarted!: () => void
  const fetchStarted = new Promise<void>((resolve) => { notifyFetchStarted = resolve })
  const fetchImpl = (() => {
    notifyFetchStarted()
    return new Promise<Response>((resolve) => { finishFetch = resolve })
  }) as unknown as typeof globalThis.fetch

  try {
    const pending = generateImages({ prompt: 'circle' }, root, { config: CONFIG, fetchImpl })
    await fetchStarted
    rmSync(output, { recursive: true, force: true })
    symlinkSync(outside, output, process.platform === 'win32' ? 'junction' : 'dir')
    finishFetch(reply({ data: [{ b64_json: PNG_B64 }] }))

    await assert.rejects(pending, /must stay inside the project/)
    assert.deepEqual(readdirSync(outside), [], 'the response must not be written through a replaced output link')
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('generateImages validates the prompt before doing any work', async () => {
  let called = false
  const fetchImpl = (async () => {
    called = true
    return reply({ data: [{ b64_json: PNG_B64 }] })
  }) as unknown as typeof globalThis.fetch

  await assert.rejects(
    () => generateImages({ prompt: '   ' }, '.', { config: CONFIG, fetchImpl }),
    /Image prompt is required/
  )
  await assert.rejects(
    () => generateImages({ prompt: 'x'.repeat(4001) }, '.', { config: CONFIG, fetchImpl }),
    /Image prompt is too long/
  )
  assert.equal(called, false)
})

test('generateImages wraps network failures without leaking the key', async () => {
  const fetchImpl = (async () => {
    throw new Error(`connect ECONNREFUSED with bearer super-secret-key`)
  }) as unknown as typeof globalThis.fetch

  await assert.rejects(
    () =>
      generateImages({ prompt: 'circle' }, '.', {
        config: { baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'super-secret-key' },
        fetchImpl
      }),
    (error: Error) => {
      assert.equal(error.message, 'Image generation request failed')
      assert.ok(!error.message.includes('super-secret-key'))
      return true
    }
  )
})

test('generateImages reports HTTP status and redacts a key echoed in the body', async () => {
  const fetchImpl = (async () =>
    reply({}, { status: 503, text: 'gateway rejected super-secret-key' })) as unknown as typeof globalThis.fetch

  await assert.rejects(
    () =>
      generateImages({ prompt: 'circle' }, '.', {
        config: { baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'super-secret-key' },
        fetchImpl
      }),
    (error: Error) => {
      assert.match(error.message, /HTTP 503/)
      assert.ok(!error.message.includes('super-secret-key'))
      assert.match(error.message, /\[redacted\]/)
      return true
    }
  )
})

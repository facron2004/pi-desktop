import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { imageToolExtension } from '../src/main/pi/image-tool'

type Tool = {
  name: string
  label?: string
  defaultActive?: boolean
  annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean; openWorldHint?: boolean }
  parameters?: unknown
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
}

// Kept inside the repo so a dynamic `import` can resolve `typebox` the same
// way Pi will. Cleaned up after the whole file finishes.
const dir = mkdtempSync(path.join(process.cwd(), '.tmp-image-tool-test-'))
const extensionFile = path.join(dir, 'image-tool-extension.mjs')
writeFileSync(extensionFile, imageToolExtension(), 'utf8')
after(() => rmSync(dir, { recursive: true, force: true }))

async function loadTool(): Promise<Tool> {
  const module = (await import(pathToFileURL(extensionFile).href)) as {
    default: (pi: { registerTool: (tool: Tool) => void }) => void
  }
  let tool: Tool | undefined
  module.default({ registerTool: (definition) => { tool = definition } })
  assert.ok(tool)
  return tool
}

test('the generated source advertises the gateway contract without leaking the key', () => {
  const source = imageToolExtension()
  assert.ok(source.includes("name: 'generate_image'"))
  assert.ok(source.includes('response_format'))
  assert.ok(source.includes('/images/generations'))
  assert.ok(source.includes('output/generated'))
  assert.ok(source.includes("type: 'image'"))
  assert.ok(source.includes('AbortSignal.timeout'))
  // The key must be read from models.json at runtime, never hard-coded.
  assert.equal(source.includes('readline'), false)
  assert.equal(source.includes('Bearer magpie'), false)
  assert.ok(source.includes('models.json'))
  assert.ok(source.includes('PI_CODING_AGENT_DIR'))
})

test('the tool name is present exactly once', () => {
  const source = imageToolExtension()
  assert.equal((source.match(/generate_image/g) ?? []).length, 1)
})

test('the generated extension is loadable JavaScript (ESM syntax check)', () => {
  // `new Function` cannot parse ESM and a dynamic import may fail to resolve
  // typebox here, so validate the module the same way node parses it.
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-image-tool-syntax-'))
  const file = path.join(directory, 'image-tool-extension.mjs')
  try {
    writeFileSync(file, imageToolExtension(), 'utf8')
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('the generated extension registers one active image tool', async () => {
  const tool = await loadTool()
  assert.equal(tool.name, 'generate_image')
  assert.equal(tool.label, 'Generate image')
  assert.equal(tool.defaultActive, true)
  assert.deepEqual(tool.annotations, { destructiveHint: false, readOnlyHint: false, openWorldHint: true })
  assert.ok(tool.parameters)
})

// A 1x1 PNG: enough to prove the whole decode → write → inline-image path
// without spending a generation or depending on the local gateway.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

test('generate_image writes a decoded picture into the project and returns it inline', async () => {
  const tool = await loadTool()
  const project = mkdtempSync(path.join(process.cwd(), '.tmp-image-tool-run-'))
  const originalCwd = process.cwd()
  const originalFetch = globalThis.fetch
  const calls: { url: string; init: { body?: string } }[] = []
  globalThis.fetch = (async (url: string, init: { body?: string }) => {
    calls.push({ url, init })
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ b64_json: TINY_PNG.toString('base64'), mime_type: 'image/png' }],
        model: 'test/image'
      }),
      text: async () => ''
    }
  }) as unknown as typeof globalThis.fetch

  process.chdir(project)
  try {
    const result = (await tool.execute('call-1', { prompt: 'A test dot' })) as {
      content: { type: string; data?: string; mimeType?: string; text?: string }[]
      isError?: boolean
      details?: { paths?: string[]; model?: string }
    }
    assert.equal(result.isError, undefined, 'the tool reported an error')
    assert.equal(calls.length, 1)
    assert.match(String(calls[0].url), /\/images\/generations$/)

    const imageBlock = result.content.find((block) => block.type === 'image')
    assert.ok(imageBlock, 'the tool did not return an inline image block')
    assert.equal(imageBlock?.mimeType, 'image/png')
    assert.equal(imageBlock?.data, TINY_PNG.toString('base64'))
    assert.match(
      result.content.find((block) => block.type === 'text')?.text ?? '',
      /Generated 1 image\(s\)/
    )

    const dir = path.join(project, 'output', 'generated')
    assert.ok(existsSync(dir), 'the output directory was not created')
    const files = readdirSync(dir)
    assert.equal(files.length, 1)
    assert.deepEqual(readFileSync(path.join(dir, files[0])), TINY_PNG)
    assert.equal(result.details?.paths?.length, 1)
    assert.equal(result.details?.model, 'test/image')
  } finally {
    globalThis.fetch = originalFetch
    process.chdir(originalCwd)
    rmSync(project, { recursive: true, force: true })
  }
})

test('generate_image rejects an output junction that escapes the project before fetching', async () => {
  const tool = await loadTool()
  const parent = mkdtempSync(path.join(process.cwd(), '.tmp-image-tool-link-'))
  const project = path.join(parent, 'project')
  const outside = path.join(parent, 'outside')
  mkdirSync(project)
  mkdirSync(outside)
  symlinkSync(outside, path.join(project, 'output'), process.platform === 'win32' ? 'junction' : 'dir')
  const originalCwd = process.cwd()
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = (async () => {
    fetchCalls += 1
    throw new Error('unexpected fetch')
  }) as unknown as typeof globalThis.fetch

  process.chdir(project)
  try {
    const result = (await tool.execute('call-link', { prompt: 'A test dot' })) as { isError?: boolean }
    assert.equal(result.isError, true)
    assert.equal(fetchCalls, 0, 'an escaped output path is rejected before the gateway call')
    assert.deepEqual(readdirSync(outside), [])
  } finally {
    globalThis.fetch = originalFetch
    process.chdir(originalCwd)
    rmSync(parent, { recursive: true, force: true })
  }
})

test('generate_image rechecks the output directory after the gateway response', async () => {
  const tool = await loadTool()
  const parent = mkdtempSync(path.join(process.cwd(), '.tmp-image-tool-race-'))
  const project = path.join(parent, 'project')
  const outside = path.join(parent, 'outside')
  mkdirSync(path.join(project, 'output', 'generated'), { recursive: true })
  mkdirSync(outside)
  const originalCwd = process.cwd()
  const originalFetch = globalThis.fetch
  let finishFetch!: (response: { ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }) => void
  let notifyFetchStarted!: () => void
  const fetchStarted = new Promise<void>((resolve) => { notifyFetchStarted = resolve })
  globalThis.fetch = (async () => {
    notifyFetchStarted()
    return new Promise((resolve) => { finishFetch = resolve })
  }) as unknown as typeof globalThis.fetch

  process.chdir(project)
  try {
    const pending = tool.execute('call-race', { prompt: 'A test dot' }) as Promise<{
      isError?: boolean
      content?: { text?: string }[]
    }>
    await fetchStarted
    rmSync(path.join(project, 'output'), { recursive: true, force: true })
    symlinkSync(outside, path.join(project, 'output'), process.platform === 'win32' ? 'junction' : 'dir')
    finishFetch({
      ok: true,
      status: 200,
      json: async () => ({ data: [{ b64_json: TINY_PNG.toString('base64'), mime_type: 'image/png' }] }),
      text: async () => ''
    })

    const result = await pending
    assert.equal(result.isError, true, 'the changed output path must fail closed')
    assert.match(result.content?.[0]?.text ?? '', /Output directory escapes the project/)
    assert.deepEqual(readdirSync(outside), [], 'the image must not be written outside the project')
  } finally {
    globalThis.fetch = originalFetch
    process.chdir(originalCwd)
    rmSync(parent, { recursive: true, force: true })
  }
})

test('generate_image fails closed on an empty prompt', async () => {
  const tool = await loadTool()
  const result = (await tool.execute('call-2', { prompt: '' })) as { isError?: boolean }
  assert.equal(result.isError, true, 'an empty prompt must fail closed')
})

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { computerUseExtension } from '../src/main/pi/computer-use'

type Content = { type: string; text?: string; data?: string; mimeType?: string }
type ToolResult = {
  content: Content[]
  details?: {
    action?: string
    width?: number
    height?: number
    scale?: number
    image?: { data?: string; mimeType?: string }
    windows?: unknown
  }
  isError?: boolean
}
type Tool = {
  name: string
  defaultActive?: boolean
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>
}

const dir = mkdtempSync(path.join(process.cwd(), '.tmp-computer-use-test-'))
const extensionFile = path.join(dir, 'computer-use-extension.mjs')
writeFileSync(extensionFile, computerUseExtension(), 'utf8')
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

test('the computer tool stays inactive until Computer Use mode turns it on', async () => {
  const tool = await loadTool()
  assert.equal(tool.name, 'computer')
  assert.equal(tool.defaultActive, false)
  const source = computerUseExtension()
  assert.equal(source.includes('readline'), false)
})

test('coordinates are refused until a screenshot exists', async () => {
  const tool = await loadTool()
  const result = await tool.execute('click-1', { action: 'click', x: 10, y: 10 })
  assert.equal(result.isError, true)
  assert.match(result.content[0].text ?? '', /screenshot/i)
})

test('a screenshot is a scaled image and lists real windows on Windows', async () => {
  if (process.platform !== 'win32') return
  const tool = await loadTool()
  const listed = await tool.execute('list-1', { action: 'list_windows' })
  assert.equal(listed.isError, undefined)
  assert.match(listed.content[0].text ?? '', /\S/)

  const shot = await tool.execute('shot-1', { action: 'screenshot' })
  if (shot.isError && /handle is invalid|CopyFromScreen/i.test(shot.content[0]?.text ?? '')) {
    // Non-interactive desktop session (e.g. background runner, locked screen, headless CI)
    return
  }
  assert.notEqual(shot.isError, true)
  assert.equal(shot.content[1]?.type, 'image')
  assert.equal(shot.content[1]?.mimeType, 'image/png')
  assert.ok((shot.details?.width ?? 0) > 0)
  assert.ok((shot.details?.height ?? 0) > 0)
  assert.ok((shot.details?.width ?? 0) <= 1280)
  assert.ok(shot.details?.image?.data)
  const outside = await tool.execute('click-2', { action: 'click', x: 100000, y: 100000 })
  assert.equal(outside.isError, true)
  assert.match(outside.content[0].text ?? '', /outside/i)
})

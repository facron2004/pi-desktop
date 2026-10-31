import assert from 'node:assert/strict'
import { test } from 'node:test'
import { countLines, LOG_PAGE_LINES, splitLog } from '../src/renderer/src/lib/log-output'
import { activityOf } from '../src/renderer/src/lib/activity'
import type { ToolItem } from '../src/renderer/src/lib/thread'

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    id: 'tool-1',
    kind: 'tool',
    toolCallId: 'call-1',
    toolName: 'read',
    args: {},
    status: 'running',
    timestamp: 0,
    order: 1,
    ...overrides
  }
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')
}

test('splitLog treats an empty text as no lines', () => {
  assert.deepEqual(splitLog(''), { visibleText: '', hiddenLines: 0, totalLines: 0 })
  assert.equal(countLines(''), 0)
})

test('splitLog returns a long text as one 200-line page', () => {
  const text = numberedLines(1000)
  const page = splitLog(text)
  assert.equal(LOG_PAGE_LINES, 200)
  assert.equal(page.totalLines, 1000)
  assert.equal(page.hiddenLines, 800)
  assert.equal(page.visibleText, `${numberedLines(200)}\n`)
  assert.ok(!page.visibleText.includes('line 201'))
  // The hidden part starts exactly where the visible part ends.
  assert.equal(text.slice(page.visibleText.length), numberedLines(1000).split('\n').slice(200).join('\n'))
})

test('splitLog hides nothing at an exact page boundary', () => {
  const text = numberedLines(200)
  assert.deepEqual(splitLog(text, 200), {
    visibleText: text,
    hiddenLines: 0,
    totalLines: 200
  })
})

test('splitLog pages one line past the boundary', () => {
  const text = numberedLines(201)
  const page = splitLog(text, 200)
  assert.equal(page.hiddenLines, 1)
  assert.equal(page.totalLines, 201)
  assert.equal(page.visibleText, `${numberedLines(200)}\n`)
})

test('splitLog keeps a trailing newline without inventing an empty line', () => {
  const text = 'one\ntwo\n'
  assert.equal(countLines(text), 2)
  assert.deepEqual(splitLog(text, 1), {
    visibleText: 'one\n',
    hiddenLines: 1,
    totalLines: 2
  })
  assert.deepEqual(splitLog(text, 2), {
    visibleText: text,
    hiddenLines: 0,
    totalLines: 2
  })
})

test('splitLog counts a text that is only newlines as empty lines', () => {
  assert.equal(countLines('\n'), 1)
  assert.equal(countLines('\n\n'), 2)
})

test('splitLog clamps an invalid page size to one line', () => {
  const page = splitLog('one\ntwo', 0)
  assert.equal(page.visibleText, 'one\n')
  assert.equal(page.hiddenLines, 1)
  assert.equal(page.totalLines, 2)
})

test('activityOf names a file read with its path', () => {
  const activity = activityOf(tool({ toolName: 'read', args: { path: 'src/main/ipc.ts' } }))
  assert.deepEqual(activity, {
    label: 'Reading a file',
    detail: 'src/main/ipc.ts',
    tone: 'read'
  })
})

test('activityOf names a search with its pattern', () => {
  const activity = activityOf(tool({ toolName: 'grep', args: { pattern: 'sendToWindow' } }))
  assert.deepEqual(activity, {
    label: 'Searching files',
    detail: 'sendToWindow',
    tone: 'search'
  })
})

test('activityOf treats edit and write as editing a file', () => {
  assert.equal(activityOf(tool({ toolName: 'edit', args: { path: 'a.ts' } })).label, 'Editing a file')
  assert.equal(activityOf(tool({ toolName: 'write', args: { path: 'b.ts' } })).label, 'Editing a file')
})

test('activityOf names a shell command with the command text', () => {
  const activity = activityOf(
    tool({ toolName: 'bash', args: { command: 'npm run typecheck' } })
  )
  assert.deepEqual(activity, {
    label: 'Running a command',
    detail: 'npm run typecheck',
    tone: 'command'
  })
})

test('activityOf falls back to a generic working state', () => {
  const activity = activityOf(tool({ toolName: 'mcp__server__tool' }))
  assert.equal(activity.label, 'Working')
  assert.equal(activity.tone, 'generic')
})

test('activityOf says waiting when no tool is in flight', () => {
  assert.deepEqual(activityOf(undefined), { label: 'Waiting', detail: '', tone: 'generic' })
})

test('activityOf says waiting for a proposed call that never started', () => {
  const activity = activityOf(
    tool({ toolName: 'bash', status: 'proposed', args: { command: 'ls' } })
  )
  assert.equal(activity.label, 'Waiting')
  assert.equal(activity.detail, 'ls')
})

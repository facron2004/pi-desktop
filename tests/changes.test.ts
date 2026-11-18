import { test } from 'node:test'
import assert from 'node:assert/strict'
import { changedFilePaths, collectChanges, countChangedFiles } from '../src/renderer/src/lib/changes'
import type { ToolItem } from '../src/renderer/src/lib/thread'

function tool(overrides: Partial<ToolItem>): ToolItem {
  return {
    id: 'tool-1',
    kind: 'tool',
    toolCallId: 'call-1',
    toolName: 'edit',
    args: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] },
    status: 'ok',
    timestamp: 1,
    order: 1,
    ...overrides
  }
}

test('a proposed edit is not a file change', () => {
  const items = [tool({ status: 'proposed' })]
  assert.equal(countChangedFiles(items), 0)
  assert.deepEqual(collectChanges(items), [])
})

test('a failed or aborted edit is not a file change', () => {
  for (const status of ['error', 'aborted'] as const) {
    const items = [tool({ status })]
    assert.equal(countChangedFiles(items), 0, status)
    assert.deepEqual(collectChanges(items), [], status)
  }
})

test('a successful edit and write produce a real change with a diff', () => {
  const items = [
    tool({ id: 'edit', toolCallId: 'edit-call', status: 'ok' }),
    tool({
      id: 'write',
      toolCallId: 'write-call',
      toolName: 'write',
      args: { path: 'src/b.ts', content: 'one\ntwo' },
      status: 'ok'
    })
  ]
  assert.equal(countChangedFiles(items), 2)
  const changes = collectChanges(items)
  assert.equal(changes.length, 2)
  const edit = changes.find((change) => change.path === 'src/a.ts')
  assert.ok(edit)
  assert.equal(edit.kind, 'edit')
  assert.ok(edit.diffs.length > 0)
  const write = changes.find((change) => change.path === 'src/b.ts')
  assert.ok(write)
  assert.equal(write.kind, 'write')
  assert.equal(write.content, 'one\ntwo')
})

test('changedFilePaths lists the files without building their diffs', () => {
  const items = [
    tool({ id: 'edit', toolCallId: 'edit-call', status: 'ok' }),
    tool({
      id: 'write',
      toolCallId: 'write-call',
      toolName: 'write',
      args: { path: 'src/b.ts', content: 'one\ntwo' },
      status: 'ok'
    }),
    tool({
      id: 'image',
      toolCallId: 'image-call',
      toolName: 'generate_image',
      args: { prompt: 'lighthouse' },
      details: { paths: ['output/generated/lighthouse.png'] },
      status: 'ok',
      timestamp: 2
    }),
    tool({
      id: 'failed',
      toolCallId: 'failed-call',
      toolName: 'edit',
      args: { path: 'src/failed.ts', edits: [] },
      status: 'error'
    })
  ]
  assert.deepEqual(changedFilePaths(items), [
    { path: 'src/a.ts', at: 1 },
    { path: 'src/b.ts', at: 1 },
    { path: 'output/generated/lighthouse.png', at: 2 }
  ])
})

test('an unchanged tool node reuses its diff instead of diffing again', () => {
  const item = tool({ status: 'ok' })
  const first = collectChanges([item])
  const second = collectChanges([item])
  // Same block object: the second call did not run another line diff. The
  // Changes panel calls this on every `items` update while the agent streams,
  // so a rebuild per call used to freeze the window for seconds.
  assert.equal(first[0].diffs[0], second[0].diffs[0])
  assert.notEqual(first[0].diffs, second[0].diffs, 'the returned list is not the cached array')
})

test('a changed tool node rebuilds only its own diffs', () => {
  const a = tool({
    id: 'a',
    toolCallId: 'a',
    args: { path: 'src/a.ts', edits: [{ oldText: 'one', newText: 'two' }] }
  })
  const b = tool({
    id: 'b',
    toolCallId: 'b',
    args: { path: 'src/b.ts', edits: [{ oldText: 'three', newText: 'four' }] }
  })
  const first = collectChanges([a, b])
  const patchedB: ToolItem = {
    ...b,
    args: { path: 'src/b.ts', edits: [{ oldText: 'three', newText: 'four\nfive' }] }
  }
  const second = collectChanges([a, patchedB])
  const before = (changes: typeof first, path: string) => changes.find((change) => change.path === path)!
  assert.equal(before(first, 'src/a.ts').diffs[0], before(second, 'src/a.ts').diffs[0], 'untouched node keeps its diff')
  assert.notEqual(before(first, 'src/b.ts').diffs[0], before(second, 'src/b.ts').diffs[0], 'patched node is rebuilt')
})

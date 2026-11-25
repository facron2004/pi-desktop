import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEvent, itemsFromMessages, type ToolItem } from '../src/renderer/src/lib/thread'
import type { AgentMessage } from '../src/shared/types'
import {
  subagentCalls,
  subagentTasks,
  isActiveSubagent,
  summarizeSubagents,
  subagentPreview,
  type SubagentTreeTask
} from '../src/renderer/src/lib/subagents'

/** A ToolItem shaped like the subagent calls the reducer projects. */
function tool(patch: Partial<ToolItem> = {}): ToolItem {
  return {
    id: 'node', kind: 'tool', toolCallId: 'batch', toolName: 'subagent',
    args: { tasks: [{ task: 'Inspect' }, { task: 'Verify' }] },
    status: 'running', timestamp: 1, order: 1, ...patch
  }
}

/** A bare SubagentTreeTask for the pure helpers (no reducer replay needed). */
function task(patch: Partial<SubagentTreeTask> = {}): SubagentTreeTask {
  return {
    id: 'batch:0',
    task: 'Inspect',
    cwd: '',
    status: 'completed',
    ...patch
  }
}

function message(role: string, content: AgentMessage['content'], timestamp = 1): AgentMessage {
  return { role, content, timestamp }
}

test('subagentTasks flattens two subagent calls in order and ignores unrelated tool nodes', () => {
  const first = tool({ id: 'call-1', toolCallId: 'call-1', args: { tasks: [{ task: 'Inspect' }, { task: 'Verify' }] } })
  const unrelated = tool({ id: 'read-1', toolCallId: 'read-1', toolName: 'read', args: { path: 'a.ts' } })
  const second = applyEvent([], {
    type: 'tool_execution_end', toolCallId: 'call-2', toolName: 'subagent', isError: false,
    result: { content: [{ type: 'text', text: 'Done' }], details: { results: [{ task: 'Summarise', status: 'completed' }] } }
  })
  const items = [first, unrelated, ...second]
  const tasks = subagentTasks(items)
  assert.deepEqual(tasks.map((t) => t.task), ['Inspect', 'Verify', 'Summarise'])
  assert.deepEqual(tasks.map((t) => t.id), ['call-1:0', 'call-1:1', 'call-2:0'])
  // Equivalent to subagentCalls(items).flatMap((call) => call.tasks).
  assert.deepEqual(tasks, subagentCalls(items).flatMap((call) => call.tasks))
})

test('subagentTasks returns [] for a thread with no subagent calls', () => {
  const items = itemsFromMessages([
    { role: 'user', timestamp: 1, content: 'hello' },
    { role: 'assistant', timestamp: 2, content: [{ type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'a.ts' } }] },
    { role: 'toolResult', timestamp: 3, toolCallId: 'r', toolName: 'read', isError: false, content: [{ type: 'text', text: 'file contents' }] }
  ])
  assert.deepEqual(subagentTasks(items), [])
  assert.deepEqual(subagentTasks([]), [])
})

test('isActiveSubagent is true only for running and queued tasks', () => {
  for (const status of ['running', 'queued'] as const) {
    assert.equal(isActiveSubagent(task({ status })), true, `${status} is active`)
  }
  for (const status of ['proposed', 'completed', 'failed', 'aborted', 'timed_out'] as const) {
    assert.equal(isActiveSubagent(task({ status })), false, `${status} is not active`)
  }
})

test('summarizeSubagents counts total, active and finished, leaving proposed in total only', () => {
  const tasks = [
    task({ status: 'running' }),
    task({ status: 'queued' }),
    task({ status: 'completed' }),
    task({ status: 'failed' }),
    task({ status: 'aborted' }),
    task({ status: 'timed_out' }),
    task({ status: 'proposed' })
  ]
  assert.deepEqual(summarizeSubagents(tasks), { total: 7, active: 2, finished: 4 })
  assert.deepEqual(summarizeSubagents([]), { total: 0, active: 0, finished: 0 })
})

test('subagentPreview prefers live progressText over activity while running', () => {
  const live = task({
    status: 'running',
    progressText: 'Streaming lines 1-2 of the file',
    activity: 'Reading src/index.ts',
    toolName: 'read',
    output: 'should not win'
  })
  assert.equal(subagentPreview(live), 'Streaming lines 1-2 of the file')
  // With no progress text, the running activity/toolName pair is the preview.
  const activity = task({ status: 'running', activity: 'Reading', toolName: 'read', output: 'should not win' })
  assert.equal(subagentPreview(activity), 'Reading · read')
})

test('subagentPreview prefers errorMessage over output for a failed task', () => {
  assert.equal(
    subagentPreview(task({ status: 'failed', errorMessage: 'Child exited with code 3', output: 'partial work' })),
    'Child exited with code 3'
  )
  // The same terminal group reads errorMessage first.
  assert.equal(
    subagentPreview(task({ status: 'aborted', errorMessage: 'Stopped by the user', output: 'partial work' })),
    'Stopped by the user'
  )
  assert.equal(
    subagentPreview(task({ status: 'timed_out', errorMessage: 'Subagent timed out', output: 'partial work' })),
    'Subagent timed out'
  )
})

test('subagentPreview picks the newest assistant text and ignores thinking/toolCall/image blocks', () => {
  const withNewestText = task({
    status: 'completed',
    messages: [
      message('assistant', 'old answer', 1),
      message('user', 'do the thing', 2),
      message('assistant', [
        { type: 'thinking', thinking: 'hidden reasoning' },
        { type: 'toolCall', id: 'c', name: 'read', arguments: { path: 'a.ts' } },
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
        { type: 'text', text: 'The newest' },
        { type: 'text', text: 'answer is 42' }
      ], 3)
    ]
  })
  assert.equal(subagentPreview(withNewestText), 'The newest answer is 42')

  // A newest assistant message with no text blocks is skipped; an older
  // assistant text is then used, and non-text blocks never leak in.
  const skipEmptyNewest = task({
    status: 'completed',
    messages: [
      message('assistant', 'older real answer', 1),
      message('assistant', [
        { type: 'thinking', thinking: 'just thinking' },
        { type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'ls' } }
      ], 2)
    ]
  })
  assert.equal(subagentPreview(skipEmptyNewest), 'older real answer')
})

test('subagentPreview falls back to output, then activity/toolName, then progressText', () => {
  assert.equal(
    subagentPreview(task({ status: 'completed', output: 'Final answer text', activity: 'Reading', toolName: 'read' })),
    'Final answer text'
  )
  assert.equal(
    subagentPreview(task({ status: 'completed', activity: 'Reading', toolName: 'read' })),
    'Reading · read'
  )
  assert.equal(subagentPreview(task({ status: 'completed', activity: 'Working' })), 'Working')
  assert.equal(subagentPreview(task({ status: 'completed', toolName: 'bash' })), 'bash')
  assert.equal(
    subagentPreview(task({ status: 'completed', progressText: 'A tail of the answer' })),
    'A tail of the answer'
  )
  // A whitespace-only source is skipped rather than returned.
  assert.equal(
    subagentPreview(task({ status: 'completed', output: '   \n\t  ', activity: 'Reading', toolName: 'read' })),
    'Reading · read'
  )
})

test('subagentPreview collapses whitespace and clamps long values to 240 chars ending in an ellipsis', () => {
  assert.equal(
    subagentPreview(task({ status: 'completed', output: '  first line\n\tsecond   line\r\n  third  ' })),
    'first line second line third'
  )
  const preview = subagentPreview(task({ status: 'completed', output: 'x'.repeat(300) }))
  assert.equal(preview.length, 240)
  assert.equal(preview.slice(0, 239), 'x'.repeat(239))
  assert.equal(preview.endsWith('…'), true)
})

test('subagentPreview returns an empty string for a queued task with no content', () => {
  assert.equal(subagentPreview(task({ status: 'queued' })), '')
})

test('a finished task preview can come from its replayed messages rather than raw thinking text', () => {
  const items = itemsFromMessages([
    { role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: 'batch', name: 'subagent', arguments: { tasks: [{ task: 'Review' }] } }] },
    {
      role: 'toolResult', timestamp: 2, toolCallId: 'batch', toolName: 'subagent', isError: false,
      content: [],
      details: { results: [
        { task: 'Review', status: 'completed', messages: [
          { role: 'assistant', timestamp: 3, content: [
            { type: 'thinking', thinking: 'RAW HIDDEN THOUGHT' },
            { type: 'text', text: 'The refactor is complete.' }
          ] }
        ] }
      ] }
    }
  ])
  const finished = subagentTasks(items)[0]
  assert.equal(finished.status, 'completed')
  const preview = subagentPreview(finished)
  assert.equal(preview, 'The refactor is complete.')
  assert.equal(preview.includes('RAW HIDDEN THOUGHT'), false)
})

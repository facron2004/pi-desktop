import test from 'node:test'
import assert from 'node:assert/strict'
import { applyEvent, itemsFromMessages, markAborted, type ToolItem } from '../src/renderer/src/lib/thread'
import { subagentCalls } from '../src/renderer/src/lib/subagents'

function tool(patch: Partial<ToolItem> = {}): ToolItem {
  return {
    id: 'node', kind: 'tool', toolCallId: 'batch', toolName: 'subagent',
    args: { tasks: [{ task: 'Inspect' }, { task: 'Verify' }] },
    status: 'running', timestamp: 1, order: 1, ...patch
  }
}

test('a proposal is not run, and a started call waits for child startup confirmation', () => {
  assert.deepEqual(subagentCalls([tool({ status: 'proposed' })])[0].tasks.map((task) => task.status), ['proposed', 'proposed'])
  assert.deepEqual(subagentCalls([tool()])[0].tasks.map((task) => task.status), ['queued', 'queued'])
})

test('subagent task identities keep their order across progress updates', () => {
  const first = subagentCalls([tool({ details: { results: [
    { task: 'Inspect', status: 'running', activity: 'Running a tool', toolName: 'read', startedAt: 2 },
    { task: 'Verify', status: 'queued' }
  ] } })])[0]
  const next = subagentCalls([tool({ details: { results: [
    { task: 'Inspect', status: 'completed', startedAt: 2, finishedAt: 10, output: 'Found it' },
    { task: 'Verify', status: 'running', startedAt: 5 }
  ] } })])[0]
  assert.deepEqual(first.tasks.map((task) => task.id), next.tasks.map((task) => task.id))
  assert.equal(first.tasks[0].activity, 'Running a tool')
  assert.equal(first.tasks[0].toolName, 'read')
  assert.deepEqual(next.tasks.map((task) => task.status), ['completed', 'running'])
  assert.equal(next.tasks[0].output, 'Found it')
})

test('a stopped parent aborts unfinished children without changing completed children', () => {
  const live = tool({ details: { results: [
    { task: 'Inspect', status: 'completed', exitCode: 0 },
    { task: 'Verify', status: 'running', exitCode: -1 }
  ] } })
  const aborted = markAborted([live])
  const late = applyEvent(aborted, {
    type: 'tool_execution_update', toolCallId: 'batch', toolName: 'subagent',
    partialResult: { details: { results: [{ status: 'running' }, { status: 'running' }] } }
  })
  assert.deepEqual(subagentCalls(late)[0].tasks.map((task) => task.status), ['completed', 'aborted'])
})

test('legacy replay reports individual failures even when the batch succeeded', () => {
  const items = itemsFromMessages([
    { role: 'assistant', timestamp: 1, content: [{ type: 'toolCall', id: 'batch', name: 'subagent', arguments: tool().args }] },
    { role: 'toolResult', timestamp: 2, toolCallId: 'batch', toolName: 'subagent', isError: false, content: [], details: { results: [
      { task: 'Inspect', exitCode: 0, output: 'Done' },
      { task: 'Verify', exitCode: 3, stderr: 'Test failed' }
    ] } }
  ])
  const tasks = subagentCalls(items)[0].tasks
  assert.deepEqual(tasks.map((task) => task.status), ['completed', 'failed'])
  assert.equal(tasks[1].errorMessage, 'Test failed')
})

test('an orphan result still retains the task tree and its output', () => {
  const items = applyEvent([], {
    type: 'tool_execution_end', toolCallId: 'solo', toolName: 'subagent', isError: false,
    result: { content: [{ type: 'text', text: 'Done' }], details: { results: [{ task: 'Inspect', status: 'completed', output: 'Done' }] } }
  })
  assert.equal(subagentCalls(items)[0].tasks[0].status, 'completed')
  assert.equal(subagentCalls(items)[0].tasks[0].output, 'Done')
})

test('malformed details fall back to task arguments and unrelated tools stay out of the tree', () => {
  const calls = subagentCalls([tool({ details: { results: 'unavailable' } }), tool({ toolName: 'read' })])
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].tasks.map((task) => task.task), ['Inspect', 'Verify'])
})

test('a task label names the tree row while the briefing stays available', () => {
  const briefing = 'Read every file in src and summarise the architecture'
  const calls = subagentCalls([tool({
    args: { tasks: [{ task: briefing, label: 'Scout' }] },
    details: { results: [{ task: briefing, label: 'Scout', status: 'completed' }] }
  })])
  assert.equal(calls[0].tasks[0].label, 'Scout')
  assert.equal(calls[0].tasks[0].task, briefing)
})

test('a timed out child is a terminal state of its own', () => {
  const calls = subagentCalls([tool({
    args: { task: 'Long task' },
    details: { results: [{ task: 'Long task', status: 'timed_out', errorMessage: 'Subagent timed out after 1000 ms.' }] }
  })])
  assert.equal(calls[0].tasks[0].status, 'timed_out')
  assert.match(calls[0].tasks[0].errorMessage ?? '', /timed out/i)
})

test('live progress text is projected only while the child is running', () => {
  const running = subagentCalls([tool({
    args: { task: 'Stream' },
    details: { results: [{ task: 'Stream', status: 'running', progressText: 'LIVE-PROGRESS' }] }
  })])[0].tasks[0]
  assert.equal(running.progressText, 'LIVE-PROGRESS')
  const done = subagentCalls([tool({
    args: { task: 'Stream' },
    details: { results: [{ task: 'Stream', status: 'completed', progressText: 'LIVE-PROGRESS' }] }
  })])[0].tasks[0]
  assert.equal(done.progressText, undefined)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiEvent } from '@shared/types'
import {
  normalizePiEvent,
  resetStreamState,
  type StreamContext,
  type StreamEvent
} from '../src/renderer/src/lib/stream-events'
import {
  applyEvent,
  applyEvents,
  applyStreamEvent,
  type ThreadItem
} from '../src/renderer/src/lib/thread'

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function contextOf(sessionKey: string): StreamContext {
  return { sessionKey, runId: 'run-1', turnId: 'turn-1' }
}

function normalizeOne(event: PiEvent, context: StreamContext = contextOf('thread-a')): StreamEvent {
  const normalized = normalizePiEvent(event, context)
  assert.ok(normalized, `expected ${event.type} to normalize`)
  return normalized
}

function update(event: Record<string, unknown>): PiEvent {
  return { type: 'message_update', assistantMessageEvent: event }
}

/**
 * Compare projections without the process-local bookkeeping (ids, order and
 * wall-clock timestamps) that is deliberately different between two runs.
 */
function stable(items: ThreadItem[]): unknown {
  return JSON.parse(
    JSON.stringify(items, (key, value) =>
      key === 'id' ||
      key === 'order' ||
      key === 'timestamp' ||
      key === 'startedAt' ||
      key === 'finishedAt' ||
      key === 'threadId' ||
      key === 'sequence'
        ? undefined
        : value
    )
  )
}

/* ------------------------------------------------------------------ *
 * identity
 * ------------------------------------------------------------------ */

test('a message keeps one message id from start through its updates to the end', () => {
  resetStreamState()
  const context = contextOf('thread-message')

  const start = normalizeOne(
    {
      type: 'message_start',
      message: { role: 'assistant', content: [], timestamp: 1 }
    },
    context
  )
  assert.equal(start.type, 'message.started')
  assert.equal(start.threadId, 'thread-message')
  assert.equal(start.runId, 'run-1')
  assert.equal(start.turnId, 'turn-1')
  assert.equal(start.sequence, 1)
  assert.equal(start.status, 'streaming')
  assert.equal(typeof start.messageId, 'string')

  const delta = normalizeOne(
    update({ type: 'text_delta', contentIndex: 0, delta: 'Hi' }),
    context
  )
  assert.equal(delta.type, 'message.delta')
  assert.equal(delta.messageId, start.messageId)
  assert.equal(delta.sequence, 2)

  const end = normalizeOne(
    {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }], timestamp: 2 }
    },
    context
  )
  assert.equal(end.type, 'message.completed')
  assert.equal(end.messageId, start.messageId)
  assert.equal(end.sequence, 3)
  assert.equal(end.source.type, 'message_end')
})

test('a duplicated message start reuses its identity and creates one item', () => {
  resetStreamState()
  const context = contextOf('thread-duplicate-start')
  const start: PiEvent = {
    type: 'message_start',
    message: { role: 'assistant', content: [], timestamp: 1 }
  }
  const first = normalizeOne(start, context)
  const second = normalizeOne(start, context)
  assert.equal(second.messageId, first.messageId)

  let items: ThreadItem[] = []
  for (const event of [start, start]) {
    const normalized = normalizePiEvent(event, context)
    assert.ok(normalized)
    items = applyStreamEvent(items, normalized)
  }
  assert.equal(items.length, 1)
  assert.equal(items[0].kind, 'assistant')
  assert.equal(items[0].messageId, first.messageId)
})

test('every normalized kind carries thread, sequence and the untouched source', () => {
  const fixtures: { label: string; event: PiEvent; expected: string }[] = [
    { label: 'run.started', event: { type: 'agent_start' }, expected: 'run.started' },
    { label: 'run.turn.started', event: { type: 'turn_start' }, expected: 'run.turn.started' },
    { label: 'run.status', event: { type: 'agent_end', willRetry: false }, expected: 'run.status' },
    { label: 'run.finished', event: { type: 'agent_settled', aborted: true }, expected: 'run.finished' },
    {
      label: 'message.started',
      event: { type: 'message_start', message: { role: 'user', content: 'hi', timestamp: 1 } },
      expected: 'message.started'
    },
    {
      label: 'message.block.started',
      event: update({ type: 'text_start', contentIndex: 0 }),
      expected: 'message.block.started'
    },
    {
      label: 'message.delta',
      event: update({ type: 'text_delta', contentIndex: 0, delta: 'hi' }),
      expected: 'message.delta'
    },
    {
      label: 'message.block.completed',
      event: update({ type: 'text_end', contentIndex: 0, content: 'hi' }),
      expected: 'message.block.completed'
    },
    {
      label: 'message.completed',
      event: {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: 2 }
      },
      expected: 'message.completed'
    },
    {
      label: 'tool.proposed',
      event: update({ type: 'toolcall_start', contentIndex: 0, id: 'call-1', toolName: 'bash' }),
      expected: 'tool.proposed'
    },
    {
      label: 'tool.args',
      event: update({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'call-1', name: 'bash', arguments: { command: 'ls' } }
      }),
      expected: 'tool.args'
    },
    {
      label: 'tool.started',
      event: {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' }
      },
      expected: 'tool.started'
    },
    {
      label: 'tool.output.delta',
      event: {
        type: 'tool_execution_update',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
        partialResult: { content: [{ type: 'text', text: '.' }] }
      },
      expected: 'tool.output.delta'
    },
    {
      label: 'tool.finished',
      event: {
        type: 'tool_execution_end',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
        result: { content: [{ type: 'text', text: '.' }] },
        isError: false
      },
      expected: 'tool.finished'
    },
    {
      label: 'command.output.delta',
      event: { type: 'bash_execution_update', id: 'req-1', delta: 'ok\n' },
      expected: 'command.output.delta'
    },
    {
      label: 'approval.requested',
      event: { type: 'extension_ui_request', id: 'req-1', method: 'confirm', title: 'Run?' },
      expected: 'approval.requested'
    },
    {
      label: 'approval.resolved',
      event: { type: 'extension_ui_response', id: 'req-1', confirmed: true },
      expected: 'approval.resolved'
    },
    {
      label: 'notice',
      event: { type: 'client_notice', level: 'info', text: 'hello' },
      expected: 'notice'
    },
    {
      label: 'error',
      event: { type: 'extension_error', error: 'boom' },
      expected: 'error'
    },
    { label: 'unknown', event: { type: 'a_future_event' }, expected: 'unknown' }
  ]

  for (const fixture of fixtures) {
    resetStreamState()
    const context = contextOf(`thread-${fixture.label}`)
    const normalized = normalizeOne(fixture.event, context)
    assert.equal(normalized.type, fixture.expected, fixture.label)
    assert.equal(normalized.threadId, `thread-${fixture.label}`, fixture.label)
    assert.equal(normalized.sequence, 1, fixture.label)
    assert.equal(normalized.runId, 'run-1', fixture.label)
    assert.equal(normalized.turnId, 'turn-1', fixture.label)
    assert.equal(normalized.source, fixture.event, fixture.label)
  }
})

test('identity fields land on the items the projection creates', () => {
  resetStreamState()
  const context = contextOf('thread-items')

  const items = applyEvents(
    [],
    [
      {
        type: 'message_start',
        message: { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 }
      },
      { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } },
      update({ type: 'toolcall_start', contentIndex: 0, id: 'c1', toolName: 'bash' }),
      update({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'c1', name: 'bash', arguments: { command: 'ls' } }
      }),
      {
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'ls' }
      },
      { type: 'bash_execution_update', id: 'bash-1', delta: 'ok\n' },
      { type: 'compaction_start', reason: 'threshold' }
    ],
    context
  )

  for (const item of items) {
    assert.equal(item.threadId, 'thread-items', `${item.kind} threadId`)
    assert.equal(typeof item.sequence, 'number', `${item.kind} sequence`)
  }
  const user = items.find((item) => item.kind === 'user')
  const assistant = items.find((item) => item.kind === 'assistant')
  const tool = items.find((item) => item.kind === 'tool')
  const bash = items.find((item) => item.kind === 'bash')
  const notice = items.find((item) => item.kind === 'notice')
  assert.ok(user && assistant && tool && bash && notice)
  assert.equal(user.runId, 'run-1')
  assert.equal(assistant.runId, 'run-1')
  assert.equal(tool.runId, 'run-1')
})

test('a context-less applyEvent still projects but stamps no thread id', () => {
  resetStreamState()
  const items = applyEvents([], [{ type: 'client_notice', level: 'info', text: 'hello' }])
  const notice = items[0]
  assert.ok(notice.kind === 'notice')
  assert.equal(notice.threadId, undefined)
  assert.equal(typeof notice.sequence, 'number')
})

/* ------------------------------------------------------------------ *
 * sequence
 * ------------------------------------------------------------------ */

test('sequence is monotonic per thread and independent between threads', () => {
  resetStreamState()
  const a = contextOf('thread-a')
  const b = contextOf('thread-b')

  const events: PiEvent[] = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'user', content: 'hi', timestamp: 1 } },
    { type: 'message_end', message: { role: 'user', content: 'hi', timestamp: 1 } },
    { type: 'client_notice', level: 'info', text: 'note' },
    { type: 'something_unmapped' }
  ]

  let last = 0
  for (const event of events) {
    const normalized = normalizeOne(event, a)
    assert.ok(normalized.sequence > last, `${event.type} sequence`)
    last = normalized.sequence
  }

  const firstOnB = normalizeOne({ type: 'agent_start' }, b)
  assert.equal(firstOnB.sequence, 1)
  const nextOnA = normalizeOne({ type: 'turn_start' }, a)
  assert.equal(nextOnA.sequence, last + 1)

  // Sequence is per thread, not per run: a new run id keeps the same clock.
  const laterRun = normalizeOne({ type: 'agent_start' }, { ...a, runId: 'run-2' })
  assert.equal(laterRun.sequence, nextOnA.sequence + 1)
})

/* ------------------------------------------------------------------ *
 * reducer equivalence
 * ------------------------------------------------------------------ */

test('applyEvent and applyStreamEvent(normalizePiEvent) project the same thread', () => {
  resetStreamState()
  const context = contextOf('thread-equivalence')
  const events: PiEvent[] = [
    { type: 'agent_start' },
    { type: 'turn_start' },
    { type: 'message_start', message: { role: 'user', content: 'run it', timestamp: 1 } },
    { type: 'message_end', message: { role: 'user', content: 'run it', timestamp: 1 } },
    { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } },
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'Look' }),
    update({ type: 'text_end', contentIndex: 0, content: 'Look' }),
    update({ type: 'toolcall_start', contentIndex: 1, id: 'call-1', toolName: 'bash' }),
    update({ type: 'toolcall_delta', contentIndex: 1, delta: '{"command":' }),
    update({ type: 'toolcall_delta', contentIndex: 1, delta: '"echo hi"}' }),
    update({
      type: 'toolcall_end',
      contentIndex: 1,
      toolCall: { id: 'call-1', name: 'bash', arguments: { command: 'echo hi' } }
    }),
    {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'echo hi' }
    },
    {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'echo hi' },
      partialResult: { content: [{ type: 'text', text: 'hi' }] }
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'echo hi' },
      result: {
        content: [{ type: 'text', text: 'hi\n' }],
        structuredContent: { exit_code: 0 }
      },
      isError: false,
      durationMs: 12
    },
    update({ type: 'text_start', contentIndex: 2 }),
    update({ type: 'text_delta', contentIndex: 2, delta: 'Done.' }),
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Look' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'echo hi' } },
          { type: 'text', text: 'Done.' }
        ],
        timestamp: 3,
        usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3 },
        model: 'test-model',
        stopReason: 'stop'
      }
    },
    { type: 'turn_end' },
    { type: 'agent_end', willRetry: false },
    { type: 'agent_settled', aborted: false },
    { type: 'compaction_start', reason: 'manual' },
    {
      type: 'compaction_end',
      reason: 'manual',
      aborted: false,
      result: { tokensBefore: 1000, estimatedTokensAfter: 200 }
    },
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: 'overloaded' },
    { type: 'auto_retry_end', success: true }
  ]

  let viaAdapter: ThreadItem[] = []
  let viaApply: ThreadItem[] = []
  for (const event of events) {
    const streamEvent = normalizePiEvent(event, context)
    assert.ok(streamEvent, `${event.type} should normalize`)
    viaAdapter = applyStreamEvent(viaAdapter, streamEvent)
    viaApply = applyEvent(viaApply, event, context)
    assert.deepEqual(stable(viaAdapter), stable(viaApply), `after ${event.type}`)
  }

  assert.equal(viaAdapter.filter((item) => item.kind === 'tool').length, 1)
  assert.equal(viaAdapter.find((item) => item.kind === 'tool')?.kind, 'tool')
})

/* ------------------------------------------------------------------ *
 * message update sub-types
 * ------------------------------------------------------------------ */

test('message update sub-types normalize to their semantic block events', () => {
  resetStreamState()
  const context = contextOf('thread-blocks')
  normalizeOne(
    { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } },
    context
  )

  const textStart = normalizeOne(update({ type: 'text_start', contentIndex: 0 }), context)
  assert.equal(textStart.type, 'message.block.started')
  assert.equal(textStart.type === 'message.block.started' && textStart.blockType, 'text')

  const textDelta = normalizeOne(update({ type: 'text_delta', contentIndex: 0, delta: 'a' }), context)
  assert.equal(textDelta.type, 'message.delta')
  assert.equal(textDelta.type === 'message.delta' && textDelta.delta, 'a')

  const textEnd = normalizeOne(update({ type: 'text_end', contentIndex: 0, content: 'ab' }), context)
  assert.equal(textEnd.type, 'message.block.completed')
  assert.equal(textEnd.type === 'message.block.completed' && textEnd.content, 'ab')

  const thinkingStart = normalizeOne(
    update({ type: 'thinking_start', contentIndex: 1 }),
    context
  )
  assert.equal(
    thinkingStart.type === 'message.block.started' && thinkingStart.blockType,
    'thinking'
  )
  const thinkingDelta = normalizeOne(
    update({ type: 'thinking_delta', contentIndex: 1, delta: 'hmm' }),
    context
  )
  assert.equal(thinkingDelta.type === 'message.delta' && thinkingDelta.blockType, 'thinking')
  const thinkingEnd = normalizeOne(
    update({ type: 'thinking_end', contentIndex: 1, content: 'hmm!' }),
    context
  )
  assert.equal(
    thinkingEnd.type === 'message.block.completed' && thinkingEnd.content,
    'hmm!'
  )
})

test('text_end and message_end are authoritative in the semantic projection', () => {
  resetStreamState()
  const context = contextOf('thread-authority')
  let items = applyEvents(
    [],
    [
      { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } },
      update({ type: 'text_start', contentIndex: 0 }),
      update({ type: 'text_delta', contentIndex: 0, delta: 'partial' }),
      update({ type: 'text_end', contentIndex: 0, content: 'final' })
    ],
    context
  )
  let assistant = items.find((item) => item.kind === 'assistant')
  assert.ok(assistant && assistant.kind === 'assistant')
  assert.equal(assistant.blocks[0].type === 'text' && assistant.blocks[0].text, 'final')

  items = applyEvents(
    items,
    [
      {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'authoritative' }], timestamp: 2 }
      }
    ],
    context
  )
  assistant = items.find((item) => item.kind === 'assistant')
  assert.ok(assistant && assistant.kind === 'assistant')
  assert.equal(assistant.blocks[0].type === 'text' && assistant.blocks[0].text, 'authoritative')
  assert.equal(assistant.streaming, false)
})

/* ------------------------------------------------------------------ *
 * tool calls: duplicates, out-of-order and snapshots
 * ------------------------------------------------------------------ */

test('duplicate and out-of-order tool events keep one node per tool call', () => {
  resetStreamState()
  const context = contextOf('thread-tools')
  const start: PiEvent = {
    type: 'tool_execution_start',
    toolCallId: 'call-1',
    toolName: 'bash',
    args: { command: 'ls' }
  }
  const end: PiEvent = {
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'bash',
    args: { command: 'ls' },
    result: { content: [{ type: 'text', text: 'done' }] },
    isError: false,
    durationMs: 5
  }

  let viaAdapter: ThreadItem[] = []
  let viaApply: ThreadItem[] = []
  const events: PiEvent[] = [
    // An update before the reducer knows the call: it has nowhere to land.
    {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls' },
      partialResult: { content: [{ type: 'text', text: 'early' }] }
    },
    start,
    start,
    end,
    end
  ]
  for (const event of events) {
    const streamEvent = normalizePiEvent(event, context)
    assert.ok(streamEvent)
    viaAdapter = applyStreamEvent(viaAdapter, streamEvent)
    viaApply = applyEvent(viaApply, event, context)
    assert.deepEqual(stable(viaAdapter), stable(viaApply), `after ${event.type}`)
  }
  assert.equal(viaAdapter.length, 1)
  const tool = viaAdapter[0]
  assert.ok(tool.kind === 'tool')
  assert.equal(tool.status, 'ok')
  assert.equal(tool.result, 'done')
})

test('a late start or update after a result cannot regress a finished tool', () => {
  resetStreamState()
  const context = contextOf('thread-late-tool')
  const events: PiEvent[] = [
    { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } },
    update({ type: 'toolcall_start', contentIndex: 0, id: 'call-1', toolName: 'bash' }),
    update({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 'call-1', name: 'bash', arguments: { command: 'ls' } }
    }),
    {
      type: 'tool_execution_start',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'ls' }
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'done' }] },
      isError: false
    },
    // Replayed after the result: neither may reopen the row.
    { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } },
    {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: { content: [{ type: 'text', text: 'late' }] }
    }
  ]
  let items: ThreadItem[] = []
  for (const event of events) {
    const normalized = normalizePiEvent(event, context)
    assert.ok(normalized)
    items = applyStreamEvent(items, normalized)
  }
  const tool = items.find((item) => item.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(tool.status, 'ok')
  assert.equal(tool.result, 'done')
})

test('a result before the proposed call still ends with the arguments from toolcall_end', () => {
  resetStreamState()
  const context = contextOf('thread-out-of-order')
  const events: PiEvent[] = [
    { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } },
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: {},
      result: { content: [{ type: 'text', text: 'done' }] },
      isError: false
    },
    update({ type: 'toolcall_start', contentIndex: 0, id: 'call-1', toolName: 'bash' }),
    update({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 'call-1', name: 'bash', arguments: { command: 'ls' } }
    })
  ]

  let items: ThreadItem[] = []
  for (const event of events) {
    const streamEvent = normalizePiEvent(event, context)
    assert.ok(streamEvent)
    items = applyStreamEvent(items, streamEvent)
  }
  const tools = items.filter((item) => item.kind === 'tool')
  assert.equal(tools.length, 1)
  assert.ok(tools[0].kind === 'tool')
  assert.deepEqual(tools[0].args, { command: 'ls' })
  // The result is terminal: a late proposal cannot downgrade a finished call.
  assert.equal(tools[0].status, 'ok')
})

test('tool_execution_start without a tool name keeps the proposed name', () => {
  resetStreamState()
  const context = contextOf('thread-tool-name')
  let items = applyEvents(
    [],
    [
      { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } },
      update({ type: 'toolcall_start', contentIndex: 0, id: 'call-1', toolName: 'read' }),
      update({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'call-1', name: 'read', arguments: { path: 'a.ts' } }
      }),
      { type: 'tool_execution_start', toolCallId: 'call-1' }
    ],
    context
  )
  const tool = items.find((item) => item.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(tool.toolName, 'read')
  assert.equal(tool.status, 'running')
})

test('tool_execution_update replaces the partial result instead of appending it', () => {
  resetStreamState()
  const context = contextOf('thread-progress')
  let items = applyEvents(
    [],
    [
      { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 1 } },
      update({ type: 'toolcall_start', contentIndex: 0, id: 'call-1', toolName: 'bash' }),
      update({
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'call-1', name: 'bash', arguments: { command: 'ls' } }
      }),
      { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash', args: { command: 'ls' } },
      {
        type: 'tool_execution_update',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
        partialResult: { content: [{ type: 'text', text: 'a' }] }
      },
      {
        type: 'tool_execution_update',
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'ls' },
        partialResult: { content: [{ type: 'text', text: 'a\nb' }] }
      }
    ],
    context
  )
  const tool = items.find((item) => item.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(tool.progress, 'a\nb')
})

/* ------------------------------------------------------------------ *
 * approval and unknown events
 * ------------------------------------------------------------------ */

test('extension UI requests are normalized as approvals without changing the thread', () => {
  resetStreamState()
  const context = contextOf('thread-approval')
  const request = normalizeOne(
    { type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Run it?' },
    context
  )
  assert.equal(request.type, 'approval.requested')
  assert.equal(request.type === 'approval.requested' && request.dialog, true)
  assert.equal(request.status, 'waiting_approval')

  const responseEvent: PiEvent = { type: 'extension_ui_response', id: 'ui-1', confirmed: true }
  const response = normalizeOne(responseEvent, context)
  assert.equal(response.type, 'approval.resolved')
  assert.equal(response.type === 'approval.resolved' && response.requestId, 'ui-1')

  let items: ThreadItem[] = []
  assert.deepEqual(applyStreamEvent(items, request), [])
  items = applyStreamEvent(items, response)
  assert.deepEqual(items, [])
})

test('unknown Pi records become unknown events without touching the thread', () => {
  resetStreamState()
  const event: PiEvent = { type: 'entry_appended', entry: { type: 'custom' } }
  const normalized = normalizeOne(event)
  assert.equal(normalized.type, 'unknown')
  assert.equal(normalized.type === 'unknown' && normalized.sourceType, 'entry_appended')
  assert.deepEqual(applyStreamEvent([], normalized), [])
})

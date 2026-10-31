import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PiEvent } from '@shared/types'
import {
  applyEvent,
  applyEvents,
  itemsFromMessages,
  lastAssistantText,
  markAborted,
  type ThreadItem
} from '../src/renderer/src/lib/thread'

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function userEvent(text: string): PiEvent {
  return {
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 }
  }
}

function userEnd(text: string): PiEvent {
  return {
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1 }
  }
}

function assistantStart(): PiEvent {
  return { type: 'message_start', message: { role: 'assistant', content: [], timestamp: 2 } }
}
function update(event: Record<string, unknown>): PiEvent {
  return {
    type: 'message_update',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0
    },
    assistantMessageEvent: event
  }
}

function assistantEnd(content: unknown, extra: Record<string, unknown> = {}): PiEvent {
  return {
    type: 'message_end',
    message: { role: 'assistant', content, timestamp: 3, ...extra }
  }
}

function tools(items: ThreadItem[]): Extract<ThreadItem, { kind: 'tool' }>[] {
  return items.filter((item): item is Extract<ThreadItem, { kind: 'tool' }> => item.kind === 'tool')
}

function texts(items: ThreadItem[]): string {
  return items
    .flatMap((item) =>
      item.kind === 'assistant'
        ? item.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
        : []
    )
    .join('')
}

/* ------------------------------------------------------------------ *
 * T01/T02 — text deltas and final calibration
 * ------------------------------------------------------------------ */

test('text deltas accumulate and text_end replaces them with the authority', () => {
  let items: ThreadItem[] = applyEvents([], [userEvent('hi'), userEnd('hi'), assistantStart()])
  items = applyEvents(items, [
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'Hello ' }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'wor' }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'ld' })
  ])
  assert.equal(texts(items), 'Hello world')

  // `text_end` carries the authoritative content of the block, so a stream
  // that disagreed with itself is corrected rather than added to.
  items = applyEvents(items, [update({ type: 'text_end', contentIndex: 0, content: 'Hello world!' })])
  assert.equal(texts(items), 'Hello world!')

  items = applyEvents(items, [assistantEnd([{ type: 'text', text: 'Hello world!' }])])
  assert.equal(texts(items), 'Hello world!')
  assert.equal(lastAssistantText(items), 'Hello world!')
})

test('message_end makes the message authoritative and stops the stream', () => {
  let items: ThreadItem[] = applyEvents([], [assistantStart()])
  items = applyEvents(items, [
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'partial' })
  ])
  const assistant = items.find((item) => item.kind === 'assistant')
  assert.ok(assistant && assistant.kind === 'assistant' && assistant.streaming)

  items = applyEvents(items, [assistantEnd([{ type: 'text', text: 'final' }])])
  const done = items.find((item) => item.kind === 'assistant')
  assert.ok(done && done.kind === 'assistant')
  assert.equal(done.streaming, false)
  assert.equal(texts(items), 'final')
})

/* ------------------------------------------------------------------ *
 * T03/T04/T05 — the life of one tool call
 * ------------------------------------------------------------------ */

test('one tool call is one node from proposed to finished', () => {
  const callId = 'call_1'
  let items: ThreadItem[] = applyEvents([], [assistantStart()])
  items = applyEvents(items, [
    update({ type: 'toolcall_start', contentIndex: 0, id: callId, toolName: 'bash' }),
    update({ type: 'toolcall_delta', contentIndex: 0, delta: '{"command":' }),
    update({ type: 'toolcall_delta', contentIndex: 0, delta: '"echo hi"}' }),
    update({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: callId, name: 'bash', arguments: { command: 'echo hi' } }
    })
  ])

  // The model named the tool but nothing has executed yet.
  assert.equal(tools(items).length, 1)
  assert.equal(tools(items)[0].status, 'proposed')
  assert.deepEqual(tools(items)[0].args, { command: 'echo hi' })

  items = applyEvents(items, [
    { type: 'tool_execution_start', toolCallId: callId, toolName: 'bash', args: { command: 'echo hi' } }
  ])
  assert.equal(tools(items).length, 1)
  assert.equal(tools(items)[0].status, 'running')

  // Several updates of the same call: the node count never grows and the
  // newest partial result replaces the previous one.
  items = applyEvents(items, [
    {
      type: 'tool_execution_update',
      toolCallId: callId,
      toolName: 'bash',
      args: { command: 'echo hi' },
      partialResult: { content: [{ type: 'text', text: 'hi' }] }
    },
    {
      type: 'tool_execution_update',
      toolCallId: callId,
      toolName: 'bash',
      args: { command: 'echo hi' },
      partialResult: { content: [{ type: 'text', text: 'hi\nhi' }] }
    }
  ])
  assert.equal(tools(items).length, 1)
  assert.equal(tools(items)[0].progress, 'hi\nhi')

  items = applyEvents(items, [
    {
      type: 'tool_execution_end',
      toolCallId: callId,
      toolName: 'bash',
      args: { command: 'echo hi' },
      result: {
        content: [{ type: 'text', text: 'hi\nhi' }],
        structuredContent: { output: 'hi\nhi', truncated: false, exit_code: 0, wall_time_seconds: 0.2 }
      },
      isError: false,
      durationMs: 210
    }
  ])
  assert.equal(tools(items).length, 1)
  assert.equal(tools(items)[0].status, 'ok')
  assert.equal(tools(items)[0].result, 'hi\nhi')
  assert.equal(tools(items)[0].exitCode, 0)
  assert.equal(tools(items)[0].durationMs, 210)
  // The partial result is not kept next to the final one.
  assert.equal(tools(items)[0].progress, undefined)
})

test('a tool error does not fail the run and keeps the node expandable', () => {
  const callId = 'call_err'
  let items: ThreadItem[] = applyEvents([], [assistantStart()])
  items = applyEvents(items, [
    update({ type: 'toolcall_start', contentIndex: 0, id: callId, toolName: 'bash' }),
    update({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: callId, name: 'bash', arguments: { command: 'false' } }
    }),
    {
      type: 'tool_execution_start',
      toolCallId: callId,
      toolName: 'bash',
      args: { command: 'false' }
    },
    {
      type: 'tool_execution_end',
      toolCallId: callId,
      toolName: 'bash',
      args: { command: 'false' },
      result: { content: [{ type: 'text', text: 'command failed' }], structuredContent: { exit_code: 1 } },
      isError: true,
      durationMs: 40
    }
  ])
  const node = tools(items)[0]
  assert.equal(node.status, 'error')
  assert.equal(node.isError, true)
  assert.equal(node.exitCode, 1)
  assert.equal(node.result, 'command failed')
})

test('a tool call that is never executed stays proposed', () => {
  // The model named a tool and the run ended before it ran. It must not be
  // shown as a success.
  let items: ThreadItem[] = applyEvents([], [assistantStart()])
  items = applyEvents(items, [
    update({ type: 'toolcall_start', contentIndex: 0, id: 'call_x', toolName: 'bash' }),
    update({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 'call_x', name: 'bash', arguments: { command: 'sleep 5' } }
    })
  ])
  items = markAborted(items)
  const node = tools(items)[0]
  assert.equal(node.status, 'proposed')
  assert.notEqual(node.status, 'ok')
})

/* ------------------------------------------------------------------ *
 * T06/T07 — parallel tools and the order of their nodes
 * ------------------------------------------------------------------ */

test('parallel tools keep their creation order however they finish', () => {
  const a = 'call_a'
  const b = 'call_b'
  let items: ThreadItem[] = applyEvents([], [assistantStart()])
  items = applyEvents(items, [
    update({ type: 'toolcall_start', contentIndex: 0, id: a, toolName: 'bash' }),
    update({ type: 'toolcall_start', contentIndex: 1, id: b, toolName: 'read' }),
    { type: 'tool_execution_start', toolCallId: a, toolName: 'bash', args: { command: 'echo a' } },
    { type: 'tool_execution_start', toolCallId: b, toolName: 'read', args: { path: 'p.json' } }
  ])
  assert.deepEqual(
    tools(items).map((tool) => tool.toolCallId),
    [a, b]
  )

  // The second one finishes first.
  items = applyEvents(items, [
    {
      type: 'tool_execution_end',
      toolCallId: b,
      toolName: 'read',
      args: { path: 'p.json' },
      result: { content: [{ type: 'text', text: '{}' }] },
      isError: false,
      durationMs: 5
    },
    {
      type: 'tool_execution_end',
      toolCallId: a,
      toolName: 'bash',
      args: { command: 'echo a' },
      result: { content: [{ type: 'text', text: 'a' }] },
      isError: false,
      durationMs: 30
    }
  ])
  assert.deepEqual(
    tools(items).map((tool) => tool.toolCallId),
    [a, b]
  )
  assert.deepEqual(
    tools(items).map((tool) => tool.status),
    ['ok', 'ok']
  )
})

test('a tool result arriving without a preceding execution event still has one node', () => {
  // Pi can report the result of a call the client never saw start (a
  // resumed run, say). The node is created once, with the final state.
  let items: ThreadItem[] = applyEvents([], [assistantStart()])
  items = applyEvents(items, [
    {
      type: 'tool_execution_end',
      toolCallId: 'call_ghost',
      toolName: 'grep',
      args: { pattern: 'x' },
      result: { content: [{ type: 'text', text: 'hit' }] },
      isError: false,
      durationMs: 12
    }
  ])
  assert.equal(tools(items).length, 1)
  assert.equal(tools(items)[0].status, 'ok')
  assert.equal(tools(items)[0].durationMs, 12)
})

test('tool_execution_start after toolcall_end does not lose the arguments', () => {
  let items: ThreadItem[] = applyEvents([], [assistantStart()])
  items = applyEvents(items, [
    update({ type: 'toolcall_start', contentIndex: 0, id: 'c1', toolName: 'read' }),
    update({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: { id: 'c1', name: 'read', arguments: { path: 'a.ts' } }
    })
  ])
  // `tool_execution_start` also carries the arguments, but an event that
  // arrives without them must not wipe the ones already known.
  items = applyEvents(items, [
    { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read' } as PiEvent
  ])
  assert.deepEqual(tools(items)[0].args, { path: 'a.ts' })
  assert.equal(tools(items)[0].status, 'running')
})

/* ------------------------------------------------------------------ *
 * T03 — the order of text, tool and text inside one turn
 * ------------------------------------------------------------------ */

test('text, tools and more text stay in the order they happened', () => {
  let items: ThreadItem[] = applyEvents([], [assistantStart()])
  items = applyEvents(items, [
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'Looking—' }),
    update({ type: 'text_end', contentIndex: 0, content: 'Looking—' }),
    update({ type: 'toolcall_start', contentIndex: 1, id: 'c1', toolName: 'read' }),
    update({ type: 'toolcall_delta', contentIndex: 1, delta: '{"path":"a.ts"}' }),
    update({
      type: 'toolcall_end',
      contentIndex: 1,
      toolCall: { id: 'c1', name: 'read', arguments: { path: 'a.ts' } }
    }),
    { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } },
    {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'read',
      args: { path: 'a.ts' },
      result: { content: [{ type: 'text', text: 'file body' }] },
      isError: false
    },
    update({ type: 'text_start', contentIndex: 2 }),
    update({ type: 'text_delta', contentIndex: 2, delta: 'Done.' })
  ])
  items = applyEvents(items, [
    assistantEnd([
      { type: 'text', text: 'Looking—' },
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
      { type: 'text', text: 'Done.' }
    ])
  ])

  const assistant = items.find((item) => item.kind === 'assistant')
  assert.ok(assistant && assistant.kind === 'assistant')
  assert.deepEqual(
    assistant.blocks.map((block) => block.type),
    ['text', 'toolCall', 'text']
  )
  // The tool node sits between the two text blocks in the item list, which
  // is what the renderer draws as one continuous stream.
  const kinds = items.map((item) => item.kind)
  assert.deepEqual(kinds, ['assistant', 'tool'])
})

/* ------------------------------------------------------------------ *
 * T08 — abort
 * ------------------------------------------------------------------ */

test('an aborted run keeps what was produced and marks the rest aborted', () => {
  let items: ThreadItem[] = applyEvents([], [userEvent('go'), userEnd('go'), assistantStart()])
  items = applyEvents(items, [
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'half an answer' }),
    update({ type: 'toolcall_start', contentIndex: 1, id: 'c1', toolName: 'bash' }),
    {
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'sleep 100' }
    }
  ])
  items = markAborted(items)

  assert.equal(texts(items), 'half an answer')
  assert.equal(tools(items)[0].status, 'aborted')
  const assistant = items.find((item) => item.kind === 'assistant')
  assert.ok(assistant && assistant.kind === 'assistant' && assistant.streaming === false)
})

/* ------------------------------------------------------------------ *
 * T11 — session isolation
 * ------------------------------------------------------------------ */

test('a replayed history and a live stream produce the same node kinds', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Sure.' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo hi' } }
      ],
      timestamp: 2
    },
    {
      role: 'toolResult',
      toolCallId: 'c1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'hi' }],
      isError: false,
      timestamp: 3
    },
    { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], timestamp: 4 }
  ]
  const hydrated = itemsFromMessages(messages as never)

  let live: ThreadItem[] = applyEvents([], [userEvent('hi'), userEnd('hi'), assistantStart()])
  live = applyEvents(live, [
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'Sure.' }),
    update({ type: 'text_end', contentIndex: 0, content: 'Sure.' }),
    update({ type: 'toolcall_start', contentIndex: 1, id: 'c1', toolName: 'bash' }),
    update({
      type: 'toolcall_end',
      contentIndex: 1,
      toolCall: { id: 'c1', name: 'bash', arguments: { command: 'echo hi' } }
    }),
    assistantEnd([
      { type: 'text', text: 'Sure.' },
      { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'echo hi' } }
    ]),
    {
      type: 'tool_execution_start',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'echo hi' }
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'echo hi' },
      result: { content: [{ type: 'text', text: 'hi' }] },
      isError: false
    },
    assistantStart(),
    update({ type: 'text_start', contentIndex: 0 }),
    update({ type: 'text_delta', contentIndex: 0, delta: 'Done.' }),
    update({ type: 'text_end', contentIndex: 0, content: 'Done.' }),
    assistantEnd([{ type: 'text', text: 'Done.' }])
  ])

  assert.deepEqual(
    live.map((item) => item.kind),
    hydrated.map((item) => item.kind)
  )
  assert.deepEqual(
    live.filter((item) => item.kind === 'tool').map((item) => (item as { status: string }).status),
    hydrated.filter((item) => item.kind === 'tool').map((item) => (item as { status: string }).status)
  )
  assert.equal(texts(live), texts(hydrated))
})

test('a replayed call without a result is still a proposed node', () => {
  const hydrated = itemsFromMessages([
    { role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'never-ran', name: 'bash', arguments: { command: 'sleep 5' } }],
      timestamp: 2
    }
  ] as never)
  const nodes = tools(hydrated)
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0].toolCallId, 'never-ran')
  assert.equal(nodes[0].status, 'proposed')
  assert.deepEqual(nodes[0].args, { command: 'sleep 5' })

  const afterAbort = markAborted(hydrated)
  assert.equal(tools(afterAbort)[0].status, 'proposed')
})

/* ------------------------------------------------------------------ *
 * T12 — long conversations
 * ------------------------------------------------------------------ */

test('a long conversation with many tools stays one node per call', () => {
  let items: ThreadItem[] = []
  for (let index = 0; index < 200; index += 1) {
    const id = `c${index}`
    items = applyEvents(items, [assistantStart()])
    items = applyEvents(items, [
      update({ type: 'toolcall_start', contentIndex: 0, id, toolName: 'read' }),
      update({ type: 'toolcall_end', contentIndex: 0, toolCall: { id, name: 'read', arguments: { path: `${index}.ts` } } }),
      { type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: `${index}.ts` } },
      {
        type: 'tool_execution_end',
        toolCallId: id,
        toolName: 'read',
        args: { path: `${index}.ts` },
        result: { content: [{ type: 'text', text: `body ${index}` }] },
        isError: false
      },
      assistantEnd([
        { type: 'text', text: `step ${index}` },
        { type: 'toolCall', id, name: 'read', arguments: { path: `${index}.ts` } }
      ])
    ])
  }
  assert.equal(tools(items).length, 200)
  assert.equal(new Set(tools(items).map((tool) => tool.toolCallId)).size, 200)
})

/* ------------------------------------------------------------------ *
 * notices
 * ------------------------------------------------------------------ */

test('compaction and retry notices are recorded, not swallowed', () => {
  let items: ThreadItem[] = []
  items = applyEvents(items, [{ type: 'compaction_start', reason: 'threshold' }])
  items = applyEvents(items, [
    { type: 'compaction_end', reason: 'threshold', aborted: false, result: { tokensBefore: 9000, estimatedTokensAfter: 2000 } }
  ])
  const notices = items.filter((item) => item.kind === 'notice')
  assert.equal(notices.length, 2)
  assert.ok(notices[0].kind === 'notice' && notices[0].level === 'info')
  assert.ok(notices[1].kind === 'notice' && notices[1].level === 'success')

  items = applyEvents(items, [
    { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 1000, errorMessage: 'overloaded' }
  ])
  const retry = items[items.length - 1]
  assert.ok(retry.kind === 'notice' && retry.level === 'warn')
  assert.match(retry.text, /attempt 2\/3/)
})

test('a rate-limit retry notice does not paste the provider payload', () => {
  const payload =
    'sensetime API error (429): {"message":"RPM (Requests Per Minute) limit of the model is exceeded","code":"ModelAccountRpmRateLimitExceeded"}'
  const items = applyEvents([], [
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 8, delayMs: 20_000, errorMessage: payload }
  ])
  const notice = items[items.length - 1]
  assert.ok(notice.kind === 'notice')
  assert.match(notice.text, /rate limit, next try in 20s/)
  assert.doesNotMatch(notice.text, /ModelAccountRpmRateLimitExceeded/)
})

test('a cancelled retry is a stopped attempt, and retry results use stream notices', () => {
  for (const [success, finalError, level, text] of [
    [false, 'Retry cancelled', 'warn', 'Retry cancelled'],
    [true, undefined, 'success', 'Retry succeeded'],
    [false, '429 RPM limit', 'error', 'Retry failed: still rate limited']
  ] as const) {
    const [item] = applyEvents([], [{ type: 'auto_retry_end', success, finalError }])
    assert.ok(item.kind === 'notice')
    assert.equal(item.source, 'retry')
    assert.equal(item.level, level)
    assert.equal(item.text, text)
  }
})

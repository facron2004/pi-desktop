import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { bridgeRuntime, type IpcContext } from '../src/main/ipc'
import type { PiEvent, RuntimeEvent, RuntimeQueueEvent } from '../src/shared/types'

interface MockSentMessage {
  channel: string
  payload: any
  timestamp: number
}

function unwrapRuntimeEvents(sent: MockSentMessage[]): RuntimeEvent[] {
  return sent
    .filter((s) => s.channel === 'runtime:event')
    .flatMap((s) => (Array.isArray(s.payload) ? s.payload : [s.payload]))
}

const flushBatch = () => new Promise<void>((resolve) => setTimeout(resolve, 35))

class MockBrowserWindow extends EventEmitter {
  isDestroyedVal = false
  contentsDestroyedVal = false
  sent: MockSentMessage[] = []

  isDestroyed(): boolean {
    return this.isDestroyedVal
  }

  isFocused(): boolean {
    return true
  }

  get webContents() {
    return {
      isDestroyed: () => this.contentsDestroyedVal,
      send: (channel: string, payload: any) => {
        this.sent.push({
          channel,
          payload: JSON.parse(JSON.stringify(payload)),
          timestamp: performance.now()
        })
      }
    }
  }
}

function createTestContext(window: MockBrowserWindow, supervisor: EventEmitter): IpcContext {
  return {
    supervisor: supervisor as any,
    settings: {
      getCached: () => ({ desktopNotifications: false })
    } as any,
    getWindow: () => window as any,
    terminals: {} as any,
    memory: new EventEmitter() as any,
    remote: {} as any,
    remoteReady: Promise.resolve(),
    scheduledTasks: new EventEmitter() as any
  }
}

test('IPC: multi-session interleaved streaming token coalescing across distinct sessions', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  // Dispatch 9 deltas interleaved round-robin across 3 sessions
  const sessions = ['session-A', 'session-B', 'session-C']
  const tokens = ['T1 ', 'T2 ', 'T3']

  for (const token of tokens) {
    for (const session of sessions) {
      supervisor.emit('event', {
        ownerId: session,
        event: {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: `${session}:${token}`
          }
        } as PiEvent
      })
    }
  }

  // Await 8ms batch flush timer
  await flushBatch()

  const rawDeliveries = window.sent.filter((s) => s.channel === 'runtime:event')
  const deliveries = unwrapRuntimeEvents(window.sent)

  // Under per-owner coalescing, exactly 3 single-event deliveries should occur (1 per session)
  assert.equal(
    rawDeliveries.length,
    3,
    `Expected 3 coalesced deliveries for 3 sessions, got ${rawDeliveries.length}`
  )

  for (const session of sessions) {
    const event = deliveries.find((d) => d.ownerId === session)
    assert.ok(event, `Delivery for ${session} must be present`)
    const expectedText = `${session}:T1 ${session}:T2 ${session}:T3`
    assert.equal(
      (event.event as any).assistantMessageEvent.delta,
      expectedText,
      `Text for ${session} should match concatenated tokens`
    )
  }
})

test('IPC: coalesced thinking deltas keep the latest redaction snapshot', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  for (const redacted of [false, true]) {
    const thinking = redacted ? 'Redacted' : 'Before'
    const partial = { role: 'assistant', content: [{ type: 'thinking', thinking, redacted }] }
    supervisor.emit('event', {
      ownerId: 'session-thinking',
      event: {
        type: 'message_update',
        message: partial,
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: thinking, partial }
      }
    })
  }

  await flushBatch()
  const deliveries = unwrapRuntimeEvents(window.sent)
  assert.equal(deliveries.length, 1)
  const payload = deliveries[0].event.assistantMessageEvent as { delta: string; partial: { content: { redacted: boolean }[] } }
  assert.equal(payload.delta, 'BeforeRedacted')
  assert.equal(payload.partial.content[0].redacted, true)
})

test('IPC: synchronous flush ahead of structural events guarantees zero event-order inversion and preserves other sessions', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  supervisor.emit('event', {
    ownerId: 'session-A',
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Finished work.' }
    } as PiEvent
  })

  supervisor.emit('event', {
    ownerId: 'session-B',
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Still thinking...' }
    } as PiEvent
  })

  // Session A emits structural agent_settled immediately without awaiting batch timer
  supervisor.emit('event', {
    ownerId: 'session-A',
    event: {
      type: 'agent_settled',
      aborted: false
    } as PiEvent
  })

  // Selective per-owner flush: Session A flushed synchronously; Session B stays buffered until timer
  const syncEvents = unwrapRuntimeEvents(window.sent)
  assert.deepEqual(
    syncEvents.map((e) => `${e.ownerId}:${e.event.type}`),
    ['session-A:message_update', 'session-A:agent_settled'],
    'Only session-A deltas must flush synchronously ahead of session-A structural event'
  )

  await flushBatch()

  const deliveries = unwrapRuntimeEvents(window.sent)

  const settledIndex = deliveries.findIndex(
    (d) => d.ownerId === 'session-A' && d.event.type === 'agent_settled'
  )
  const aTextIndex = deliveries.findIndex(
    (d) => d.ownerId === 'session-A' && d.event.type === 'message_update'
  )
  const bTextIndex = deliveries.findIndex(
    (d) => d.ownerId === 'session-B' && d.event.type === 'message_update'
  )

  assert.ok(aTextIndex >= 0, 'Session A text delta must be delivered')
  assert.ok(settledIndex >= 0, 'Session A agent_settled must be delivered')
  assert.ok(bTextIndex > settledIndex, 'Session B delta should arrive later on batch timer')
  assert.ok(
    aTextIndex < settledIndex,
    `Text delta (index ${aTextIndex}) must precede agent_settled (index ${settledIndex})`
  )
})

test('IPC: tool_execution_update replaces earlier snapshots in-place with multi-session isolation', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  supervisor.emit('event', {
    ownerId: 'session-A',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: 'A step 1'
    } as PiEvent
  })
  supervisor.emit('event', {
    ownerId: 'session-B',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: 'B step 1'
    } as PiEvent
  })
  supervisor.emit('event', {
    ownerId: 'session-A',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: 'A step 2 (final)'
    } as PiEvent
  })
  supervisor.emit('event', {
    ownerId: 'session-B',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      partialResult: 'B step 2 (final)'
    } as PiEvent
  })

  await flushBatch()

  const deliveries = unwrapRuntimeEvents(window.sent).filter(
    (e) => e.event.type === 'tool_execution_update'
  )

  assert.equal(deliveries.length, 2, 'Earlier tool updates must be replaced in-place')

  const aUpdate = deliveries.find((d) => d.ownerId === 'session-A')
  const bUpdate = deliveries.find((d) => d.ownerId === 'session-B')

  assert.equal((aUpdate?.event as any).partialResult, 'A step 2 (final)')
  assert.equal((bUpdate?.event as any).partialResult, 'B step 2 (final)')
})

test('IPC: stream coalescing does not mutate input event objects in-place', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  const inputEvent1: PiEvent = {
    type: 'message_update',
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'Initial '
    }
  } as any

  const inputEvent2: PiEvent = {
    type: 'message_update',
    assistantMessageEvent: {
      type: 'text_delta',
      contentIndex: 0,
      delta: 'Appended'
    }
  } as any

  supervisor.emit('event', {
    ownerId: 'session-immutability',
    event: inputEvent1
  })
  supervisor.emit('event', {
    ownerId: 'session-immutability',
    event: inputEvent2
  })

  await flushBatch()

  // The original objects passed in must not have been mutated
  const sub1 = (inputEvent1 as any).assistantMessageEvent
  const sub2 = (inputEvent2 as any).assistantMessageEvent
  assert.equal(sub1.delta, 'Initial ', 'Original inputEvent1 must remain untouched')
  assert.equal(sub2.delta, 'Appended', 'Original inputEvent2 must remain untouched')

  const deliveries = unwrapRuntimeEvents(window.sent)
  assert.equal(deliveries.length, 1)
  assert.equal(
    (deliveries[0].event as any).assistantMessageEvent.delta,
    'Initial Appended',
    'Delivered event must contain the coalesced text'
  )
})

test('IPC: intra-session transition separation strictly preserves ordering between thinking and text in a batch', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  // In the same session: thinking_delta followed by text_delta
  supervisor.emit('event', {
    ownerId: 'session-transition',
    event: {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'thought'
      }
    } as PiEvent
  })

  supervisor.emit('event', {
    ownerId: 'session-transition',
    event: {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'answer'
      }
    } as PiEvent
  })

  await flushBatch()

  const rawDeliveries = window.sent.filter((s) => s.channel === 'runtime:event')
  assert.equal(rawDeliveries.length, 1, 'Incompatible items within one owner window arrive in one batch IPC')
  assert.ok(Array.isArray(rawDeliveries[0].payload), 'Batch with >1 item is sent as RuntimeEvent[]')

  const deliveries = unwrapRuntimeEvents(window.sent).filter(
    (e) => e.ownerId === 'session-transition'
  )

  // Must not coalesce thinking_delta and text_delta together; must deliver both in strict order
  assert.equal(deliveries.length, 2, 'Incompatible event types for the same session must remain separate')
  assert.equal((deliveries[0].event as any).assistantMessageEvent.type, 'thinking_delta')
  assert.equal((deliveries[1].event as any).assistantMessageEvent.type, 'text_delta')
})

test('IPC: toolcall_delta coalesces per contentIndex without crossing incompatible indices', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  supervisor.emit('event', {
    ownerId: 'sess-tc',
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"cmd":' }
    } as PiEvent
  })
  supervisor.emit('event', {
    ownerId: 'sess-tc',
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '"ls"}' }
    } as PiEvent
  })
  supervisor.emit('event', {
    ownerId: 'sess-tc',
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 1, delta: '{}' }
    } as PiEvent
  })

  await flushBatch()

  const events = unwrapRuntimeEvents(window.sent)
  assert.equal(events.length, 2)
  assert.equal((events[0].event as any).assistantMessageEvent.contentIndex, 0)
  assert.equal((events[0].event as any).assistantMessageEvent.delta, '{"cmd":"ls"}')
  assert.equal((events[1].event as any).assistantMessageEvent.contentIndex, 1)
  assert.equal((events[1].event as any).assistantMessageEvent.delta, '{}')
})

test('IPC: runtime:queue events, batched runtime:stderr, and recreated window cleanup', async () => {
  let currentWindow = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime({
    supervisor: supervisor as any,
    settings: {
      getCached: () => ({ desktopNotifications: false })
    } as any,
    getWindow: () => currentWindow as any,
    terminals: {} as any,
    memory: new EventEmitter() as any,
    remote: {} as any,
    remoteReady: Promise.resolve(),
    scheduledTasks: new EventEmitter() as any
  })

  const queuePayload: RuntimeQueueEvent = {
    ownerId: 'sess-2',
    cwd: 'E:/repo',
    queued: true,
    position: 1,
    holderOwnerId: 'sess-1',
    externalHolder: false
  }
  supervisor.emit('queued', queuePayload)

  supervisor.emit('stderr', { ownerId: 'sess-2', line: 'warn 1' })
  supervisor.emit('stderr', { ownerId: 'sess-2', line: 'warn 2' })
  supervisor.emit('rekey', { from: 'sess-2', to: 'E:/sessions/s2.jsonl', replace: true })

  assert.deepEqual(
    currentWindow.sent.map((m) => [m.channel, m.payload]),
    [
      ['runtime:queue', queuePayload],
      ['runtime:stderr', { ownerId: 'sess-2', line: 'warn 1\nwarn 2' }],
      ['runtime:rekey', { from: 'sess-2', to: 'E:/sessions/s2.jsonl', replace: true }]
    ]
  )

  // Switch to a recreated window, buffer events, and close it before timer fires.
  currentWindow.isDestroyedVal = true
  const recreated = new MockBrowserWindow()
  currentWindow = recreated

  supervisor.emit('event', {
    ownerId: 'sess-new',
    event: {
      type: 'message_delta',
      delta: 'should drop on close'
    } as PiEvent
  })
  recreated.emit('closed')
  recreated.isDestroyedVal = true

  await flushBatch()
  assert.equal(recreated.sent.length, 0, 'Closed recreated window must drop pending buffered events')
})

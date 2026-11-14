import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { bridgeRuntime, type IpcContext } from '../src/main/ipc'
import type { PiEvent } from '../src/shared/types'

interface MockSentMessage {
  channel: string
  payload: any
  timestamp: number
}

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

  // Await microtask flush
  await new Promise((resolve) => setTimeout(resolve, 30))

  const deliveries = window.sent.filter((s) => s.channel === 'runtime:event')

  // Under backward-scan coalescing, exactly 3 deliveries should occur (1 per session)
  assert.equal(
    deliveries.length,
    3,
    `Expected 3 coalesced deliveries for 3 sessions, got ${deliveries.length}`
  )

  for (const session of sessions) {
    const delivery = deliveries.find((d) => d.payload.ownerId === session)
    assert.ok(delivery, `Delivery for ${session} must be present`)
    const expectedText = `${session}:T1 ${session}:T2 ${session}:T3`
    assert.equal(
      delivery.payload.event.assistantMessageEvent.delta,
      expectedText,
      `Text for ${session} should match concatenated tokens`
    )
  }
})

test('IPC: synchronous flush ahead of structural events guarantees zero event-order inversion', async () => {
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

  // Session A emits structural agent_settled immediately without awaiting microtask
  supervisor.emit('event', {
    ownerId: 'session-A',
    event: {
      type: 'agent_settled',
      aborted: false
    } as PiEvent
  })

  await new Promise((resolve) => setTimeout(resolve, 30))

  const deliveries = window.sent.filter((s) => s.channel === 'runtime:event')

  const settledIndex = deliveries.findIndex(
    (d) => d.payload.ownerId === 'session-A' && d.payload.event.type === 'agent_settled'
  )
  const aTextIndex = deliveries.findIndex(
    (d) => d.payload.ownerId === 'session-A' && d.payload.event.type === 'message_update'
  )

  assert.ok(aTextIndex >= 0, 'Session A text delta must be delivered')
  assert.ok(settledIndex >= 0, 'Session A agent_settled must be delivered')
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

  await new Promise((resolve) => setTimeout(resolve, 30))

  const deliveries = window.sent.filter(
    (s) => s.channel === 'runtime:event' && s.payload.event.type === 'tool_execution_update'
  )

  assert.equal(deliveries.length, 2, 'Earlier tool updates must be replaced in-place')

  const aUpdate = deliveries.find((d) => d.payload.ownerId === 'session-A')
  const bUpdate = deliveries.find((d) => d.payload.ownerId === 'session-B')

  assert.equal(aUpdate?.payload.event.partialResult, 'A step 2 (final)')
  assert.equal(bUpdate?.payload.event.partialResult, 'B step 2 (final)')
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

  await new Promise((resolve) => setTimeout(resolve, 30))

  // The original objects passed in must not have been mutated
  const sub1 = (inputEvent1 as any).assistantMessageEvent
  const sub2 = (inputEvent2 as any).assistantMessageEvent
  assert.equal(sub1.delta, 'Initial ', 'Original inputEvent1 must remain untouched')
  assert.equal(sub2.delta, 'Appended', 'Original inputEvent2 must remain untouched')

  const deliveries = window.sent.filter((s) => s.channel === 'runtime:event')
  assert.equal(deliveries.length, 1)
  assert.equal(
    deliveries[0].payload.event.assistantMessageEvent.delta,
    'Initial Appended',
    'Delivered event must contain the coalesced text'
  )
})

test('IPC: intra-session transition separation strictly preserves ordering between thinking and text', async () => {
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

  await new Promise((resolve) => setTimeout(resolve, 30))

  const deliveries = window.sent.filter(
    (s) => s.channel === 'runtime:event' && s.payload.ownerId === 'session-transition'
  )

  // Must not coalesce thinking_delta and text_delta together; must deliver both in strict order
  assert.equal(deliveries.length, 2, 'Incompatible event types for the same session must remain separate')
  assert.equal(deliveries[0].payload.event.assistantMessageEvent.type, 'thinking_delta')
  assert.equal(deliveries[1].payload.event.assistantMessageEvent.type, 'text_delta')
})

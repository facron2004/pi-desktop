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
  throwOnSend = false

  isDestroyed(): boolean {
    return this.isDestroyedVal
  }

  isFocused(): boolean {
    return true
  }

  destroy(): void {
    this.isDestroyedVal = true
    this.contentsDestroyedVal = true
    this.emit('closed')
  }

  get webContents() {
    return {
      isDestroyed: () => this.contentsDestroyedVal,
      send: (channel: string, payload: any) => {
        if (this.contentsDestroyedVal) {
          throw new Error('Object has been destroyed: cannot send to webContents')
        }
        if (this.throwOnSend) {
          throw new Error('Simulated Electron IPC transport error')
        }
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

const flushTicks = () => new Promise<void>((resolve) => setTimeout(resolve, 30))

// -----------------------------------------------------------------------------
// STRESS TEST 1: Multi-Session Interleaved Flooding (4 sessions, 2,000+ tokens)
// -----------------------------------------------------------------------------
test('Adversarial Stress: 4 sessions round-robin interleaved (2,000 tokens) achieves >90% reduction without blocking', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  const sessions = ['sess-A', 'sess-B', 'sess-C', 'sess-D']
  const tokensPerSession = 500 // 4 * 500 = 2,000 deltas total
  const expectedText: Record<string, string> = {
    'sess-A': '',
    'sess-B': '',
    'sess-C': '',
    'sess-D': ''
  }

  // Interleave round-robin: A0, B0, C0, D0, A1, B1, C1, D1, ...
  for (let i = 0; i < tokensPerSession; i++) {
    for (const s of sessions) {
      const token = `[${s}:${i}] `
      expectedText[s] += token
      supervisor.emit('event', {
        ownerId: s,
        event: {
          type: 'message_update',
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 0,
            delta: token
          }
        } as PiEvent
      })
    }
  }

  await flushTicks()

  const deliveries = window.sent.filter((s) => s.channel === 'runtime:event')

  // Under backward-scan coalescing, exactly 4 deliveries should occur (1 per session)
  const reductionRatio = ((2000 - deliveries.length) / 2000) * 100
  console.log(`\n  -> Interleaved 2,000 deltas across 4 sessions. Deliveries: ${deliveries.length}`)
  console.log(`  -> Coalescing reduction ratio: ${reductionRatio.toFixed(2)}% (Target: >90%)`)

  assert.ok(
    reductionRatio >= 90,
    `Coalescing reduction must exceed 90%, achieved ${reductionRatio.toFixed(2)}%`
  )
  assert.equal(
    deliveries.length,
    4,
    `Expected exactly 4 deliveries (1 per session), got ${deliveries.length}`
  )

  // Verify intra-session chronological ordering and zero cross-talk
  const reconstructedText: Record<string, string> = {
    'sess-A': '',
    'sess-B': '',
    'sess-C': '',
    'sess-D': ''
  }

  for (const delivery of deliveries) {
    const ownerId = delivery.payload.ownerId
    assert.ok(sessions.includes(ownerId), `Unexpected ownerId: ${ownerId}`)
    const delta = delivery.payload.event.assistantMessageEvent.delta
    reconstructedText[ownerId] += delta
  }

  for (const s of sessions) {
    assert.equal(
      reconstructedText[s],
      expectedText[s],
      `Reconstructed stream for session ${s} must match expected verbatim without loss or reordering`
    )
  }
})

// -----------------------------------------------------------------------------
// STRESS TEST 2: High Concurrency Interleaved Flooding (8 sessions, 4,000 tokens)
// -----------------------------------------------------------------------------
test('Adversarial Stress: 8 sessions round-robin interleaved (4,000 tokens) achieves >90% reduction', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  const sessions = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']
  const tokensPerSession = 500 // 8 * 500 = 4,000 deltas total
  const expectedText: Record<string, string> = {}
  for (const s of sessions) expectedText[s] = ''

  for (let i = 0; i < tokensPerSession; i++) {
    for (const s of sessions) {
      const token = `${s}_t${i} `
      expectedText[s] += token
      supervisor.emit('event', {
        ownerId: s,
        event: {
          type: 'message_delta',
          delta: token
        } as PiEvent
      })
    }
  }

  await flushTicks()

  const deliveries = window.sent.filter((s) => s.channel === 'runtime:event')
  const reductionRatio = ((4000 - deliveries.length) / 4000) * 100
  console.log(`\n  -> Interleaved 4,000 deltas across 8 sessions. Deliveries: ${deliveries.length}`)
  console.log(`  -> Coalescing reduction ratio: ${reductionRatio.toFixed(2)}%`)

  assert.ok(reductionRatio >= 90)
  assert.equal(deliveries.length, 8, `Expected exactly 8 deliveries (1 per session), got ${deliveries.length}`)

  for (const s of sessions) {
    const delivery = deliveries.find((d) => d.payload.ownerId === s)
    assert.ok(delivery, `Delivery for ${s} must exist`)
    assert.equal(delivery.payload.event.delta, expectedText[s])
  }
})

// -----------------------------------------------------------------------------
// STRESS TEST 3: Incompatible Events Break Coalescing and Maintain Chronological Order
// -----------------------------------------------------------------------------
test('Adversarial Stress: Incompatible event sequence interleaved across sessions preserves strict ordering', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  // Session 1: thinking_delta -> text_delta -> thinking_delta -> text_delta
  // Interleaved with Session 2 emitting text_delta
  const s1 = 'session-complex-1'
  const s2 = 'session-complex-2'

  // S1: thinking 1
  supervisor.emit('event', {
    ownerId: s1,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'think_part1 ' }
    } as PiEvent
  })
  // S2: text 1
  supervisor.emit('event', {
    ownerId: s2,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 's2_text1 ' }
    } as PiEvent
  })
  // S1: thinking 2 (should coalesce with thinking 1)
  supervisor.emit('event', {
    ownerId: s1,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'think_part2' }
    } as PiEvent
  })
  // S1: text 1 (INCOMPATIBLE with thinking -> must break coalescing and create new entry)
  supervisor.emit('event', {
    ownerId: s1,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'answer_part1 ' }
    } as PiEvent
  })
  // S2: text 2 (should coalesce with s2 text 1)
  supervisor.emit('event', {
    ownerId: s2,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 's2_text2' }
    } as PiEvent
  })
  // S1: text 2 (same contentIndex and type -> should coalesce with answer_part1)
  supervisor.emit('event', {
    ownerId: s1,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'answer_part2' }
    } as PiEvent
  })
  // S1: different contentIndex 1 text (INCOMPATIBLE due to contentIndex -> must break)
  supervisor.emit('event', {
    ownerId: s1,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'block2_text' }
    } as PiEvent
  })
  // S1: thinking at contentIndex 1 (INCOMPATIBLE due to type -> must break)
  supervisor.emit('event', {
    ownerId: s1,
    event: {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'block2_think' }
    } as PiEvent
  })

  await flushTicks()

  const deliveries = window.sent.filter((s) => s.channel === 'runtime:event')

  const s1Deliveries = deliveries.filter((d) => d.payload.ownerId === s1)
  const s2Deliveries = deliveries.filter((d) => d.payload.ownerId === s2)

  // S2 should have 1 coalesced delivery: 's2_text1 s2_text2'
  assert.equal(s2Deliveries.length, 1, 'S2 text deltas must coalesce into 1 delivery')
  assert.equal(s2Deliveries[0].payload.event.assistantMessageEvent.delta, 's2_text1 s2_text2')

  // S1 should have 4 separate deliveries in strict chronological order:
  // 1. thinking_delta (idx 0): 'think_part1 think_part2'
  // 2. text_delta (idx 0): 'answer_part1 answer_part2'
  // 3. text_delta (idx 1): 'block2_text'
  // 4. thinking_delta (idx 1): 'block2_think'
  assert.equal(s1Deliveries.length, 4, `S1 must have 4 distinct phase blocks, got ${s1Deliveries.length}`)

  assert.equal(s1Deliveries[0].payload.event.assistantMessageEvent.type, 'thinking_delta')
  assert.equal(s1Deliveries[0].payload.event.assistantMessageEvent.contentIndex, 0)
  assert.equal(s1Deliveries[0].payload.event.assistantMessageEvent.delta, 'think_part1 think_part2')

  assert.equal(s1Deliveries[1].payload.event.assistantMessageEvent.type, 'text_delta')
  assert.equal(s1Deliveries[1].payload.event.assistantMessageEvent.contentIndex, 0)
  assert.equal(s1Deliveries[1].payload.event.assistantMessageEvent.delta, 'answer_part1 answer_part2')

  assert.equal(s1Deliveries[2].payload.event.assistantMessageEvent.type, 'text_delta')
  assert.equal(s1Deliveries[2].payload.event.assistantMessageEvent.contentIndex, 1)
  assert.equal(s1Deliveries[2].payload.event.assistantMessageEvent.delta, 'block2_text')

  assert.equal(s1Deliveries[3].payload.event.assistantMessageEvent.type, 'thinking_delta')
  assert.equal(s1Deliveries[3].payload.event.assistantMessageEvent.contentIndex, 1)
  assert.equal(s1Deliveries[3].payload.event.assistantMessageEvent.delta, 'block2_think')
})

// -----------------------------------------------------------------------------
// STRESS TEST 4: Immediate Structural Events Force Immediate Synchronous Flush
// -----------------------------------------------------------------------------
test('Adversarial Stress: ALL 13 structural events + dialogs force immediate synchronous flush without inversion', async () => {
  const structuralEvents: PiEvent[] = [
    { type: 'agent_start' } as any,
    { type: 'turn_start' } as any,
    { type: 'message_start', message: { role: 'assistant' } } as any,
    { type: 'toolcall_start', toolCallId: 't1', toolName: 'exec' } as any,
    { type: 'toolcall_end', toolCallId: 't1', toolName: 'exec' } as any,
    { type: 'tool_execution_start', toolCallId: 't1' } as any,
    { type: 'tool_execution_end', toolCallId: 't1', result: 'ok' } as any,
    { type: 'message_end', message: { role: 'assistant' } } as any,
    { type: 'turn_end' } as any,
    { type: 'agent_end' } as any,
    { type: 'agent_settled', aborted: false } as any,
    { type: 'extension_ui_request', id: 'ui-req-1', method: 'confirm', message: 'Proceed?' } as any,
    { type: 'extension_ui_response', id: 'ui-req-1', result: true } as any
  ]

  for (const structEvent of structuralEvents) {
    const window = new MockBrowserWindow()
    const supervisor = new EventEmitter()
    bridgeRuntime(createTestContext(window, supervisor))

    // Step 1: Queue a pending text delta
    supervisor.emit('event', {
      ownerId: 'sess-sync',
      event: {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: `Preceding text before ${structEvent.type}` }
      } as PiEvent
    })

    // At this exact moment, before microtask ticks, queue has not flushed asynchronously.
    // Step 2: Synchronously emit the structural event!
    supervisor.emit('event', {
      ownerId: 'sess-sync',
      event: structEvent
    })

    // SYNCHRONOUS ASSERTION: The window must have ALREADY received BOTH messages immediately!
    assert.equal(
      window.sent.length,
      2,
      `Structural event ${structEvent.type} must trigger synchronous flush immediately. Sent count: ${window.sent.length}`
    )

    // Preceding text delta must strictly precede the structural event
    assert.equal(window.sent[0].payload.event.type, 'message_update')
    assert.equal(window.sent[0].payload.event.assistantMessageEvent.delta, `Preceding text before ${structEvent.type}`)
    assert.equal(window.sent[1].payload.event.type, structEvent.type)

    // Await microtask and verify NO duplicate deliveries occur
    await flushTicks()
    assert.equal(
      window.sent.length,
      2,
      `No duplicate flushes should occur after microtask tick for ${structEvent.type}`
    )
  }
})

// -----------------------------------------------------------------------------
// STRESS TEST 5: Supervisor Status and Rekey Force Immediate Synchronous Flush
// -----------------------------------------------------------------------------
test('Adversarial Stress: supervisor status and rekey force immediate synchronous flush', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  // Queue text delta
  supervisor.emit('event', {
    ownerId: 'sess-status',
    event: {
      type: 'message_delta',
      delta: 'Delta before status'
    } as PiEvent
  })

  // Emit status synchronously
  supervisor.emit('status', {
    ownerId: 'sess-status',
    status: { running: true, phase: 'active' }
  })

  assert.equal(window.sent.length, 2, 'Status must synchronously flush pending deltas')
  assert.equal(window.sent[0].channel, 'runtime:event')
  assert.equal(window.sent[0].payload.event.delta, 'Delta before status')
  assert.equal(window.sent[1].channel, 'runtime:status')

  // Queue another delta
  supervisor.emit('event', {
    ownerId: 'sess-rekey',
    event: {
      type: 'message_delta',
      delta: 'Delta before rekey'
    } as PiEvent
  })

  // Emit rekey synchronously
  supervisor.emit('rekey', {
    from: 'sess-rekey',
    to: 'sess-rekeyed-target'
  })

  assert.equal(window.sent.length, 4, 'Rekey must synchronously flush pending deltas')
  assert.equal(window.sent[2].channel, 'runtime:event')
  assert.equal(window.sent[2].payload.event.delta, 'Delta before rekey')
  assert.equal(window.sent[3].channel, 'runtime:rekey')
})

// -----------------------------------------------------------------------------
// STRESS TEST 6: Window Closed Discards Pending Queue Without Memory Leak
// -----------------------------------------------------------------------------
test('Adversarial Stress: Window destruction mid-stream cleanly cleans up queue', async () => {
  const window = new MockBrowserWindow()
  const supervisor = new EventEmitter()
  bridgeRuntime(createTestContext(window, supervisor))

  // Queue 100 deltas
  for (let i = 0; i < 100; i++) {
    supervisor.emit('event', {
      ownerId: 'sess-closed',
      event: {
        type: 'message_delta',
        delta: `delta ${i} `
      } as PiEvent
    })
  }

  // Destroy window before microtask flush
  window.destroy()

  await flushTicks()

  // Window is destroyed, so zero events should have been sent to destroyed window
  assert.equal(window.sent.length, 0, 'No events sent to destroyed window')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionMetrics } from '../src/renderer/src/lib/session-metrics'
import type { AssistantItem, ThreadItem, UserItem } from '../src/renderer/src/lib/thread'
import type { SessionStats } from '../src/shared/types'

function user(id: string): UserItem {
  return { id, kind: 'user', text: id, images: [], timestamp: 1, order: 1 }
}

function assistant(id: string, output: number, input = 100, cacheRead = 100): AssistantItem {
  return {
    id,
    kind: 'assistant',
    blocks: [{ type: 'text', text: id }],
    streaming: false,
    timestamp: 2,
    order: 2,
    usage: {
      input,
      output,
      cacheRead,
      cacheWrite: 0,
      totalTokens: input + output + cacheRead
    }
  }
}

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 100, output: 50, cacheRead: 100, cacheWrite: 0, total: 250 },
    cost: 0,
    ...overrides
  }
}

test('token totals and the hit rate come from the transcript', () => {
  const metrics = sessionMetrics(
    [user('u1'), assistant('a1', 50), assistant('a2', 50)],
    undefined,
    {}
  )
  assert.equal(metrics.totalTokens, 500)
  assert.equal(metrics.cacheHitPercent, 50)
})

test('a live get_session_stats reading wins over the visible transcript', () => {
  const metrics = sessionMetrics(
    [user('u1'), assistant('a1', 50)],
    stats({ tokens: { input: 300, output: 90, cacheRead: 700, cacheWrite: 0, total: 1090 } }),
    {}
  )
  assert.equal(metrics.totalTokens, 1090)
  assert.equal(metrics.cacheHitPercent, 70)
})

test('cache writes belong to the prompt base of the hit rate', () => {
  const metrics = sessionMetrics(
    [],
    stats({ tokens: { input: 100, output: 50, cacheRead: 700, cacheWrite: 200, total: 1_050 } }),
    {}
  )
  // 700 read / (100 input + 700 read + 200 write)
  assert.equal(metrics.cacheHitPercent, 70)
  assert.equal(metrics.cacheWriteTokens, 200)
})

test('the context reading is a projection of get_session_stats', () => {
  const metrics = sessionMetrics(
    [],
    stats({ contextUsage: { tokens: 18_000, contextWindow: 200_000, percent: 9 } }),
    {}
  )
  assert.deepEqual(
    [metrics.contextTokens, metrics.contextWindow, metrics.contextPercent],
    [18_000, 200_000, 9]
  )
  const cold = sessionMetrics([], undefined, {})
  assert.equal(cold.contextTokens, null)
  assert.equal(cold.cacheHitPercent, null)
})

test('TTFT uses the sample measured from run start to the first text delta', () => {
  const metrics = sessionMetrics([], undefined, {
    runId: 'run-1',
    startedAt: 1_000,
    startedMonotonicAt: 100,
    ttftMs: 820,
    firstTokenAt: 1_820
  })
  assert.equal(metrics.ttftMs, 820)
  assert.equal(sessionMetrics([], undefined, { startedAt: 1_000, firstTokenAt: 1_820 }).ttftMs, null)
})

test('TTFT average includes the current prompt run when its sample is not yet persisted', () => {
  const run = {
    runId: 'run-current',
    ttftMs: 26_500
  }
  const metrics = sessionMetrics([], undefined, run)
  assert.equal(metrics.ttftMs, 26_500)
  assert.equal(metrics.averageTtftMs, 26_500)
})

test('model time and average TTFT use locally recorded session samples', () => {
  const metrics = sessionMetrics(
    [],
    stats({ userMessages: 2 }),
    { settled: true },
    {
      modelDurationsMs: { turn1: 1_200, turn2: 2_800 },
      ttftDurationsMs: { run1: 600, run2: 1_000 },
      toolDurationsMs: {},
      runDurationsMs: {},
      generationWindowMs: {}
    }
  )
  assert.equal(metrics.modelTimeMs, 4_000)
  assert.equal(metrics.averageTtftMs, 800)
})

test('a settled run keeps its measured TTFT when local storage did not record it', () => {
  const metrics = sessionMetrics([], undefined, {
    runId: 'run-current',
    ttftMs: 250,
    settled: true
  })
  assert.equal(metrics.averageTtftMs, 250)
})

test('average TTFT counts one sample per run across multiple model turns', () => {
  const metrics = sessionMetrics([], undefined, {
    runId: 'run-2',
    turnId: 'turn-2',
    ttftMs: 300
  }, {
    modelDurationsMs: {},
    ttftDurationsMs: { 'run-1': 100, 'run-2': 300 },
    toolDurationsMs: {},
    runDurationsMs: {},
    generationWindowMs: {}
  })
  assert.equal(metrics.ttftMs, 300)
  assert.equal(metrics.averageTtftMs, 200)
})

test('live model time uses a monotonic clock', () => {
  const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => 1_800 }
  })
  try {
    const metrics = sessionMetrics([], undefined, { modelTurnStartedAt: 1_000, settled: false })
    assert.equal(metrics.modelTimeMs, 800)
  } finally {
    if (performanceDescriptor) Object.defineProperty(globalThis, 'performance', performanceDescriptor)
  }
})

test('tool time uses persisted client timings when Pi did not save a duration', () => {
  const tool: ThreadItem = {
    id: 'tool-1',
    kind: 'tool',
    toolCallId: 'call-1',
    toolName: 'read',
    args: {},
    status: 'ok',
    timestamp: 1,
    order: 1
  }
  const metrics = sessionMetrics(
    [tool],
    stats({ toolCalls: 2 }),
    {},
    {
      modelDurationsMs: {},
      ttftDurationsMs: {},
      toolDurationsMs: { 'call-1': 450 },
      runDurationsMs: {},
      generationWindowMs: {}
    }
  )
  assert.equal(metrics.toolTimeMs, 450)
  assert.equal(metrics.timedToolCalls, 1)
})

test('TPS is the newest turn\'s output over the generation window', () => {
  const items: ThreadItem[] = [
    user('u1'),
    assistant('a1', 1000),
    user('u2'),
    assistant('a2', 120)
  ]
  const metrics = sessionMetrics(items, undefined, {
    firstTokenAt: 10_000,
    lastTokenAt: 12_000
  })
  assert.equal(metrics.tps, 60)
  assert.equal(sessionMetrics(items, undefined, { firstTokenAt: 10_000 }).tps, null)
})

test('TPS sums each answer\'s window, so a tool gap is not model time', () => {
  const items: ThreadItem[] = [
    user('u1'),
    assistant('a1', 500),
    assistant('a2', 700)
  ]
  // Two answers generated for 1s each, with a 10s tool call between them.
  const metrics = sessionMetrics(items, undefined, {
    generationMs: 2_000,
    firstTokenAt: 10_000,
    lastTokenAt: 21_000
  })
  assert.equal(metrics.tps, 600)
})

test('TPS holds the completed answers\' speed throughout the next streamed answer', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance')
  let monotonic = 1_500
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => monotonic }
  })
  try {
    const streaming = { ...assistant('a2', 0), streaming: true, usage: undefined }
    const items = [user('u1'), assistant('a1', 60), streaming]
    const run = {
      generationMs: 1_000,
      messageGenerationBaseMs: 1_000,
      messageGenerationStartedAt: 1_000
    }
    for (monotonic of [1_500, 2_000, 10_000]) {
      assert.equal(sessionMetrics(items, undefined, run).tps, 60,
        'an unfinished answer has no final token count to pair with its growing duration')
    }
    assert.equal(sessionMetrics(items, undefined, {
      ...run,
      generationMs: 1_500,
      messageGenerationStartedAt: undefined
    }).tps, 60, 'ending a thinking or text block must not count time before message usage arrives')

    assert.equal(sessionMetrics([user('u1'), assistant('a1', 60), assistant('a2', 120)], undefined, {
      ...run,
      generationMs: 2_000,
      messageGenerationStartedAt: undefined
    }).tps, 90, 'message completion publishes its tokens and matching duration together')
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'performance', descriptor)
  }
})

test('TPS waits for a complete sample even if the stream contains partial usage', () => {
  const items = [user('u1'), { ...assistant('a1', 120), streaming: true, durationMs: 400 }]
  assert.equal(sessionMetrics(items, undefined, {
    generationMs: 400,
    messageGenerationBaseMs: 0,
    firstTokenAt: 1_000,
    lastTokenAt: 1_400
  }).tps, null)
})

test('TPS is restored from the saved generation window after reopening a session', () => {
  const items: ThreadItem[] = [
    { ...user('u1'), timestamp: 2_000 },
    assistant('a1', 120)
  ]
  const metrics = sessionMetrics(items, undefined, {}, {
    modelDurationsMs: {},
    ttftDurationsMs: {},
    toolDurationsMs: {},
    runDurationsMs: {},
    generationWindowMs: { '2000': 2_000 }
  })
  assert.equal(metrics.tps, 60)
})

test('TPS survives a long-session tail that restarts user ordinals at zero', () => {
  const items: ThreadItem[] = [
    { ...user('u43'), timestamp: 2_000 },
    assistant('a43', 120)
  ]
  const metrics = sessionMetrics(items, undefined, {}, {
    modelDurationsMs: {},
    ttftDurationsMs: {},
    toolDurationsMs: {},
    runDurationsMs: {},
    generationWindowMs: { 'user:42:2000': 2_000 }
  })
  assert.equal(metrics.tps, 60)
})

test('TPS does not reuse a sample when another user message shares its timestamp', () => {
  const items: ThreadItem[] = [
    { ...user('u1'), timestamp: 2_000 },
    assistant('a1', 120),
    { ...user('u2'), timestamp: 2_000 },
    assistant('a2', 90)
  ]
  const metrics = sessionMetrics(items, undefined, {}, {
    modelDurationsMs: {},
    ttftDurationsMs: {},
    toolDurationsMs: {},
    runDurationsMs: {},
    generationWindowMs: { 'user:42:2000': 2_000 }
  })
  assert.equal(metrics.tps, null)
})

test('reopened conversations do not infer TTFT from message timestamps', () => {
  const items: ThreadItem[] = [
    { ...user('u1'), timestamp: 1_000 },
    { ...assistant('a1', 100), timestamp: 1_500, durationMs: 2_000 },
    { ...assistant('a2', 300), timestamp: 5_000, durationMs: 3_000 }
  ]
  const metrics = sessionMetrics(items, undefined, {})
  assert.equal(metrics.averageTtftMs, null, 'assistant timestamps are recorded before provider generation starts')
  assert.equal(metrics.ttftMs, null)
  assert.equal(metrics.tps, 80, '400 output tokens over two 2s/3s answer windows')
  assert.equal(metrics.modelTimeMs, 5_000, 'sum of both assistant generation durations')
})

test('reopened conversations leave TPS unmeasured when assistant durations are missing', () => {
  const items: ThreadItem[] = [
    { ...user('u1'), timestamp: 1_000 },
    { ...assistant('a1', 100), timestamp: 1_500 },
    { ...assistant('a2', 300), timestamp: 20_000 }
  ]
  const metrics = sessionMetrics(items, undefined, {})
  assert.equal(metrics.tps, null, 'message timestamps span tool time and cannot prove generation speed')
})

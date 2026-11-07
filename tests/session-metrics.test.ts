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

test('TTFT is the prompt-to-first-token delay', () => {
  const metrics = sessionMetrics([], undefined, { startedAt: 1_000, firstTokenAt: 1_820 })
  assert.equal(metrics.ttftMs, 820)
  assert.equal(sessionMetrics([], undefined, { startedAt: 1_000 }).ttftMs, null)
})

test('model time and average TTFT use locally recorded session samples', () => {
  const metrics = sessionMetrics(
    [],
    stats({ userMessages: 2 }),
    { settled: true },
    {
      modelDurationsMs: { turn1: 1_200, turn2: 2_800 },
      ttftDurationsMs: { run1: 600, run2: 1_000 },
      toolDurationsMs: {}
    }
  )
  assert.equal(metrics.modelTimeMs, 4_000)
  assert.equal(metrics.averageTtftMs, 800)
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
      toolDurationsMs: { 'call-1': 450 }
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

import test from 'node:test'
import assert from 'node:assert/strict'
import { alignBreakdown, contextReading } from '../src/renderer/src/lib/context-reading'
import type { AssistantItem, ThreadItem } from '../src/renderer/src/lib/thread'
import type { ModelInfo, SessionStats } from '../src/shared/types'

function assistant(id: string, input: number, output: number, cacheRead: number): AssistantItem {
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

const MODEL: ModelInfo = {
  id: 'test-model',
  name: 'Test',
  api: 'openai-completions',
  provider: 'test',
  reasoning: false,
  input: ['text'],
  contextWindow: 200_000,
  maxTokens: 8_000
}

test('Pi\'s own context usage wins when the process reported it', () => {
  const reading = contextReading({
    stats: stats({ contextUsage: { tokens: 18_000, contextWindow: 200_000, percent: 9 } }),
    items: [],
    model: MODEL
  })
  assert.equal(reading.tokens, 18_000)
  assert.equal(reading.contextWindow, 200_000)
  assert.equal(reading.percent, 9)
  assert.equal(reading.source, 'pi')
})

test('a conversation with no statistics falls back to the transcript', () => {
  const items: ThreadItem[] = [
    assistant('a1', 2_000, 400, 16_000),
    assistant('a2', 2_400, 300, 18_000)
  ]
  const reading = contextReading({ items, model: MODEL })
  // The newest message is what the last request put in the window.
  assert.equal(reading.tokens, 20_700)
  assert.equal(reading.contextWindow, 200_000)
  assert.equal(reading.source, 'transcript')
  assert.ok(reading.percent !== null && reading.percent > 10)
  // A transcript fallback still totals the session for the panels.
  assert.equal(reading.tokensTotal, 18_400 + 20_700)
  assert.equal(reading.cost, null)
})

test('an answer that reported no usage cannot erase the newest real reading', () => {
  const items: ThreadItem[] = [
    assistant('a1', 900, 100, 3_000),
    assistant('a2', 0, 0, 0)
  ]
  const reading = contextReading({ items, model: MODEL })
  assert.equal(reading.tokens, 4_000)
  assert.equal(reading.source, 'transcript')
})

test('the window comes from the model when Pi omits contextUsage', () => {
  const reading = contextReading({ stats: stats(), items: [], model: MODEL })
  assert.equal(reading.contextWindow, 200_000)
  assert.equal(reading.tokens, null)
  assert.equal(reading.percent, null)
  assert.equal(reading.source, 'transcript')
})

test('a cold conversation with nothing at all reports no percentage, not zero', () => {
  const reading = contextReading({ items: [] })
  assert.equal(reading.tokens, null)
  assert.equal(reading.contextWindow, null)
  assert.equal(reading.percent, null)
  assert.equal(reading.tokensTotal, 0)
  assert.equal(reading.source, 'transcript')
})

test('the saved model supplies the window before a process starts', () => {
  const items: ThreadItem[] = [assistant('a1', 1_000, 100, 4_000)]
  const reading = contextReading({ items, fallbackModel: MODEL })
  assert.equal(reading.contextWindow, 200_000)
  assert.equal(reading.percent, (5_100 / 200_000) * 100)
})

test('Pi reporting null tokens after a compaction still yields a reading', () => {
  const items: ThreadItem[] = [assistant('a1', 900, 100, 3_000)]
  const reading = contextReading({
    stats: stats({ contextUsage: { tokens: null, contextWindow: 200_000, percent: null } }),
    items,
    model: MODEL
  })
  // Pi said "no valid usage yet"; the transcript's newest message stands in.
  assert.equal(reading.tokens, 4_000)
  assert.equal(reading.contextWindow, 200_000)
  assert.equal(reading.source, 'transcript')
})

test('the session totals prefer Pi and fall back to the transcript', () => {
  const items: ThreadItem[] = [assistant('a1', 10, 10, 10)]
  const fromPi = contextReading({
    stats: stats({ tokens: { input: 300, output: 90, cacheRead: 700, cacheWrite: 10, total: 1_100 } }),
    items
  })
  assert.deepEqual(
    [fromPi.tokensTotal, fromPi.input, fromPi.output, fromPi.cacheRead, fromPi.cacheWrite],
    [1_100, 300, 90, 700, 10]
  )
  const fromTranscript = contextReading({ items })
  assert.deepEqual(
    [
      fromTranscript.tokensTotal,
      fromTranscript.input,
      fromTranscript.output,
      fromTranscript.cacheRead,
      fromTranscript.cacheWrite
    ],
    [30, 10, 10, 10, 0]
  )
})

test('the breakdown rows add up to the reading they are printed under', () => {
  // A split taken from an earlier request: system 11.3K, tools 7.5K, messages
  // 87.4K — it adds up to 106K, while the panel now reads 30K.
  const stored = {
    systemPrompt: 11_300,
    toolDefinitions: 7_500,
    conversationMessages: 87_400,
    source: 'request' as const,
    total: 106_200
  }
  const aligned = alignBreakdown(stored, 30_000)
  assert.ok(aligned)
  const sum = (aligned.systemPrompt ?? 0) + (aligned.toolDefinitions ?? 0) + (aligned.conversationMessages ?? 0)
  assert.equal(sum, 30_000)
  assert.equal(aligned.systemPrompt, 3_192)
  assert.equal(aligned.toolDefinitions, 2_119)
  assert.equal(aligned.conversationMessages, 24_689)
  assert.equal(aligned.total, 30_000)
  assert.equal(aligned.source, 'request', 'rescaling keeps the source it came from')
})

test('a split that already describes the reading is left alone', () => {
  const stored = {
    systemPrompt: 10_000,
    toolDefinitions: 5_000,
    conversationMessages: 20_000,
    source: 'session' as const,
    total: 35_000
  }
  const aligned = alignBreakdown(stored, 35_000)
  assert.deepEqual(aligned, { ...stored, total: 35_000 })
})

test('a split with no reading or no conversation row is printed as it was stored', () => {
  const stored = {
    systemPrompt: 11_300,
    toolDefinitions: 7_500,
    conversationMessages: 87_400,
    source: 'request' as const,
    total: 106_200
  }
  assert.deepEqual(alignBreakdown(stored, null), stored)
  const scaffoldingOnly = { ...stored, conversationMessages: null }
  assert.deepEqual(alignBreakdown(scaffoldingOnly, 30_000), scaffoldingOnly, 'stretching the scaffolding would claim the whole window is system and tools')
  assert.equal(alignBreakdown(undefined, 30_000), undefined)
})

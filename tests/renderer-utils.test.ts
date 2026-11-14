import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countChangedFiles } from '../src/renderer/src/lib/changes'
import { diffableEdits } from '../src/renderer/src/lib/tool-renderers'
import { filterModels, normalizeModelSearchText } from '../src/renderer/src/lib/model-search'
import { formatClock, formatExactTokens, formatTokens, formatUsageTokens } from '../src/renderer/src/lib/format'
import { sortModelsByRecency } from '../src/renderer/src/lib/model-recency'
import type { ModelInfo } from '../src/shared/types'
import {
  enforceSessionLru,
  touchSessionLru,
  forgetSessionLru,
  MAX_CACHED_INACTIVE_THREADS
} from '../src/renderer/src/store/useAppStore'
import type { SessionThread } from '../src/renderer/src/store/useAppStore'
import type { ToolItem } from '../src/renderer/src/lib/thread'
import { fileTone, languageOf } from '../src/renderer/src/lib/files'

test('file tone and syntax lookup treat prototype property names as ordinary filenames', () => {
  assert.equal(fileTone('constructor'), 'plain')
  assert.equal(fileTone('file.constructor'), 'plain')
  assert.equal(fileTone('file.__proto__'), 'plain')
  assert.equal(languageOf('file.constructor'), '')
  assert.equal(languageOf('file.__proto__'), '')
})

function mockTool(toolName: string, status: ToolItem['status'], path?: string, edits?: { oldText?: string; newText?: string }[]): ToolItem {
  return {
    id: `tool-${Math.random()}`,
    kind: 'tool',
    toolCallId: `call-${Math.random()}`,
    toolName,
    status,
    args: { path, edits },
    timestamp: Date.now(),
    order: 1
  }
}

function mockThread(overrides: Partial<SessionThread> = {}): SessionThread {
  return {
    status: { running: false, phase: 'idle' },
    isStreaming: false,
    run: { phase: 'idle', turns: 0, settled: true },
    items: [{ id: 'item-1', kind: 'user', text: 'hi', images: [], timestamp: 1, order: 1 }],
    queue: { steering: [], followUp: [] },
    forkTargets: [],
    forking: false,
    version: 1,
    ...overrides
  }
}

test('countChangedFiles correctly counts distinct files and filters unconfirmed edits', () => {
  // Empty
  assert.equal(countChangedFiles([]), 0)

  // Proposed, error, aborted edits must NOT be counted as file changes
  const unconfirmed = [
    mockTool('edit', 'proposed', 'src/a.ts'),
    mockTool('edit', 'running', 'src/b.ts'),
    mockTool('edit', 'error', 'src/c.ts'),
    mockTool('edit', 'aborted', 'src/d.ts')
  ]
  assert.equal(countChangedFiles(unconfirmed), 0)

  // Non-edit/write tools must NOT be counted
  const otherTools = [
    mockTool('read', 'ok', 'src/a.ts'),
    mockTool('bash', 'ok')
  ]
  assert.equal(countChangedFiles(otherTools), 0)

  // Multiple successful edits and writes to same and different files
  const successful = [
    mockTool('edit', 'ok', 'src/file1.ts'),
    mockTool('edit', 'ok', 'src/file1.ts'), // duplicate
    mockTool('write', 'ok', 'src/file2.ts'),
    mockTool('edit', 'ok', 'src/file3.ts')
  ]
  assert.equal(countChangedFiles(successful), 3)
})

test('diffableEdits extracts edit pairs without throwing', () => {
  const readTool = mockTool('read', 'ok', 'file.ts')
  assert.deepEqual(diffableEdits(readTool), [])

  const editTool = mockTool('edit', 'ok', 'file.ts', [
    { oldText: 'const a = 1', newText: 'const a = 2' }
  ])
  const pairs = diffableEdits(editTool)
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0].oldText, 'const a = 1')
  assert.equal(pairs[0].newText, 'const a = 2')
})

test('enforceSessionLru evicts oldest inactive threads when limit is exceeded', () => {
  // Setup 5 inactive sessions with maxInactive = 2
  touchSessionLru('C:/sessions/session1.jsonl')
  touchSessionLru('C:/sessions/session2.jsonl')
  touchSessionLru('C:/sessions/session3.jsonl')
  touchSessionLru('C:/sessions/session4.jsonl')
  touchSessionLru('C:/sessions/session5.jsonl')

  const threads: Record<string, SessionThread> = {
    'C:/sessions/session1.jsonl': mockThread(),
    'C:/sessions/session2.jsonl': mockThread(),
    'C:/sessions/session3.jsonl': mockThread(),
    'C:/sessions/session4.jsonl': mockThread(),
    'C:/sessions/session5.jsonl': mockThread()
  }

  // Active session is session5; limit = 2 inactive
  // 4 inactive sessions: session1, session2, session3, session4.
  // 4 - 2 = 2 oldest inactive evicted: session1, session2.
  // 2 most recent inactive retained: session3, session4.
  // Active session5 retained.
  const result = enforceSessionLru(threads, 'C:/sessions/session5.jsonl', 2)

  // session1 and session2 should have items dropped and version reset to 0
  assert.equal(result['C:/sessions/session1.jsonl'].version, 0)
  assert.equal(result['C:/sessions/session1.jsonl'].items.length, 0)
  assert.equal(result['C:/sessions/session2.jsonl'].version, 0)
  assert.equal(result['C:/sessions/session2.jsonl'].items.length, 0)

  // session3, session4 and active session5 retain items
  assert.equal(result['C:/sessions/session3.jsonl'].version, 1)
  assert.equal(result['C:/sessions/session3.jsonl'].items.length, 1)
  assert.equal(result['C:/sessions/session4.jsonl'].version, 1)
  assert.equal(result['C:/sessions/session4.jsonl'].items.length, 1)
  assert.equal(result['C:/sessions/session5.jsonl'].version, 1)
  assert.equal(result['C:/sessions/session5.jsonl'].items.length, 1)
})

test('enforceSessionLru protects streaming, queued, running, and draft sessions from eviction', () => {
  const threads: Record<string, SessionThread> = {
    'draft:new-chat': mockThread({ isStreaming: false }),
    'C:/sessions/streaming.jsonl': mockThread({ isStreaming: true }),
    'C:/sessions/queued.jsonl': mockThread({ queue: { steering: ['next'], followUp: [] } }),
    'C:/sessions/running.jsonl': mockThread({ run: { phase: 'generating', turns: 1, settled: false } }),
    'C:/sessions/dialog.jsonl': mockThread({ uiRequest: { id: 'req-1', method: 'confirm', message: 'ok?' } as any }),
    'C:/sessions/stale.jsonl': mockThread()
  }

  // Limit = 0 inactive
  // Only stale.jsonl should be evicted!
  const result = enforceSessionLru(threads, undefined, 0)

  assert.equal(result['draft:new-chat'].version, 1)
  assert.equal(result['C:/sessions/streaming.jsonl'].version, 1)
  assert.equal(result['C:/sessions/queued.jsonl'].version, 1)
  assert.equal(result['C:/sessions/running.jsonl'].version, 1)
  assert.equal(result['C:/sessions/dialog.jsonl'].version, 1)

  // Stale session is evicted
  assert.equal(result['C:/sessions/stale.jsonl'].version, 0)
  assert.equal(result['C:/sessions/stale.jsonl'].items.length, 0)
})

test('turn memoization logic ignores run changes for historical turns', () => {
  function equalTurnView(
    prev: { isLastTurn: boolean; run: any; turnId: string },
    next: { isLastTurn: boolean; run: any; turnId: string }
  ): boolean {
    if (prev.isLastTurn !== next.isLastTurn) return false
    if (next.isLastTurn && prev.run !== next.run) return false
    return prev.turnId === next.turnId
  }

  const run1 = { phase: 'idle', turns: 1, settled: true }
  const run2 = { phase: 'generating', turns: 2, settled: false }

  // Historical turn: run changed from run1 to run2 -> must evaluate as EQUAL (no re-render!)
  assert.equal(
    equalTurnView(
      { isLastTurn: false, run: run1, turnId: 'turn-1' },
      { isLastTurn: false, run: run2, turnId: 'turn-1' }
    ),
    true
  )

  // Live turn: run changed from run1 to run2 -> must evaluate as NOT EQUAL (must re-render!)
  assert.equal(
    equalTurnView(
      { isLastTurn: true, run: run1, turnId: 'turn-2' },
      { isLastTurn: true, run: run2, turnId: 'turn-2' }
    ),
    false
  )
})

test('model search normalizes separators and requires every token', () => {
  assert.equal(normalizeModelSearchText('Claude-Sonnet_4.5'), 'claude sonnet 4 5')
  const models: ModelInfo[] = [
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic', api: '', reasoning: true, input: ['text'], contextWindow: 1, maxTokens: 1 },
    { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', provider: 'openai', api: '', reasoning: true, input: ['text'], contextWindow: 1, maxTokens: 1 }
  ]
  assert.deepEqual(filterModels(models, 'sonnet 4'), [models[0]])
  assert.deepEqual(filterModels(models, 'gpt terra'), [models[1]])
  assert.deepEqual(filterModels(models, 'missing'), [])
})

test('model recency ordering keeps first-seen order for unused models', () => {
  const models = [
    { provider: 'a', id: 'one' },
    { provider: 'a', id: 'two' },
    { provider: 'b', id: 'three' }
  ]
  assert.deepEqual(
    sortModelsByRecency(models, { 'b/three': 10, 'a/two': 20 }).map((model) => model.id),
    ['two', 'three', 'one']
  )
  assert.deepEqual(sortModelsByRecency(models, {}), models)
})

test('the usage measure keeps one decimal at every scale', () => {
  // The overview reads as a column of digits (20.4K / 81.9K / 61.2K / 325), so
  // the reading must not switch rounding with the magnitude.
  assert.equal(formatUsageTokens(0), '0')
  assert.equal(formatUsageTokens(325), '325')
  assert.equal(formatUsageTokens(1_000), '1.0K')
  assert.equal(formatUsageTokens(20_400), '20.4K')
  assert.equal(formatUsageTokens(81_945), '81.9K')
  assert.equal(formatUsageTokens(1_250_000), '1.3M')
  assert.equal(formatUsageTokens(undefined), '—')
})

test('abbreviated token counts always use an uppercase K', () => {
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1_000), '1.0K')
  assert.equal(formatTokens(20_400), '20K')
  assert.equal(formatTokens(1_250_000), '1.3M')
  assert.equal(formatTokens(undefined), '—')
})

test('exact token counts keep their separators for a usage breakdown', () => {
  assert.equal(formatExactTokens(4173), `${(4173).toLocaleString()} tok`)
  assert.equal(formatExactTokens(4_354_048), `${(4_354_048).toLocaleString()} tok`)
  assert.equal(formatExactTokens(0), '0 tok')
  assert.equal(formatExactTokens(undefined), '—')
  assert.equal(formatExactTokens(null), '—')
})

test('formatClock keeps today short and dates older messages', () => {
  const now = new Date(2026, 10, 13, 20, 55)
  const at = (day: number, hour = 10, minute = 46) => new Date(2026, 10, day, hour, minute).getTime()
  const timeOnly = new Date(at(13)).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  })

  assert.equal(formatClock(undefined, now), '')
  assert.equal(formatClock(at(13), now), timeOnly)

  // "Today" is a calendar-day comparison, not a 24-hour one: a message from
  // late yesterday still has to carry its date.
  const lateYesterday = new Date(2026, 10, 12, 23, 59)
  const yesterday = formatClock(lateYesterday.getTime(), now)
  assert.notEqual(yesterday, timeOnly)
  assert.ok(yesterday.includes('12'), `Expected a dated clock, got ${yesterday}`)
  assert.ok(
    yesterday.endsWith(
      lateYesterday.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    ),
    `Expected the time to survive, got ${yesterday}`
  )

  // Within the year the date stays compact; an older year is spelled out.
  assert.ok(!formatClock(at(12), now).includes('2026'))
  assert.ok(formatClock(new Date(2025, 10, 12, 10, 46).getTime(), now).includes('2025'))
})

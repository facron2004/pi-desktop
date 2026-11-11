import type { SessionStats } from '@shared/types'
import type { ThreadItem } from './thread'
import { monotonicNow, type SessionTimingRecord, userTimingDuration } from './session-timing'

/**
 * The numbers shown under the composer after a run.
 *
 * Token totals and the cache hit rate are projections of the transcript and
 * Pi's `get_session_stats`. Turn/step counts and complete tool durations come
 * come from session items, supplemented with client-observed timing samples
 * stored per session in `session-timing.ts`. This is the only place that
 * derives the displayed metrics from those sources.
 */
export interface RunTiming {
  startedAt?: number
  startedMonotonicAt?: number
  /** Pi-observed run start to the first nonempty text delta. */
  ttftMs?: number
  firstTokenAt?: number
  lastTokenAt?: number
  /**
   * Summed completed generation blocks in this run.
   *
   * A run that calls tools writes several answers; the wall clock between
   * them is tool time, not model time.
   */
  generationMs?: number
  /** Generation time before the current assistant message began. */
  messageGenerationBaseMs?: number
  /** Monotonic start of the answer currently being generated. */
  messageGenerationStartedAt?: number
  modelTurnStartedAt?: number
  runId?: string
  turnId?: string
  settled?: boolean
}

export interface SessionMetrics {
  /** Tokens used by the conversation so far. */
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turnCount: number
  stepCount: number
  /** Sum of tool durations available in the transcript or local timing record. */
  toolTimeMs: number | null
  timedToolCalls: number
  /** Average of recorded runs and the current run sample, or null. */
  averageTtftMs: number | null
  /** Sum of completed model response timings observed by this app, or the transcript. */
  modelTimeMs: number | null
  /** Cache reads as a share of all prompt tokens, or null when unknown. */
  cacheHitPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  /** Completed output tokens per second in the newest turn. */
  tps: number | null
  /** Pi's run-start to first-text timing sample. */
  ttftMs: number | null
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

export function sessionMetrics(
  items: readonly ThreadItem[],
  stats: SessionStats | undefined,
  run: RunTiming,
  timing?: SessionTimingRecord
): SessionMetrics {
  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let total = 0
  let lastTurnOutput = 0
  let lastUserIndex = -1
  let lastUserTimestamp: number | undefined
  let lastUserOrdinal: number | undefined
  let transcriptTurnCount = 0
  let toolItemCount = 0
  let knownToolTimeMs = 0
  let timedToolCalls = 0
  let lastTurnGenerationMs = 0
  let hasStreamingAssistant = false
  let transcriptModelMs = 0

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'user') {
      lastUserIndex = index
      lastUserTimestamp = item.timestamp
      lastUserOrdinal = transcriptTurnCount
      transcriptTurnCount += 1
    } else if (item.kind === 'tool') {
      toolItemCount += 1
      const terminal = item.status === 'ok' || item.status === 'error' || item.status === 'aborted'
      const duration = item.durationMs ?? timing?.toolDurationsMs[item.toolCallId]
      if (terminal && typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
        knownToolTimeMs += duration
        timedToolCalls += 1
      }
    }
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind !== 'assistant') continue
    if (typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
      transcriptModelMs += item.durationMs
    }
    if (index > lastUserIndex) {
      hasStreamingAssistant ||= item.streaming
      if (!item.streaming && typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
        lastTurnGenerationMs += item.durationMs
      }
    }
    if (!item.usage) continue
    input += item.usage.input
    output += item.usage.output
    cacheRead += item.usage.cacheRead
    cacheWrite += item.usage.cacheWrite
    total += item.usage.totalTokens
    // Only the newest turn's output belongs to the generation window that the
    // run's timing fields describe.
    if (index > lastUserIndex && !item.streaming) lastTurnOutput += item.usage.output
  }

  // A live `get_session_stats` wins over the visible transcript, which is
  // only the current branch and may be behind by one event.
  const statsTokens = stats?.tokens
  const hasStatsTokens = Boolean(statsTokens && statsTokens.total > 0)
  const totalTokens = hasStatsTokens ? statsTokens!.total : total
  const inputTokens = hasStatsTokens ? statsTokens!.input : input
  const outputTokens = hasStatsTokens ? statsTokens!.output : output
  const cacheReadTokens = hasStatsTokens ? statsTokens!.cacheRead : cacheRead
  const cacheWriteTokens = hasStatsTokens ? statsTokens!.cacheWrite : cacheWrite
  // Every prompt token is either fresh input, a cache read or a cache write;
  // leaving writes out of the base inflated the rate on a growing context.
  const hitBase = cacheReadTokens + inputTokens + cacheWriteTokens
  const cacheHitPercent = hitBase > 0 ? round((cacheReadTokens / hitBase) * 100) : null

  const turnCount = stats?.userMessages ?? transcriptTurnCount
  const stepCount = stats?.toolCalls ?? toolItemCount
  const toolTimeMs = stepCount === 0 && toolItemCount === 0
    ? 0
    : timedToolCalls > 0
      ? knownToolTimeMs
      : null

  const context = stats?.contextUsage
  const contextTokens = context?.tokens ?? null
  const contextWindow = context?.contextWindow ?? null
  const contextPercent = context?.percent ?? null

  const ttftMs = typeof run.ttftMs === 'number' && Number.isFinite(run.ttftMs) && run.ttftMs >= 0
    ? run.ttftMs
    : null
  const ttftSamples = Object.values(timing?.ttftDurationsMs ?? {})
    .filter((value) => Number.isFinite(value) && value >= 0)
  const currentRunRecorded = Boolean(run.runId && timing?.ttftDurationsMs[run.runId] !== undefined)
  const includeCurrentTtft = !currentRunRecorded && ttftMs !== null
  const averageTtftMs = ttftSamples.length || includeCurrentTtft
    ? round((ttftSamples.reduce((sum, value) => sum + value, 0) + (includeCurrentTtft ? ttftMs! : 0)) /
      (ttftSamples.length + (includeCurrentTtft ? 1 : 0)))
    : null
  // Only monotonic samples are summed. Version-1 records measured this against
  // the wall clock, which jumps on sleep and time sync; one answer could read
  // as hours, so `session-timing.ts` drops those samples when a record is read.
  const modelSamples = Object.values(timing?.modelDurationsMs ?? {})
    .filter((value) => Number.isFinite(value) && value >= 0)
  const liveModelTime = run.modelTurnStartedAt !== undefined
    ? Math.max(0, monotonicNow() - run.modelTurnStartedAt)
    : 0
  const modelTimeMs = modelSamples.length || liveModelTime > 0
    ? modelSamples.reduce((sum, value) => sum + value, 0) + liveModelTime
    : transcriptModelMs > 0
      ? transcriptModelMs
      : null
  // Usage arrives when the message completes. Pair those tokens only with
  // completed messages' windows: a growing live denominator with a frozen
  // numerator makes the reading fall on every delta and jump on completion.
  // Closed thinking/text blocks still belong to the unfinished message.
  const measuredWindowMs = hasStreamingAssistant
    ? run.messageGenerationBaseMs
    : run.generationMs
  // Older runs, and tests, still report a single span; keep it as a fallback.
  const legacyWindowMs =
    !hasStreamingAssistant && run.lastTokenAt !== undefined && run.firstTokenAt !== undefined
      ? run.lastTokenAt - run.firstTokenAt
      : 0
  const restoredWindowMs = hasStreamingAssistant || lastUserTimestamp === undefined
    ? undefined
    : userTimingDuration(timing?.generationWindowMs ?? {}, lastUserTimestamp, lastUserOrdinal)
  // A transcript-only conversation has no client samples. Each assistant
  // message carries the duration Pi spent generating it, so summing those is
  // the same per-answer window the live path records — tool gaps excluded.
  const transcriptWindowMs = lastTurnGenerationMs
  const windowMs = measuredWindowMs !== undefined
    ? measuredWindowMs
    : legacyWindowMs > 0
      ? legacyWindowMs
      : restoredWindowMs !== undefined && restoredWindowMs > 0
        ? restoredWindowMs
        : transcriptWindowMs
  const tps =
    windowMs > 0 && lastTurnOutput > 0 ? round(lastTurnOutput / (windowMs / 1000)) : null

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    turnCount,
    stepCount,
    toolTimeMs,
    timedToolCalls,
    averageTtftMs,
    modelTimeMs,
    cacheHitPercent,
    contextTokens,
    contextWindow,
    contextPercent,
    tps,
    ttftMs
  }
}

import type { SessionStats } from '@shared/types'
import type { ThreadItem } from './thread'
import type { SessionTimingRecord } from './session-timing'

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
  firstTokenAt?: number
  lastTokenAt?: number
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
  turnCount: number
  stepCount: number
  /** Sum of tool durations available in the transcript or local timing record. */
  toolTimeMs: number | null
  timedToolCalls: number
  /** Average across completed runs observed by this app. */
  averageTtftMs: number | null
  /** Sum of completed model response timings observed by this app. */
  modelTimeMs: number | null
  /** Cache reads as a share of all prompt tokens, or null when unknown. */
  cacheHitPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  /** Output tokens per second of the most recent generation window. */
  tps: number | null
  /** Milliseconds from the prompt to the first text delta. */
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
  let total = 0
  let lastTurnOutput = 0
  let lastUserIndex = -1
  let transcriptTurnCount = 0
  let toolItemCount = 0
  let knownToolTimeMs = 0
  let timedToolCalls = 0

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'user') {
      lastUserIndex = index
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
    if (item.kind !== 'assistant' || !item.usage) continue
    input += item.usage.input
    output += item.usage.output
    cacheRead += item.usage.cacheRead
    total += item.usage.totalTokens
    // Only the newest turn's output belongs to the generation window that the
    // run's timing fields describe.
    if (index > lastUserIndex) lastTurnOutput += item.usage.output
  }

  // A live `get_session_stats` wins over the visible transcript, which is
  // only the current branch and may be behind by one event.
  const statsTokens = stats?.tokens
  const hasStatsTokens = Boolean(statsTokens && statsTokens.total > 0)
  const totalTokens = hasStatsTokens ? statsTokens!.total : total
  const inputTokens = hasStatsTokens ? statsTokens!.input : input
  const outputTokens = hasStatsTokens ? statsTokens!.output : output
  const cacheReadTokens = hasStatsTokens ? statsTokens!.cacheRead : cacheRead
  const hitRead = cacheReadTokens
  const hitInput = inputTokens
  const hitBase = hitRead + hitInput
  const cacheHitPercent = hitBase > 0 ? round((hitRead / hitBase) * 100) : null

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

  const ttftMs =
    run.firstTokenAt !== undefined && run.startedAt !== undefined
      ? Math.max(0, run.firstTokenAt - run.startedAt)
      : null
  const ttftSamples = Object.values(timing?.ttftDurationsMs ?? {})
    .filter((value) => Number.isFinite(value) && value >= 0)
  const currentRunRecorded = Boolean(run.runId && timing?.ttftDurationsMs[run.runId] !== undefined)
  const includeLiveTtft = run.settled === false && !currentRunRecorded && ttftMs !== null
  const averageTtftMs = ttftSamples.length || includeLiveTtft
    ? round((ttftSamples.reduce((sum, value) => sum + value, 0) + (includeLiveTtft ? ttftMs! : 0)) /
      (ttftSamples.length + (includeLiveTtft ? 1 : 0)))
    : ttftMs
  const modelSamples = Object.values(timing?.modelDurationsMs ?? {})
    .filter((value) => Number.isFinite(value) && value >= 0)
  const liveModelTime = run.modelTurnStartedAt !== undefined
    ? Math.max(0, Date.now() - run.modelTurnStartedAt)
    : 0
  const modelTimeMs = modelSamples.length || liveModelTime > 0
    ? modelSamples.reduce((sum, value) => sum + value, 0) + liveModelTime
    : null
  const windowMs =
    run.lastTokenAt !== undefined && run.firstTokenAt !== undefined
      ? run.lastTokenAt - run.firstTokenAt
      : 0
  const tps =
    windowMs > 0 && lastTurnOutput > 0 ? round(lastTurnOutput / (windowMs / 1000)) : null

  return {
    totalTokens,
    inputTokens,
    outputTokens,
    cacheReadTokens,
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

import type { SessionStats } from '@shared/types'
import type { ThreadItem } from './thread'
import { subagentUsage } from './subagent-usage'
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
  /** Sum of recorded model response timings for the session. */
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
  /**
   * Tokens the subagents reported, kept apart from `totalTokens`.
   *
   * A child process has its own Pi statistics, so those tokens are not part of
   * the parent's prompt and adding them would distort the cache hit rate.
   */
  subagentTokens: number
  /** Summed subagent cost, or null when no task reported one. */
  subagentCost: number | null
  /** Tasks that contributed to the subagent reading. */
  subagentTaskCount: number
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/**
 * Model-time samples for answers in the newest turn.
 *
 * Each sample is stored twice: once under the turn id, and once as
 * `assistant:<message time>:<turn id>`. Only the stamped copies are used
 * here, so the turn-id copy is not added again. Samples from earlier turns
 * are left out; they belong to a different output.
 */
function newestTurnModelWindowMs(
  durations: Record<string, number> | undefined,
  lastUserTimestamp: number | undefined,
  beforeTimestamp?: number
): number {
  if (!durations || lastUserTimestamp === undefined) return 0
  let sum = 0
  for (const [id, value] of Object.entries(durations)) {
    const match = /^assistant:(\d+)(?::|$)/.exec(id)
    if (!match) continue
    const stamp = Number(match[1])
    if (!Number.isFinite(stamp) || stamp < lastUserTimestamp) continue
    // A held reading describes the turn that ended at this prompt; samples
    // stamped with the newest prompt belong to the turn now starting.
    if (beforeTimestamp !== undefined && stamp >= beforeTimestamp) continue
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) sum += value
  }
  return sum
}

export function sessionMetrics(
  items: readonly ThreadItem[],
  stats: SessionStats | undefined,
  run: RunTiming,
  timing?: SessionTimingRecord,
  options: { historyTruncated?: boolean } = {}
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
  let previousUserIndex = -1
  let previousUserTimestamp: number | undefined
  let previousUserOrdinal: number | undefined
  const userTimestampCounts = new Map<number, number>()
  let transcriptTurnCount = 0
  let toolItemCount = 0
  let knownToolTimeMs = 0
  let timedToolCalls = 0
  let lastTurnGenerationMs = 0
  let previousTurnGenerationMs = 0
  let previousTurnOutput = 0
  let hasStreamingAssistant = false
  let transcriptModelMs = 0
  let completedAssistantCount = 0
  let completedAssistantDurationCount = 0

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'user') {
      previousUserIndex = lastUserIndex
      previousUserTimestamp = lastUserTimestamp
      previousUserOrdinal = lastUserOrdinal
      lastUserIndex = index
      lastUserTimestamp = item.timestamp
      lastUserOrdinal = transcriptTurnCount
      userTimestampCounts.set(item.timestamp, (userTimestampCounts.get(item.timestamp) ?? 0) + 1)
      transcriptTurnCount += 1
    } else if (item.kind === 'tool') {
      toolItemCount += 1
      const terminal = item.status === 'ok' || item.status === 'error' || item.status === 'aborted'
      const duration = [item.durationMs, timing?.toolDurationsMs[item.toolCallId]].find(
        (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
      )
      if (terminal && duration !== undefined) {
        knownToolTimeMs += duration
        timedToolCalls += 1
      }
    } else if (item.kind === 'assistant') {
      if (!item.streaming) {
        completedAssistantCount += 1
        if (typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
          completedAssistantDurationCount += 1
        }
      }
      if (typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
        transcriptModelMs += item.durationMs
      }
    }
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind !== 'assistant') continue
    if (index > lastUserIndex) {
      hasStreamingAssistant ||= item.streaming
      if (!item.streaming && typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
        lastTurnGenerationMs += item.durationMs
      }
    }
    const inPreviousTurn = previousUserIndex >= 0 && index > previousUserIndex && index < lastUserIndex
    if (inPreviousTurn && !item.streaming) {
      if (typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) && item.durationMs >= 0) {
        previousTurnGenerationMs += item.durationMs
      }
    }
    if (!item.usage) continue
    input += item.usage.input
    output += item.usage.output
    cacheRead += item.usage.cacheRead
    cacheWrite += item.usage.cacheWrite
    total += item.usage.totalTokens
    // Only the newest turn's output belongs to the generation window that the
    // run's timing fields describe. A message with no usage must not poison
    // the sum: `undefined` would make it NaN and the speed would stay blank.
    if (index > lastUserIndex && !item.streaming) {
      const produced = item.usage?.output
      if (typeof produced === 'number' && Number.isFinite(produced) && produced > 0) {
        lastTurnOutput += produced
      }
    }
    if (inPreviousTurn) {
      const produced = item.usage.output
      if (typeof produced === 'number' && Number.isFinite(produced) && produced > 0) {
        previousTurnOutput += produced
      }
    }
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
  // Pi's session statistics cover the full session. Keep model samples at that
  // same scope, including messages in other branches and outside a long tail.
  //
  // The transcript already carries Pi's own `durationMs` per assistant message,
  // while the local record is an append-only journal. Adding the two would
  // count every message twice after reopening a conversation — the 48-minute
  // "model time" from a 24-minute session. Use the larger complete reading
  // instead: the local journal can cover branches the visible transcript does
  // not, and the transcript is the authority for the branch it does show.
  const modelEntries = Object.entries(timing?.modelDurationsMs ?? {})
    .filter(([, value]) => Number.isFinite(value) && value >= 0)
  const turnSamples = modelEntries.filter(([id]) => !id.startsWith('assistant:'))
  const messageSamples = modelEntries.filter(([id]) => id.startsWith('assistant:'))
  const measuredModelMs = (turnSamples.length > 0 ? turnSamples : messageSamples)
    .reduce((sum, [, value]) => sum + value, 0)
  const liveModelTime = run.modelTurnStartedAt !== undefined && !run.settled
    ? Math.max(0, monotonicNow() - run.modelTurnStartedAt)
    : 0
  // A complete transcript is authoritative: every completed assistant message
  // carries Pi's own duration, so an older local journal cannot inflate it.
  // Only fall back to the journal when the visible transcript has gaps (for
  // example a bounded tail or messages recorded before Pi emitted durations).
  const completeTranscriptModel = options.historyTruncated !== true &&
    completedAssistantCount > 0 && completedAssistantDurationCount === completedAssistantCount
  const baseModelMs = completeTranscriptModel
    ? transcriptModelMs
    : transcriptModelMs > 0
      ? (measuredModelMs > 0 ? Math.max(measuredModelMs, transcriptModelMs) : transcriptModelMs)
      : measuredModelMs
  const modelTimeMs = baseModelMs > 0 || liveModelTime > 0
    ? baseModelMs + liveModelTime
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
    : userTimingDuration(
      timing?.generationWindowMs ?? {},
      lastUserTimestamp,
      lastUserOrdinal,
      userTimestampCounts.get(lastUserTimestamp) ?? 0
    )
  // A transcript-only conversation has no client samples. Each assistant
  // message carries the duration Pi spent generating it, so summing those is
  // the same per-answer window the live path records — tool gaps excluded.
  const transcriptWindowMs = lastTurnGenerationMs
  // `generationMs: 0` is the value a run starts with, not a measurement. A
  // window that never closed must not hide the durations Pi already wrote on
  // the completed answers, or the usage line shows "—" after a real run.
  const measuredWindow = measuredWindowMs !== undefined && measuredWindowMs > 0
    ? measuredWindowMs
    : undefined
  const windowMs = measuredWindow !== undefined
    ? measuredWindow
    : legacyWindowMs > 0
      ? legacyWindowMs
      : restoredWindowMs !== undefined && restoredWindowMs > 0
        ? restoredWindowMs
        : transcriptWindowMs
  const turnOutput = lastTurnOutput > 0
    ? lastTurnOutput
    : !hasStreamingAssistant && turnCount <= 1 && hasStatsTokens && statsTokens!.output > 0
      ? statsTokens!.output
      : 0
  // One turn: the model-time total is that turn's generation, even when the
  // live window was left at 0 and only the timing journal still has it.
  // A later turn is the same shape when Pi wrote no `durationMs` and the
  // generation window was not closed: the journal still has one sample per
  // answer, stamped with the assistant message time.
  const sampledWindowMs = !hasStreamingAssistant && windowMs <= 0
    ? newestTurnModelWindowMs(timing?.modelDurationsMs, lastUserTimestamp)
    : 0
  const speedWindowMs = windowMs > 0
    ? windowMs
    : sampledWindowMs > 0
      ? sampledWindowMs
      : !hasStreamingAssistant && turnCount <= 1 && (modelTimeMs ?? 0) > 0
        ? modelTimeMs!
        : 0
  const tps =
    speedWindowMs > 0 && turnOutput > 0 ? round(turnOutput / (speedWindowMs / 1000)) : null
  // A prompt does not produce tokens at the instant it is sent. Blanking the
  // reading there hid the speed of the turn that had just finished, so hold
  // that completed turn's value until this one has an answer of its own.
  const previousRestoredWindowMs = previousUserIndex >= 0
    ? userTimingDuration(
      timing?.generationWindowMs ?? {},
      previousUserTimestamp,
      previousUserOrdinal,
      previousUserTimestamp === undefined ? 0 : userTimestampCounts.get(previousUserTimestamp) ?? 0
    )
    : undefined
  const previousWindowMs = previousRestoredWindowMs !== undefined && previousRestoredWindowMs > 0
    ? previousRestoredWindowMs
    : previousTurnGenerationMs > 0
      ? previousTurnGenerationMs
      : newestTurnModelWindowMs(timing?.modelDurationsMs, previousUserTimestamp, lastUserTimestamp)
  const heldTps =
    turnOutput === 0 && previousTurnOutput > 0 && previousWindowMs > 0
      ? round(previousTurnOutput / (previousWindowMs / 1000))
      : null

  // Kept apart from the token totals above: the children are their own Pi
  // processes, so their usage is neither in the parent's statistics nor in
  // the parent transcript's usage.
  const subagents = subagentUsage(items)

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
    tps: tps ?? heldTps,
    ttftMs,
    subagentTokens: subagents.tokens,
    subagentCost: subagents.cost ?? null,
    subagentTaskCount: subagents.tasks
  }
}

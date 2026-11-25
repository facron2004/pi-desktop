import type { SessionStats } from '@shared/types'
import type { ThreadItem } from './thread'
import { subagentCallOf } from './subagents'
import { accumulateSubagentCall, type SubagentUsage } from './subagent-usage'
import {
  monotonicNow,
  type SessionTimingRecord,
  timingFieldRevision,
  userTimingDuration
} from './session-timing'

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
  /** Average output tokens per second over completed, timed responses. */
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

function validNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

interface ItemsDigest {
  toolDurationsRef: Record<string, number> | undefined
  toolDurationsRev: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  lastTurnOutput: number
  lastUserIndex: number
  lastUserTimestamp: number | undefined
  lastUserOrdinal: number | undefined
  previousUserIndex: number
  previousUserTimestamp: number | undefined
  previousUserOrdinal: number | undefined
  userTimestampCounts: Map<number, number>
  transcriptTurnCount: number
  toolItemCount: number
  knownToolTimeMs: number
  timedToolCalls: number
  previousTurnOutput: number
  hasStreamingAssistant: boolean
  transcriptModelMs: number
  timedOutput: number
  timedOutputMs: number
  /** Positive output without a duration, indexed only by unambiguous timestamps. */
  untimedOutputByTimestamp: Map<number, number | null>
  completedAssistantCount: number
  completedAssistantDurationCount: number
  subagents: SubagentUsage
}

const itemsDigestCache = new WeakMap<readonly ThreadItem[], ItemsDigest>()

function summarizeItems(
  items: readonly ThreadItem[],
  toolDurationsMs: Record<string, number> | undefined
): ItemsDigest {
  const toolRev = timingFieldRevision(toolDurationsMs)
  const cached = itemsDigestCache.get(items)
  if (cached && cached.toolDurationsRef === toolDurationsMs && cached.toolDurationsRev === toolRev) {
    return cached
  }

  let input = 0
  let output = 0
  let cacheRead = 0
  let cacheWrite = 0
  let total = 0
  let currentTurnCompletedOutput = 0
  let currentTurnMissingOutput = false
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
  let previousTurnOutput = 0
  let hasStreamingAssistant = false
  let transcriptModelMs = 0
  let timedOutput = 0
  let timedOutputMs = 0
  const untimedOutputByTimestamp = new Map<number, number | null>()
  let completedAssistantCount = 0
  let completedAssistantDurationCount = 0
  const subagents: SubagentUsage = { tokens: 0, cost: undefined, tasks: 0, settled: 0 }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'user') {
      if (lastUserIndex >= 0) {
        previousTurnOutput = currentTurnMissingOutput ? 0 : currentTurnCompletedOutput
      }
      currentTurnCompletedOutput = 0
      currentTurnMissingOutput = false
      hasStreamingAssistant = false
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
      if (terminal) {
        const duration = validNonNegative(item.durationMs) ?? validNonNegative(toolDurationsMs?.[item.toolCallId])
        if (duration !== undefined) {
          knownToolTimeMs += duration
          timedToolCalls += 1
        }
      }
      if (item.toolName === 'subagent') {
        accumulateSubagentCall(subagents, subagentCallOf(item))
      }
    } else if (item.kind === 'assistant') {
      const duration = validNonNegative(item.durationMs)
      if (!item.streaming) {
        const produced = validNonNegative(item.usage?.output)
        completedAssistantCount += 1
        currentTurnCompletedOutput += produced ?? 0
        currentTurnMissingOutput ||= produced === undefined
        if (duration !== undefined) {
          completedAssistantDurationCount += 1
          // Only a completed answer has a final duration. A streaming message
          // can carry a partial `durationMs`, and counting it here made model
          // time (and the average speed built on it) move while nothing had
          // been measured yet.
          transcriptModelMs += duration
        }
        if (duration && produced) {
          timedOutput += produced
          timedOutputMs += duration
        }
        untimedOutputByTimestamp.set(
          item.timestamp,
          !duration && produced && !untimedOutputByTimestamp.has(item.timestamp) ? produced : null
        )
      } else {
        hasStreamingAssistant = true
      }
      if (item.usage) {
        input += item.usage.input
        output += item.usage.output
        cacheRead += item.usage.cacheRead
        cacheWrite += item.usage.cacheWrite
        total += item.usage.totalTokens
      }
    }
  }

  const digest: ItemsDigest = {
    toolDurationsRef: toolDurationsMs,
    toolDurationsRev: toolRev,
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    lastTurnOutput: currentTurnMissingOutput ? 0 : currentTurnCompletedOutput,
    lastUserIndex,
    lastUserTimestamp,
    lastUserOrdinal,
    previousUserIndex,
    previousUserTimestamp,
    previousUserOrdinal,
    userTimestampCounts,
    transcriptTurnCount,
    toolItemCount,
    knownToolTimeMs,
    timedToolCalls,
    previousTurnOutput,
    hasStreamingAssistant,
    transcriptModelMs,
    timedOutput,
    timedOutputMs,
    untimedOutputByTimestamp,
    completedAssistantCount,
    completedAssistantDurationCount,
    subagents
  }
  itemsDigestCache.set(items, digest)
  return digest
}

export function sessionMetrics(
  items: readonly ThreadItem[],
  stats: SessionStats | undefined,
  run: RunTiming,
  timing?: SessionTimingRecord,
  options: { historyTruncated?: boolean } = {}
): SessionMetrics {
  const {
    input,
    output,
    cacheRead,
    cacheWrite,
    total,
    lastTurnOutput,
    lastUserTimestamp,
    lastUserOrdinal,
    previousUserIndex,
    previousUserTimestamp,
    previousUserOrdinal,
    userTimestampCounts,
    transcriptTurnCount,
    toolItemCount,
    knownToolTimeMs,
    timedToolCalls,
    previousTurnOutput,
    hasStreamingAssistant,
    transcriptModelMs,
    timedOutput,
    timedOutputMs,
    untimedOutputByTimestamp,
    completedAssistantCount,
    completedAssistantDurationCount,
    subagents
  } = summarizeItems(items, timing?.toolDurationsMs)

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

  const ttftMs = validNonNegative(run.ttftMs) ?? null
  let ttftSum = 0
  let ttftCount = 0
  if (timing?.ttftDurationsMs) {
    for (const id in timing.ttftDurationsMs) {
      const value = timing.ttftDurationsMs[id]
      if (Number.isFinite(value) && value >= 0) {
        ttftSum += value
        ttftCount += 1
      }
    }
  }
  const currentRunRecorded = Boolean(run.runId && timing?.ttftDurationsMs[run.runId] !== undefined)
  const includeCurrentTtft = !currentRunRecorded && ttftMs !== null
  const averageTtftMs = ttftCount || includeCurrentTtft
    ? round((ttftSum + (includeCurrentTtft ? ttftMs! : 0)) / (ttftCount + (includeCurrentTtft ? 1 : 0)))
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
  let turnModelSum = 0
  let hasTurnModelSamples = false
  let messageModelSum = 0
  const journalSpeedDurations = new Map<number, number | null>()
  if (timing?.modelDurationsMs) {
    for (const id in timing.modelDurationsMs) {
      const value = timing.modelDurationsMs[id]
      if (!Number.isFinite(value) || value < 0) continue
      if (id.startsWith('assistant:')) {
        messageModelSum += value
        const stamp = /^assistant:(\d+)(?::|$)/.exec(id)
        const timestamp = stamp ? Number(stamp[1]) : undefined
        if (timestamp !== undefined && untimedOutputByTimestamp.get(timestamp)) {
          journalSpeedDurations.set(timestamp, journalSpeedDurations.has(timestamp) ? null : value)
        }
      } else {
        turnModelSum += value
        hasTurnModelSamples = true
      }
    }
  }
  const measuredModelMs = hasTurnModelSamples ? turnModelSum : messageModelSum
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
  // Pair every completed response with its own duration. Session totals can
  // include other branches, a truncated prefix or newer live usage.
  let speedOutput = timedOutput
  let speedMs = timedOutputMs
  for (const [timestamp, duration] of journalSpeedDurations) {
    if (!duration) continue
    speedOutput += untimedOutputByTimestamp.get(timestamp) ?? 0
    speedMs += duration
  }
  const averageTps = speedMs > 0 ? round(speedOutput / (speedMs / 1000)) : null

  // Usage arrives when the message completes. Pair those tokens only with
  // completed messages' windows: a growing live denominator with a frozen
  // numerator makes the reading fall on every delta and jump on completion.
  // Closed thinking/text blocks still belong to the unfinished message.
  const measuredWindowMs = (hasStreamingAssistant
    ? run.messageGenerationBaseMs
    : run.generationMs) ?? 0
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
  const windowMs = measuredWindowMs > 0
    ? measuredWindowMs
    : legacyWindowMs > 0
      ? legacyWindowMs
      : restoredWindowMs ?? 0
  // Older transcripts can still pair the turn's usage with its generation window.
  const turnTps =
    windowMs > 0 && lastTurnOutput > 0 ? round(lastTurnOutput / (windowMs / 1000)) : null
  // A prompt does not produce tokens at the instant it is sent. Blanking the
  // reading there hid the speed of the turn that had just finished, so hold
  // that completed turn's value until this one has an answer of its own.
  const previousWindowMs = (previousUserIndex >= 0
    ? userTimingDuration(
      timing?.generationWindowMs ?? {},
      previousUserTimestamp,
      previousUserOrdinal,
      previousUserTimestamp === undefined ? 0 : userTimestampCounts.get(previousUserTimestamp) ?? 0
    )
    : undefined) ?? 0
  const heldTps =
    lastTurnOutput === 0 && previousTurnOutput > 0 && previousWindowMs > 0
      ? round(previousTurnOutput / (previousWindowMs / 1000))
      : null

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
    tps: averageTps ?? turnTps ?? heldTps,
    ttftMs,
    subagentTokens: subagents.tokens,
    subagentCost: subagents.cost ?? null,
    subagentTaskCount: subagents.tasks
  }
}

import type { SessionStats } from '@shared/types'
import type { ThreadItem } from './thread'

/**
 * The numbers shown under the composer after a run.
 *
 * Token totals, the cache hit rate and the context window are projections of
 * the transcript and Pi's `get_session_stats`. TPS and TTFT are client
 * observations: Pi reports no timing, so the run records when its first and
 * last text deltas arrived and the speed is derived here. Nothing is stored
 * twice — this function is the only place that derives them.
 */
export interface RunTiming {
  startedAt?: number
  firstTokenAt?: number
  lastTokenAt?: number
}

export interface SessionMetrics {
  /** Tokens used by the conversation so far. */
  totalTokens: number
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
  run: RunTiming
): SessionMetrics {
  let input = 0
  let output = 0
  let cacheRead = 0
  let total = 0
  let lastTurnOutput = 0
  let lastUserIndex = -1

  for (let index = 0; index < items.length; index += 1) {
    if (items[index].kind === 'user') lastUserIndex = index
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
  const totalTokens = statsTokens && statsTokens.total > 0 ? statsTokens.total : total
  const hitRead = statsTokens && statsTokens.total > 0 ? statsTokens.cacheRead : cacheRead
  const hitInput = statsTokens && statsTokens.total > 0 ? statsTokens.input : input
  const hitBase = hitRead + hitInput
  const cacheHitPercent = hitBase > 0 ? round((hitRead / hitBase) * 100) : null

  const context = stats?.contextUsage
  const contextTokens = context?.tokens ?? null
  const contextWindow = context?.contextWindow ?? null
  const contextPercent = context?.percent ?? null

  const ttftMs =
    run.firstTokenAt !== undefined && run.startedAt !== undefined
      ? Math.max(0, run.firstTokenAt - run.startedAt)
      : null
  const windowMs =
    run.lastTokenAt !== undefined && run.firstTokenAt !== undefined
      ? run.lastTokenAt - run.firstTokenAt
      : 0
  const tps =
    windowMs > 0 && lastTurnOutput > 0 ? round(lastTurnOutput / (windowMs / 1000)) : null

  return {
    totalTokens,
    cacheHitPercent,
    contextTokens,
    contextWindow,
    contextPercent,
    tps,
    ttftMs
  }
}

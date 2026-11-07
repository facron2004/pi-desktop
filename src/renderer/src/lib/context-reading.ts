import type { ModelInfo, SessionStats } from '@shared/types'
import type { ThreadItem } from './thread'

/**
 * The one context-window reading the usage line and the context panel share.
 *
 * Pi's `get_session_stats` is the authority: it knows the model's window and
 * its own estimate of what the conversation currently occupies. But that
 * command only answers while a process is running, and a conversation that was
 * merely reopened from disk has no process yet — which used to leave the ring
 * and the panel blank with no way to ask. So the transcript is the fallback:
 * every assistant message carries its own usage, and the newest one is the
 * closest stand-in for "what the last request put in the window".
 *
 * `source` says which side answered, so the UI can be honest about it instead
 * of presenting a derived number as Pi's own.
 */
export interface ContextReading {
  /** Tokens Pi (or the transcript) says are in the window now. */
  tokens: number | null
  contextWindow: number | null
  percent: number | null
  source: 'pi' | 'transcript'
  /** Session totals, for the panels that list the token split. */
  tokensTotal: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Pi's own cost reading; the transcript cannot derive it. */
  cost: number | null
}

function windowOf(...models: (ModelInfo | { contextWindow?: number } | undefined)[]): number | null {
  for (const model of models) {
    const window = model?.contextWindow
    if (typeof window === 'number' && window > 0) return window
  }
  return null
}

function percentOf(tokens: number | null, window: number | null): number | null {
  if (tokens === null || window === null || window <= 0) return null
  return (tokens / window) * 100
}

export function contextReading(input: {
  stats?: SessionStats
  items: readonly ThreadItem[]
  /** The model the live session reported, when there is one. */
  model?: ModelInfo
  /** The model the app would start with, for a conversation with no process. */
  fallbackModel?: ModelInfo
}): ContextReading {
  const { stats, items, model, fallbackModel } = input

  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheWrite = 0
  let total = 0
  let newestContext: number | null = null
  for (const item of items) {
    if (item.kind !== 'assistant' || !item.usage) continue
    const usage = item.usage
    inputTokens += usage.input
    outputTokens += usage.output
    cacheRead += usage.cacheRead
    cacheWrite += usage.cacheWrite
    total += usage.totalTokens
    // The newest message is the closest thing the transcript knows to "what
    // the last request actually put in the window".
    newestContext = usage.totalTokens
  }

  const statsTokens = stats?.tokens
  const hasStats = Boolean(statsTokens && statsTokens.total > 0)
  const totals = hasStats
    ? {
        tokensTotal: statsTokens!.total,
        input: statsTokens!.input,
        output: statsTokens!.output,
        cacheRead: statsTokens!.cacheRead,
        cacheWrite: statsTokens!.cacheWrite
      }
    : {
        tokensTotal: total,
        input: inputTokens,
        output: outputTokens,
        cacheRead,
        cacheWrite
      }

  const context = stats?.contextUsage
  const reportedTokens = typeof context?.tokens === 'number' ? context.tokens : null
  const window = windowOf(model, fallbackModel) ?? (context?.contextWindow || null)

  // Pi reporting `null` tokens means it has no valid usage yet (right after a
  // compaction). The transcript's newest message is then the honest estimate.
  const tokens = reportedTokens ?? newestContext
  const percent = context?.percent ?? percentOf(tokens, window)

  return {
    tokens,
    contextWindow: window,
    percent,
    source: reportedTokens !== null || context?.percent != null ? 'pi' : 'transcript',
    ...totals,
    cost: typeof stats?.cost === 'number' ? stats.cost : null
  }
}

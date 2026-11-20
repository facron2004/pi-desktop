import type { ThreadItem } from './thread'
import { subagentCallOf, type SubagentCall } from './subagents'

/**
 * The tokens and cost the subagents of one conversation reported.
 *
 * This is an independent reading: a child runs as its own Pi process, so its
 * usage never appears in the parent's `get_session_stats` or in the parent
 * transcript's usage. Adding it into `totalTokens` would also change the
 * parent's cache hit rate, so the numbers stay separate.
 */
export interface SubagentUsage {
  /** Sum of input + output + cache read + cache write across every task. */
  tokens: number
  /** Sum of the costs tasks reported, or undefined when none reported one. */
  cost?: number
  /** Tasks that took part in the reading. */
  tasks: number
  /** Tasks that reported a terminal state. */
  settled: number
}

/** A task status that means the child stopped reporting progress. */
const SETTLED: ReadonlySet<string> = new Set(['completed', 'failed', 'aborted', 'timed_out'])

export function accumulateSubagentCall(usage: SubagentUsage, call: SubagentCall): void {
  for (const task of call.tasks) {
    usage.tasks += 1
    usage.tokens += task.tokens ?? 0
    // `subagentCalls` only sets a cost when the child reported a number;
    // a non-finite report is not a cost and must not poison the sum.
    if (typeof task.cost === 'number' && Number.isFinite(task.cost)) {
      usage.cost = (usage.cost ?? 0) + task.cost
    }
    if (SETTLED.has(task.status)) usage.settled += 1
  }
}

/**
 * Derive the subagent usage from the tool nodes, through the same projection
 * the tree and the rail use. No second parser: `subagentCalls` already reads
 * `details.results[].usage` and applies the token arithmetic.
 */
export function subagentUsage(items: readonly ThreadItem[]): SubagentUsage {
  const usage: SubagentUsage = { tokens: 0, cost: undefined, tasks: 0, settled: 0 }

  for (const item of items) {
    if (item.kind !== 'tool' || item.toolName !== 'subagent') continue
    accumulateSubagentCall(usage, subagentCallOf(item))
  }

  return usage
}

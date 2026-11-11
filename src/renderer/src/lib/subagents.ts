import type { AgentMessage, SubagentTaskProgress, SubagentTaskStatus } from '@shared/types'
import type { ThreadItem, ToolItem } from './thread'

export interface SubagentTreeTask extends Omit<SubagentTaskProgress, 'status'> {
  id: string
  status: SubagentTaskStatus | 'proposed'
  /** Token usage the child reported, for the compact row metrics. */
  tokens?: number
  cost?: number
}

export interface SubagentCall {
  id: string
  tasks: SubagentTreeTask[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function time(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function statusOf(tool: ToolItem, result: Record<string, unknown>): SubagentTreeTask['status'] {
  if (tool.status === 'proposed') return 'proposed'
  // A sibling can still be running after this task finishes. Likewise, a
  // parent abort must not change a child that already completed successfully.
  if (result.status === 'completed' || result.status === 'failed' || result.status === 'aborted' || result.status === 'timed_out') {
    return result.status
  }
  // A stopped parent makes every unfinished child aborted even if a late
  // progress update still says it was running.
  if (tool.status === 'aborted') return 'aborted'
  // Live batches can be observed while the parent tool node is already `ok`
  // (for example a persisted update); the per-task status is newer than the
  // parent node's terminal state.
  if (result.status === 'queued' || result.status === 'running') return result.status
  if (result.aborted || result.stopReason === 'aborted') return 'aborted'
  if (typeof result.exitCode === 'number' && result.exitCode !== -1) {
    return result.exitCode === 0 && result.stopReason !== 'error' ? 'completed' : 'failed'
  }
  if (tool.status === 'error') return 'failed'
  if (tool.status === 'ok') return 'completed'
  // Old sessions did not record explicit task states; -1 meant a live child.
  return result.exitCode === -1 ? 'running' : 'queued'
}

/** Derive the tree from tool nodes, shared by live progress and session replay. */
export function subagentCalls(items: readonly ThreadItem[]): SubagentCall[] {
  const calls: SubagentCall[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || item.toolName !== 'subagent') continue
    const details = record(item.details)
    const results = Array.isArray(details.results) ? details.results.map(record) : []
    const requested = Array.isArray(item.args.tasks) ? item.args.tasks.map(record) : [item.args]
    const id = item.toolCallId || item.id
    const count = Math.max(requested.length, results.length, 1)
    calls.push({
      id,
      tasks: Array.from({ length: count }, (_, index) => {
        const result = results[index] ?? {}
        const args = requested[index] ?? {}
        const status = statusOf(item, result)
        const usage = record(result.usage)
        return {
          id: `${id}:${index}`,
          task: text(result.task) || text(args.task) || 'Subagent',
          label: text(result.label) || text(args.label),
          cwd: text(result.cwd) || text(args.cwd) || text(item.args.cwd) || '',
          status,
          model: text(result.model) || text(item.args.model),
          activity: status === 'running' ? text(result.activity) : undefined,
          toolName: status === 'running' ? text(result.toolName) : undefined,
          progressText: status === 'running' ? text(result.progressText) : undefined,
          startedAt: time(result.startedAt),
          finishedAt: time(result.finishedAt) ?? (status === 'aborted' ? item.finishedAt : undefined),
          tokens: usage.input !== undefined || usage.output !== undefined
            ? numberOf(usage.input) + numberOf(usage.output) + numberOf(usage.cacheRead) + numberOf(usage.cacheWrite)
            : undefined,
          cost: typeof usage.cost === 'number' ? usage.cost : undefined,
          messages: Array.isArray(result.messages) ? result.messages as AgentMessage[] : undefined,
          messagesTruncated: result.messagesTruncated === true,
          output: text(result.output) || (count === 1 ? item.result : undefined),
          errorMessage: text(result.errorMessage) || (status === 'failed' ? text(result.stderr) : undefined)
        }
      })
    })
  }
  return calls
}

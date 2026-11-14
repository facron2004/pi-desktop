import type {
  AgentMessage,
  ContentBlock,
  SubagentTaskProgress,
  SubagentTaskStatus
} from '@shared/types'
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

/* ------------------------------------------------------------------ *
 * The title badge's projection
 *
 * The badge beside the conversation title and the task rail read the very
 * same tool nodes. Everything below is derived from `subagentCalls`, so a
 * live progress update reaches the badge without a second store of state.
 * ------------------------------------------------------------------ */

const TERMINAL_STATUSES = new Set<SubagentTreeTask['status']>([
  'completed', 'failed', 'aborted', 'timed_out'
])

/** Every child task of one conversation, in the order the calls appeared. */
export function subagentTasks(items: readonly ThreadItem[]): SubagentTreeTask[] {
  return subagentCalls(items).flatMap((call) => call.tasks)
}

/** Only a task that still occupies a worker slot is in flight. */
export function isActiveSubagent(task: SubagentTreeTask): boolean {
  return task.status === 'running' || task.status === 'queued'
}

export interface SubagentSummary {
  total: number
  active: number
  finished: number
}

export function summarizeSubagents(tasks: readonly SubagentTreeTask[]): SubagentSummary {
  let active = 0
  let finished = 0
  for (const task of tasks) {
    if (isActiveSubagent(task)) active += 1
    if (TERMINAL_STATUSES.has(task.status)) finished += 1
  }
  return { total: tasks.length, active, finished }
}

const PREVIEW_LIMIT = 240

/** One line is all the badge's list has room for. */
function clipPreview(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > PREVIEW_LIMIT
    ? `${flat.slice(0, PREVIEW_LIMIT - 1)}…`
    : flat
}

function activityOf(task: SubagentTreeTask): string {
  return [task.activity, task.toolName]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

/**
 * The last thing the child actually said. Thinking, tool calls and images are
 * not its answer, and an older assistant message is not the newest one.
 */
function lastAssistantText(messages: readonly AgentMessage[] | undefined): string {
  if (!messages) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') continue
    const content = message.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((block): block is Extract<ContentBlock, { type: 'text' }> =>
              Boolean(block) && typeof block === 'object' && (block as ContentBlock).type === 'text')
            .map((block) => block.text ?? '')
            .join(' ')
        : ''
    if (text.trim()) return text
  }
  return ''
}

/**
 * A short look at what a child is doing or produced, for the title badge.
 *
 * A live tail wins while it runs, a failure explains itself, and a finished
 * child answers with its own last words. Nothing here invents content: an
 * empty source simply falls through to the next one.
 */
export function subagentPreview(task: SubagentTreeTask): string {
  const candidates: (string | undefined)[] = []
  if (task.status === 'running') {
    candidates.push(task.progressText, activityOf(task))
  }
  if (task.status === 'failed' || task.status === 'aborted' || task.status === 'timed_out') {
    candidates.push(task.errorMessage)
  }
  candidates.push(
    lastAssistantText(task.messages),
    task.output,
    activityOf(task),
    task.progressText
  )
  for (const candidate of candidates) {
    const preview = clipPreview(candidate ?? '')
    if (preview) return preview
  }
  return ''
}

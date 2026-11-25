import type { ThreadItem } from './thread'
import { subagentCallOf, type SubagentTreeTask } from './subagents'

export type SwarmDisplayStatus = SwarmWorkerStatus | 'queued' | 'history'

/**
 * What the page should show for one worker.
 *
 * The same worker data means different things live and after the turn: a
 * running worker in a replayed conversation did finish, and an idle worker with
 * a queue has work waiting even though its status says idle.
 */
export function displayStatusOf(worker: SwarmWorkerState, live: boolean): SwarmDisplayStatus {
  const active = isSwarmWorking(worker)
  if (!live && active) return 'history'
  if (live && worker.status === 'idle' && (worker.queued ?? 0) > 0) return 'queued'
  return worker.status
}

/** One task the lead handed to a worker, projected from its tool call. */
export interface SwarmAssignment {
  id: string
  worker: string
  task: string
  status: SubagentTreeTask['status']
  at?: number
  tokens?: number
  model?: string
  result: SubagentTreeTask
}

/** Every swarm_task / swarm_message in invocation order, newest first. */
export function swarmAssignments(items: readonly ThreadItem[]): SwarmAssignment[] {
  const assignments: SwarmAssignment[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || (item.toolName !== 'swarm_task' && item.toolName !== 'swarm_message')) continue
    for (const task of subagentCallOf(item).tasks) {
      assignments.push({
        id: task.id,
        worker: (task.label ?? '').trim(),
        task: task.task,
        status: task.status,
        at: task.finishedAt ?? task.startedAt,
        tokens: task.tokens,
        model: task.model,
        result: task
      })
    }
  }
  return assignments.reverse()
}

export function assignmentsByWorker(assignments: readonly SwarmAssignment[]): Map<string, SwarmAssignment[]> {
  const lanes = new Map<string, SwarmAssignment[]>()
  // Iterate oldest first so a lane reads left to right like the work happened.
  for (const assignment of [...assignments].reverse()) {
    const key = assignment.worker || '—'
    const lane = lanes.get(key)
    if (lane) lane.push(assignment)
    else lanes.set(key, [assignment])
  }
  return lanes
}

export interface SwarmAssignmentCounts {
  total: number
  active: number
  queued: number
  completed: number
  failed: number
}

export function countAssignments(assignments: readonly SwarmAssignment[]): SwarmAssignmentCounts {
  const counts: SwarmAssignmentCounts = { total: assignments.length, active: 0, queued: 0, completed: 0, failed: 0 }
  for (const assignment of assignments) {
    if (assignment.status === 'running') counts.active += 1
    else if (assignment.status === 'queued' || assignment.status === 'dispatched') counts.queued += 1
    else if (assignment.status === 'failed' || assignment.status === 'timed_out') counts.failed += 1
    else if (assignment.status === 'completed') counts.completed += 1
  }
  return counts
}

export type SwarmWorkerFilter = 'all' | 'active' | 'idle' | 'failed'

export function filterWorkers(
  workers: readonly SwarmWorkerState[],
  live: boolean,
  filter: SwarmWorkerFilter
): SwarmWorkerState[] {
  if (filter === 'all') return [...workers]
  return workers.filter((worker) => {
    const status = displayStatusOf(worker, live)
    if (filter === 'active') return status === 'starting' || status === 'working' || status === 'queued'
    if (filter === 'failed') return status === 'failed'
    return status === 'idle' || status === 'stopped' || status === 'history'
  })
}

export type SwarmAssignmentFilter = 'all' | 'active' | 'done' | 'failed'

export function filterAssignments(
  assignments: readonly SwarmAssignment[],
  filter: SwarmAssignmentFilter
): SwarmAssignment[] {
  if (filter === 'all') return [...assignments]
  return assignments.filter((assignment) => {
    if (filter === 'active') return assignment.status === 'running' || assignment.status === 'queued' || assignment.status === 'dispatched'
    if (filter === 'failed') return assignment.status === 'failed' || assignment.status === 'timed_out'
    return assignment.status === 'completed'
  })
}

/** One line of the orchestration feed: what a worker is doing, or what was handed over. */
export interface SwarmFeedEvent {
  id: string
  kind: 'worker' | 'assignment'
  at?: number
  name: string
  task?: string
  activity?: string
  status: SwarmDisplayStatus | SubagentTreeTask['status']
  assignment?: SwarmAssignment
}

/**
 * The orchestration feed: live workers first (that is what is happening now),
 * then the newest hand-offs. Capped so a long session stays readable.
 */
export function swarmFeed(
  workers: readonly SwarmWorkerState[],
  assignments: readonly SwarmAssignment[],
  live: boolean,
  limit = 8
): SwarmFeedEvent[] {
  const events: SwarmFeedEvent[] = []
  if (live) {
    for (const worker of workers) {
      if (!isSwarmWorking(worker)) continue
      events.push({
        id: `worker:${worker.name}`,
        kind: 'worker',
        at: worker.startedAt,
        name: worker.name,
        task: worker.task,
        activity: swarmPreview(worker),
        status: displayStatusOf(worker, true)
      })
    }
  }
  for (const assignment of assignments) {
    events.push({
      id: `assignment:${assignment.id}`,
      kind: 'assignment',
      at: assignment.at,
      name: assignment.worker,
      task: assignment.task,
      status: assignment.status,
      assignment
    })
  }
  return events
    .sort((left, right) => (left.kind === right.kind
      ? (right.at ?? 0) - (left.at ?? 0)
      : left.kind === 'worker' ? -1 : 1))
    .slice(0, Math.max(0, limit))
}

/** Earliest start across workers, for the overview's "elapsed" reading. */
export function swarmStartedAt(workers: readonly SwarmWorkerState[]): number | undefined {
  let earliest: number | undefined
  for (const worker of workers) {
    if (worker.startedAt === undefined) continue
    if (earliest === undefined || worker.startedAt < earliest) earliest = worker.startedAt
  }
  return earliest
}



/**
 * The projection the Swarm panel reads.
 *
 * Swarm tools report their whole worker roster in `details.workers`, and the
 * extension also publishes the same roster through the `setStatus` channel
 * while it runs. Both are projections of one process state: the details keep
 * the invited history of a session, the status entry carries what is live now.
 */

export const SWARM_STATUS_KEY = 'pi-desktop-swarm'

export type SwarmWorkerStatus = 'starting' | 'working' | 'idle' | 'failed' | 'stopped'

export interface SwarmWorkerState {
  name: string
  role?: string
  status: SwarmWorkerStatus
  model?: string
  task?: string
  output?: string
  outputTruncated?: boolean
  progressText?: string
  activity?: string
  toolName?: string
  startedAt?: number
  finishedAt?: number
  recycled?: boolean
  queued?: number
  turns?: number
  tokens?: number
  cost?: number
  errorMessage?: string
}

const STATUSES = new Set<SwarmWorkerStatus>(['starting', 'working', 'idle', 'failed', 'stopped'])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeWorker(value: unknown): SwarmWorkerState | undefined {
  const raw = record(value)
  const name = text(raw.name)
  if (!name) return undefined
  const status = text(raw.status) as SwarmWorkerStatus | undefined
  return {
    name,
    role: text(raw.role),
    status: status && STATUSES.has(status) ? status : 'idle',
    model: text(raw.model),
    task: text(raw.task),
    output: text(raw.output),
    outputTruncated: raw.outputTruncated === true,
    progressText: text(raw.progressText),
    activity: text(raw.activity),
    toolName: text(raw.toolName),
    startedAt: numberOf(raw.startedAt),
    finishedAt: numberOf(raw.finishedAt),
    recycled: raw.recycled === true,
    queued: numberOf(raw.queued),
    turns: numberOf(raw.turns),
    tokens: numberOf(raw.tokens),
    cost: numberOf(raw.cost),
    errorMessage: text(raw.errorMessage)
  }
}

/** The status entry carries the live roster as JSON; anything else is ignored. */
export function parseSwarmSnapshots(value: string | undefined): SwarmWorkerState[] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      const worker = normalizeWorker(entry)
      return worker ? [worker] : []
    })
  } catch {
    return []
  }
}

/** Each tool result carries a complete roster at the time it was reported. */
export function swarmWorkers(items: readonly ThreadItem[]): SwarmWorkerState[] {
  let latest: unknown[] = []
  let reportedAt = -Infinity
  for (const item of items) {
    if (item.kind !== 'tool' || !item.toolName.startsWith('swarm_')) continue
    const details = record(item.details)
    if (!Array.isArray(details.workers)) continue
    // Tool cards stay in invocation order, even when their results arrive out of order.
    const timestamp = item.finishedAt ?? item.timestamp
    if (timestamp < reportedAt) continue
    latest = details.workers
    reportedAt = timestamp
  }
  return latest.flatMap((entry) => {
    const worker = normalizeWorker(entry)
    return worker ? [worker] : []
  })
}

export function isSwarmWorking(worker: SwarmWorkerState): boolean {
  return worker.status === 'working' || worker.status === 'starting' || (worker.queued ?? 0) > 0
}

export interface SwarmSummary {
  total: number
  working: number
  idle: number
  failed: number
  stopped: number
  tokens: number
}

export function summarizeSwarm(workers: readonly SwarmWorkerState[]): SwarmSummary {
  let working = 0
  let idle = 0
  let failed = 0
  let stopped = 0
  let tokens = 0
  for (const worker of workers) {
    if (isSwarmWorking(worker)) working += 1
    else if (worker.status === 'failed') failed += 1
    else if (worker.status === 'stopped') stopped += 1
    else idle += 1
    tokens += worker.tokens ?? 0
  }
  return { total: workers.length, working, idle, failed, stopped, tokens }
}

/**
 * The one sentence at the top of the Swarm page.
 *
 * A live team says who is working. Failures only become the sentence when
 * nobody is. A closed mode with people still running says they are finishing.
 * Without a live roster the page is a snapshot, not a team that is idle.
 */
export function swarmSituation(
  summary: SwarmSummary,
  live: boolean,
  swarmMode: boolean
): { key: string; count?: number } {
  if (!live) return { key: 'No live connection. This is the last team snapshot.' }
  if (!swarmMode && summary.working > 0) {
    return { key: 'Swarm Mode is off. {count} workers are still finishing.', count: summary.working }
  }
  if (summary.working > 0) return { key: '{count} workers are working', count: summary.working }
  if (summary.failed > 0) return { key: '{count} failed, the team is waiting', count: summary.failed }
  return { key: 'The team is idle. More work can be assigned.' }
}

/** The second line of a roster row: what that worker is doing right now. */
export type SwarmRosterLine =
  | { kind: 'tool'; tool: string }
  | { kind: 'activity'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'last'; text: string }
  | { kind: 'none' }

function flat(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim()
}

export function swarmRosterLine(worker: SwarmWorkerState, live: boolean): SwarmRosterLine {
  if (live && (worker.status === 'working' || worker.status === 'starting')) {
    const tool = flat(worker.toolName)
    if (tool) return { kind: 'tool', tool }
    const activity = flat(worker.activity)
    if (activity && activity !== 'Starting' && activity !== 'Working') return { kind: 'activity', text: activity }
    const preview = swarmPreview(worker)
    if (preview) return { kind: 'activity', text: preview }
    if (worker.status === 'starting') return { kind: 'activity', text: 'Starting' }
    return { kind: 'none' }
  }
  const error = flat(worker.errorMessage)
  if (worker.status === 'failed' && error) return { kind: 'error', text: error }
  const task = flat(worker.task)
  if (task) return { kind: 'last', text: task }
  return { kind: 'none' }
}

/**
 * The roster the page lists.
 *
 * A live status entry wins. A saved roster wins after the process is gone.
 * When a session only kept the hand-overs, one idle row per worker still
 * opens those turns — the names stay in the order the work first appeared.
 */
export function rosterForPage(
  liveWorkers: readonly SwarmWorkerState[],
  historyWorkers: readonly SwarmWorkerState[],
  assignments: readonly SwarmAssignment[],
  live: boolean
): SwarmWorkerState[] {
  if (live) return [...liveWorkers]
  if (historyWorkers.length) return [...historyWorkers]
  const seen = new Set<string>()
  const synthesized: SwarmWorkerState[] = []
  for (const assignment of [...assignments].reverse()) {
    const name = assignment.worker.trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    synthesized.push({ name, status: 'idle', task: assignment.task })
  }
  return synthesized
}

/** True while the lead's spawn call has not settled and the roster may still be empty. */
export function swarmSpawnPending(items: readonly ThreadItem[]): boolean {
  return items.some((item) =>
    item.kind === 'tool'
    && item.toolName === 'swarm_spawn'
    && (item.status === 'proposed' || item.status === 'running')
  )
}

/** A one-line preview: a live tail while working, the report once idle. */
export function swarmPreview(worker: SwarmWorkerState): string {
  if (worker.status === 'starting') return ''
  const candidates = worker.status === 'working'
    ? [worker.progressText, worker.toolName, worker.activity, worker.task]
    : [worker.errorMessage, worker.output, worker.task]
  for (const candidate of candidates) {
    const flat = (candidate ?? '').replace(/\s+/g, ' ').trim()
    if (flat) return flat
  }
  return ''
}

import type { ThreadItem } from './thread'

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

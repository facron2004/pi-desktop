import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskSchedule,
  ScheduledTaskStatus,
  RuntimeRekey,
  RuntimeStatus,
  PiEvent
} from '@shared/types'
import type { SettingsStore } from './settings'
import type { SessionSupervisor } from './pi/supervisor'
import { lastRunAssistantMessage } from './pi/run-result'
import { properLockfile } from './proper-lockfile'

interface ScheduledTaskServiceOptions {
  userData: string
  settings: SettingsStore
  supervisor: SessionSupervisor
  customInstructions: (cwd: string) => string | undefined
}

interface ActiveRun {
  taskId: string
  draftKey: string
  lastRunAt: number
  sessionFile?: string
  modelError?: string
  releaseRunLock: () => void
  releaseRunSlot: () => void
}

interface PendingRunResult {
  lastRunAt: number
  lastStatus: ScheduledTaskStatus
  lastError?: string
  lastSessionFile?: string
  releaseRunLock: () => void
}

interface TaskRunOwner {
  token: string
  ownerPid: number
  piPid?: number
}

interface RunSlotLease {
  ownerFile: string
  release: () => void
}

const TIMER_SLICE_MS = 60_000
const CROSS_PROCESS_POLL_MS = 2_000
/**
 * How long a task waits after an automatic launch failed before it is attempted
 * again. A launch that fails before its schedule was advanced leaves the task
 * due, and a zero-delay retry would turn an unwritable task file into a busy
 * loop (measured at ~26 attempts a second).
 */
const FAILED_LAUNCH_RETRY_MS = 60_000
/** A due task is never polled faster than this, so no failure can spin the timer. */
const MIN_DUE_DELAY_MS = 250
const TASK_LOCK_STALE_MS = 60_000
const TASK_LOCK_UPDATE_MS = 20_000
const LIVE_PROCESS_LOCK_STALE_MS = Number.MAX_SAFE_INTEGER
const MAX_CONCURRENT_SCHEDULED_RUNS = 4
const MAX_SCHEDULED_TASKS = 100
const MAX_SCHEDULED_TASK_PROMPT_CHARS = 100_000
const MAX_SCHEDULED_TASK_ERROR_CHARS = 4_096
const MAX_SCHEDULED_TASK_MODEL_CHARS = 256
const MAX_SCHEDULED_TASK_SESSION_FILE_CHARS = 32_768
const MAX_SCHEDULED_TASK_FILE_BYTES = 96 * 1024 * 1024
const SCHEDULED_TASK_STATUSES = new Set<ScheduledTaskStatus>(['running', 'completed', 'error', 'aborted'])
/** Pi's own effort scale, the one `--thinking` accepts. */
const SCHEDULED_TASK_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

class InvalidScheduledTaskFileError extends Error {}

function scheduledTaskFileFingerprint(file: string): string {
  try {
    const stats = statSync(file, { bigint: true })
    if (!stats.isFile()) throw new Error('The scheduled task file is not a regular file.')
    if (stats.size > BigInt(MAX_SCHEDULED_TASK_FILE_BYTES)) {
      throw new Error('The scheduled task file exceeds the size limit.')
    }
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
}

function parseStoredTasks(raw: string): ScheduledTask[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new InvalidScheduledTaskFileError('The scheduled task file is invalid.')
  }
  if (!Array.isArray(parsed)) throw new InvalidScheduledTaskFileError('The scheduled task file is invalid.')
  if (parsed.length > MAX_SCHEDULED_TASKS) {
    throw new InvalidScheduledTaskFileError(`The scheduled task file contains more than ${MAX_SCHEDULED_TASKS} tasks.`)
  }
  const kept = parsed.filter(isStoredTask)
  if (kept.length !== parsed.length) {
    // A record with no id, title or usable schedule cannot be shown or run, so it
    // is dropped — but the drop has to be visible somewhere, because the next
    // write persists the pruned list.
    console.error(
      `[pi-desktop] ignored ${parsed.length - kept.length} unusable scheduled task record(s)`
    )
  }
  return kept.map((task) => {
    const lastError = limitScheduledTaskError(task.lastError)
    const lastSessionFile = task.lastSessionFile !== undefined &&
      task.lastSessionFile.length > MAX_SCHEDULED_TASK_SESSION_FILE_CHARS
      ? undefined
      : task.lastSessionFile
    const model = normalizeScheduledTaskModel(task.model)
    const thinkingLevel = normalizeScheduledTaskThinkingLevel(task.thinkingLevel)
    return lastError === task.lastError &&
      lastSessionFile === task.lastSessionFile &&
      model === task.model &&
      thinkingLevel === task.thinkingLevel
      ? task
      : { ...task, lastError, lastSessionFile, model, thinkingLevel }
  })
}

/** An empty or unusable model is "follow the app default", not a broken task. */
function normalizeScheduledTaskModel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const model = value.trim()
  return model && model.length <= MAX_SCHEDULED_TASK_MODEL_CHARS ? model : undefined
}

function normalizeScheduledTaskThinkingLevel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const level = value.trim().toLowerCase()
  return SCHEDULED_TASK_THINKING_LEVELS.has(level) ? level : undefined
}

function limitScheduledTaskError(error: string | undefined): string | undefined {
  return error === undefined ? undefined : error.slice(0, MAX_SCHEDULED_TASK_ERROR_CHARS)
}

function validScheduledTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function processLiveness(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'dead'
    if (code === 'EPERM') return 'alive'
    return 'unknown'
  }
}

function isStoredTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const task = value as Record<string, unknown>
  if (
    typeof task.id !== 'string' || !task.id || task.id.length > 128 ||
    typeof task.title !== 'string' || !task.title || task.title.length > 120 ||
    typeof task.prompt !== 'string' || !task.prompt.trim() || task.prompt.length > MAX_SCHEDULED_TASK_PROMPT_CHARS ||
    typeof task.workspaceId !== 'string' || !task.workspaceId || task.workspaceId.length > 256 ||
    typeof task.enabled !== 'boolean' ||
    typeof task.createdAt !== 'number' || !Number.isFinite(task.createdAt)
  ) return false

  const schedule = task.schedule
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return false
  const valueSchedule = schedule as Record<string, unknown>
  if (valueSchedule.kind === 'once') {
    if (typeof valueSchedule.at !== 'number' || !Number.isFinite(valueSchedule.at)) return false
  } else if (valueSchedule.kind === 'daily') {
    if (!validScheduledTime(valueSchedule.time)) return false
  } else if (valueSchedule.kind === 'weekly') {
    if (
      !validScheduledTime(valueSchedule.time) ||
      !Number.isInteger(valueSchedule.weekday) ||
      (valueSchedule.weekday as number) < 0 ||
      (valueSchedule.weekday as number) > 6
    ) return false
  } else {
    return false
  }

  if (task.nextRunAt !== undefined && (typeof task.nextRunAt !== 'number' || !Number.isFinite(task.nextRunAt))) return false
  if (task.lastRunAt !== undefined && (typeof task.lastRunAt !== 'number' || !Number.isFinite(task.lastRunAt))) return false
  if (task.lastStatus !== undefined && !SCHEDULED_TASK_STATUSES.has(task.lastStatus as ScheduledTaskStatus)) return false
  if (task.lastError !== undefined && typeof task.lastError !== 'string') return false
  if (task.lastSessionFile !== undefined && typeof task.lastSessionFile !== 'string') return false
  if (task.model !== undefined && typeof task.model !== 'string') return false
  if (task.thinkingLevel !== undefined && typeof task.thinkingLevel !== 'string') return false
  return true
}

function nextOccurrence(schedule: ScheduledTaskSchedule, from: number): number | undefined {
  if (schedule.kind === 'once') return schedule.at
  const [hour, minute] = schedule.time.split(':').map(Number)
  const candidate = new Date(from)
  candidate.setHours(hour, minute, 0, 0)
  if (schedule.kind === 'daily') {
    if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1)
    return candidate.getTime()
  }
  const daysUntil = (schedule.weekday - candidate.getDay() + 7) % 7
  candidate.setDate(candidate.getDate() + daysUntil)
  if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 7)
  return candidate.getTime()
}

function validateInput(
  value: ScheduledTaskInput,
  options: { allowPastOnce?: boolean } = {}
): ScheduledTaskInput {
  const title = String(value?.title ?? '').trim().slice(0, 120)
  const rawPrompt = String(value?.prompt ?? '')
  if (rawPrompt.length > MAX_SCHEDULED_TASK_PROMPT_CHARS) {
    throw new Error(`Task prompts must be at most ${MAX_SCHEDULED_TASK_PROMPT_CHARS.toLocaleString()} characters.`)
  }
  const prompt = rawPrompt.trim()
  const workspaceId = String(value?.workspaceId ?? '').trim()
  const schedule = value?.schedule
  const rawModel = typeof value?.model === 'string' ? value.model.trim() : ''
  const model = rawModel ? normalizeScheduledTaskModel(rawModel) : undefined
  const rawThinkingLevel = typeof value?.thinkingLevel === 'string' ? value.thinkingLevel.trim() : ''
  const thinkingLevel = rawThinkingLevel ? normalizeScheduledTaskThinkingLevel(rawThinkingLevel) : undefined
  if (!title) throw new Error('Enter a task name.')
  if (!prompt) throw new Error('Enter the prompt to run.')
  if (!workspaceId || workspaceId.length > 256) throw new Error('Choose a project.')
  if (rawModel && !model) throw new Error('Choose a valid model.')
  if (rawThinkingLevel && !thinkingLevel) throw new Error('Choose a valid reasoning effort.')
  if (!schedule || !['once', 'daily', 'weekly'].includes(schedule.kind)) {
    throw new Error('Choose a valid schedule.')
  }
  // An unset choice follows the app's current default, so it stays absent.
  const choice = {
    ...(model ? { model } : {}),
    ...(thinkingLevel ? { thinkingLevel } : {})
  }
  if (schedule.kind === 'once') {
    if (!Number.isFinite(schedule.at)) {
      throw new Error('Choose a valid date and time.')
    }
    if (schedule.at <= Date.now() && !options.allowPastOnce) {
      throw new Error('Choose a future date and time.')
    }
    return { title, prompt, workspaceId, schedule: { kind: 'once', at: schedule.at }, ...choice }
  }
  if (!validScheduledTime(schedule.time)) {
    throw new Error('Choose a valid local time.')
  }
  if (schedule.kind === 'weekly') {
    if (!Number.isInteger(schedule.weekday) || schedule.weekday < 0 || schedule.weekday > 6) {
      throw new Error('Choose a valid day of the week.')
    }
    return {
      title,
      prompt,
      workspaceId,
      schedule: { kind: 'weekly', time: schedule.time, weekday: schedule.weekday },
      ...choice
    }
  }
  return { title, prompt, workspaceId, schedule: { kind: 'daily', time: schedule.time }, ...choice }
}

/** Persistent local-time scheduler. A task starts a fresh Pi session per run. */
export class ScheduledTaskService extends EventEmitter {
  private readonly file: string
  private fileFingerprint: string | undefined
  private readonly settings: SettingsStore
  private readonly supervisor: SessionSupervisor
  private readonly customInstructions: (cwd: string) => string | undefined
  private tasks: ScheduledTask[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly activeTasks = new Map<string, ActiveRun>()
  private readonly activeRuns = new Map<string, ActiveRun>()
  private disposed = false
  private schedulingStopped = false
  private waitingForRunSlot = false
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private readonly pendingRunResults = new Map<string, PendingRunResult>()
  private tasksAfterFailedLaunch: ScheduledTask[] | undefined

  constructor(options: ScheduledTaskServiceOptions) {
    super()
    this.file = path.join(options.userData, 'scheduled-tasks.json')
    this.settings = options.settings
    this.supervisor = options.supervisor
    this.customInstructions = options.customInstructions
    this.refreshFromDisk(true)
    this.recoverInterruptedRuns()
    this.supervisor.on('event', this.onRuntimeEvent)
    this.supervisor.on('rekey', this.onRuntimeRekey)
    this.supervisor.on('status', this.onRuntimeStatus)
    this.scheduleNext()
    this.scheduleRefresh()
  }

  list(): ScheduledTask[] {
    this.refreshFromDisk()
    return this.cloneTasks(this.tasks)
  }

  create(input: ScheduledTaskInput): ScheduledTask[] {
    const normalized = validateInput(input)
    this.assertWorkspace(normalized.workspaceId)
    this.mutateTasks((tasks) => {
      if (tasks.length >= MAX_SCHEDULED_TASKS) {
        throw new Error(`You can create up to ${MAX_SCHEDULED_TASKS} scheduled tasks.`)
      }
      const now = Date.now()
      const task: ScheduledTask = {
        ...normalized,
        id: randomUUID(),
        enabled: true,
        createdAt: now,
        nextRunAt: nextOccurrence(normalized.schedule, now)
      }
      return [...tasks, task]
    })
    return this.list()
  }

  update(id: string, input: ScheduledTaskInput): ScheduledTask[] {
    this.mutateTasks((tasks) => {
      const current = this.requireTask(id, tasks)
      // A one-time task that already ran keeps its past date when only its
      // title, prompt or model is edited. An enabled task still has to point
      // at the future: its schedule is what will launch it.
      const normalized = validateInput(input, { allowPastOnce: !current.enabled })
      this.assertWorkspace(normalized.workspaceId)
      const now = Date.now()
      return tasks.map((task) => task.id === id
        ? {
            ...task,
            ...normalized,
            // An omitted choice means "follow the app default" and has to clear
            // the value the task carried before.
            model: normalized.model,
            thinkingLevel: normalized.thinkingLevel,
            nextRunAt: task.enabled ? nextOccurrence(normalized.schedule, now) : undefined
          }
        : task)
    })
    return this.list()
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask[] {
    this.mutateTasks((tasks) => {
      const current = this.requireTask(id, tasks)
      if (enabled && current.schedule.kind === 'once' && current.schedule.at <= Date.now()) {
        throw new Error('Edit this one-time task to choose a future date before enabling it.')
      }
      return tasks.map((task) => task.id === id
        ? {
            ...task,
            enabled,
            nextRunAt: enabled
              ? (task.nextRunAt ?? nextOccurrence(task.schedule, Date.now()))
              : task.nextRunAt
          }
        : task)
    })
    return this.list()
  }

  remove(id: string): ScheduledTask[] {
    this.mutateTasks((tasks) => {
      this.requireTask(id, tasks)
      return tasks.filter((task) => task.id !== id)
    })
    // A deleted task must not leave its agent running unseen: the run's Pi
    // process is only reachable through this service.
    void this.stopRun(id).catch(() => {})
    return this.list()
  }

  /**
   * Stop the run a task is doing right now, leaving its schedule intact.
   *
   * The run owns a Pi process under a draft session key, so stopping it through
   * the supervisor aborts the turn and Pi publishes `agent_settled`; the settle
   * path then records `aborted` and releases the run lock and slot. A process
   * that is already gone publishes no settle, which is why the record is also
   * finished here when the supervisor reports the run is over.
   */
  async stopRun(id: string): Promise<boolean> {
    const active = this.activeTasks.get(id)
    if (!active) return false
    await this.supervisor.stop(active.sessionFile ?? active.draftKey).catch(() => {})
    // The settle event normally finishes the task; this covers the case where
    // there is nothing left to settle.
    if (this.activeTasks.get(id) === active && !this.supervisor.sessionInfo(active.sessionFile ?? active.draftKey)?.running) {
      this.finish(active, 'aborted')
    }
    return true
  }

  async runNow(id: string): Promise<ScheduledTask[]> {
    if (this.schedulingStopped) throw new Error('Scheduled tasks are shutting down.')
    this.refreshFromDisk()
    const task = this.requireTask(id)
    await this.launch(task, true)
    return this.list()
  }

  /** Stop future launches while keeping event listeners for runs being stopped. */
  stopScheduling(): void {
    this.schedulingStopped = true
    if (this.timer) clearTimeout(this.timer)
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.timer = undefined
    this.refreshTimer = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stopScheduling()
    this.flushPendingRunResults()
    this.releasePendingRunResults()
    this.supervisor.off('event', this.onRuntimeEvent)
    this.supervisor.off('rekey', this.onRuntimeRekey)
    this.supervisor.off('status', this.onRuntimeStatus)
    for (const [key, active] of this.activeRuns) {
      if (!this.supervisor.sessionInfo(key)?.running) {
        active.releaseRunLock()
        active.releaseRunSlot()
      }
    }
  }

  private readonly onRuntimeEvent = (payload: { ownerId: string; event: PiEvent }): void => {
    const { ownerId, event } = payload
    if (event.type !== 'agent_end' && event.type !== 'agent_settled') return
    const active = this.activeRuns.get(ownerId)
    if (!active) return
    if (event.type === 'agent_end') {
      // Pi can still retry. Retain the latest attempt's result until settlement.
      const assistant = lastRunAssistantMessage(event.messages)
      if (assistant) {
        active.modelError = assistant.stopReason === 'error'
          ? (typeof assistant.errorMessage === 'string' && assistant.errorMessage.trim()) || 'Pi could not complete this task.'
          : undefined
      }
      return
    }

    const aborted = event.aborted === true
    const error = event.crashed === true
      ? 'Pi exited unexpectedly before this task finished.'
      : aborted ? undefined : active.modelError
    const status: ScheduledTaskStatus = error ? 'error' : aborted ? 'aborted' : 'completed'
    this.finish(active, status, error)
  }

  private readonly onRuntimeRekey = (change: RuntimeRekey): void => {
    const active = this.activeRuns.get(change.from)
    if (!active) return
    this.activeRuns.delete(change.from)
    active.sessionFile = change.to
    this.activeRuns.set(change.to, active)
  }

  private readonly onRuntimeStatus = (payload: { ownerId: string; status: RuntimeStatus }): void => {
    if (payload.status.phase !== 'error') return
    // A transport/RPC error does not mean the agent process stopped. Keep the
    // task reserved until its settle event or the supervisor confirms exit.
    if (this.supervisor.sessionInfo(payload.ownerId)?.running) return
    const active = this.activeRuns.get(payload.ownerId)
    if (active) this.finish(active, 'error', payload.status.error ?? 'Pi could not start.')
  }

  private readTaskSnapshot(fingerprint: string): ScheduledTask[] {
    const tasks = this.readForMutation()
    this.fileFingerprint = fingerprint === scheduledTaskFileFingerprint(this.file)
      ? fingerprint
      : undefined
    return tasks
  }

  private recoverInvalidTaskFile(): ScheduledTask[] | undefined {
    try {
      // An unlocked read can see a corrupt version that a peer has since
      // replaced. Verify the current file under the same lock used for writes.
      return this.withDataLock(() => {
        const fingerprint = scheduledTaskFileFingerprint(this.file)
        try {
          return this.readTaskSnapshot(fingerprint)
        } catch (error) {
          if (!(error instanceof InvalidScheduledTaskFileError)) throw error
          if (scheduledTaskFileFingerprint(this.file) !== fingerprint) return undefined

          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const target = path.join(path.dirname(this.file), `scheduled-tasks.corrupt-${stamp}-${randomUUID()}.json`)
          renameSync(this.file, target)
          this.fileFingerprint = 'missing'
          this.tasksAfterFailedLaunch = undefined
          this.releasePendingRunResults()
          console.error(`[pi-desktop] the scheduled task file could not be read (${error.message}) and was moved to ${target}`)
          return []
        }
      })
    } catch (error) {
      // Leave the fingerprint uncommitted so the next refresh can try again.
      if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') {
        console.error('[pi-desktop] could not recover the scheduled task file:', error)
      }
      return undefined
    }
  }

  private readStoredTasks(): ScheduledTask[] | undefined {
    if (scheduledTaskFileFingerprint(this.file) === 'missing') return undefined
    return parseStoredTasks(readFileSync(this.file, 'utf8'))
  }

  private readForMutation(): ScheduledTask[] {
    const tasks = this.readStoredTasks()
    if (tasks) {
      this.tasksAfterFailedLaunch = undefined
      return this.applyPendingRunResults(tasks)
    }
    // A launch that never got to write can be retried after storage recovers.
    return this.tasksAfterFailedLaunch ? this.cloneTasks(this.tasksAfterFailedLaunch) : []
  }

  private applyPendingRunResults(tasks: ScheduledTask[]): ScheduledTask[] {
    if (!this.pendingRunResults.size) return tasks
    let changed = false
    const next = tasks.map((task) => {
      const result = this.pendingRunResults.get(task.id)
      if (!result || task.lastStatus !== 'running' || task.lastRunAt !== result.lastRunAt) return task
      changed = true
      return {
        ...task,
        lastStatus: result.lastStatus,
        lastError: result.lastError,
        lastSessionFile: result.lastSessionFile ?? task.lastSessionFile
      }
    })
    return changed ? next : tasks
  }

  private releasePendingRunResults(): void {
    for (const result of this.pendingRunResults.values()) result.releaseRunLock()
    this.pendingRunResults.clear()
  }

  private flushPendingRunResults(): boolean {
    if (!this.pendingRunResults.size) return false
    try {
      return this.withDataLock(() => {
        const stored = this.readStoredTasks() ?? []
        const next = this.applyPendingRunResults(stored)
        if (next !== stored) this.write(next)
        else this.releasePendingRunResults()
        const changed = JSON.stringify(next) !== JSON.stringify(this.tasks)
        this.tasks = next
        return changed
      })
    } catch (error) {
      console.error('[pi-desktop] could not persist scheduled task status:', error)
      return false
    }
  }

  private write(tasks: ScheduledTask[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      const contents = JSON.stringify(tasks, null, 2)
      if (Buffer.byteLength(contents, 'utf8') > MAX_SCHEDULED_TASK_FILE_BYTES) {
        throw new Error('Scheduled tasks exceed the storage size limit.')
      }
      writeFileSync(temp, contents, 'utf8')
      renameSync(temp, this.file)
      try {
        this.fileFingerprint = scheduledTaskFileFingerprint(this.file)
      } catch {
        this.fileFingerprint = undefined
      }
      this.tasksAfterFailedLaunch = undefined
      this.releasePendingRunResults()
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        /* a failed write may not have created the temporary file */
      }
      throw error
    }
  }

  private withDataLock<T>(action: () => T): T {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const release = properLockfile.lockSync(this.file, { realpath: false, retries: 0 })
    try {
      return action()
    } finally {
      release()
    }
  }

  private mutateTasks(update: (tasks: ScheduledTask[]) => ScheduledTask[]): void {
    this.withDataLock(() => {
      const next = update(this.readForMutation())
      this.write(next)
      this.tasks = next
    })
    this.publish()
  }

  private refreshFromDisk(initial = false): boolean {
    let next: ScheduledTask[]
    try {
      const fingerprint = scheduledTaskFileFingerprint(this.file)
      if (fingerprint === this.fileFingerprint) return false
      next = this.readTaskSnapshot(fingerprint)
    } catch (error) {
      if (!(error instanceof InvalidScheduledTaskFileError)) {
        if (initial) console.error('[pi-desktop] could not read scheduled tasks:', error)
        return false
      }
      const recovered = this.recoverInvalidTaskFile()
      if (recovered === undefined) return false
      next = recovered
    }
    const changed = !initial && next !== this.tasks && JSON.stringify(next) !== JSON.stringify(this.tasks)
    this.tasks = next
    if (changed) {
      this.emit('changed', this.cloneTasks(next))
      this.scheduleNext()
    }
    return changed
  }

  private scheduleRefresh(): void {
    if (this.schedulingStopped) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      const resultsChanged = this.flushPendingRunResults()
      this.refreshFromDisk()
      if (this.recoverInterruptedRuns() || resultsChanged) this.emit('changed', this.cloneTasks(this.tasks))
      this.skipOverlappedOccurrences()
      this.waitingForRunSlot = false
      this.scheduleNext()
      this.scheduleRefresh()
    }, CROSS_PROCESS_POLL_MS)
    this.refreshTimer.unref?.()
  }

  private recoverInterruptedRuns(): boolean {
    const needsRecovery = this.tasks.some((task) =>
      task.lastStatus === 'running' &&
      !this.activeTasks.has(task.id) &&
      !this.hasTaskRunLock(task.id)
    )
    if (!needsRecovery) return false
    try {
      return this.withDataLock(() => {
        const current = this.readForMutation()
        let recovered = false
        const next = current.map((task) => {
          if (
            task.lastStatus !== 'running' ||
            this.activeTasks.has(task.id) ||
            this.hasTaskRunLock(task.id)
          ) return task
          recovered = true
          return {
            ...task,
            lastStatus: 'error' as const,
            lastError: 'Pi Desktop closed before this task finished.'
          }
        })
        if (recovered) this.write(next)
        this.tasks = next
        return recovered
      })
    } catch (error) {
      console.error('[pi-desktop] could not recover scheduled tasks:', error)
      return false
    }
  }

  private taskRunLockFile(id: string): string {
    const digest = createHash('sha256').update(id).digest('hex')
    return path.join(path.dirname(this.file), `scheduled-task-${digest}.run`)
  }

  private taskRunOwnerFile(id: string): string {
    return this.runLockOwnerFile(this.taskRunLockFile(id))
  }

  private runSlotOwnerFile(slot: number): string {
    return this.runLockOwnerFile(this.runSlotLockFile(slot))
  }

  private runLockOwnerFile(lockFile: string): string {
    return `${lockFile}.owner.json`
  }

  private runLockOwnerState(lockFile: string, ownerFile: string): 'alive' | 'dead' | 'unknown' {
    let owner: TaskRunOwner
    try {
      owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as TaskRunOwner
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'dead'
      try {
        return properLockfile.checkSync(lockFile, {
          realpath: false,
          stale: LIVE_PROCESS_LOCK_STALE_MS
        }) ? 'unknown' : 'dead'
      } catch {
        return 'unknown'
      }
    }
    try {
      if (!properLockfile.checkSync(lockFile, {
        realpath: false,
        stale: LIVE_PROCESS_LOCK_STALE_MS
      })) return 'dead'
    } catch {
      return 'unknown'
    }
    if (!owner || typeof owner.token !== 'string') return 'unknown'
    const pid = owner.piPid ?? owner.ownerPid
    if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown'
    return processLiveness(pid)
  }

  private writeRunLockOwner(file: string, owner: TaskRunOwner): void {
    const temporary = `${file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' })
      renameSync(temporary, file)
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* the temporary file may not exist */ }
      throw error
    }
  }

  private removeRunLockOwner(file: string, token: string): void {
    try {
      const owner = JSON.parse(readFileSync(file, 'utf8')) as TaskRunOwner
      if (owner.token === token) unlinkSync(file)
    } catch {
      /* A stale or unreadable owner record must not interrupt task settlement. */
    }
  }

  private wrapRunLockRelease(releaseLock: () => void, ownerFile: string, token: string): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      try {
        releaseLock()
      } catch (error) {
        // proper-lockfile rejects release after a lease is compromised. Keep
        // cleanup moving so the paired run-slot lock can still be released.
        console.error('[pi-desktop] could not release scheduled task lock:', error)
      } finally {
        this.removeRunLockOwner(ownerFile, token)
      }
    }
  }

  private hasTaskRunLock(id: string): boolean {
    if (this.runLockOwnerState(this.taskRunLockFile(id), this.taskRunOwnerFile(id)) === 'alive') return true
    try {
      return properLockfile.checkSync(this.taskRunLockFile(id), {
        realpath: false,
        stale: TASK_LOCK_STALE_MS
      })
    } catch {
      return true
    }
  }

  private skipOverlappedOccurrences(): void {
    const now = Date.now()
    if (!this.tasks.some((task) =>
      task.enabled &&
      task.schedule.kind !== 'once' &&
      task.nextRunAt !== undefined &&
      task.nextRunAt <= now &&
      this.hasTaskRunLock(task.id)
    )) return

    let changed = false
    try {
      this.withDataLock(() => {
        const current = this.readForMutation()
        const next = current.map((task) => {
          if (
            !task.enabled ||
            task.schedule.kind === 'once' ||
            task.nextRunAt === undefined ||
            task.nextRunAt > now ||
            !this.hasTaskRunLock(task.id)
          ) return task
          changed = true
          return { ...task, nextRunAt: nextOccurrence(task.schedule, now) }
        })
        if (changed) this.write(next)
        this.tasks = next
      })
      if (changed) this.emit('changed', this.cloneTasks(this.tasks))
    } catch (error) {
      console.error('[pi-desktop] could not defer an overlapping scheduled task:', error)
    }
  }

  private publish(): void {
    this.emit('changed', this.cloneTasks(this.tasks))
    this.scheduleNext()
  }

  private cloneTasks(tasks: ScheduledTask[]): ScheduledTask[] {
    return tasks.map((task) => ({ ...task, schedule: { ...task.schedule } }))
  }

  private requireTask(id: string, tasks = this.tasks): ScheduledTask {
    const task = tasks.find((entry) => entry.id === id)
    if (!task) throw new Error('Scheduled task not found.')
    return task
  }

  private assertWorkspace(id: string): void {
    if (!this.settings.get().workspaces.some((workspace) => workspace.id === id)) {
      throw new Error('Choose a project that is still in the sidebar.')
    }
  }

  private scheduleNext(now = Date.now()): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (
      this.schedulingStopped ||
      this.waitingForRunSlot ||
      this.activeTasks.size >= MAX_CONCURRENT_SCHEDULED_RUNS
    ) return
    const due = this.tasks
      .filter((task) =>
        task.enabled &&
        task.nextRunAt !== undefined &&
        (task.nextRunAt > now || !this.hasTaskRunLock(task.id))
      )
      .reduce<number | undefined>((soonest, task) =>
        soonest === undefined || task.nextRunAt! < soonest ? task.nextRunAt : soonest, undefined)
    if (due === undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      const checkAt = Date.now()
      if (due <= checkAt) {
        for (const task of this.tasks) {
          if (task.enabled && task.nextRunAt !== undefined && task.nextRunAt <= checkAt) {
            void this.launch(task, false).catch((error) => {
              console.error('[pi-desktop] scheduled task failed:', error)
              this.deferAfterFailedLaunch(task.id)
            })
            if (this.waitingForRunSlot) break
          }
        }
      }
      this.scheduleNext(checkAt)
    }, Math.min(due <= now ? MIN_DUE_DELAY_MS : due - now, TIMER_SLICE_MS))
  }

  /**
   * An automatic launch can fail before the schedule was advanced: an
   * unreadable or unwritable task file, a lock a stale helper still holds, a
   * run slot that could not be taken. The task is still due afterwards, so
   * `scheduleNext` would arm a zero-delay timer and retry as fast as the disk
   * allows. Move it one backoff window forward instead; its row already carries
   * the failure, and a recovered disk picks it up on the next pass.
   */
  private deferAfterFailedLaunch(taskId: string): void {
    if (this.disposed || this.schedulingStopped) return
    const now = Date.now()
    const index = this.tasks.findIndex((task) => task.id === taskId)
    if (index === -1) return
    const task = this.tasks[index]
    if (!task.enabled || task.nextRunAt === undefined || task.nextRunAt > now) return
    const next = this.tasks.slice()
    next[index] = { ...task, nextRunAt: now + FAILED_LAUNCH_RETRY_MS }
    this.tasks = next
    // In memory only: the failure that got us here may well be the task file
    // itself. The row already carries the error; this just spaces the retries.
    this.emit('changed', this.cloneTasks(next))
    this.scheduleNext(now)
  }

  private async launch(task: ScheduledTask, manual: boolean): Promise<void> {
    if (this.pendingRunResults.has(task.id)) {
      if (manual) throw new Error('The previous run result is still being saved. Try again shortly.')
      return
    }
    if (this.activeTasks.has(task.id)) {
      if (!manual && task.schedule.kind !== 'once') {
        this.skipOverlappedOccurrences()
        return
      }
      throw new Error('This task is already running.')
    }
    const sessionKey = `draft:${randomUUID()}`
    const runOwner: TaskRunOwner = { token: randomUUID(), ownerPid: process.pid }
    const taskRunLockFile = this.taskRunLockFile(task.id)
    const taskRunOwnerFile = this.taskRunOwnerFile(task.id)
    let releaseRunLock: () => void
    let releaseLockFile: (() => void) | undefined
    try {
      const stale = this.runLockOwnerState(taskRunLockFile, taskRunOwnerFile) === 'alive'
        ? LIVE_PROCESS_LOCK_STALE_MS
        : TASK_LOCK_STALE_MS
      releaseLockFile = properLockfile.lockSync(taskRunLockFile, {
        realpath: false,
        retries: 0,
        stale,
        update: TASK_LOCK_UPDATE_MS,
        onCompromised: () => {
          void this.supervisor.stop(sessionKey).catch(() => {})
        }
      })
      this.writeRunLockOwner(taskRunOwnerFile, runOwner)
      releaseRunLock = this.wrapRunLockRelease(releaseLockFile, taskRunOwnerFile, runOwner.token)
    } catch (error) {
      try { releaseLockFile?.() } catch { /* lock acquisition cleanup is best-effort */ }
      this.removeRunLockOwner(taskRunOwnerFile, runOwner.token)
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined
      if (code !== 'ELOCKED') throw error
      if (manual) throw new Error('This task is already running.')
      this.refreshFromDisk()
      this.skipOverlappedOccurrences()
      this.scheduleNext()
      return
    }

    let runSlot: RunSlotLease | undefined
    try {
      runSlot = this.acquireRunSlot(sessionKey, runOwner)
    } catch (error) {
      releaseRunLock()
      throw error
    }
    if (!runSlot) {
      releaseRunLock()
      if (manual) throw new Error('All scheduled task run slots are busy. Try again when one finishes.')
      this.waitingForRunSlot = true
      return
    }
    const releaseRunSlot = runSlot.release
    this.waitingForRunSlot = false

    let currentTask: ScheduledTask | undefined
    const now = Date.now()
    try {
      this.withDataLock(() => {
        const current = this.readForMutation()
        currentTask = current.find((entry) => entry.id === task.id)
        if (!currentTask) {
          if (manual) throw new Error('Scheduled task not found.')
          return
        }
        if (
          !manual &&
          (!currentTask.enabled || currentTask.nextRunAt === undefined || currentTask.nextRunAt > now)
        ) {
          currentTask = undefined
          return
        }
        const startTask = currentTask
        const next = current.map((entry) => entry.id === startTask.id
          ? {
              ...entry,
              enabled: entry.schedule.kind === 'once' ? false : entry.enabled,
              nextRunAt: manual && entry.schedule.kind !== 'once' && entry.nextRunAt !== undefined && entry.nextRunAt > now
                ? entry.nextRunAt
                : nextOccurrence(entry.schedule, now),
              lastRunAt: now,
              lastStatus: 'running' as const,
              lastError: undefined,
              lastSessionFile: undefined
            }
          : entry)
        this.write(next)
        this.tasks = next
      })
    } catch (error) {
      releaseRunLock()
      releaseRunSlot()
      if (!(error instanceof Error && error.message === 'Scheduled task not found.')) {
        const message = limitScheduledTaskError(error instanceof Error ? error.message : String(error))
        this.tasks = this.tasks.map((entry) => entry.id === task.id
          ? { ...entry, lastStatus: 'error', lastError: message }
          : entry)
        this.tasksAfterFailedLaunch = this.cloneTasks(this.tasks)
        this.publish()
      }
      throw error
    }

    if (!currentTask) {
      releaseRunLock()
      releaseRunSlot()
      this.refreshFromDisk()
      this.scheduleNext()
      return
    }

    const active: ActiveRun = { taskId: currentTask.id, draftKey: sessionKey, lastRunAt: now, releaseRunLock, releaseRunSlot }
    this.activeTasks.set(currentTask.id, active)
    this.activeRuns.set(sessionKey, active)
    this.publish()
    const workspace = this.settings.get().workspaces.find((entry) => entry.id === currentTask!.workspaceId)
    if (!workspace) {
      this.finish(active, 'error', 'The selected project is no longer available.')
      return
    }

    try {
      const settings = this.settings.get()
      // A task may pin its own model and effort; otherwise the app defaults
      // apply. A pinned choice must not rewrite Pi's global default.
      const model = currentTask.model ?? settings.model
      const thinkingLevel = currentTask.thinkingLevel ?? settings.thinkingLevel
      const ensured = await this.supervisor.ensure({
        sessionKey,
        cwd: workspace.path,
        model,
        thinkingLevel,
        rememberDefaults: !currentTask.model && !currentTask.thinkingLevel,
        customInstructions: this.customInstructions(workspace.path),
        trace: { sourceAction: 'scheduled-task', uiSessionId: sessionKey }
      })
      if (!ensured.ok) throw new Error(ensured.error ?? 'Pi did not start.')
      if (this.activeTasks.get(active.taskId) !== active) {
        void this.supervisor.stop(active.sessionFile ?? sessionKey).catch(() => {})
        return
      }
      const piPid = this.supervisor.sessionInfo(sessionKey)?.pid
      if (piPid !== undefined) {
        try {
          const owner = { ...runOwner, piPid }
          this.writeRunLockOwner(taskRunOwnerFile, owner)
          this.writeRunLockOwner(runSlot.ownerFile, owner)
        } catch (error) {
          await this.supervisor.stop(sessionKey).catch(() => {})
          this.finish(active, 'error', 'Could not record the Pi process for this scheduled task.')
          throw error
        }
      }
      try {
        await this.supervisor.request(sessionKey, 'set_session_name', { name: currentTask.title }, 30_000, {
          sourceAction: 'scheduled-task-title',
          uiSessionId: sessionKey
        })
      } catch {
        // The prompt is more important than the optional conversation title.
      }
      if (this.activeTasks.get(active.taskId) !== active) {
        void this.supervisor.stop(active.sessionFile ?? sessionKey).catch(() => {})
        return
      }
      const result = await this.supervisor.request<{ disposition?: string; cancelled?: boolean }>(
        sessionKey,
        'prompt',
        { message: currentTask.prompt },
        900_000,
        { sourceAction: manual ? 'scheduled-task-manual' : 'scheduled-task', uiSessionId: sessionKey }
      )
      if (result?.disposition === 'handled') {
        this.finish(active, result.cancelled === true ? 'aborted' : 'completed')
      }
    } catch (error) {
      // A timed-out RPC response does not prove that Pi stopped executing the
      // prompt. Keep the run reserved until its settle event arrives so a
      // retry cannot overlap the still-running agent.
      if (this.activeTasks.get(active.taskId) === active) {
        if (!this.supervisor.sessionInfo(active.sessionFile ?? active.draftKey)?.running) {
          this.finish(active, 'error', error instanceof Error ? error.message : String(error))
        }
        if (!manual) console.error('[pi-desktop] scheduled task failed:', error)
      }
      // The schedule was already advanced before this run started. Only
      // pre-launch failures should reach the timer's retry backoff.
      if (manual) throw error
    }
  }

  private finish(
    active: ActiveRun,
    status: ScheduledTaskStatus,
    error?: string
  ): void {
    const { taskId, sessionFile } = active
    // An RPC response can arrive after this run settled and the task started again.
    if (this.activeTasks.get(taskId) !== active) return
    this.activeTasks.delete(taskId)
    this.activeRuns.delete(sessionFile ?? active.draftKey)
    // Keep the task lease until its outcome is durable. Peers otherwise read
    // the old running state and recover it as an interrupted run.
    this.pendingRunResults.set(taskId, {
      lastRunAt: active.lastRunAt,
      lastStatus: status,
      lastError: limitScheduledTaskError(error),
      lastSessionFile: sessionFile,
      releaseRunLock: active.releaseRunLock
    })
    active.releaseRunSlot()
    this.waitingForRunSlot = false
    this.tasks = this.applyPendingRunResults(this.tasks)
    this.flushPendingRunResults()
    this.emit('changed', this.cloneTasks(this.tasks))
    this.scheduleNext()
  }

  private runSlotLockFile(slot: number): string {
    return path.join(path.dirname(this.file), `scheduled-task-run-slot-${slot}`)
  }

  private acquireRunSlot(sessionKey: string, owner: TaskRunOwner): RunSlotLease | undefined {
    for (let slot = 0; slot < MAX_CONCURRENT_SCHEDULED_RUNS; slot++) {
      const lockFile = this.runSlotLockFile(slot)
      const ownerFile = this.runSlotOwnerFile(slot)
      let releaseLock: (() => void) | undefined
      try {
        const stale = this.runLockOwnerState(lockFile, ownerFile) === 'alive'
          ? LIVE_PROCESS_LOCK_STALE_MS
          : TASK_LOCK_STALE_MS
        releaseLock = properLockfile.lockSync(lockFile, {
          realpath: false,
          retries: 0,
          stale,
          update: TASK_LOCK_UPDATE_MS,
          onCompromised: () => {
            void this.supervisor.stop(sessionKey).catch(() => {})
          }
        })
        this.writeRunLockOwner(ownerFile, owner)
        return {
          ownerFile,
          release: this.wrapRunLockRelease(releaseLock, ownerFile, owner.token)
        }
      } catch (error) {
        try { releaseLock?.() } catch { /* lock acquisition cleanup is best-effort */ }
        this.removeRunLockOwner(ownerFile, owner.token)
        const code = typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : undefined
        if (code !== 'ELOCKED') throw error
      }
    }
    return undefined
  }
}

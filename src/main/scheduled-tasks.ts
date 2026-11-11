import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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
import { properLockfile } from './proper-lockfile'

interface ScheduledTaskServiceOptions {
  userData: string
  settings: SettingsStore
  supervisor: SessionSupervisor
  customInstructions: (cwd: string) => string | undefined
}

interface ActiveRun {
  taskId: string
  sessionFile?: string
  releaseRunLock: () => void
  releaseRunSlot: () => void
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
const TASK_LOCK_STALE_MS = 60_000
const TASK_LOCK_UPDATE_MS = 20_000
const LIVE_PROCESS_LOCK_STALE_MS = Number.MAX_SAFE_INTEGER
const MAX_CONCURRENT_SCHEDULED_RUNS = 4
const MAX_SCHEDULED_TASKS = 100
const MAX_SCHEDULED_TASK_PROMPT_CHARS = 100_000
const SCHEDULED_TASK_STATUSES = new Set<ScheduledTaskStatus>(['running', 'completed', 'error', 'aborted'])

function scheduledTaskFileFingerprint(file: string): string {
  try {
    const stats = statSync(file, { bigint: true })
    return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw error
  }
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
    typeof task.id !== 'string' || !task.id ||
    typeof task.title !== 'string' || !task.title || task.title.length > 120 ||
    typeof task.prompt !== 'string' || !task.prompt.trim() ||
    typeof task.workspaceId !== 'string' || !task.workspaceId ||
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

function validateInput(value: ScheduledTaskInput): ScheduledTaskInput {
  const title = String(value?.title ?? '').trim().slice(0, 120)
  const rawPrompt = String(value?.prompt ?? '')
  if (rawPrompt.length > MAX_SCHEDULED_TASK_PROMPT_CHARS) {
    throw new Error(`Task prompts must be at most ${MAX_SCHEDULED_TASK_PROMPT_CHARS.toLocaleString()} characters.`)
  }
  const prompt = rawPrompt.trim()
  const workspaceId = String(value?.workspaceId ?? '').trim()
  const schedule = value?.schedule
  if (!title) throw new Error('Enter a task name.')
  if (!prompt) throw new Error('Enter the prompt to run.')
  if (!workspaceId) throw new Error('Choose a project.')
  if (!schedule || !['once', 'daily', 'weekly'].includes(schedule.kind)) {
    throw new Error('Choose a valid schedule.')
  }
  if (schedule.kind === 'once') {
    if (!Number.isFinite(schedule.at) || schedule.at <= Date.now()) {
      throw new Error('Choose a future date and time.')
    }
    return { title, prompt, workspaceId, schedule: { kind: 'once', at: schedule.at } }
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
      schedule: { kind: 'weekly', time: schedule.time, weekday: schedule.weekday }
    }
  }
  return { title, prompt, workspaceId, schedule: { kind: 'daily', time: schedule.time } }
}

/** Persistent local-time scheduler. A task starts a fresh Pi session per run. */
export class ScheduledTaskService extends EventEmitter {
  private readonly file: string
  private fileFingerprint: string | undefined
  private readonly settings: SettingsStore
  private readonly supervisor: SessionSupervisor
  private readonly customInstructions: (cwd: string) => string | undefined
  private tasks: ScheduledTask[]
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly activeTasks = new Set<string>()
  private readonly activeRuns = new Map<string, ActiveRun>()
  private disposed = false
  private schedulingStopped = false
  private waitingForRunSlot = false
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private pendingTasks: ScheduledTask[] | undefined

  constructor(options: ScheduledTaskServiceOptions) {
    super()
    this.file = path.join(options.userData, 'scheduled-tasks.json')
    this.settings = options.settings
    this.supervisor = options.supervisor
    this.customInstructions = options.customInstructions
    this.tasks = this.read()
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
    const normalized = validateInput(input)
    this.assertWorkspace(normalized.workspaceId)
    this.mutateTasks((tasks) => {
      this.requireTask(id, tasks)
      const now = Date.now()
      return tasks.map((task) => task.id === id
        ? {
            ...task,
            ...normalized,
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
    return this.list()
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
    if (payload.event.type !== 'agent_settled') return
    const active = this.activeRuns.get(payload.ownerId)
    if (!active) return
    const crashed = payload.event.crashed === true
    const status: ScheduledTaskStatus = crashed
      ? 'error'
      : payload.event.aborted === true
        ? 'aborted'
        : 'completed'
    this.finish(
      active.taskId,
      status,
      crashed ? 'Pi exited unexpectedly before this task finished.' : undefined,
      active.sessionFile
    )
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
    if (active) this.finish(active.taskId, 'error', payload.status.error ?? 'Pi could not start.', active.sessionFile)
  }

  private read(): ScheduledTask[] {
    try {
      const fingerprint = scheduledTaskFileFingerprint(this.file)
      if (fingerprint === 'missing') {
        this.fileFingerprint = fingerprint
        return []
      }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      this.fileFingerprint = fingerprint === scheduledTaskFileFingerprint(this.file)
        ? fingerprint
        : undefined
      return Array.isArray(parsed) ? parsed.filter(isStoredTask) : []
    } catch (error) {
      console.error('[pi-desktop] could not read scheduled tasks:', error)
      return []
    }
  }

  private readForMutation(): ScheduledTask[] {
    if (!existsSync(this.file)) return this.pendingTasks ? this.cloneTasks(this.pendingTasks) : []
    const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
    if (!Array.isArray(parsed)) throw new Error('The scheduled task file is invalid.')
    const tasks = parsed.filter(isStoredTask)
    if (!this.pendingTasks) return tasks

    const tasksById = new Map(tasks.map((task) => [task.id, task]))
    this.pendingTasks = this.pendingTasks.filter((task) =>
      tasksById.get(task.id)?.lastRunAt === task.lastRunAt
    )
    const pendingById = new Map(this.pendingTasks.map((task) => [task.id, task]))
    return tasks.map((task) => {
      const pending = pendingById.get(task.id)
      return pending && task.lastStatus === 'running'
        ? {
            ...task,
            lastStatus: pending.lastStatus,
            lastError: pending.lastError,
            lastSessionFile: pending.lastSessionFile
          }
        : task
    })
  }

  private write(tasks: ScheduledTask[]): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(tasks, null, 2), 'utf8')
      renameSync(temp, this.file)
      try {
        this.fileFingerprint = scheduledTaskFileFingerprint(this.file)
      } catch {
        this.fileFingerprint = undefined
      }
      this.pendingTasks = undefined
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

  private refreshFromDisk(): boolean {
    let next: ScheduledTask[]
    try {
      const fingerprint = scheduledTaskFileFingerprint(this.file)
      if (fingerprint === this.fileFingerprint) return false
      next = this.readForMutation()
      this.fileFingerprint = fingerprint === scheduledTaskFileFingerprint(this.file)
        ? fingerprint
        : undefined
    } catch {
      return false
    }
    const changed = next !== this.tasks && JSON.stringify(next) !== JSON.stringify(this.tasks)
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
      this.refreshFromDisk()
      if (this.recoverInterruptedRuns()) this.emit('changed', this.cloneTasks(this.tasks))
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
            })
            if (this.waitingForRunSlot) break
          }
        }
      }
      this.scheduleNext(checkAt)
    }, Math.min(Math.max(0, due - now), TIMER_SLICE_MS))
  }

  private async launch(task: ScheduledTask, manual: boolean): Promise<void> {
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
        const message = error instanceof Error ? error.message : String(error)
        this.tasks = this.tasks.map((entry) => entry.id === task.id
          ? { ...entry, lastStatus: 'error', lastError: message }
          : entry)
        this.pendingTasks = this.cloneTasks(this.tasks)
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

    this.activeTasks.add(currentTask.id)
    this.activeRuns.set(sessionKey, { taskId: currentTask.id, releaseRunLock, releaseRunSlot })
    this.publish()
    const workspace = this.settings.get().workspaces.find((entry) => entry.id === currentTask!.workspaceId)
    if (!workspace) {
      this.finish(currentTask.id, 'error', 'The selected project is no longer available.')
      return
    }

    try {
      const settings = this.settings.get()
      const ensured = await this.supervisor.ensure({
        sessionKey,
        cwd: workspace.path,
        model: settings.model,
        thinkingLevel: settings.thinkingLevel,
        customInstructions: this.customInstructions(workspace.path),
        trace: { sourceAction: 'scheduled-task', uiSessionId: sessionKey }
      })
      if (!ensured.ok) throw new Error(ensured.error ?? 'Pi did not start.')
      const piPid = this.supervisor.sessionInfo(sessionKey)?.pid
      if (piPid !== undefined) {
        try {
          const owner = { ...runOwner, piPid }
          this.writeRunLockOwner(taskRunOwnerFile, owner)
          this.writeRunLockOwner(runSlot.ownerFile, owner)
        } catch (error) {
          await this.supervisor.stop(sessionKey).catch(() => {})
          this.finish(currentTask.id, 'error', 'Could not record the Pi process for this scheduled task.')
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
      const result = await this.supervisor.request<{ disposition?: string; cancelled?: boolean }>(
        sessionKey,
        'prompt',
        { message: currentTask.prompt },
        900_000,
        { sourceAction: manual ? 'scheduled-task-manual' : 'scheduled-task', uiSessionId: sessionKey }
      )
      if (result?.disposition === 'handled') {
        const active = this.activeRuns.get(sessionKey)
        if (active) {
          this.finish(
            currentTask.id,
            result.cancelled === true ? 'aborted' : 'completed',
            undefined,
            active.sessionFile
          )
        }
      }
    } catch (error) {
      // A timed-out RPC response does not prove that Pi stopped executing the
      // prompt. Keep the run reserved until its settle event arrives so a
      // retry cannot overlap the still-running agent.
      if (!this.supervisor.sessionInfo(sessionKey)?.running && this.activeTasks.has(currentTask.id)) {
        this.finish(currentTask.id, 'error', error instanceof Error ? error.message : String(error))
      }
      throw error
    }
  }

  private finish(
    taskId: string,
    status: ScheduledTaskStatus,
    error?: string,
    sessionFile?: string
  ): void {
    if (!this.activeTasks.has(taskId)) return
    this.activeTasks.delete(taskId)
    let releaseRunLock: (() => void) | undefined
    let releaseRunSlot: (() => void) | undefined
    for (const [key, active] of this.activeRuns) {
      if (active.taskId === taskId) {
        releaseRunLock = active.releaseRunLock
        releaseRunSlot = active.releaseRunSlot
        this.activeRuns.delete(key)
      }
    }
    let next: ScheduledTask[] | undefined
    try {
      this.withDataLock(() => {
        const current = this.readForMutation()
        next = current.map((task) => task.id === taskId
          ? {
              ...task,
              lastStatus: status,
              lastError: error,
              lastSessionFile: sessionFile ?? task.lastSessionFile
            }
          : task)
        if (JSON.stringify(next) !== JSON.stringify(current)) this.write(next)
        this.tasks = next
      })
    } catch (persistError) {
      // A disk failure must not interrupt the supervisor's event delivery.
      console.error('[pi-desktop] could not persist scheduled task status:', persistError)
      next ??= this.tasks.map((task) => task.id === taskId
        ? {
            ...task,
            lastStatus: status,
            lastError: error,
            lastSessionFile: sessionFile ?? task.lastSessionFile
          }
        : task)
      this.tasks = next
      this.pendingTasks = this.cloneTasks(next)
    } finally {
      releaseRunLock?.()
      releaseRunSlot?.()
      this.waitingForRunSlot = false
    }
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

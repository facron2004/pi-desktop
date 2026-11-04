import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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

interface ScheduledTaskServiceOptions {
  userData: string
  settings: SettingsStore
  supervisor: SessionSupervisor
  customInstructions: (cwd: string) => string | undefined
}

interface ActiveRun {
  taskId: string
  sessionFile?: string
}

const TIMER_SLICE_MS = 60_000

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
  const prompt = String(value?.prompt ?? '').trim()
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
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
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
  private readonly settings: SettingsStore
  private readonly supervisor: SessionSupervisor
  private readonly customInstructions: (cwd: string) => string | undefined
  private tasks: ScheduledTask[]
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly activeTasks = new Set<string>()
  private readonly activeRuns = new Map<string, ActiveRun>()
  private disposed = false

  constructor(options: ScheduledTaskServiceOptions) {
    super()
    this.file = path.join(options.userData, 'scheduled-tasks.json')
    this.settings = options.settings
    this.supervisor = options.supervisor
    this.customInstructions = options.customInstructions
    this.tasks = this.read()
    const recoveredAt = Date.now()
    let recovered = false
    this.tasks = this.tasks.map((task) => {
      if (task.lastStatus !== 'running') return task
      recovered = true
      return {
        ...task,
        lastStatus: 'error',
        lastError: 'Pi Desktop closed before this task finished.'
      }
    })
    if (recovered) this.write()
    this.supervisor.on('event', this.onRuntimeEvent)
    this.supervisor.on('rekey', this.onRuntimeRekey)
    this.supervisor.on('status', this.onRuntimeStatus)
    this.scheduleNext(recoveredAt)
  }

  list(): ScheduledTask[] {
    return this.tasks.map((task) => ({ ...task, schedule: { ...task.schedule } }))
  }

  create(input: ScheduledTaskInput): ScheduledTask[] {
    const normalized = validateInput(input)
    this.assertWorkspace(normalized.workspaceId)
    const now = Date.now()
    const task: ScheduledTask = {
      ...normalized,
      id: randomUUID(),
      enabled: true,
      createdAt: now,
      nextRunAt: nextOccurrence(normalized.schedule, now)
    }
    this.tasks = [...this.tasks, task]
    this.changed()
    return this.list()
  }

  update(id: string, input: ScheduledTaskInput): ScheduledTask[] {
    const normalized = validateInput(input)
    this.assertWorkspace(normalized.workspaceId)
    this.requireTask(id)
    const now = Date.now()
    this.tasks = this.tasks.map((task) => task.id === id
      ? {
          ...task,
          ...normalized,
          nextRunAt: task.enabled ? nextOccurrence(normalized.schedule, now) : undefined
        }
      : task)
    this.changed()
    return this.list()
  }

  setEnabled(id: string, enabled: boolean): ScheduledTask[] {
    const current = this.requireTask(id)
    if (enabled && current.schedule.kind === 'once' && current.schedule.at <= Date.now()) {
      throw new Error('Edit this one-time task to choose a future date before enabling it.')
    }
    this.tasks = this.tasks.map((task) => task.id === id
      ? {
          ...task,
          enabled,
          nextRunAt: enabled
            ? (task.nextRunAt ?? nextOccurrence(task.schedule, Date.now()))
            : task.nextRunAt
        }
      : task)
    this.changed()
    return this.list()
  }

  remove(id: string): ScheduledTask[] {
    this.requireTask(id)
    this.tasks = this.tasks.filter((task) => task.id !== id)
    this.changed()
    return this.list()
  }

  async runNow(id: string): Promise<ScheduledTask[]> {
    const task = this.requireTask(id)
    await this.launch(task, true)
    return this.list()
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.supervisor.off('event', this.onRuntimeEvent)
    this.supervisor.off('rekey', this.onRuntimeRekey)
    this.supervisor.off('status', this.onRuntimeStatus)
  }

  private readonly onRuntimeEvent = (payload: { ownerId: string; event: PiEvent }): void => {
    if (payload.event.type !== 'agent_settled') return
    const active = this.activeRuns.get(payload.ownerId)
    if (!active) return
    const status: ScheduledTaskStatus = payload.event.aborted === true ? 'aborted' : 'completed'
    this.finish(active.taskId, status, undefined, active.sessionFile)
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
    const active = this.activeRuns.get(payload.ownerId)
    if (active) this.finish(active.taskId, 'error', payload.status.error ?? 'Pi could not start.', active.sessionFile)
  }

  private read(): ScheduledTask[] {
    try {
      if (!existsSync(this.file)) return []
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return Array.isArray(parsed) ? parsed.filter((task): task is ScheduledTask =>
        Boolean(task && typeof task === 'object' && typeof task.id === 'string' && typeof task.title === 'string')
      ) : []
    } catch (error) {
      console.error('[pi-desktop] could not read scheduled tasks:', error)
      return []
    }
  }

  private write(): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(this.tasks, null, 2), 'utf8')
    renameSync(temp, this.file)
  }

  private changed(): void {
    this.write()
    this.emit('changed', this.list())
    this.scheduleNext()
  }

  private requireTask(id: string): ScheduledTask {
    const task = this.tasks.find((entry) => entry.id === id)
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
    if (this.disposed) return
    const due = this.tasks
      .filter((task) => task.enabled && task.nextRunAt !== undefined)
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
          }
        }
      }
      this.scheduleNext(checkAt)
    }, Math.min(Math.max(0, due - now), TIMER_SLICE_MS))
  }

  private async launch(task: ScheduledTask, manual: boolean): Promise<void> {
    if (this.activeTasks.has(task.id)) {
      if (!manual && task.schedule.kind !== 'once') {
        this.tasks = this.tasks.map((entry) => entry.id === task.id
          ? { ...entry, nextRunAt: nextOccurrence(entry.schedule, Date.now()) }
          : entry)
        this.changed()
        return
      }
      throw new Error('This task is already running.')
    }
    this.activeTasks.add(task.id)
    const now = Date.now()
    const sessionKey = `draft:${randomUUID()}`
    const workspace = this.settings.get().workspaces.find((entry) => entry.id === task.workspaceId)
    if (!workspace) {
      this.activeTasks.delete(task.id)
      this.finish(task.id, 'error', 'The selected project is no longer available.')
      return
    }
    this.activeRuns.set(sessionKey, { taskId: task.id })
    this.tasks = this.tasks.map((entry) => entry.id === task.id
      ? {
          ...entry,
          enabled: entry.schedule.kind === 'once' ? false : entry.enabled,
          nextRunAt: manual && entry.schedule.kind !== 'once'
            ? entry.nextRunAt
            : nextOccurrence(entry.schedule, now),
          lastRunAt: now,
          lastStatus: 'running',
          lastError: undefined,
          lastSessionFile: undefined
        }
      : entry)
    this.changed()
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
      try {
        await this.supervisor.request(sessionKey, 'set_session_name', { name: task.title }, 30_000, {
          sourceAction: 'scheduled-task-title',
          uiSessionId: sessionKey
        })
      } catch {
        // The prompt is more important than the optional conversation title.
      }
      const result = await this.supervisor.request<{ disposition?: string }>(
        sessionKey,
        'prompt',
        { message: task.prompt },
        900_000,
        { sourceAction: manual ? 'scheduled-task-manual' : 'scheduled-task', uiSessionId: sessionKey }
      )
      if (result?.disposition === 'handled') {
        const active = this.activeRuns.get(sessionKey)
        this.finish(task.id, 'completed', undefined, active?.sessionFile)
      }
    } catch (error) {
      this.finish(task.id, 'error', error instanceof Error ? error.message : String(error))
      throw error
    } finally {
      this.activeTasks.delete(task.id)
    }
  }

  private finish(
    taskId: string,
    status: ScheduledTaskStatus,
    error?: string,
    sessionFile?: string
  ): void {
    this.activeTasks.delete(taskId)
    for (const [key, active] of this.activeRuns) {
      if (active.taskId === taskId) this.activeRuns.delete(key)
    }
    this.tasks = this.tasks.map((task) => task.id === taskId
      ? {
          ...task,
          lastStatus: status,
          lastError: error,
          lastSessionFile: sessionFile ?? task.lastSessionFile
        }
      : task)
    this.changed()
  }
}

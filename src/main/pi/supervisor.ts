import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type {
  ExtensionUiResponse,
  PiEvent,
  PiState,
  RpcTraceHint,
  RuntimeEnsureOptions,
  RuntimeStartOptions,
  RuntimeStatus
} from '@shared/types'
import { appendSessionName } from '../sessions'
import { CwdGate } from './cwd-gate'
import { canonicalSessionFile } from './session-file'

/** How long an idle hot session keeps its process. Viewing it does not reset this. */
const WARM_MS = 10 * 60 * 1000

const WRITE_COMMANDS = new Set(['prompt', 'bash'])
const BIND_COMMANDS = new Set(['prompt', 'fork', 'clone', 'new_session'])

/**
 * One Pi process the supervisor can start, talk to, and stop.
 *
 * `PiRuntime` is the production implementation. Tests pass a fake so two
 * sessions can be driven without spawning the CLI.
 */
export interface ManagedSessionRuntime extends EventEmitter {
  readonly isRunning: boolean
  readonly currentStatus: RuntimeStatus
  start(options: RuntimeStartOptions): Promise<{ ok: boolean; error?: string }>
  request<T = unknown>(
    command: string,
    payload?: Record<string, unknown>,
    timeoutMs?: number,
    trace?: RpcTraceHint
  ): Promise<T>
  respondUi(id: string, response: ExtensionUiResponse): void
  stop(): Promise<void>
  hasPendingUi?(id: string): boolean
}

export type SessionRuntimeFactory = () => ManagedSessionRuntime

interface QueuedJob {
  key: string
  cwd: string
  command: string
  payload: Record<string, unknown>
  timeoutMs: number
  trace?: RpcTraceHint
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface RuntimeActivity {
  ownerId: string
  cwd: string
  writes: number
  running: boolean
  settlements: number
  stopping?: Promise<void>
}

/**
 * One Pi process per hot conversation.
 *
 * The map is keyed by the desktop session id: a JSONL path, or `draft:…`
 * until Pi assigns a file. Selecting a row never touches this class, and it
 * never sends `switch_session`. The old single-process path aborted the live
 * agent on every sidebar click, so it is not kept behind a flag.
 */
export class SessionSupervisor extends EventEmitter {
  private readonly runtimes = new Map<string, ManagedSessionRuntime>()
  private readonly starting = new Map<string, Promise<{ ok: boolean; error?: string }>>()
  private readonly aliases = new Map<string, string>()
  /** Canonical session-file identity → the runtime map key that may write it. */
  private readonly fileOwners = new Map<string, string>()
  private readonly gate = new CwdGate()
  private readonly queued = new Map<string, QueuedJob[]>()
  private readonly approvals = new Set<string>()
  private readonly warmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly activity = new WeakMap<ManagedSessionRuntime, RuntimeActivity>()
  private shuttingDown = false

  constructor(private readonly factory: SessionRuntimeFactory) {
    super()
  }

  has(key: string): boolean {
    return this.runtimes.get(this.canonical(key))?.isRunning ?? false
  }

  runningKeys(): string[] {
    return [...this.runtimes.keys()].filter((key) => this.runtimes.get(key)?.isRunning)
  }

  /** Desktop Git writes share the same directory gate as agent turns. */
  async withCwdLock<T>(cwd: string, action: () => Promise<T>): Promise<T> {
    const key = `operation:${randomUUID()}`
    if (this.shuttingDown) throw new Error('Pi is shutting down.')
    if (!this.gate.claim(cwd, key)) {
      throw new Error('A conversation is working in this folder. Wait for it to finish before changing Git state.')
    }
    try {
      return await action()
    } finally {
      this.release(key, cwd)
    }
  }

  async ensure(options: RuntimeEnsureOptions): Promise<{ ok: boolean; error?: string }> {
    if (this.shuttingDown) return { ok: false, error: 'Pi is shutting down.' }
    const id = this.reserveSession(options)
    const existing = this.runtimes.get(id)
    const stopping = existing && this.activity.get(existing)?.stopping
    if (stopping) {
      await stopping
      return this.ensure(options)
    }
    if (existing?.isRunning && existing.currentStatus.phase === 'ready') return { ok: true }
    const pending = this.starting.get(id)
    if (pending) return pending
    const init = this.boot(id, options)
    this.starting.set(id, init)
    try {
      return await init
    } finally {
      this.starting.delete(id)
    }
  }

  async request<T = unknown>(
    key: string,
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 30_000,
    trace?: RpcTraceHint
  ): Promise<T> {
    const id = this.canonical(key)
    if (this.shuttingDown) throw new Error('Pi is shutting down.')
    const runtime = this.runtimes.get(id)
    const activity = runtime && this.activity.get(runtime)
    if (!runtime?.isRunning || !activity || activity.stopping) {
      throw new Error('Pi is not running for this conversation.')
    }
    if (command === 'abort' || command === 'abort_retry') {
      this.dropQueued(id)
      this.approvals.delete(id)
    }
    if (command === 'abort_bash') this.dropQueued(id, 'bash')
    const removed = command === 'clear_queue' ? this.dropQueued(id, 'prompt') : []
    const writing = WRITE_COMMANDS.has(command)
    if (writing) {
      this.clearWarm(id)
      const cwd = this.cwdOf(id)
      if (cwd && !this.gate.claim(cwd, id)) {
        return this.enqueue<T>({ key: id, cwd, command, payload, timeoutMs, trace })
      }
      activity.writes += 1
    }
    const settlements = activity.settlements
    try {
      const result = await this.invoke<T>(id, command, payload, timeoutMs, trace)
      if (command === 'get_state' && this.ownerOf(runtime) === id) {
        const file = (result as PiState | undefined)?.sessionFile
        if (file && file !== id) this.bindFile(id, file)
      }
      if (command === 'prompt') {
        const disposition = (result as { disposition?: string } | undefined)?.disposition
        // Acceptance precedes completion. A handled extension or rejected steer
        // must not unlock an existing run, nor can a late ack reopen a settled one.
        if ((disposition === 'started' || disposition === 'queued') && activity.settlements === settlements) {
          activity.running = true
        }
      }
      if (command === 'clear_queue') {
        const queue = result as { steering?: string[]; followUp?: string[] } | undefined
        return {
          steering: [...(queue?.steering ?? []), ...removed.filter(job => job.payload.streamingBehavior !== 'followUp').map(job => String(job.payload.message ?? ''))],
          followUp: [...(queue?.followUp ?? []), ...removed.filter(job => job.payload.streamingBehavior === 'followUp').map(job => String(job.payload.message ?? ''))]
        } as T
      }
      if (BIND_COMMANDS.has(command)) {
        const file = await this.rebindFromState(this.ownerOf(runtime) ?? id)
        if (file && command !== 'prompt') return { ...result, sessionFile: file } as T
      }
      return result
    } finally {
      if (writing) {
        activity.writes -= 1
        this.release(this.ownerOf(runtime) ?? id)
      }
    }
  }

  respondUi(key: string, id: string, response: ExtensionUiResponse): void {
    let targetKey: string | undefined = key ? this.canonical(key) : undefined
    let runtime = targetKey ? this.runtimes.get(targetKey) : undefined

    // If key wasn't given, or target runtime does not have this UI request,
    // look for the runtime that actually has this pending request id.
    if (!runtime || (runtime.hasPendingUi && !runtime.hasPendingUi(id))) {
      runtime = undefined
      targetKey = undefined
      for (const [rKey, r] of this.runtimes) {
        if (r.hasPendingUi?.(id)) {
          targetKey = rKey
          runtime = r
          break
        }
      }
    }

    if (runtime) {
      runtime.respondUi(id, response)
      if (targetKey && (!runtime.hasPendingUi || !runtime.hasPendingUi(id))) {
        this.approvals.delete(targetKey)
      }
    }
  }

  async rename(file: string, name: string): Promise<boolean> {
    const runtime = this.runtimes.get(this.canonical(file))
    if (runtime?.isRunning) {
      await runtime.request('set_session_name', { name }, 30_000, { sourceAction: 'session-rename' })
      return true
    }
    return await appendSessionName(file, name)
  }

  async stop(key?: string): Promise<void> {
    if (!key) {
      this.shuttingDown = true
      const pending = [...this.queued.values()].flat()
      this.queued.clear()
      for (const job of pending) job.reject(new Error('Pi is shutting down.'))
      try {
        await Promise.all([...this.runtimes.keys()].map(id => this.stop(id)))
      } finally {
        this.aliases.clear()
        this.fileOwners.clear()
        this.shuttingDown = false
      }
      return
    }
    const id = this.canonical(key)
    const runtime = this.runtimes.get(id)
    this.clearWarm(id)
    this.dropQueued(id)
    if (!runtime) return
    const activity = this.activity.get(runtime)!
    if (activity.stopping) return activity.stopping
    const wasBusy = activity.running || activity.writes > 0
    const starting = this.starting.get(id)
    const stopped = (async () => {
      try {
        await runtime.stop()
        await starting
        // A launch that was still in flight must not resurrect a stopped writer.
        if (runtime.isRunning) await runtime.stop()
        if (wasBusy) {
          // The transport was detached before shutdown, so Pi's final event
          // cannot arrive. Process exit confirms that this run was stopped.
          this.emit('event', { ownerId: id, event: { type: 'agent_settled', aborted: true, runtimeStopped: true } })
        }
      } finally {
        if (this.runtimes.get(id) === runtime) this.runtimes.delete(id)
        this.approvals.delete(id)
        this.releaseFile(id)
        this.release(id, activity.cwd)
      }
    })()
    activity.stopping = stopped
    return stopped
  }

  async stopCwd(cwd: string): Promise<void> {
    const keys = [...this.runtimes.keys()].filter((key) => {
      const runtime = this.runtimes.get(key)
      return runtime?.currentStatus.cwd && CwdGate.key(runtime.currentStatus.cwd) === CwdGate.key(cwd)
    })
    // Cancel every waiter before any old writer can exit and dispatch one.
    await Promise.all(keys.map(key => this.stop(key)))
  }

  /**
   * Pick the runtime that already owns this session file, or reserve it.
   *
   * Two keys for one JSONL — a draft and the path Pi just wrote, or the same
   * path spelled with different slashes — must not start two writers.
   */
  private reserveSession(options: RuntimeEnsureOptions): string {
    const requested = this.canonical(options.sessionKey)
    const file = options.sessionFile
    if (!file) return requested
    const canon = canonicalSessionFile(file)
    const owner = this.fileOwners.get(canon)
    if (owner) {
      const holder = this.canonical(owner)
      if (holder !== requested) this.aliases.set(requested, holder)
      return holder
    }
    this.fileOwners.set(canon, requested)
    return requested
  }

  private async boot(id: string, options: RuntimeEnsureOptions): Promise<{ ok: boolean; error?: string }> {
    let runtime = this.runtimes.get(id)
    if (!runtime) {
      runtime = this.factory()
      this.runtimes.set(id, runtime)
      this.activity.set(runtime, { ownerId: id, cwd: options.cwd, writes: 0, running: false, settlements: 0 })
      this.attach(runtime)
    }
    let started: { ok: boolean; error?: string }
    try {
      started = await runtime.start({
        cwd: options.cwd,
        sessionFile: options.sessionFile,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        customInstructions: options.customInstructions,
        trace: { ...options.trace, sourceAction: options.trace?.sourceAction ?? 'ensure', uiSessionId: id }
      })
    } catch (error) {
      started = { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    if (this.activity.get(runtime)?.stopping || this.runtimes.get(id) !== runtime) return { ok: false }
    if (!started.ok) {
      await runtime.stop()
      this.runtimes.delete(id)
      this.release(id)
      this.releaseFile(id)
      return started
    }
    const file = runtime.currentStatus.sessionFile
    if (file && file !== id) this.bindFile(id, file, true)
    else if (file) this.fileOwners.set(canonicalSessionFile(file), id)
    this.scheduleWarm(this.ownerOf(runtime) ?? id)
    return { ok: true }
  }

  private attach(runtime: ManagedSessionRuntime): void {
    runtime.on('event', (event: PiEvent) => {
      const ownerId = this.ownerOf(runtime)
      if (!ownerId) return
      this.note(ownerId, runtime, event)
      this.emit('event', { ownerId, event })
    })
    runtime.on('status', (status: RuntimeStatus) => {
      const ownerId = this.ownerOf(runtime)
      if (!ownerId) return
      if (status.phase === 'error' || ((status.phase === 'stopped') && !runtime.isRunning)) {
        this.activity.get(runtime)!.running = false
        this.approvals.delete(ownerId)
        this.release(ownerId)
      }
      this.emit('status', { ownerId, status })
    })
    runtime.on('stderr', (line: string) => {
      const ownerId = this.ownerOf(runtime)
      if (ownerId) this.emit('stderr', { ownerId, line })
    })
  }

  private ownerOf(runtime: ManagedSessionRuntime): string | undefined {
    const key = this.activity.get(runtime)?.ownerId
    return key && this.runtimes.get(key) === runtime ? key : undefined
  }

  private note(ownerId: string, runtime: ManagedSessionRuntime, event: PiEvent): void {
    const activity = this.activity.get(runtime)!
    if (event.type === 'extension_ui_request') {
      const req = event as unknown as { method?: string; sessionKey?: string }
      if (!req.sessionKey) req.sessionKey = ownerId
      const method = req.method
      if (method === 'select' || method === 'confirm' || method === 'input' || method === 'editor') {
        this.approvals.add(ownerId)
      }
    }
    if (event.type === 'agent_settled') {
      activity.running = false
      activity.settlements += 1
      this.approvals.delete(ownerId)
      this.release(ownerId)
      this.scheduleWarm(ownerId)
    } else if (event.type === 'agent_start') {
      activity.running = true
      this.clearWarm(ownerId)
    }
  }

  private async invoke<T>(
    id: string,
    command: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    trace?: RpcTraceHint
  ): Promise<T> {
    const key = this.canonical(id)
    const runtime = this.runtimes.get(key)
    if (!runtime?.isRunning) {
      throw new Error('Pi is not running for this conversation.')
    }
    return runtime.request<T>(command, payload, timeoutMs, trace)
  }

  private enqueue<T>(job: Omit<QueuedJob, 'resolve' | 'reject'>): Promise<T> {
    const cwd = CwdGate.key(job.cwd)
    const list = this.queued.get(cwd) ?? []
    const promise = new Promise<T>((resolve, reject) => {
      list.push({
        ...job,
        resolve: (value) => resolve(value as T),
        reject
      })
    })
    this.queued.set(cwd, list)
    this.emit('queued', { ownerId: job.key, cwd: job.cwd })
    return promise
  }

  private dropQueued(key: string, command?: string): QueuedJob[] {
    const id = this.canonical(key)
    const removed: QueuedJob[] = []
    for (const [cwd, jobs] of this.queued) {
      const kept: QueuedJob[] = []
      for (const job of jobs) {
        if (this.canonical(job.key) === id && (!command || job.command === command)) {
          removed.push(job)
          job.resolve({ disposition: 'handled', cancelled: true })
        } else kept.push(job)
      }
      if (kept.length) this.queued.set(cwd, kept)
      else this.queued.delete(cwd)
    }
    return removed
  }

  private release(key: string, stoppedCwd?: string): void {
    const id = this.canonical(key)
    const runtime = this.runtimes.get(id)
    const activity = runtime && this.activity.get(runtime)
    if (activity && (activity.writes > 0 || activity.running || activity.stopping)) return
    const cwd = CwdGate.key(stoppedCwd ?? this.cwdOf(id) ?? '')
    if (!cwd || this.gate.holder(cwd) !== id) return
    this.gate.release(cwd, id)
    if (this.shuttingDown) return
    const next = this.queued.get(cwd)?.shift()
    if (this.queued.get(cwd)?.length === 0) this.queued.delete(cwd)
    if (next) {
      void this.request(next.key, next.command, next.payload, next.timeoutMs, next.trace)
        .then(next.resolve, next.reject)
    }
    if (runtime?.isRunning) this.scheduleWarm(id)
  }

  private async rebindFromState(id: string): Promise<string | undefined> {
    const key = this.canonical(id)
    const runtime = this.runtimes.get(key)
    if (!runtime?.isRunning) return
    try {
      const state = await runtime.request<PiState>('get_state', {}, 10_000, { sourceAction: 'bind-file' })
      if (state?.sessionFile && state.sessionFile !== key) this.bindFile(key, state.sessionFile)
      return state?.sessionFile
    } catch {
      /* the command already finished; the file can be learned on the next get_state */
    }
  }

  private bindFile(from: string, file: string, startup = false): void {
    const runtime = this.runtimes.get(from)
    if (!runtime || from === file) return
    this.runtimes.delete(from)
    this.runtimes.set(file, runtime)
    this.activity.get(runtime)!.ownerId = file
    // A fork moves this process, but the original JSONL remains a separate chat.
    // Only drafts and alternate spellings of the same file are aliases.
    for (const [alias, owner] of this.aliases) {
      if (owner === from) this.aliases.set(alias, file)
    }
    const replace = startup && !from.startsWith('draft:') && canonicalSessionFile(from) !== canonicalSessionFile(file)
    if (replace || from.startsWith('draft:') || canonicalSessionFile(from) === canonicalSessionFile(file)) {
      this.aliases.set(from, file)
    }
    this.gate.retarget(from, file)
    if (this.approvals.has(from)) {
      this.approvals.delete(from)
      this.approvals.add(file)
    }
    this.clearWarm(from)
    this.scheduleWarm(file)
    for (const jobs of this.queued.values()) {
      for (const job of jobs) {
        if (job.key === from) job.key = file
      }
    }
    for (const [locked, owner] of this.fileOwners) {
      if (owner === from) this.fileOwners.delete(locked)
    }
    this.fileOwners.set(canonicalSessionFile(file), file)
    this.emit('rekey', { from, to: file, ...(replace ? { replace: true } : {}) })
  }

  private releaseFile(key: string): void {
    const id = this.canonical(key)
    for (const [file, owner] of this.fileOwners) {
      if (owner === id || this.canonical(owner) === id) this.fileOwners.delete(file)
    }
  }

  private cwdOf(key: string): string | undefined {
    const runtime = this.runtimes.get(this.canonical(key))
    return runtime && this.activity.get(runtime)?.cwd
  }

  private canonical(key: string): string {
    const seen = new Set<string>()
    let current = key
    while (this.aliases.has(current) && !seen.has(current)) {
      seen.add(current)
      current = this.aliases.get(current) ?? current
    }
    return current
  }

  private scheduleWarm(key: string): void {
    this.clearWarm(key)
    const timer = setTimeout(() => {
      // The id may have moved from `draft:…` to a JSONL path since the timer
      // was armed. Follow that alias, and never retire a session that is
      // writing or waiting on the user.
      const id = this.canonical(key)
      this.warmTimers.delete(id)
      if (this.gate.holds(id) || this.approvals.has(id) || [...this.queued.values()].some(jobs => jobs.some(job => this.canonical(job.key) === id))) return
      const runtime = this.runtimes.get(id)
      if (!runtime?.isRunning) return
      void this.stop(id)
    }, WARM_MS)
    timer.unref?.()
    this.warmTimers.set(key, timer)
  }

  private clearWarm(key: string): void {
    const timer = this.warmTimers.get(key)
    if (!timer) return
    clearTimeout(timer)
    this.warmTimers.delete(key)
  }
}

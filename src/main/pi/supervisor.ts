import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'
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
import { isExternalToolName } from '../memory/policy'
import { CwdGate, InterprocessCwdGate } from './cwd-gate'
import { canonicalSessionFile } from './session-file'
import { properLockfile } from '../proper-lockfile'

interface HeldSessionFileLock {
  ownerId: string
  release: () => Promise<void>
}

class SessionFileLockError extends Error {}

/** How long an idle hot session keeps its process. Viewing it does not reset this. */
const WARM_MS = 10 * 60 * 1000
const CWD_QUEUE_POLL_MS = 250

const WRITE_COMMANDS = new Set(['prompt', 'bash'])
const BIND_COMMANDS = new Set(['prompt', 'fork', 'clone', 'new_session'])

function sameWorkingDirectory(left: string, right: string): boolean {
  if (!left || !right) return left === right
  return CwdGate.key(left) === CwdGate.key(right)
}

/**
 * One Pi process the supervisor can start, talk to, and stop.
 *
 * `PiRuntime` is the production implementation. Tests pass a fake so two
 * sessions can be driven without spawning the CLI.
 */
export interface ManagedSessionRuntime extends EventEmitter {
  readonly isRunning: boolean
  readonly pid?: number
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
  preflight?: () => void
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface RuntimeActivity {
  ownerId: string
  cwd: string
  writes: number
  running: boolean
  settlements: number
  /** The conversation used MCP, computer use, subagents or another outside tool. */
  externalContext: boolean
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
  private readonly startingCwds = new Map<string, string>()
  private readonly cancelledStarts = new Set<string>()
  private readonly aliases = new Map<string, string>()
  /** Canonical session-file identity → the runtime map key that may write it. */
  private readonly fileOwners = new Map<string, string>()
  /** Cross-process locks held while a runtime or session-file mutation owns a JSONL. */
  private readonly sessionFileLocks = new Map<string, HeldSessionFileLock>()
  private readonly gate = new CwdGate()
  private readonly interprocessGate?: InterprocessCwdGate
  private readonly queued = new Map<string, QueuedJob[]>()
  private readonly approvals = new Set<string>()
  private readonly warmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private queueDrainTimer?: ReturnType<typeof setTimeout>
  private readonly releasingCwds = new Set<string>()
  private readonly stoppingCwds = new Map<string, number>()
  private readonly releasingOwners = new Set<string>()
  private readonly activity = new WeakMap<ManagedSessionRuntime, RuntimeActivity>()
  private shuttingDown = false

  constructor(private readonly factory: SessionRuntimeFactory, cwdLockDirectory?: string) {
    super()
    if (cwdLockDirectory) this.interprocessGate = new InterprocessCwdGate(cwdLockDirectory)
  }

  has(key: string): boolean {
    return this.runtimes.get(this.canonical(key))?.isRunning ?? false
  }

  runningKeys(): string[] {
    return [...this.runtimes.keys()].filter((key) => this.runtimes.get(key)?.isRunning)
  }

  /**
   * The folder and tool reach of one hot conversation. Memory generation uses
   * this after a run settles: a chat that only read and edited local files is
   * eligible, one that used MCP or computer use may not be.
   */
  sessionInfo(key: string): { cwd: string; externalContext: boolean; running: boolean; pid?: number } | undefined {
    const id = this.canonical(key)
    const runtime = this.runtimes.get(id)
    if (!runtime) return undefined
    const activity = this.activity.get(runtime)
    if (!activity) return undefined
    return {
      cwd: activity.cwd,
      externalContext: activity.externalContext,
      running: activity.running || activity.writes > 0,
      pid: runtime.pid
    }
  }

  /** Desktop Git writes share the same directory gate as agent turns. */
  async withCwdLock<T>(cwd: string, action: () => Promise<T>): Promise<T> {
    const key = `operation:${randomUUID()}`
    if (this.shuttingDown) throw new Error('Pi is shutting down.')
    if (!this.claimCwd(cwd, key)) {
      throw new Error('A conversation is working in this folder. Wait for it to finish before changing Git state.')
    }
    try {
      return await action()
    } finally {
      await this.release(key, cwd)
    }
  }

  async ensure(options: RuntimeEnsureOptions): Promise<{ ok: boolean; error?: string }> {
    if (this.shuttingDown) return { ok: false, error: 'Pi is shutting down.' }
    if ([...this.stoppingCwds.keys()].some(root => this.gate.contains(root, options.cwd))) {
      return { ok: false, error: 'Working folder is being closed.' }
    }
    const requestedId = this.canonical(options.sessionKey)
    const fileOwner = options.sessionFile
      ? this.fileOwners.get(canonicalSessionFile(options.sessionFile))
      : undefined
    const ownerId = fileOwner ? this.canonical(fileOwner) : requestedId
    const current = this.runtimes.get(ownerId)
    const boundCwd = current
      ? this.activity.get(current)?.cwd ?? current.currentStatus.cwd
      : this.startingCwds.get(ownerId)
    if (
      (current && boundCwd === undefined) ||
      (boundCwd !== undefined && !sameWorkingDirectory(boundCwd, options.cwd))
    ) {
      return { ok: false, error: 'Conversation is already bound to another working folder.' }
    }
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
    this.cancelledStarts.delete(id)
    this.startingCwds.set(id, options.cwd)
    const init = this.boot(id, options)
    this.starting.set(id, init)
    try {
      return await init
    } finally {
      this.starting.delete(id)
      this.startingCwds.delete(id)
      this.cancelledStarts.delete(id)
    }
  }

  async request<T = unknown>(
    key: string,
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 30_000,
    trace?: RpcTraceHint,
    preflight?: () => void
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
      if (cwd && !this.claimCwd(cwd, id)) {
        return this.enqueue<T>({ key: id, cwd, command, payload, timeoutMs, trace, preflight })
      }
      if (command === 'prompt') {
        const sessionFile = runtime.currentStatus.sessionFile
        if (sessionFile) {
          try {
            await this.acquireSessionFileLock(sessionFile, id)
          } catch (error) {
            await this.release(id, cwd)
            throw error
          }
        }
      }
      activity.writes += 1
    }
    try {
      preflight?.()
    } catch (error) {
      if (writing) {
        activity.writes -= 1
        await this.release(this.ownerOf(runtime) ?? id)
      }
      throw error
    }
    const settlements = activity.settlements
    try {
      const result = await this.invoke<T>(id, command, payload, timeoutMs, trace)
      if (command === 'get_state' && this.ownerOf(runtime) === id) {
        const file = (result as PiState | undefined)?.sessionFile
        if (file && file !== id) {
          try {
            await this.bindFile(id, file)
          } catch (error) {
            if (error instanceof SessionFileLockError) await this.stop(id)
            throw error
          }
        }
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
    } catch (error) {
      // A failed write response does not prove Pi rejected or stopped the
      // operation. Keep the directory reserved until Pi settles or exits.
      if (writing && runtime.isRunning && activity.settlements === settlements) {
        activity.running = true
      }
      throw error
    } finally {
      if (writing) {
        activity.writes -= 1
        await this.release(this.ownerOf(runtime) ?? id)
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

  async rename(file: string, name: string, handle?: FileHandle): Promise<boolean> {
    const runtime = this.runtimes.get(this.canonical(file))
    let renamed = false
    if (runtime?.isRunning) {
      await runtime.request('set_session_name', { name }, 30_000, { sourceAction: 'session-rename' })
      renamed = true
    } else {
      try {
        renamed = await this.withSessionFileMutation(file, () => appendSessionName(file, name, handle))
      } catch (error) {
        if (error instanceof SessionFileLockError) return false
        throw error
      }
    }
    // A cold rename only appends to the JSONL, and a hot one publishes its name
    // on the runtime stream. Neither re-reads the session list, so push one
    // signal for both: the sidebar and the title bar wear the new name at once.
    if (renamed) this.emit('rename', { file, name })
    return renamed
  }

  async stop(key?: string): Promise<void> {
    if (!key) {
      this.shuttingDown = true
      const pending = [...this.queued.values()].flat()
      this.queued.clear()
      for (const job of pending) job.reject(new Error('Pi is shutting down.'))
      try {
        const stopping = [...this.runtimes.keys()].map(id => this.stop(id))
        const starting = [...this.starting.values()]
        const results = await Promise.allSettled([...stopping, ...starting])
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failed) throw failed.reason
      } finally {
        this.aliases.clear()
        this.fileOwners.clear()
        for (const [file, lock] of this.sessionFileLocks) {
          await this.releaseSessionFileLock(file, lock.ownerId)
        }
        this.shuttingDown = false
      }
      return
    }
    const id = this.canonical(key)
    const runtime = this.runtimes.get(id)
    this.clearWarm(id)
    this.dropQueued(id)
    if (!runtime) {
      const pending = this.starting.get(id)
      if (pending) {
        this.cancelledStarts.add(id)
        await pending.catch(() => {})
      }
      return
    }
    const activity = this.activity.get(runtime)!
    if (activity.stopping) return activity.stopping
    const wasBusy = activity.running || activity.writes > 0
    const settlementsAtStop = activity.settlements
    const starting = this.starting.get(id)
    const stopped = (async () => {
      try {
        if (wasBusy && runtime.isRunning) {
          try {
            await runtime.request('clear_queue', {}, 1000, { sourceAction: 'shutdown-clear-queue' })
          } catch {
            /* process shutdown below is the fallback */
          }
          if (activity.settlements === settlementsAtStop && runtime.isRunning) {
            try {
              await runtime.request('abort', {}, 7000, { sourceAction: 'shutdown-abort' })
            } catch {
              /* process shutdown below is the fallback */
            }
          }
        }
        await runtime.stop()
        await starting
        // A launch that was still in flight must not resurrect a stopped writer.
        if (runtime.isRunning) await runtime.stop()
        if (wasBusy && activity.settlements === settlementsAtStop) {
          // The transport was detached before shutdown, so Pi's final event
          // could not arrive (or abort did not settle it). Process exit confirms
          // that this run was stopped.
          this.emit('event', { ownerId: id, event: { type: 'agent_settled', aborted: true, runtimeStopped: true } })
        }
      } finally {
        this.clearWarm(id)
        if (this.runtimes.get(id) === runtime) this.runtimes.delete(id)
        this.approvals.delete(id)
        await this.releaseFile(id)
        activity.stopping = undefined
        await this.release(id, activity.cwd)
      }
    })()
    activity.stopping = stopped
    return stopped
  }

  async stopCwd(cwd: string, afterStopped?: () => void): Promise<void> {
    const closing = CwdGate.key(cwd)
    this.stoppingCwds.set(closing, (this.stoppingCwds.get(closing) ?? 0) + 1)
    try {
      const keys = new Set([...this.runtimes.keys()].filter((key) => {
        const runtime = this.runtimes.get(key)
        return runtime?.currentStatus.cwd && this.gate.contains(cwd, runtime.currentStatus.cwd)
      }))
      for (const [key, startingCwd] of this.startingCwds) {
        if (this.gate.contains(cwd, startingCwd)) keys.add(key)
      }
      // Cancel every waiter before any old writer can exit and dispatch one.
      await Promise.all([...keys].map(key => this.stop(key)))
      afterStopped?.()
    } finally {
      const count = this.stoppingCwds.get(closing) ?? 0
      if (count <= 1) this.stoppingCwds.delete(closing)
      else this.stoppingCwds.set(closing, count - 1)
    }
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
    try {
      if (options.sessionFile) await this.acquireSessionFileLock(options.sessionFile, id)
    } catch (error) {
      await this.releaseFile(id)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }

    // Shutdown may begin while opening the existing session's cross-process
    // lock. Do not launch a new writer after the global stop snapshot.
    if (this.shuttingDown) {
      await this.releaseFile(id)
      return { ok: false, error: 'Pi is shutting down.' }
    }
    if (this.cancelledStarts.has(id)) {
      await this.releaseFile(id)
      return { ok: false }
    }

    let runtime = this.runtimes.get(id)
    if (!runtime) {
      runtime = this.factory()
      this.runtimes.set(id, runtime)
      this.activity.set(runtime, {
        ownerId: id,
        cwd: options.cwd,
        writes: 0,
        running: false,
        settlements: 0,
        externalContext: false
      })
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
      await this.release(id)
      await this.releaseFile(id)
      return started
    }
    const file = runtime.currentStatus.sessionFile
    try {
      if (file && file !== id) await this.bindFile(id, file, true)
      else if (file) this.fileOwners.set(canonicalSessionFile(file), id)
    } catch (error) {
      await runtime.stop()
      if (this.runtimes.get(id) === runtime) this.runtimes.delete(id)
      await this.release(id)
      await this.releaseFile(id)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
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
      const activity = this.activity.get(runtime)!
      if (status.phase === 'error' && runtime.isRunning && activity.writes > 0) {
        // The request that hit the transport error may still be executing in Pi.
        activity.running = true
      }
      if ((status.phase === 'error' || status.phase === 'stopped') && !runtime.isRunning) {
        // A process that dies mid-run never writes `agent_settled`, and the
        // run would stay open for the rest of the app's life. A deliberate
        // stop sets `stopping` and publishes its own settle after the exit.
        // An RPC error can arrive while the child is still running, so keep
        // its activity and directory lease until a settle or process exit.
        const crashed = (activity.running || activity.writes > 0) && !activity.stopping && !runtime.isRunning
        activity.running = false
        this.approvals.delete(ownerId)
        if (crashed) {
          this.emit('event', {
            ownerId,
            event: { type: 'agent_settled', aborted: false, crashed: true }
          })
        }
        this.releaseFromEvent(ownerId)
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
    if (event.type === 'tool_execution_start' && isExternalToolName(event.toolName)) {
      activity.externalContext = true
    }
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
      this.releaseFromEvent(ownerId)
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
    this.scheduleQueueDrain()
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

  private claimCwd(cwd: string, key: string): boolean {
    if (!cwd) return true
    const id = CwdGate.key(cwd)
    const ownerId = this.canonical(key)
    if (this.releasingOwners.has(ownerId) || this.releasingCwds.has(id) || !this.gate.claim(cwd, ownerId)) return false
    if (!this.interprocessGate) return true
    try {
      const acquired = this.interprocessGate.acquire(cwd, ownerId)
      if (acquired) return true
      this.gate.releaseKey(id, ownerId)
      return false
    } catch (error) {
      this.gate.releaseKey(id, ownerId)
      throw error
    }
  }

  private async release(key: string, stoppedCwd?: string): Promise<void> {
    const id = this.canonical(key)
    const runtime = this.runtimes.get(id)
    const activity = runtime && this.activity.get(runtime)
    if (activity && (activity.writes > 0 || activity.running || activity.stopping)) return
    const cwd = CwdGate.key(stoppedCwd ?? this.cwdOf(id) ?? '')
    if (!cwd || !this.gate.holds(id)) return
    const heldCwds = this.gate.keysFor(id)
    this.releasingOwners.add(id)
    if (this.interprocessGate) {
      for (const heldCwd of heldCwds) this.releasingCwds.add(heldCwd)
      try {
        await this.interprocessGate.releaseOwner(id)
      } finally {
        this.releasingOwners.delete(id)
        for (const heldCwd of heldCwds) this.releasingCwds.delete(heldCwd)
      }
    } else {
      this.releasingOwners.delete(id)
    }
    // A continuation or another writer may have become active while the
    // cross-process registry lock was being acquired. Keep the local gate
    // until that writer settles as well.
    if (activity && (activity.writes > 0 || activity.running || activity.stopping)) return
    this.gate.releaseOwner(id)
    if (this.shuttingDown) return
    this.drainQueued()
    if (runtime?.isRunning) this.scheduleWarm(id)
  }

  private releaseFromEvent(key: string): void {
    void this.release(key).catch((error) => {
      console.error('[pi-desktop] could not release project activity lock:', error)
    })
  }

  /** Start queued writes as soon as no overlapping working directory owns the gate. */
  private drainQueued(): void {
    for (const [cwd, jobs] of this.queued) {
      const next = jobs[0]
      if (!next || !this.gate.claim(next.cwd, this.canonical(next.key))) continue
      jobs.shift()
      if (jobs.length === 0) this.queued.delete(cwd)
      void this.request(next.key, next.command, next.payload, next.timeoutMs, next.trace, next.preflight)
        .then(next.resolve, next.reject)
    }
    this.scheduleQueueDrain()
  }

  private scheduleQueueDrain(): void {
    if (!this.interprocessGate || this.shuttingDown || this.queued.size === 0) {
      if (this.queueDrainTimer) clearTimeout(this.queueDrainTimer)
      this.queueDrainTimer = undefined
      return
    }
    if (this.queueDrainTimer) return
    this.queueDrainTimer = setTimeout(() => {
      this.queueDrainTimer = undefined
      this.drainQueued()
    }, CWD_QUEUE_POLL_MS)
    this.queueDrainTimer.unref?.()
  }

  private async rebindFromState(id: string): Promise<string | undefined> {
    const key = this.canonical(id)
    const runtime = this.runtimes.get(key)
    if (!runtime?.isRunning) return
    try {
      const state = await runtime.request<PiState>('get_state', {}, 10_000, { sourceAction: 'bind-file' })
      if (state?.sessionFile && state.sessionFile !== key) await this.bindFile(key, state.sessionFile)
      return state?.sessionFile
    } catch (error) {
      if (error instanceof SessionFileLockError) {
        await this.stop(key)
        throw error
      }
      /* the command already finished; the file can be learned on the next get_state */
    }
  }

  private async bindFile(from: string, file: string, startup = false): Promise<void> {
    const runtime = this.runtimes.get(from)
    if (!runtime || from === file) return
    await this.acquireSessionFileLock(file, from)
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
    this.interprocessGate?.retargetOwner(from, file)
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
    const fileKey = canonicalSessionFile(file)
    this.fileOwners.set(fileKey, file)
    for (const [locked, sessionLock] of this.sessionFileLocks) {
      if (sessionLock.ownerId !== from) continue
      if (locked === fileKey) sessionLock.ownerId = file
      else await this.releaseSessionFileLock(locked, from)
    }
    this.emit('rekey', { from, to: file, ...(replace ? { replace: true } : {}) })
  }

  private async releaseFile(key: string): Promise<void> {
    const id = this.canonical(key)
    for (const [file, owner] of this.fileOwners) {
      if (owner === id || this.canonical(owner) === id) this.fileOwners.delete(file)
    }
    const locks = [...this.sessionFileLocks].filter(([, lock]) =>
      lock.ownerId === id || this.canonical(lock.ownerId) === id
    )
    await Promise.all(locks.map(([file, lock]) => this.releaseSessionFileLock(file, lock.ownerId)))
  }

  async withSessionFileMutation<T>(file: string, action: () => Promise<T>): Promise<T> {
    const ownerId = `mutation:${randomUUID()}`
    const lock = await this.acquireSessionFileLock(file, ownerId)
    try {
      return await action()
    } finally {
      if (lock) await this.releaseSessionFileLock(canonicalSessionFile(file), ownerId)
    }
  }

  private async acquireSessionFileLock(file: string, ownerId: string): Promise<HeldSessionFileLock | undefined> {
    if (!existsSync(file) && (!path.isAbsolute(file) || !existsSync(path.dirname(file)))) return undefined
    const key = canonicalSessionFile(file)
    const held = this.sessionFileLocks.get(key)
    if (held) {
      if (held.ownerId === ownerId) return held
      throw new SessionFileLockError('This conversation is already open in another Pi Desktop process.')
    }

    const lock: HeldSessionFileLock = { ownerId, release: async () => {} }
    try {
      lock.release = await properLockfile.lock(key, {
        realpath: false,
        retries: 0,
        onCompromised: () => {
          void this.stop(lock.ownerId).catch(() => {})
        }
      })
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined
      if (code === 'ELOCKED') {
        throw new SessionFileLockError('This conversation is already open in another Pi Desktop process.')
      }
      throw new Error(`Could not lock this conversation: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.sessionFileLocks.set(key, lock)
    return lock
  }

  private async releaseSessionFileLock(file: string, ownerId?: string): Promise<void> {
    const key = canonicalSessionFile(file)
    const lock = this.sessionFileLocks.get(key)
    if (!lock || (ownerId && lock.ownerId !== ownerId)) return
    try {
      await lock.release()
    } catch (error) {
      console.error('[pi-desktop] could not release a session file lock:', error)
    } finally {
      if (this.sessionFileLocks.get(key) === lock) this.sessionFileLocks.delete(key)
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

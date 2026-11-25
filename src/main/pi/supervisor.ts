import { EventEmitter } from 'node:events'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'
import {
  isSideSessionKey,
  type ExtensionUiResponse,
  type PiEvent,
  type PiState,
  type RpcTraceHint,
  type RuntimeEnsureOptions,
  type RuntimeQueueEvent,
  type RuntimeStartOptions,
  type RuntimeStatus,
  type SessionRuntimeRole
} from '@shared/types'
import { appendSessionName } from '../sessions'
import { isExternalToolName } from '../memory/policy'
import { CwdGate, InterprocessCwdGate, type CwdClaimMode } from './cwd-gate'
import { PiRpcPreSendError, isPreSendRpcError, isRpcCommandError } from './rpc-client'
import { canonicalSessionFile } from './session-file'
import { properLockfile } from '../proper-lockfile'

interface HeldSessionFileLock {
  ownerId: string
  release: () => Promise<void>
}

class SessionFileLockError extends Error {}

/** How long an idle hot session keeps its process. Viewing it does not reset this. */
const WARM_MS = 10 * 60 * 1000
export const MAX_IDLE_RUNTIMES = 4
const CWD_QUEUE_POLL_MIN_MS = 50
const CWD_QUEUE_POLL_MAX_MS = 500
const CWD_RELEASE_RETRY_MS = 500
const MAX_QUEUED_JOBS_PER_CWD = 64
const MAX_QUEUED_JOBS_TOTAL = 256
const MAX_QUEUED_PAYLOAD_BYTES_TOTAL = 32 * 1024 * 1024

const WRITE_COMMANDS = new Set(['prompt', 'bash'])
const SESSION_CHANGE_COMMANDS = new Set(['fork', 'clone', 'new_session'])

function sameWorkingDirectory(left: string, right: string): boolean {
  if (!left || !right) return left === right
  return CwdGate.key(left) === CwdGate.key(right)
}

function estimatePayloadBytes(value: unknown): number {
  const pending = [value]
  const seen = new WeakSet<object>()
  let bytes = 0
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item)
      continue
    }
    if (!item || typeof item !== 'object') {
      bytes += 8
      continue
    }
    if (seen.has(item)) continue
    seen.add(item)
    if (item instanceof ArrayBuffer) {
      bytes += item.byteLength
      continue
    }
    if (ArrayBuffer.isView(item)) {
      bytes += item.byteLength
      continue
    }
    if (Array.isArray(item)) {
      bytes += item.length * 2
      for (const child of item) pending.push(child)
      continue
    }
    for (const [key, child] of Object.entries(item)) {
      bytes += Buffer.byteLength(key) + 2
      pending.push(child)
    }
  }
  return bytes
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
  /** Answer a pending extension dialog; false when no runtime was waiting for it. */
  respondUi(id: string, response: ExtensionUiResponse): boolean
  stop(): Promise<void>
  hasPendingUi?(id: string): boolean
  hasAnyPendingUi?(): boolean
}

export type SessionRuntimeFactory = () => ManagedSessionRuntime

interface QueuedJob {
  key: string
  cwd: string
  command: string
  payload: Record<string, unknown>
  payloadBytes: number
  timeoutMs: number
  trace?: RpcTraceHint
  preflight?: () => void
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface RuntimeActivity {
  ownerId: string
  cwd: string
  role: SessionRuntimeRole
  /** Canonical key (`draft:…` or `.jsonl`) of bound Main session when `role === 'side'`. */
  parentKey?: string
  writes: number
  running: boolean
  settlements: number
  nameWrites: number
  /** The conversation used MCP, computer use, subagents or another outside tool. */
  externalContext: boolean
  /** True while this runtime has only been speculatively prewarmed for viewing. */
  prewarmOnly?: boolean
  binding?: Promise<void>
  finalizing?: boolean
  stopping?: Promise<void>
  changingSession?: boolean
  lastAccessed: number
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
  private readonly aliasesByTarget = new Map<string, Set<string>>()
  /** Canonical session-file identity → the runtime map key that may write it. */
  private readonly fileOwners = new Map<string, string>()
  /** Cross-process locks held while a runtime or session-file mutation owns a JSONL. */
  private readonly sessionFileLocks = new Map<string, HeldSessionFileLock>()
  private readonly gate = new CwdGate()
  private readonly interprocessGate?: InterprocessCwdGate
  private readonly queued = new Map<string, QueuedJob[]>()
  private queuedJobCount = 0
  private queuedPayloadBytes = 0
  private readonly approvals = new Set<string>()
  private readonly warmTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private queueDrainTimer?: ReturnType<typeof setTimeout>
  private queueDrainDelayMs = CWD_QUEUE_POLL_MIN_MS
  private readonly releasingCwds = new Set<{ ownerId: string; cwd: string; mode: CwdClaimMode; done: Promise<void> }>()
  private readonly stoppingCwds = new Map<string, number>()
  private readonly releasingOwners = new Map<string, number>()
  private readonly cwdReleaseRetries = new Map<string, { ownerId: string }>()
  private readonly activity = new WeakMap<ManagedSessionRuntime, RuntimeActivity>()
  private readonly sideByParent = new Map<string, Set<string>>()
  private shuttingDown = false
  private cliUpgradeInProgress = false
  private accessClock = 0

  private touchRuntime(activity: RuntimeActivity): void {
    const stamp = Date.now() * 1000 + (++this.accessClock % 1000)
    activity.lastAccessed = stamp
    if (activity.prewarmOnly) return
    for (const peerKey of this.pairedKeysOf(activity.ownerId)) {
      const peerRuntime = this.runtimes.get(peerKey)
      const peerActivity = peerRuntime && this.activity.get(peerRuntime)
      if (!peerRuntime?.isRunning || !peerActivity || peerActivity.stopping || peerActivity.prewarmOnly) {
        continue
      }
      peerActivity.lastAccessed = stamp
      if (this.warmTimers.has(peerKey)) {
        this.scheduleWarm(peerKey)
      }
    }
  }

  private linkSideToParent(sideKey: string, parentKey: string | undefined): void {
    const canonSide = this.canonical(sideKey)
    this.unlinkSide(canonSide)
    if (!parentKey) return
    const canonParent = this.canonical(parentKey)
    let set = this.sideByParent.get(canonParent)
    if (!set) {
      set = new Set<string>()
      this.sideByParent.set(canonParent, set)
    }
    set.add(canonSide)
    const runtime = this.runtimes.get(canonSide)
    const activity = runtime && this.activity.get(runtime)
    if (activity) activity.parentKey = canonParent
  }

  private unlinkSide(sideKey: string): void {
    const canonSide = this.canonical(sideKey)
    for (const [parentKey, set] of this.sideByParent) {
      set.delete(sideKey)
      set.delete(canonSide)
      if (set.size === 0) this.sideByParent.delete(parentKey)
    }
  }

  private pairedKeysOf(key: string): string[] {
    const id = this.canonical(key)
    const runtime = this.runtimes.get(id)
    const activity = runtime && this.activity.get(runtime)
    const paired = new Set<string>()
    if (activity?.role === 'side' && activity.parentKey) {
      paired.add(this.canonical(activity.parentKey))
    }
    const sides = this.sideByParent.get(id)
    if (sides) {
      for (const sideKey of sides) paired.add(this.canonical(sideKey))
    }
    paired.delete(id)
    return [...paired]
  }

  constructor(private readonly factory: SessionRuntimeFactory, cwdLockDirectory?: string) {
    super()
    if (cwdLockDirectory) this.interprocessGate = new InterprocessCwdGate(cwdLockDirectory)
  }

  has(key: string): boolean {
    return this.runtimes.get(this.canonical(key))?.isRunning ?? false
  }

  /** Fast check for whether a ready runtime already owns `(sessionKey, cwd, sessionFile)`. */
  isReadyMatch(options: Pick<RuntimeEnsureOptions, 'sessionKey' | 'cwd' | 'sessionFile' | 'role'>): boolean {
    if (this.cliUpgradeInProgress || this.shuttingDown) return false
    const requestedId = this.canonical(options.sessionKey)
    const fileOwner = options.sessionFile
      ? this.fileOwners.get(canonicalSessionFile(options.sessionFile))
      : undefined
    const ownerId = fileOwner ? this.canonical(fileOwner) : requestedId
    const runtime = this.runtimes.get(ownerId)
    const activity = runtime && this.activity.get(runtime)
    if (!runtime?.isRunning || runtime.currentStatus.phase !== 'ready' || !activity || activity.stopping) {
      return false
    }
    const expectedRole: SessionRuntimeRole =
      options.role === 'side' || isSideSessionKey(options.sessionKey) || isSideSessionKey(options.sessionFile)
        ? 'side'
        : 'main'
    if (activity.role !== expectedRole) return false
    if (!sameWorkingDirectory(activity.cwd, options.cwd)) return false
    if (options.sessionFile) {
      const activeFile = runtime.currentStatus.sessionFile
      if (!activeFile || canonicalSessionFile(activeFile) !== canonicalSessionFile(options.sessionFile)) {
        return false
      }
    }
    return true
  }

  runningKeys(): string[] {
    return [...this.runtimes.keys()].filter((key) => this.runtimes.get(key)?.isRunning)
  }

  /** Stop idle Pi processes and block new work while the bundled CLI is replaced. */
  async prepareForCliUpgrade(): Promise<boolean> {
    if (
      this.cliUpgradeInProgress ||
      this.shuttingDown ||
      this.starting.size > 0 ||
      this.queuedJobCount > 0 ||
      [...this.runtimes.values()].some((runtime) => {
        const activity = this.activity.get(runtime)
        return activity?.running || activity?.writes || activity?.binding
      })
    ) return false

    this.cliUpgradeInProgress = true
    try {
      const stopped = await Promise.allSettled(this.runningKeys().map((key) => this.stop(key)))
      const failed = stopped.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
      return true
    } catch (error) {
      this.cliUpgradeInProgress = false
      throw error
    }
  }

  finishCliUpgrade(): void {
    this.cliUpgradeInProgress = false
  }

  /**
   * The folder and tool reach of one hot conversation. Memory generation uses
   * this after a run settles: a chat that only read and edited local files is
   * eligible, one that used MCP or computer use may not be.
   */
  sessionInfo(key: string): {
    cwd: string
    role: SessionRuntimeRole
    parentKey?: string
    externalContext: boolean
    running: boolean
    waitingForInput: boolean
    pid?: number
  } | undefined {
    const id = this.canonical(key)
    const runtime = this.runtimes.get(id)
    if (!runtime) return undefined
    const activity = this.activity.get(runtime)
    if (!activity) return undefined
    return {
      cwd: activity.cwd,
      role: activity.role,
      ...(activity.parentKey ? { parentKey: this.canonical(activity.parentKey) } : {}),
      externalContext: activity.externalContext,
      running: activity.running || activity.writes > 0,
      waitingForInput: this.approvals.has(id),
      pid: runtime.pid
    }
  }

  parentOf(key: string): string | undefined {
    const id = this.canonical(key)
    const runtime = this.runtimes.get(id)
    const activity = runtime && this.activity.get(runtime)
    return activity?.parentKey ? this.canonical(activity.parentKey) : undefined
  }

  sideKeysForParent(parentKey: string): string[] {
    const canonParent = this.canonical(parentKey)
    const set = this.sideByParent.get(canonParent)
    if (!set) return []
    return [...set].map((sideKey) => this.canonical(sideKey))
  }

  async stopSideForParent(parentKey: string): Promise<void> {
    const keys = this.sideKeysForParent(parentKey)
    if (keys.length === 0) return
    await Promise.all(keys.map((sideKey) => this.stop(sideKey)))
  }

  /** Desktop Git writes take an exclusive directory lock over agent runs. */
  async withCwdLock<T>(cwd: string, action: () => Promise<T>): Promise<T> {
    const key = `operation:${randomUUID()}`
    if (this.shuttingDown) throw new Error('Pi is shutting down.')
    if (cwd && this.releasingCwds.size > 0) {
      // The UI can receive agent_settled before the shared lease leaves disk.
      const cwdKey = CwdGate.key(cwd)
      const releases = [...this.releasingCwds]
        .filter((entry) => CwdGate.overlaps(cwdKey, entry.cwd))
        .map((entry) => entry.done)
      if (releases.length > 0) {
        await Promise.all(releases)
        if (this.shuttingDown) throw new Error('Pi is shutting down.')
      }
    }
    const claim = this.tryClaimCwdSync(cwd, key, 'exclusive')
    if (claim.status === 'conflict') {
      throw new Error('A conversation is working in this folder. Wait for it to finish before changing Git state.')
    }
    if (claim.status === 'lock_busy') {
      if (!(await this.finishClaimCwdAsync(claim, 'exclusive'))) {
        throw new Error('A conversation is working in this folder. Wait for it to finish before changing Git state.')
      }
    }
    try {
      if (this.shuttingDown) throw new Error('Pi is shutting down.')
      return await action()
    } finally {
      await this.release(key, cwd)
    }
  }

  async ensure(options: RuntimeEnsureOptions): Promise<{ ok: boolean; error?: string }> {
    if (this.cliUpgradeInProgress) return { ok: false, error: 'The Pi CLI is updating. Try again when it finishes.' }
    if (this.shuttingDown) return { ok: false, error: 'Pi is shutting down.' }
    if (this.stoppingCwds.size > 0 && [...this.stoppingCwds.keys()].some(root => this.gate.contains(root, options.cwd))) {
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
    if (existing?.isRunning && existing.currentStatus.phase === 'ready') {
      const activity = this.activity.get(existing)
      if (activity) {
        if (activity.role === 'side' && options.parentSessionKey) {
          this.linkSideToParent(id, options.parentSessionKey)
        }
        if (!options.prewarm) {
          activity.prewarmOnly = false
          this.touchRuntime(activity)
        } else if (activity.lastAccessed === 0) {
          this.touchRuntime(activity)
        }
      }
      this.pruneIdleRuntimes(id)
      return { ok: true }
    }
    const pending = this.starting.get(id)
    if (pending) {
      if (!options.prewarm) {
        const startingRuntime = this.runtimes.get(id)
        const startingActivity = startingRuntime && this.activity.get(startingRuntime)
        if (startingActivity) startingActivity.prewarmOnly = false
      }
      const res = await pending
      const settledId = this.canonical(id)
      const settledRuntime = this.runtimes.get(settledId)
      const settledActivity = settledRuntime && this.activity.get(settledRuntime)
      if (settledActivity?.role === 'side' && options.parentSessionKey) {
        this.linkSideToParent(settledId, options.parentSessionKey)
      }
      if (!options.prewarm) {
        if (settledActivity) {
          settledActivity.prewarmOnly = false
          this.touchRuntime(settledActivity)
        }
      }
      return res
    }
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
      this.pruneIdleRuntimes(this.canonical(id))
    }
  }

  request<T = unknown>(
    key: string,
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 30_000,
    trace?: RpcTraceHint,
    preflight?: () => void
  ): Promise<T> {
    return this.dispatchRequest(key, command, payload, timeoutMs, trace, preflight)
  }

  private async dispatchRequest<T>(
    key: string,
    command: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    trace?: RpcTraceHint,
    preflight?: () => void,
    fromQueue = false
  ): Promise<T> {
    const id = this.canonical(key)
    if (this.cliUpgradeInProgress) throw new Error('The Pi CLI is updating. Try again when it finishes.')
    if (this.shuttingDown) throw new Error('Pi is shutting down.')
    const runtime = this.runtimes.get(id)
    const activity = runtime && this.activity.get(runtime)
    if (!runtime?.isRunning || !activity || activity.stopping) {
      throw new Error('Pi is not running for this conversation.')
    }
    const writing = WRITE_COMMANDS.has(command)
    const changesSession = SESSION_CHANGE_COMMANDS.has(command)
    if (activity.changingSession && (writing || changesSession || command === 'set_session_name')) {
      throw new PiRpcPreSendError('This conversation is changing sessions. Try again when it finishes.', 'closed')
    }
    if (changesSession && (activity.running || activity.writes > 0 || this.hasQueuedJobs(id))) {
      throw new PiRpcPreSendError('Wait for the active run or queued work to finish before changing sessions.', 'closed')
    }
    this.touchRuntime(activity)
    activity.prewarmOnly = false
    if (command === 'abort' || command === 'abort_retry') {
      this.dropQueued(id)
      this.approvals.delete(id)
    }
    if (command === 'abort_bash') this.dropQueued(id, 'bash')
    const removed = command === 'clear_queue' ? this.dropQueued(id, 'prompt') : []
    const writeCwd = writing ? this.cwdOf(id) : undefined
    if (writing) {
      this.clearWarm(id)
      // Keep writes waiting for the registry mutex in the same cancellable
      // FIFO as writes blocked by a Git operation.
      if (writeCwd && !fromQueue && (this.queued.has(CwdGate.key(writeCwd)) || !this.claimCwd(writeCwd, id))) {
        return this.enqueue<T>({ key: id, cwd: writeCwd, command, payload, timeoutMs, trace, preflight })
      }
      activity.writes += 1
    }
    if (changesSession) activity.changingSession = true
    try {
      const sessionFile = command === 'prompt' ? runtime.currentStatus.sessionFile : undefined
      if (sessionFile) await this.acquireSessionFileLock(sessionFile, id)
      preflight?.()
    } catch (error) {
      if (changesSession) activity.changingSession = false
      if (writing) {
        activity.writes -= 1
        await this.release(this.ownerOf(runtime) ?? id, writeCwd)
      }
      throw error
    }
    const settlements = activity.settlements
    if (command === 'set_session_name') activity.nameWrites += 1
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
        // Only user prompts belong in the composer when the directory queue is cleared.
        const internalActions = ['image-params', 'image-params-cancel', 'message-edit', 'message-undo']
        const prompts = removed.filter(job => !internalActions.includes(job.trace?.sourceAction ?? ''))
        return {
          steering: [...(queue?.steering ?? []), ...prompts.filter(job => job.payload.streamingBehavior !== 'followUp').map(job => String(job.payload.message ?? ''))],
          followUp: [...(queue?.followUp ?? []), ...prompts.filter(job => job.payload.streamingBehavior === 'followUp').map(job => String(job.payload.message ?? ''))]
        } as T
      }
      if (command === 'prompt' || changesSession) {
        const file = await this.rebindFromState(this.ownerOf(runtime) ?? id)
        if (file && command !== 'prompt') return { ...result, sessionFile: file } as T
      }
      return result
    } catch (error) {
      // A timed-out or transport-failed `prompt` does not prove Pi rejected the
      // turn, so keep the directory reserved until Pi settles or exits. Explicit
      // RPC command rejections (`PiRpcCommandError`, emitted only on preflight
      // failure before a turn starts), pre-send local rejections, and `bash`
      // commands (which never emit `agent_settled`) must not stick `running`.
      if (
        command === 'prompt' &&
        runtime.isRunning &&
        activity.settlements === settlements &&
        !isPreSendRpcError(error) &&
        !isRpcCommandError(error)
      ) {
        activity.running = true
      }
      throw error
    } finally {
      if (changesSession) activity.changingSession = false
      if (writing) {
        activity.writes -= 1
        await this.release(this.ownerOf(runtime) ?? id, writeCwd)
      }
    }
  }

  respondUi(key: string, id: string, response: ExtensionUiResponse): boolean {
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
      const activity = this.activity.get(runtime)
      if (activity) {
        activity.prewarmOnly = false
        this.touchRuntime(activity)
      }
      runtime.respondUi(id, response)
      const stillPending = runtime.hasAnyPendingUi
        ? runtime.hasAnyPendingUi()
        : Boolean(runtime.hasPendingUi?.(id))
      if (targetKey && !stillPending) {
        this.approvals.delete(targetKey)
      }
      // Every surface that forwarded this dialog — the phone companion, the
      // IM channels — must learn it was answered, including when the desktop
      // answered it, so their copy of the dialog can close.
      const ownerId = targetKey ?? this.ownerOf(runtime)
      if (ownerId) this.emit('ui-responded', { ownerId, id })
      return true
    }
    return false
  }

  renameIfUnnamed(file: string, name: string): Promise<boolean> {
    return this.rename(file, name, undefined, true)
  }

  async rename(file: string, name: string, handle?: FileHandle, onlyIfUnnamed = false): Promise<boolean> {
    const resolveTargetId = (): string => {
      const fileOwner = this.fileOwners.get(canonicalSessionFile(file))
      return fileOwner ? this.canonical(fileOwner) : this.canonical(file)
    }
    let id = resolveTargetId()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pendingStart = this.starting.get(id)
      if (pendingStart) {
        await pendingStart.catch(() => {})
        id = resolveTargetId()
        continue
      }
      const existing = this.runtimes.get(id)
      const pendingStop = existing && this.activity.get(existing)?.stopping
      if (pendingStop) {
        await pendingStop.catch(() => {})
        id = resolveTargetId()
        continue
      }
      break
    }

    const runtime = this.runtimes.get(id)
    const activity = runtime && this.activity.get(runtime)
    let renamed = false
    if (runtime?.isRunning && activity && !activity.stopping) {
      if (onlyIfUnnamed) {
        if (activity.running || activity.writes > 0 || activity.changingSession) return false
        const nameWrites = activity.nameWrites
        const state = await runtime.request<PiState>('get_state', {}, 10_000, { sourceAction: 'auto-title' })
        // Pi can answer with a snapshot taken just before a manual rename.
        // Recheck locally before sending, with no await between check and send.
        if (
          !state?.sessionFile || canonicalSessionFile(state.sessionFile) !== canonicalSessionFile(file) ||
          state.sessionName || state.isStreaming || state.isCompacting ||
          this.ownerOf(runtime) !== id || activity.stopping || activity.changingSession ||
          activity.running || activity.writes > 0 || activity.nameWrites !== nameWrites
        ) return false
      }
      // Pi can already be writing the new session before the supervisor
      // updates its file owners. Use the same transition guard as other RPCs.
      await this.request(id, 'set_session_name', { name }, 30_000, { sourceAction: 'session-rename' })
      renamed = true
    } else {
      try {
        renamed = await this.withSessionFileMutation(file, () => appendSessionName(file, name, handle, onlyIfUnnamed))
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
      // Stopping every session is the app's shutdown path. The window can
      // still send IPC while other cleanup completes, so keep admission closed.
      this.shuttingDown = true
      if (this.queueDrainTimer) {
        clearTimeout(this.queueDrainTimer)
        this.queueDrainTimer = undefined
      }
      const pending = [...this.queued.values()].flat()
      this.queued.clear()
      this.queuedJobCount = 0
      this.queuedPayloadBytes = 0
      for (const job of pending) {
        this.emit('queued', { ownerId: this.canonical(job.key), cwd: job.cwd, queued: false } satisfies RuntimeQueueEvent)
        job.reject(new Error('Pi is shutting down.'))
      }
      try {
        const stopping = [...this.runtimes.keys()].map(id => this.stop(id))
        const starting = [...this.starting.values()]
        const results = await Promise.allSettled([...stopping, ...starting])
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        if (failed) throw failed.reason
      } finally {
        this.aliases.clear()
        this.aliasesByTarget.clear()
        this.fileOwners.clear()
        this.sideByParent.clear()
        for (const [file, lock] of this.sessionFileLocks) {
          await this.releaseSessionFileLock(file, lock.ownerId)
        }
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
    const wasBusy = !activity.finalizing && (activity.running || activity.writes > 0)
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
        activity.finalizing = true
        await activity.binding?.catch(() => {})
        if (wasBusy && activity.settlements === settlementsAtStop) {
          // The transport was detached before shutdown, so Pi's final event
          // could not arrive (or abort did not settle it). Process exit confirms
          // that this run was stopped.
          this.emit('event', {
            ownerId: activity.ownerId,
            event: { type: 'agent_settled', aborted: true, runtimeStopped: true }
          })
        }
      } finally {
        activity.finalizing = true
        await activity.binding?.catch(() => {})
        const owner = activity.ownerId
        this.clearWarm(owner)
        this.dropQueued(owner)
        this.approvals.delete(owner)
        // Keep the stopping runtime discoverable until its session-file lock
        // is released. Use its current owner because an in-flight state read
        // may have rebound it while shutdown was waiting for Pi to exit.
        await this.releaseFile(owner)
        this.unlinkSide(id)
        this.unlinkSide(owner)
        if (this.runtimes.get(owner) === runtime) this.runtimes.delete(owner)
        activity.stopping = undefined
        await this.release(owner, activity.cwd)
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
      if (holder !== requested) this.setAlias(requested, holder)
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

    const role: SessionRuntimeRole =
      options.role === 'side' || isSideSessionKey(id) || isSideSessionKey(options.sessionFile)
        ? 'side'
        : 'main'
    const parentKey =
      role === 'side' && options.parentSessionKey ? this.canonical(options.parentSessionKey) : undefined
    let runtime = this.runtimes.get(id)
    if (!runtime) {
      runtime = this.factory()
      this.runtimes.set(id, runtime)
      const activity: RuntimeActivity = {
        ownerId: id,
        cwd: options.cwd,
        role,
        parentKey,
        writes: 0,
        running: false,
        settlements: 0,
        nameWrites: 0,
        externalContext: false,
        prewarmOnly: options.prewarm === true,
        lastAccessed: 0
      }
      this.activity.set(runtime, activity)
      if (role === 'side' && parentKey) this.linkSideToParent(id, parentKey)
      this.attach(runtime)
    } else {
      const activity = this.activity.get(runtime)
      if (activity && role === 'side' && parentKey) {
        this.linkSideToParent(id, parentKey)
      }
    }
    let started: { ok: boolean; error?: string }
    try {
      started = await runtime.start({
        cwd: options.cwd,
        sessionFile: options.sessionFile,
        role,
        parentSessionKey: parentKey,
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        rememberDefaults: role === 'side' ? false : options.rememberDefaults,
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
      this.unlinkSide(id)
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
      this.unlinkSide(id)
      await this.release(id)
      await this.releaseFile(id)
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
    const owner = this.ownerOf(runtime) ?? id
    const activity = this.activity.get(runtime)
    if (activity) this.touchRuntime(activity)
    this.scheduleWarm(owner)
    return { ok: true }
  }

  private attach(runtime: ManagedSessionRuntime): void {
    runtime.on('event', (event: PiEvent) => {
      const ownerId = this.ownerOf(runtime)
      if (!ownerId) return
      this.note(ownerId, runtime, event)
      this.emit('event', { ownerId, event })
    })
    runtime.on('status', (status: RuntimeStatus, processExited?: boolean) => {
      const ownerId = this.ownerOf(runtime)
      if (!ownerId) return
      const activity = this.activity.get(runtime)!
      if (status.phase === 'error' && activity.writes > 0) {
        // The request that hit the transport error may still be executing in Pi.
        activity.running = true
      }
      if (processExited && !activity.stopping && !activity.finalizing) {
        // A closed RPC transport can still have a live child. Only a confirmed
        // exit retires the runtime and releases its session-file lock.
        const crashed = activity.running || activity.writes > 0
        activity.running = false
        activity.finalizing = true
        this.approvals.delete(ownerId)
        if (crashed) {
          this.emit('event', {
            ownerId,
            event: { type: 'agent_settled', aborted: false, crashed: true }
          })
        }
        void this.stop(ownerId).catch((error) => {
          console.error('[pi-desktop] could not retire an exited Pi process:', error)
        })
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
      this.touchRuntime(activity)
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

  private queueHolderInfo(
    cwd: string,
    mode: CwdClaimMode = 'shared',
    excludeOwnerId?: string
  ): Pick<RuntimeQueueEvent, 'holderOwnerId' | 'holderCwd' | 'externalHolder'> {
    const key = CwdGate.key(cwd)
    const local = this.gate.holderInfoResolved(key, mode, excludeOwnerId)
    if (local) {
      return { holderOwnerId: local.ownerId, holderCwd: local.cwd, externalHolder: false }
    }
    const ext = this.interprocessGate?.externalHolderResolved(key, mode)
    if (ext) {
      return { holderCwd: ext.cwd, externalHolder: true }
    }
    if (excludeOwnerId && (this.releasingOwners.get(excludeOwnerId) ?? 0) > 0) {
      return { holderCwd: key, externalHolder: false }
    }
    return this.interprocessGate ? { externalHolder: true } : {}
  }

  private emitQueueWaitersUpdated(jobs: QueuedJob[]): void {
    if (jobs.length === 0) return
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index]!
      const ownerId = this.canonical(job.key)
      this.emit('queued', {
        ownerId,
        cwd: job.cwd,
        queued: true,
        position: index + 1,
        ...this.queueHolderInfo(job.cwd, 'shared', ownerId)
      } satisfies RuntimeQueueEvent)
    }
  }

  private enqueue<T>(job: Omit<QueuedJob, 'resolve' | 'reject' | 'payloadBytes'>): Promise<T> {
    const cwd = CwdGate.key(job.cwd)
    const list = this.queued.get(cwd) ?? []
    const payloadBytes = estimatePayloadBytes(job.payload)
    if (
      list.length >= MAX_QUEUED_JOBS_PER_CWD ||
      this.queuedJobCount >= MAX_QUEUED_JOBS_TOTAL ||
      this.queuedPayloadBytes + payloadBytes > MAX_QUEUED_PAYLOAD_BYTES_TOTAL
    ) {
      throw new Error('The working-folder queue is full. This request was not sent; wait for the active run or clear queued work.')
    }
    const promise = new Promise<T>((resolve, reject) => {
      list.push({
        ...job,
        payloadBytes,
        resolve: (value) => resolve(value as T),
        reject
      })
    })
    this.queued.set(cwd, list)
    this.queuedJobCount += 1
    this.queuedPayloadBytes += payloadBytes
    const ownerId = this.canonical(job.key)
    this.emit('queued', {
      ownerId,
      cwd: job.cwd,
      queued: true,
      position: list.length,
      ...this.queueHolderInfo(job.cwd, 'shared', ownerId)
    } satisfies RuntimeQueueEvent)
    this.queueDrainDelayMs = CWD_QUEUE_POLL_MIN_MS
    this.scheduleQueueDrain()
    return promise
  }

  private dropQueued(key: string, command?: string): QueuedJob[] {
    const id = this.canonical(key)
    const removed: QueuedJob[] = []
    for (const [cwd, jobs] of this.queued) {
      const kept: QueuedJob[] = []
      let changed = false
      for (const job of jobs) {
        const jobOwner = this.canonical(job.key)
        if (jobOwner === id && (!command || job.command === command)) {
          removed.push(job)
          changed = true
          this.queuedJobCount -= 1
          this.queuedPayloadBytes -= job.payloadBytes
          this.emit('queued', { ownerId: jobOwner, cwd: job.cwd, queued: false } satisfies RuntimeQueueEvent)
          job.resolve({ disposition: 'handled', cancelled: true })
        } else kept.push(job)
      }
      if (kept.length) {
        this.queued.set(cwd, kept)
        if (changed) this.emitQueueWaitersUpdated(kept)
      } else {
        this.queued.delete(cwd)
      }
    }
    if (this.queued.size === 0 && this.queueDrainTimer) {
      clearTimeout(this.queueDrainTimer)
      this.queueDrainTimer = undefined
    }
    return removed
  }

  private hasConflictingRelease(cwdKey: string, mode: CwdClaimMode): boolean {
    for (const entry of this.releasingCwds) {
      if (!CwdGate.overlaps(cwdKey, entry.cwd)) continue
      if (mode === 'exclusive' || entry.mode === 'exclusive') return true
    }
    return false
  }

  private tryClaimCwdSync(
    cwd: string,
    key: string,
    mode: CwdClaimMode = 'shared'
  ):
    | { status: 'acquired' | 'conflict' }
    | { status: 'lock_busy'; id: string; ownerId: string; previousMode: CwdClaimMode | undefined } {
    if (!cwd) return { status: 'acquired' }
    const id = CwdGate.key(cwd)
    const ownerId = this.canonical(key)
    if (
      (this.releasingOwners.get(ownerId) ?? 0) > 0 ||
      this.hasConflictingRelease(id, mode)
    ) {
      return { status: 'conflict' }
    }
    const previousMode = this.gate.modeFor(id, ownerId)
    if (!this.gate.claimResolved(id, ownerId, mode)) return { status: 'conflict' }
    if (!this.interprocessGate) return { status: 'acquired' }
    try {
      const result = this.interprocessGate.tryAcquireResolvedSync(id, ownerId, mode)
      if (result === 'acquired') return { status: 'acquired' }
      if (result === 'lock_busy') return { status: 'lock_busy', id, ownerId, previousMode }
      if (previousMode) this.gate.setKeyMode(id, ownerId, previousMode)
      else this.gate.releaseKey(id, ownerId)
      return { status: 'conflict' }
    } catch (error) {
      if (previousMode) this.gate.setKeyMode(id, ownerId, previousMode)
      else this.gate.releaseKey(id, ownerId)
      throw error
    }
  }

  private async finishClaimCwdAsync(
    pending: { id: string; ownerId: string; previousMode: CwdClaimMode | undefined },
    mode: CwdClaimMode
  ): Promise<boolean> {
    const rollback = () => {
      const currentOwner = this.canonical(pending.ownerId)
      if (pending.previousMode) {
        this.gate.setKeyMode(pending.id, currentOwner, pending.previousMode)
        if (currentOwner !== pending.ownerId) this.gate.setKeyMode(pending.id, pending.ownerId, pending.previousMode)
      } else {
        this.gate.releaseKey(pending.id, currentOwner)
        if (currentOwner !== pending.ownerId) this.gate.releaseKey(pending.id, pending.ownerId)
      }
    }
    try {
      const acquired = await this.interprocessGate!.acquireResolvedAsync(pending.id, this.canonical(pending.ownerId), mode)
      if (acquired) return true
      rollback()
      return false
    } catch (error) {
      rollback()
      throw error
    }
  }

  private claimCwd(cwd: string, key: string, mode: CwdClaimMode = 'shared'): boolean {
    const result = this.tryClaimCwdSync(cwd, key, mode)
    if (result.status === 'acquired') return true
    if (result.status === 'lock_busy') {
      if (result.previousMode) this.gate.setKeyMode(result.id, result.ownerId, result.previousMode)
      else this.gate.releaseKey(result.id, result.ownerId)
    }
    return false
  }

  private async release(key: string, stoppedCwd?: string, retrying = false): Promise<void> {
    const id = this.canonical(key)
    const runtime = this.runtimes.get(id)
    const activity = runtime && this.activity.get(runtime)
    if (activity && (activity.writes > 0 || activity.running || activity.stopping)) return
    const cwd = CwdGate.key(stoppedCwd ?? this.cwdOf(id) ?? '')
    if (!cwd || !this.gate.holds(id)) return
    const currentOwnerId = (): string => activity?.ownerId ?? this.canonical(id)
    this.releasingOwners.set(id, (this.releasingOwners.get(id) ?? 0) + 1)
    if (this.interprocessGate) {
      let markReleased!: () => void
      const released = new Promise<void>((resolve) => { markReleased = resolve })
      const releaseTokens = this.gate.entriesFor(id).map((entry) => ({ ...entry, ownerId: id, done: released }))
      for (const token of releaseTokens) this.releasingCwds.add(token)
      try {
        await this.interprocessGate.releaseOwner(id)
        const reboundId = currentOwnerId()
        if (reboundId !== id) {
          await this.interprocessGate.releaseOwner(reboundId)
        }
      } catch (error) {
        // Keep the lease until it can be removed from disk. Rebinding the
        // lease to a different conversation file also moves its retry.
        const ownerId = currentOwnerId()
        if (!this.cwdReleaseRetries.has(ownerId)) {
          if (!retrying) console.error('[pi-desktop] could not release project directory lock; retrying:', error)
          const retry = { ownerId }
          this.cwdReleaseRetries.set(ownerId, retry)
          setTimeout(() => {
            const owner = retry.ownerId
            if (this.cwdReleaseRetries.get(owner) !== retry) return
            this.cwdReleaseRetries.delete(owner)
            void this.release(owner, cwd, true).then(() => {
              this.pruneIdleRuntimes(this.canonical(owner))
            }).catch((retryError) => {
              console.error('[pi-desktop] could not retry project directory release:', retryError)
            })
          }, CWD_RELEASE_RETRY_MS).unref()
        }
        return
      } finally {
        const resolved = currentOwnerId()
        const releaseKey = this.releasingOwners.has(resolved) ? resolved : id
        const count = this.releasingOwners.get(releaseKey) ?? 0
        if (count <= 1) this.releasingOwners.delete(releaseKey)
        else this.releasingOwners.set(releaseKey, count - 1)
        for (const token of releaseTokens) this.releasingCwds.delete(token)
        markReleased()
      }
    } else {
      const count = this.releasingOwners.get(id) ?? 0
      if (count <= 1) this.releasingOwners.delete(id)
      else this.releasingOwners.set(id, count - 1)
    }
    const ownerId = currentOwnerId()
    if ((this.releasingOwners.get(ownerId) ?? 0) > 0 || (ownerId !== id && (this.releasingOwners.get(id) ?? 0) > 0)) {
      return
    }
    // A continuation or another writer may have become active while the
    // cross-process registry lock was being acquired. Keep the local gate
    // until that writer settles as well.
    if (activity && (activity.writes > 0 || activity.running || activity.stopping)) return
    this.gate.releaseOwner(ownerId)
    if (ownerId !== id) this.gate.releaseOwner(id)
    if (this.shuttingDown) return
    this.queueDrainDelayMs = CWD_QUEUE_POLL_MIN_MS
    this.drainQueued()
    if (runtime?.isRunning) this.scheduleWarm(ownerId)
  }

  private releaseFromEvent(key: string): void {
    void this.release(key).then(() => {
      this.pruneIdleRuntimes(this.canonical(key))
    }).catch((error) => {
      console.error('[pi-desktop] could not release project activity lock:', error)
    })
  }

  /** Start queued writes as soon as no exclusive working-directory lock blocks them. */
  private drainQueued(): void {
    if (this.shuttingDown || this.cliUpgradeInProgress) return
    let dispatchedAny = false
    for (const [cwd, jobs] of [...this.queued]) {
      while (jobs.length > 0) {
        const next = jobs[0]!
        const owner = this.canonical(next.key)
        const runtime = this.runtimes.get(owner)
        const activity = runtime && this.activity.get(runtime)
        if (!runtime?.isRunning || !activity || activity.stopping) {
          jobs.shift()
          this.queuedJobCount -= 1
          this.queuedPayloadBytes -= next.payloadBytes
          this.emit('queued', { ownerId: owner, cwd: next.cwd, queued: false } satisfies RuntimeQueueEvent)
          next.reject(new Error('Pi is not running for this conversation.'))
          continue
        }
        // Claim BOTH the local gate and the interprocess gate BEFORE dequeuing
        // so cross-process contention preserves strict FIFO order without churn.
        let claimed = false
        try {
          claimed = this.claimCwd(next.cwd, owner, 'shared')
        } catch (error) {
          console.error('[pi-desktop] queued prompt could not inspect project lock:', error)
          break
        }
        if (!claimed) break
        jobs.shift()
        this.queuedJobCount -= 1
        this.queuedPayloadBytes -= next.payloadBytes
        dispatchedAny = true
        this.emit('queued', { ownerId: owner, cwd: next.cwd, queued: false } satisfies RuntimeQueueEvent)
        void this.dispatchRequest(next.key, next.command, next.payload, next.timeoutMs, next.trace, next.preflight, true)
          .then(next.resolve, (error) => {
            const currentRuntime = this.runtimes.get(owner)
            const currentActivity = currentRuntime && this.activity.get(currentRuntime)
            if (
              !currentRuntime?.isRunning ||
              !currentActivity ||
              currentActivity.stopping ||
              this.shuttingDown ||
              this.cliUpgradeInProgress
            ) {
              void this.release(owner, next.cwd).catch(() => {})
            }
            next.reject(error)
          })
      }
      if (jobs.length === 0) this.queued.delete(cwd)
      else this.emitQueueWaitersUpdated(jobs)
    }
    if (dispatchedAny) this.queueDrainDelayMs = CWD_QUEUE_POLL_MIN_MS
    this.scheduleQueueDrain()
  }

  private scheduleQueueDrain(): void {
    if (!this.interprocessGate || this.shuttingDown || this.queued.size === 0) {
      if (this.queueDrainTimer) clearTimeout(this.queueDrainTimer)
      this.queueDrainTimer = undefined
      return
    }
    if (this.queueDrainTimer) return
    const delay = this.queueDrainDelayMs
    this.queueDrainDelayMs = Math.min(CWD_QUEUE_POLL_MAX_MS, delay * 2)
    this.queueDrainTimer = setTimeout(() => {
      this.queueDrainTimer = undefined
      try {
        this.drainQueued()
      } catch (error) {
        console.error('[pi-desktop] queued prompt drain failed:', error)
        this.scheduleQueueDrain()
      }
    }, delay)
    // Deliberately not unref'd: this timer only exists while a request is
    // queued, and that caller is awaiting the request's promise. An unref'd
    // poll would let a bare process exit with the queued command unresolved.
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

  private bindFile(from: string, file: string, startup = false): Promise<void> {
    const runtime = this.runtimes.get(from)
    const activity = runtime && this.activity.get(runtime)
    if (!runtime || !activity || from === file || activity.finalizing) return Promise.resolve()
    const previous = activity.binding ?? Promise.resolve()
    const binding = previous.then(
      () => this.bindFileNow(runtime, activity, from, file, startup),
      () => this.bindFileNow(runtime, activity, from, file, startup)
    )
    let tracked: Promise<void>
    tracked = binding.finally(() => {
      if (activity.binding === tracked) activity.binding = undefined
    })
    activity.binding = tracked
    return tracked
  }

  private async bindFileNow(
    runtime: ManagedSessionRuntime,
    activity: RuntimeActivity,
    from: string,
    file: string,
    startup: boolean
  ): Promise<void> {
    if (activity.finalizing || this.ownerOf(runtime) !== from || from === file) return
    await this.acquireSessionFileLock(file, from)
    if (activity.finalizing || this.ownerOf(runtime) !== from) {
      // Another state read may have rebound this runtime while the lock was
      // being acquired. Do not leave a second map entry or an orphaned lock.
      await this.releaseSessionFileLock(file, from)
      return
    }
    this.runtimes.delete(from)
    this.runtimes.set(file, runtime)
    activity.ownerId = file
    // A fork moves this process, but the original JSONL remains a separate chat.
    // Only drafts and alternate spellings of the same file are aliases.
    for (const alias of [...(this.aliasesByTarget.get(from) ?? [])]) this.setAlias(alias, file)
    const replace = startup && !from.startsWith('draft:') && canonicalSessionFile(from) !== canonicalSessionFile(file)
    const migrateIdentity = replace || from.startsWith('draft:') || canonicalSessionFile(from) === canonicalSessionFile(file)
    if (migrateIdentity) {
      this.setAlias(from, file)
    }
    if (activity.role === 'side') {
      for (const [, set] of this.sideByParent) {
        if (set.delete(from)) set.add(file)
      }
      if (activity.parentKey) {
        activity.parentKey = this.canonical(activity.parentKey)
      }
    } else if (migrateIdentity) {
      const boundSides = this.sideByParent.get(from)
      if (boundSides) {
        this.sideByParent.delete(from)
        const nextSet = this.sideByParent.get(file) ?? new Set<string>()
        for (const sideKey of boundSides) {
          const canonSide = this.canonical(sideKey)
          nextSet.add(canonSide)
          const sideRuntime = this.runtimes.get(canonSide)
          const sideActivity = sideRuntime && this.activity.get(sideRuntime)
          if (sideActivity) sideActivity.parentKey = file
        }
        if (nextSet.size > 0) this.sideByParent.set(file, nextSet)
      }
    }
    this.gate.retarget(from, file)
    this.interprocessGate?.retargetOwner(from, file)
    const releaseRetry = this.cwdReleaseRetries.get(from)
    if (releaseRetry) {
      this.cwdReleaseRetries.delete(from)
      releaseRetry.ownerId = file
      this.cwdReleaseRetries.set(file, releaseRetry)
    }
    const releasingCount = this.releasingOwners.get(from)
    if (releasingCount) {
      this.releasingOwners.delete(from)
      this.releasingOwners.set(file, (this.releasingOwners.get(file) ?? 0) + releasingCount)
    }
    for (const token of this.releasingCwds) {
      if (token.ownerId === from) token.ownerId = file
    }
    if (this.approvals.has(from)) {
      this.approvals.delete(from)
      this.approvals.add(file)
    }
    this.clearWarm(from)
    this.scheduleWarm(file)
    if (migrateIdentity) {
      for (const jobs of this.queued.values()) {
        for (const job of jobs) {
          if (job.key === from) job.key = file
        }
      }
    } else {
      // The original conversation still owns these requests after a branch.
      this.dropQueued(from)
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
    this.clearAliasesForTarget(id)
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
    const key = canonicalSessionFile(file)
    const held = this.sessionFileLocks.get(key)
    if (held) {
      if (held.ownerId === ownerId) return held
      throw new SessionFileLockError('This conversation is already open in another Pi Desktop process.')
    }
    if (!existsSync(file) && (!path.isAbsolute(file) || !existsSync(path.dirname(file)))) return undefined

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

  private setAlias(alias: string, target: string): void {
    const previous = this.aliases.get(alias)
    if (previous === target) return
    if (previous) {
      const previousAliases = this.aliasesByTarget.get(previous)
      previousAliases?.delete(alias)
      if (previousAliases?.size === 0) this.aliasesByTarget.delete(previous)
    }
    this.aliases.set(alias, target)
    const targetAliases = this.aliasesByTarget.get(target) ?? new Set<string>()
    targetAliases.add(alias)
    this.aliasesByTarget.set(target, targetAliases)
  }

  private clearAliasesForTarget(target: string): void {
    const pending = [target]
    const cleared = new Set<string>()
    while (pending.length > 0) {
      const current = pending.pop()!
      if (cleared.has(current)) continue
      cleared.add(current)
      const aliases = this.aliasesByTarget.get(current)
      this.aliasesByTarget.delete(current)
      if (!aliases) continue
      for (const alias of aliases) {
        if (this.aliases.get(alias) === current) this.aliases.delete(alias)
        pending.push(alias)
      }
    }
  }

  private scheduleWarm(key: string): void {
    this.clearWarm(key)
    const timer = setTimeout(() => {
      // The id may have moved from `draft:…` to a JSONL path since the timer
      // was armed. Follow that alias, and never retire a session that is
      // writing or waiting on the user.
      const id = this.canonical(key)
      this.warmTimers.delete(key)
      if (this.gate.holds(id) || this.approvals.has(id) || [...this.queued.values()].some(jobs => jobs.some(job => this.canonical(job.key) === id))) return
      const runtime = this.runtimes.get(id)
      if (!runtime?.isRunning || this.activity.get(runtime)?.changingSession) return
      void this.stop(id).catch((error) => {
        console.error('[pi-desktop] could not retire an idle Pi process:', error)
      })
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

  private hasQueuedJobs(key: string): boolean {
    const id = this.canonical(key)
    for (const jobs of this.queued.values()) {
      for (const job of jobs) {
        if (this.canonical(job.key) === id) return true
      }
    }
    return false
  }

  private isRuntimeIdle(id: string, runtime: ManagedSessionRuntime): boolean {
    if (!runtime.isRunning) return false
    const activity = this.activity.get(runtime)
    if (!activity) return false
    if (
      activity.running || activity.writes > 0 || activity.stopping ||
      activity.finalizing || activity.binding || activity.changingSession
    ) return false
    const canon = this.canonical(id)
    const owner = this.canonical(activity.ownerId)
    if (this.gate.holds(canon) || this.gate.holds(owner)) return false
    if (this.approvals.has(canon) || this.approvals.has(owner)) return false
    if (this.hasQueuedJobs(canon) || this.hasQueuedJobs(owner)) return false
    return true
  }

  private pruneIdleRuntimes(excludeId?: string): void {
    if (this.shuttingDown || this.cliUpgradeInProgress) return
    const idle: { id: string; lastAccessed: number; prewarmOnly: boolean }[] = []
    const seenRuntimes = new Set<ManagedSessionRuntime>()
    const protectedIds = new Set<string>()
    if (excludeId) {
      protectedIds.add(excludeId)
      protectedIds.add(this.canonical(excludeId))
      for (const peerKey of this.pairedKeysOf(excludeId)) {
        protectedIds.add(peerKey)
      }
    }

    for (const [id, runtime] of this.runtimes) {
      if (seenRuntimes.has(runtime)) continue
      seenRuntimes.add(runtime)
      if (this.isRuntimeIdle(id, runtime)) {
        const activity = this.activity.get(runtime)
        idle.push({
          id,
          lastAccessed: activity?.lastAccessed ?? 0,
          prewarmOnly: Boolean(activity?.prewarmOnly)
        })
      } else {
        for (const peerKey of this.pairedKeysOf(id)) {
          protectedIds.add(peerKey)
        }
      }
    }

    if (idle.length <= MAX_IDLE_RUNTIMES) return

    // Evict speculative prewarmed idle runtimes before user-activated sessions.
    idle.sort((a, b) => {
      if (a.prewarmOnly !== b.prewarmOnly) return a.prewarmOnly ? -1 : 1
      return a.lastAccessed - b.lastAccessed
    })

    const excess = idle.length - MAX_IDLE_RUNTIMES
    let evicted = 0
    for (const candidate of idle) {
      if (evicted >= excess) break
      const canon = this.canonical(candidate.id)
      if (protectedIds.has(candidate.id) || protectedIds.has(canon)) {
        continue
      }
      if (this.starting.has(canon) || this.starting.has(candidate.id)) continue
      evicted++
      void this.stop(candidate.id).catch((error) => {
        console.error('[pi-desktop] could not retire LRU idle Pi process:', error)
      })
    }
  }
}

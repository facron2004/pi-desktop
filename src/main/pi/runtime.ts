import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  ExtensionUiResponse,
  ExtensionUiRequest,
  PermissionMode,
  PiEvent,
  PiState,
  RpcTraceHint,
  RuntimeStartOptions,
  RuntimeStatus
} from '@shared/types'
import { resolvePiLaunch } from './locate'
import { PiRpcClient } from './rpc-client'
import { buildRpcArgs } from './rpc-args'
import { canAutoApprove, parseToolApproval, permissionExtension } from './permissions'
import { ensurePatientRetrySettings, rememberDefaultModel, rememberDefaultThinkingLevel } from './retry-policy'
import { taskModesExtension } from './task-modes'
import { providerControlsExtension } from './provider-controls'
import {
  allowlistedEnv,
  callerFrames,
  emitTrace,
  readTraceHint,
  redactArgv,
  rpcTraceEnabled,
  sessionObservation,
  shouldProbeState,
  type RpcOutboundMeta
} from './trace'

export interface RuntimeOptions {
  customPiPath?: string
  /** Trust project-local configuration such as `.pi/settings.json`. */
  trustProject?: boolean
  getPermissionMode?: () => PermissionMode
}

/**
 * Owns one Pi child process for one conversation.
 *
 * The supervisor holds one of these per hot session. Viewing another
 * conversation does not call `switch_session` and does not stop this process.
 * `start` only replaces the child that belongs to this instance.
 */
export class PiRuntime extends EventEmitter {
  private client: PiRpcClient | null = null
  private status: RuntimeStatus = { phase: 'stopped' }
  private pendingApprovalId?: string
  private pendingUiRequestId?: string
  private aborting = false
  /** Bumped on every start and stop so a superseded launch cannot publish status. */
  private generation = 0
  /** Scripts written for one process, removed once that process has exited. */
  private scratch = new Map<PiRpcClient, string[]>()
  /** Epoch captured at spawn. `dispose` runs after `generation` has already moved on. */
  private epochs = new WeakMap<PiRpcClient, number>()
  /**
   * Last identity `get_state` reported for this process.
   * Command traces quote it as "before"; it is not a catalog of every session.
   */
  private observed: { sessionId?: string; sessionFile?: string; isStreaming?: boolean } = {}
  private readonly tracing: boolean

  constructor(private readonly options: RuntimeOptions = {}) {
    super()
    this.tracing = rpcTraceEnabled(process.env, app.isPackaged)
  }

  get currentStatus(): RuntimeStatus {
    return { ...this.status }
  }

  get isRunning(): boolean {
    return this.client?.running ?? false
  }

  async start(options: RuntimeStartOptions): Promise<{ ok: boolean; error?: string }> {
    const generation = ++this.generation
    const trace = readTraceHint(options.trace)
    this.observed = {}
    this.pendingApprovalId = undefined
    this.aborting = false
    // "starting" goes out before the old process is touched. Waiting for it
    // to exit, and publishing "stopped" while we wait, is the flash of
    // "Lost connection" on every project switch.
    this.setStatus({ phase: 'starting', cwd: options.cwd })
    const previous = this.client
    this.client = null
    if (previous) await this.dispose(previous)
    if (generation !== this.generation) return { ok: false }

    const launch = resolvePiLaunch(this.options.customPiPath)
    if (launch.source === 'none') {
      const error =
        'Could not find the Pi CLI. Install it with "npm i -g @earendil-works/pi-coding-agent" or set a custom path in Settings.'
      if (generation !== this.generation) return { ok: false }
      this.setStatus({ phase: 'error', cwd: options.cwd, error })
      return { ok: false, error }
    }

    // A session that was deleted while the app was closed cannot be opened.
    const sessionFile =
      options.sessionFile && existsSync(options.sessionFile) ? options.sessionFile : undefined

    // A fresh path per process. Reusing one file makes the new launch wait
    // until the process that still has it open — the one we just retired —
    // lets go of it, which on Windows is the whole shutdown.
    const scratchId = randomUUID()
    const userData = app.getPath('userData')
    const customInstructionsFile = path.join(userData, `pi-desktop-instructions-${scratchId}.md`)
    const permissionFile = path.join(userData, `pi-desktop-permissions-${scratchId}.mjs`)
    const modeFile = path.join(userData, `pi-desktop-task-modes-${scratchId}.mjs`)
    const providerFile = path.join(userData, `pi-desktop-providers-${scratchId}.mjs`)
    const permissionTitle = `pi-desktop-permissions-${scratchId}`
    const files: string[] = []
    try {
      mkdirSync(userData, { recursive: true })
      files.push(permissionFile, modeFile, providerFile)
      writeFileSync(permissionFile, permissionExtension(permissionTitle), 'utf8')
      writeFileSync(modeFile, taskModesExtension(), 'utf8')
      writeFileSync(providerFile, providerControlsExtension(), 'utf8')
      if (options.customInstructions?.trim()) {
        files.push(customInstructionsFile)
        writeFileSync(customInstructionsFile, options.customInstructions.trim(), 'utf8')
      }
    } catch (error) {
      this.deleteFiles(files)
      if (generation !== this.generation) return { ok: false }
      const message = `Could not prepare runtime configuration: ${error instanceof Error ? error.message : String(error)}`
      this.setStatus({ phase: 'error', cwd: options.cwd, error: message })
      return { ok: false, error: message }
    }

    const args = [
      ...launch.prefixArgs,
      ...buildRpcArgs(
        { ...options, sessionFile },
        this.options.trustProject,
        options.customInstructions?.trim() ? customInstructionsFile : undefined,
        permissionFile,
        modeFile,
        providerFile
      )
    ]

    // A 429 has to outlast the provider's rate window. Pi reads the budget
    // once, when this process starts, so it has to be in place before launch.
    try {
      ensurePatientRetrySettings()
      rememberDefaultModel(options.model)
      rememberDefaultThinkingLevel(options.thinkingLevel)
    } catch {
      /* an unreadable settings file keeps Pi's own budget and model */
    }

    const traceOn = this.tracing
    const client = new PiRpcClient({
      command: launch.command,
      args,
      cwd: options.cwd,
      env: launch.env,
      onBoot: traceOn
        ? (info) => {
            emitTrace({
              kind: 'boot',
              at: info.at,
              runtimeEpoch: generation,
              pid: info.pid,
              executablePath: info.executablePath,
              argv: redactArgv(info.argv),
              cwd: info.cwd,
              envKeyAllowlist: allowlistedEnv(launch.env),
              uiSessionId: trace?.uiSessionId,
              requestedSessionPath: options.sessionFile,
              sourceAction: trace?.sourceAction
            })
          }
        : undefined,
      onCommand: traceOn ? (info) => emitTrace(info) : undefined
    })
    this.epochs.set(client, generation)

    let permissionsReady = false
    let modesReady = false
    this.aborting = false
    client.on('event', (event: PiEvent) => {
      // A newer launch owns the wire. This process is only still exiting.
      if (this.generation !== generation) return
      if (event.type === 'agent_start') this.aborting = false
      if (event.type === 'agent_settled') {
        this.pendingApprovalId = undefined
        this.pendingUiRequestId = undefined
      }
      if (event.type === 'extension_ui_request') {
        const request = event as unknown as ExtensionUiRequest
        if (request.method === 'setStatus' && request.statusKey === 'pi-desktop-mode') modesReady = true
        if (request.method === 'setStatus' && request.statusKey === permissionTitle) {
          permissionsReady = request.statusText === 'ready'
          return
        }
        if (request.method === 'confirm' && request.title === permissionTitle) {
          const approval = parseToolApproval(request.message)
          if (!approval || this.aborting) {
            client.respondUi(request.id, { confirmed: false })
            return
          }
          const mode = this.options.getPermissionMode?.() ?? 'ask'
          if (mode === 'full' || (mode === 'auto' && canAutoApprove(approval, options.cwd))) {
            client.respondUi(request.id, { confirmed: true })
            return
          }
          this.pendingApprovalId = request.id
          this.emit('event', {
            ...request,
            title: 'Approve tool operation?',
            message: 'Pi is waiting for your approval before running this tool.',
            approval
          })
          return
        }
        if (['select', 'confirm', 'input', 'editor'].includes(request.method)) {
          if (this.aborting) {
            client.respondUi(request.id, { confirmed: false, cancelled: true }, this.outbound('extension-ui-cancel'))
            return
          }
          this.pendingUiRequestId = request.id
        }
      }
      this.emit('event', event)
    })
    client.on('stderr', (line: string) => this.emit('stderr', line))
    client.on('protocol-error', (payload: { line: string }) => {
      this.emit('event', {
        type: 'client_notice',
        level: 'warn',
        text: `Unparsable record from pi: ${payload.line.slice(0, 200)}`
      })
    })
    this.scratch.set(client, files)
    client.on('error', (error: Error) => {
      if (this.generation !== generation || this.client !== client) return
      this.setStatus({ phase: 'error', cwd: options.cwd, error: error.message })
    })
    client.on('exit', ({ code, signal, pid }: { code: number | null; signal: string | null; pid?: number }) => {
      if (this.tracing) {
        const ownsWire = this.client === client && this.generation === generation
        emitTrace({
          kind: 'exit',
          at: Date.now(),
          runtimeEpoch: generation,
          pid,
          code,
          signal,
          // A replaced process exiting is not the live runtime dying.
          current: ownsWire
        })
      }
      // A client that was replaced or stopped on purpose exits on purpose.
      if (this.client !== client || this.generation !== generation) return
      // Still coming up: the failed request below reports the error.
      // Publishing "stopped" here is what the UI reads as a lost connection.
      if (this.status.phase === 'starting') return
      this.setStatus({
        phase: 'stopped',
        cwd: options.cwd,
        error:
          code === 0
            ? undefined
            : describeExit(client.stderrTail, code, signal)
      })
    })

    try {
      client.start()
      if (generation !== this.generation) {
        void this.dispose(client)
        return { ok: false }
      }
      this.client = client
      const state = await client.request<PiState>(
        { type: 'get_state' },
        30_000,
        this.outbound(trace?.sourceAction ?? 'runtime-start', trace)
      )
      this.observe(state)
      // A newer start may have replaced this client while it was coming up.
      if (generation !== this.generation || this.client !== client) return { ok: false }
      if (!permissionsReady) throw new Error('Pi did not load its tool approval controls. Restart the runtime to try again.')
      if (!modesReady) throw new Error('Pi did not load its task mode controls. Restart the runtime to try again.')
      if (generation !== this.generation || this.client !== client) return { ok: false }
      this.setStatus({
        phase: 'ready',
        cwd: options.cwd,
        sessionFile: state?.sessionFile,
        sessionId: state?.sessionId
      })
      return { ok: true }
    } catch (error) {
      // The client was replaced while it was starting: the newer one owns
      // the status now, so this failure is not worth reporting.
      if (generation !== this.generation || (this.client !== null && this.client !== client)) {
        return { ok: false }
      }
      const message = error instanceof Error ? error.message : String(error)
      // Pi usually explains itself on stderr before it gives up.
      const tail = client.stderrTail
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-2)
      if (this.client === client) this.client = null
      await this.dispose(client)
      if (generation !== this.generation) return { ok: false }
      this.setStatus({
        phase: 'error',
        cwd: options.cwd,
        error: tail.length > 0 ? `${message}: ${tail.join(' ')}` : message
      })
      return { ok: false, error: this.status.error }
    }
  }

  async request<T = unknown>(
    command: string,
    payload: Record<string, unknown> = {},
    timeoutMs = 30_000,
    trace?: RpcTraceHint
  ): Promise<T> {
    if (!this.client || !this.client.running) {
      throw new Error('Pi is not running. Open a workspace to start a session.')
    }
    if (command === 'abort' || command === 'abort_retry') {
      this.aborting = true
      if (this.pendingApprovalId) {
        this.client.respondUi(this.pendingApprovalId, { confirmed: false }, this.outbound('approval-cancel', trace))
        this.pendingApprovalId = undefined
      }
      if (this.pendingUiRequestId) {
        this.client.respondUi(this.pendingUiRequestId, { confirmed: false, cancelled: true }, this.outbound('extension-ui-cancel', trace))
        this.pendingUiRequestId = undefined
      }
    }
    const hint = readTraceHint(trace)
    const result = await this.client.request<T>(
      { type: command, ...payload },
      timeoutMs,
      this.outbound(hint?.sourceAction ?? command, hint, command)
    )
    if (command === 'get_state') this.observe(result)
    if (this.tracing && shouldProbeState(command) && hint?.sourceAction !== 'state-probe') {
      await this.probeAfter(command)
    }
    return result
  }

  /**
   * Answer a blocking extension dialog so the agent can continue.
   * Silently ignored when the runtime is already gone.
   */
  respondUi(id: string, response: ExtensionUiResponse): void {
    if (id === this.pendingApprovalId) this.pendingApprovalId = undefined
    if (id === this.pendingUiRequestId) this.pendingUiRequestId = undefined
    this.client?.respondUi(id, response, this.outbound('extension-ui-response'))
  }

  hasPendingUi(id: string): boolean {
    return this.pendingApprovalId === id || this.pendingUiRequestId === id
  }

  async stop(): Promise<void> {
    const generation = ++this.generation
    if (this.pendingApprovalId && this.client?.running) {
      try {
        this.client.respondUi(this.pendingApprovalId, { confirmed: false }, this.outbound('approval-cancel'))
      } catch {
        /* client closing */
      }
    }
    if (this.pendingUiRequestId && this.client?.running) {
      try {
        this.client.respondUi(this.pendingUiRequestId, { confirmed: false, cancelled: true }, this.outbound('extension-ui-cancel'))
      } catch {
        /* client closing */
      }
    }
    this.pendingApprovalId = undefined
    this.pendingUiRequestId = undefined
    const client = this.client
    this.client = null
    if (client) await this.dispose(client)
    // A start() that began while this process was exiting owns the status now.
    if (this.generation !== generation) return
    this.setStatus({ phase: 'stopped' })
  }

  /**
   * Drop a process without telling the UI it disconnected.
   *
   * Listeners come off first: Pi keeps writing for a moment after it is
   * asked to stop, and that must not land on the project that replaced it.
   */
  private async dispose(client: PiRpcClient): Promise<void> {
    if (this.tracing) {
      // Listeners come off before the process exits, so the exit trace below
      // never sees an intentional stop. Record that stop here instead.
      emitTrace({
        kind: 'shutdown',
        at: Date.now(),
        runtimeEpoch: this.epochs.get(client),
        pid: client.pid,
        reason: 'dispose'
      })
    }
    this.epochs.delete(client)
    this.detach(client)
    const files = this.scratch.get(client)
    this.scratch.delete(client)
    await client.stop()
    this.deleteFiles(files ?? [])
    this.deleteFiles(LEGACY_RUNTIME_FILES.map((name) => path.join(app.getPath('userData'), name)))
  }

  private detach(client: PiRpcClient): void {
    client.removeAllListeners('event')
    client.removeAllListeners('stderr')
    client.removeAllListeners('protocol-error')
    client.removeAllListeners('error')
    client.removeAllListeners('exit')
  }

  private deleteFiles(files: string[]): void {
    for (const file of files) {
      try {
        if (existsSync(file)) unlinkSync(file)
      } catch {
        // The process may still be releasing the file. Nothing reads it again.
      }
    }
  }

  private setStatus(status: RuntimeStatus): void {
    this.status = status
    this.emit('status', status)
  }

  private observe(state: unknown): void {
    const next = sessionObservation(state)
    if (next.sessionId || next.sessionFile || next.isStreaming !== undefined) this.observed = next
  }

  /** Identity attached to one outbound record. Caller frames only for session mutations. */
  private outbound(sourceAction: string, trace?: RpcTraceHint, command?: string): RpcOutboundMeta {
    const hint = readTraceHint(trace)
    return {
      sourceAction: hint?.sourceAction ?? sourceAction,
      uiSessionId: hint?.uiSessionId,
      beforePiSessionId: this.observed.sessionId,
      beforePiSessionFile: this.observed.sessionFile,
      runtimeEpoch: this.generation,
      ...(this.tracing && command && shouldProbeState(command)
        ? { caller: callerFrames(new Error().stack) }
        : {})
    }
  }

  /**
   * Ask the live process who it is after a session mutation.
   *
   * The probe is a diagnostic `get_state`, not a switch. A failure here must
   * not fail the command that already completed.
   */
  private async probeAfter(command: string): Promise<void> {
    const client = this.client
    if (!client?.running) return
    try {
      const state = await client.request<PiState>({ type: 'get_state' }, 10_000, {
        sourceAction: 'state-probe',
        runtimeEpoch: this.generation,
        beforePiSessionId: this.observed.sessionId,
        beforePiSessionFile: this.observed.sessionFile
      })
      this.observe(state)
      const observed = sessionObservation(state)
      emitTrace({
        kind: 'state_probe',
        at: Date.now(),
        afterCommand: command,
        runtimeEpoch: this.generation,
        pid: client.pid,
        ok: true,
        ...observed
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'state probe failed'
      emitTrace({
        kind: 'state_probe',
        at: Date.now(),
        afterCommand: command,
        runtimeEpoch: this.generation,
        pid: client.pid,
        ok: false,
        error: message.slice(0, 200)
      })
    }
  }
}

/**
 * Explain why Pi stopped.
 *
 * The exit code alone is useless; the diagnostics Pi wrote to stderr say what
 * actually went wrong, so the last few lines are passed on to the UI.
 */
/** The fixed names older builds wrote. Removed once the process that held them has exited. */
const LEGACY_RUNTIME_FILES = [
  'pi-desktop-instructions.md',
  'pi-desktop-permissions.mjs',
  'pi-desktop-task-modes.mjs',
  'pi-desktop-providers.mjs'
]

function describeExit(stderr: string[], code: number | null, signal: string | null): string {
  const tail = stderr
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
  const reason = `pi stopped unexpectedly (code ${code}, signal ${signal})`
  return tail.length > 0 ? `${reason}: ${tail.join(' ')}` : reason
}

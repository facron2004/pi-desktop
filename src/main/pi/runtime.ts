import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveSessionFilePath, resolveSessionRoots } from '../sessions'
import {
  SUBAGENT_EDITOR_CANCEL_STATUS_KEY,
  SUBAGENT_EDITOR_PENDING_STATUS_KEY
} from '@shared/types'
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
import { prepareLaunchAgentSettings } from './retry-policy'
import { taskModesExtension } from './task-modes'
import { subagentExtension } from './subagent'
import { swarmExtension } from './swarm'
import type { AgentPreset } from './agents'
import { computerUseExtension } from './computer-use'
import { imageToolExtension } from './image-tool'
import { contextBreakdownExtension } from './context-breakdown'
import { generationTimingExtension } from './generation-timing'
import { mermaidPolicyExtension } from './mermaid'
import { providerControlsExtension } from './provider-controls'
import { workspaceToolsExtension } from './workspace-tools'
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
  getCustomPiPath?: () => string | undefined
  getSessionRoots?: () => readonly string[]
  getSessionDir?: (cwd: string) => string | undefined
  /** Trust project-local configuration such as `.pi/settings.json`. */
  trustProject?: boolean
  getTrustProject?: () => boolean
  getPermissionMode?: () => PermissionMode
  /** Read at process start. A later Settings change reaches a live process by command. */
  getComputerUse?: () => boolean
  /**
   * Read at process start, and only used for a session Pi has never written:
   * a conversation that exists keeps the mode its own entries recorded.
   */
  getDefaultPlanMode?: () => boolean
  /**
   * Model and thinking level for a subagent whose tool call names neither.
   * Read when the extension is generated; empty follows the dispatching session.
   */
  getSubagentModel?: () => { model?: string; thinking?: string }
  /**
   * Named agent presets readable from the workspace. Read when the extension
   * is generated, so a preset file change reaches the next conversation, not a
   * live one — the same lifecycle every other baked default has.
   */
  getAgentPresets?: (cwd: string) => AgentPreset[]
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
  private pendingApprovalIds = new Set<string>()
  private pendingUiRequestIds = new Set<string>()
  private pendingSubagentEditor?: { token: string; requestId?: string; cancelled: boolean }
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

  get pid(): number | undefined {
    return this.client?.pid
  }

  async start(options: RuntimeStartOptions): Promise<{ ok: boolean; error?: string }> {
    const generation = ++this.generation
    const trace = readTraceHint(options.trace)
    this.observed = {}
    this.pendingApprovalIds.clear()
    this.pendingUiRequestIds.clear()
    this.pendingSubagentEditor = undefined
    this.aborting = false
    // "starting" goes out before the old process is touched. Waiting for it
    // to exit, and publishing "stopped" while we wait, is the flash of
    // "Lost connection" on every project switch.
    this.setStatus({ phase: 'starting', cwd: options.cwd })
    const previous = this.client
    this.client = null
    if (previous) await this.dispose(previous)
    if (generation !== this.generation) return { ok: false }

    // The IPC check can go stale while the supervisor acquires the writer lock.
    let sessionFile: string | undefined
    if (options.sessionFile !== undefined) {
      const verified = await resolveSessionFilePath(
        options.sessionFile,
        this.options.getSessionRoots?.() ?? resolveSessionRoots()
      )
      if (!verified || verified !== options.sessionFile) {
        const error = 'Conversation file changed before Pi could reopen it.'
        if (generation !== this.generation) return { ok: false }
        this.setStatus({ phase: 'error', cwd: options.cwd, error })
        return { ok: false, error }
      }
      sessionFile = verified
    }

    const customPiPath = this.options.getCustomPiPath ? this.options.getCustomPiPath() : this.options.customPiPath
    const trustProject = this.options.getTrustProject ? this.options.getTrustProject() : this.options.trustProject === true

    const launch = resolvePiLaunch(customPiPath)
    if (launch.source === 'none') {
      const error =
        'Could not find the Pi CLI. Install it with "npm i -g @earendil-works/pi-coding-agent" or set a custom path in Settings.'
      if (generation !== this.generation) return { ok: false }
      this.setStatus({ phase: 'error', cwd: options.cwd, error })
      return { ok: false, error }
    }

    // A fresh path per process. Reusing one file makes the new launch wait
    // until the process that still has it open — the one we just retired —
    // lets go of it, which on Windows is the whole shutdown.
    const scratchId = randomUUID()
    const userData = app.getPath('userData')
    const expectedStaticFiles = staticExtensionPaths(userData)
    const customInstructionsFile = path.join(userData, `pi-desktop-instructions-${scratchId}.md`)
    const permissionFile = path.join(userData, `pi-desktop-permissions-${scratchId}.mjs`)
    const subagentPermissionFile = path.join(userData, `pi-desktop-subagent-permissions-${scratchId}.mjs`)
    const subagentToolsFile = path.join(userData, `pi-desktop-workspace-tools-${scratchId}.mjs`)
    const modeFile = path.join(userData, `pi-desktop-task-modes-${scratchId}.mjs`)
    const subagentFile = path.join(userData, `pi-desktop-subagent-${scratchId}.mjs`)
    const swarmFile = path.join(userData, `pi-desktop-swarm-${scratchId}.mjs`)
    const permissionTitle = `pi-desktop-permissions-${scratchId}`
    const files: string[] = []
    let staticFiles: StaticExtensionFilePaths
    try {
      await mkdir(userData, { recursive: true })
      files.push(permissionFile, subagentPermissionFile, subagentToolsFile, modeFile, subagentFile, swarmFile)
      // `sessionFile` is undefined exactly when Pi has nothing to resume, so this
      // is the one moment "a brand-new conversation starts in Plan Mode" is true.
      const defaultMode =
        !sessionFile && this.options.getDefaultPlanMode?.() === true ? 'plan' : 'default'
      const [resolvedStaticFiles] = await Promise.all([
        ensureStaticExtensionFiles(userData),
        (async () => {
          const writes: [string, string][] = [
            [
              permissionFile,
              permissionExtension(
                permissionTitle,
                true,
                modeFile,
                swarmFile,
                expectedStaticFiles.computer,
                expectedStaticFiles.image
              )
            ],
            [subagentPermissionFile, permissionExtension(permissionTitle, false)],
            [subagentToolsFile, workspaceToolsExtension()],
            [modeFile, taskModesExtension(this.options.getComputerUse?.() === true, defaultMode, modeFile)],
            [
              subagentFile,
              subagentExtension(
                this.options.getSubagentModel?.() ?? {},
                subagentPermissionFile,
                permissionTitle,
                trustProject,
                { command: launch.command, prefixArgs: launch.prefixArgs },
                // Named agent presets are project data, not Settings, but they cross
                // the same boundary: read here once per process, verified and bounded
                // by the loader, so the generated extension never re-opens a file.
                this.options.getAgentPresets?.(options.cwd) ?? [],
                subagentToolsFile
              )
            ],
            [
              swarmFile,
              swarmExtension({
                permissionExtensionPath: subagentPermissionFile,
                permissionTitle,
                trustProject,
                fallbackInvocation: { command: launch.command, prefixArgs: launch.prefixArgs },
                workspaceToolsExtensionPath: subagentToolsFile
              })
            ]
          ]
          if (options.customInstructions?.trim()) {
            files.push(customInstructionsFile)
            writes.push([customInstructionsFile, options.customInstructions.trim()])
          }
          for (const filePath of files) activeScratchEntries.add(path.basename(filePath))
          await Promise.all(writes.map(([filePath, content]) => writeFile(filePath, content, 'utf8')))
        })()
      ])
      staticFiles = resolvedStaticFiles
    } catch (error) {
      await this.deleteFiles(files)
      if (generation !== this.generation) return { ok: false }
      const message = `Could not prepare runtime configuration: ${error instanceof Error ? error.message : String(error)}`
      this.setStatus({ phase: 'error', cwd: options.cwd, error: message })
      return { ok: false, error: message }
    }
    if (generation !== this.generation) {
      await this.deleteFiles(files)
      return { ok: false }
    }

    const args = [
      ...launch.prefixArgs,
      ...buildRpcArgs(
        { ...options, sessionFile },
        trustProject,
        options.customInstructions?.trim() ? customInstructionsFile : undefined,
        permissionFile,
        modeFile,
        staticFiles.provider,
        subagentFile,
        staticFiles.computer,
        staticFiles.contextBreakdown,
        staticFiles.generationTiming,
        staticFiles.mermaid,
        staticFiles.image,
        swarmFile
      )
    ]
    const sessionDir = this.options.getSessionDir?.(options.cwd)?.trim()
    if (sessionDir) args.push('--session-dir', path.resolve(sessionDir))

    // A 429 has to outlast the provider's rate window. Pi reads the budget
    // once, when this process starts, so it has to be in place before launch.
    try {
      await prepareLaunchAgentSettings({
        model: options.model,
        thinkingLevel: options.thinkingLevel,
        rememberDefaults: options.rememberDefaults
      })
    } catch {
      /* an unreadable settings file keeps Pi's own budget and model */
    }
    if (generation !== this.generation) {
      await this.deleteFiles(files)
      return { ok: false }
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
        this.pendingApprovalIds.clear()
        this.pendingUiRequestIds.clear()
        this.pendingSubagentEditor = undefined
      }
      let cancelSubagentEditorRequestId: string | undefined
      if (event.type === 'extension_ui_request') {
        const request = event as unknown as ExtensionUiRequest
        if (request.method === 'setStatus' && request.statusKey === 'pi-desktop-mode') modesReady = true
        if (request.method === 'setStatus' && request.statusKey === SUBAGENT_EDITOR_PENDING_STATUS_KEY) {
          const token = typeof request.statusText === 'string' && request.statusText
            ? request.statusText
            : undefined
          if (token) this.pendingSubagentEditor = { token, cancelled: false }
          else if (this.pendingSubagentEditor && !this.pendingSubagentEditor.requestId) {
            this.pendingSubagentEditor = undefined
          }
          return
        }
        if (request.method === 'setStatus' && request.statusKey === SUBAGENT_EDITOR_CANCEL_STATUS_KEY) {
          const pending = this.pendingSubagentEditor
          if (pending && pending.token === request.statusText) {
            pending.cancelled = true
            if (pending.requestId) {
              this.emit('event', {
                ...request,
                statusText: JSON.stringify({ requestId: pending.requestId })
              })
            }
          }
          return
        }
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
          if (mode === 'full' || (mode === 'auto' && canAutoApprove(approval, options.cwd, launch.env))) {
            client.respondUi(request.id, { confirmed: true })
            return
          }
          this.pendingApprovalIds.add(request.id)
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
            this.pendingSubagentEditor = undefined
            client.respondUi(request.id, { confirmed: false, cancelled: true }, this.outbound('extension-ui-cancel'))
            return
          }
          if (request.method === 'editor' && this.pendingSubagentEditor && !this.pendingSubagentEditor.requestId) {
            this.pendingSubagentEditor.requestId = request.id
            if (this.pendingSubagentEditor.cancelled) cancelSubagentEditorRequestId = request.id
          }
          this.pendingUiRequestIds.add(request.id)
        }
      }
      this.emit('event', event)
      if (cancelSubagentEditorRequestId) {
        this.emit('event', {
          ...event,
          method: 'setStatus',
          statusKey: SUBAGENT_EDITOR_CANCEL_STATUS_KEY,
          statusText: JSON.stringify({ requestId: cancelSubagentEditorRequestId })
        })
      }
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
      this.pendingApprovalIds.clear()
      this.pendingUiRequestIds.clear()
      this.pendingSubagentEditor = undefined
      this.setStatus({
        phase: 'stopped',
        cwd: options.cwd,
        error:
          code === 0
            ? undefined
            : describeExit(client.stderrTail, code, signal)
      }, true)
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
    if (command === 'extension_ui_response') {
      throw new Error('Extension UI responses must use runtime:respondUi.')
    }
    if (!this.client || !this.client.running) {
      throw new Error('Pi is not running. Open a workspace to start a session.')
    }
    if (command === 'abort' || command === 'abort_retry') {
      this.aborting = true
      for (const id of this.pendingApprovalIds) {
        this.client.respondUi(id, { confirmed: false }, this.outbound('approval-cancel', trace))
      }
      this.pendingApprovalIds.clear()
      for (const id of this.pendingUiRequestIds) {
        this.client.respondUi(id, { confirmed: false, cancelled: true }, this.outbound('extension-ui-cancel', trace))
      }
      this.pendingUiRequestIds.clear()
      this.pendingSubagentEditor = undefined
    }
    const hint = readTraceHint(trace)
    const request: Record<string, unknown> & { type: string; id?: string } = {
      ...payload,
      type: command
    }
    delete request.id
    const result = await this.client.request<T>(
      request,
      timeoutMs,
      this.outbound(hint?.sourceAction ?? command, hint, command)
    ).catch((error: unknown) => {
      // The flag exists to auto-reject dialogs while an abort is in flight.
      // An abort that never reached Pi leaves the run alive, and keeping the
      // flag would silently reject every later approval for the rest of it.
      if (command === 'abort' || command === 'abort_retry') this.aborting = false
      throw error
    })
    if (command === 'get_state') this.observe(result)
    if (this.tracing && shouldProbeState(command) && hint?.sourceAction !== 'state-probe' && hint?.sourceAction !== 'shutdown-abort') {
      await this.probeAfter(command)
    }
    return result
  }

  /**
   * Answer a blocking extension dialog so the agent can continue.
   * Silently ignored when the runtime is already gone.
   */
  respondUi(id: string, response: ExtensionUiResponse): void {
    this.pendingApprovalIds.delete(id)
    if (this.pendingUiRequestIds.delete(id)) {
      if (this.pendingSubagentEditor?.requestId === id) this.pendingSubagentEditor = undefined
    }
    this.client?.respondUi(id, response, this.outbound('extension-ui-response'))
  }

  hasPendingUi(id: string): boolean {
    return this.pendingApprovalIds.has(id) || this.pendingUiRequestIds.has(id)
  }

  hasAnyPendingUi(): boolean {
    return this.pendingApprovalIds.size > 0 || this.pendingUiRequestIds.size > 0
  }

  async stop(): Promise<void> {
    const generation = ++this.generation
    if (this.client?.running) {
      for (const id of this.pendingApprovalIds) {
        try {
          this.client.respondUi(id, { confirmed: false }, this.outbound('approval-cancel'))
        } catch {
          /* client closing */
        }
      }
      for (const id of this.pendingUiRequestIds) {
        try {
          this.client.respondUi(id, { confirmed: false, cancelled: true }, this.outbound('extension-ui-cancel'))
        } catch {
          /* client closing */
        }
      }
    }
    this.pendingApprovalIds.clear()
    this.pendingUiRequestIds.clear()
    this.pendingSubagentEditor = undefined
    const client = this.client
    this.client = null
    if (client) await this.dispose(client)
    // A start() that began while this process was exiting owns the status now.
    if (this.generation !== generation) return
    // Retirement after an unexpected exit keeps the diagnostics already reported.
    if (this.status.phase !== 'stopped') this.setStatus({ phase: 'stopped' })
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
    await this.deleteFiles(files ?? [])
    if (!legacyRuntimeFilesCleaned) {
      legacyRuntimeFilesCleaned = true
      await this.deleteFiles(LEGACY_RUNTIME_FILES.map((name) => path.join(app.getPath('userData'), name)))
    }
  }

  private detach(client: PiRpcClient): void {
    client.removeAllListeners('event')
    client.removeAllListeners('stderr')
    client.removeAllListeners('protocol-error')
    client.removeAllListeners('error')
    client.removeAllListeners('exit')
  }

  private async deleteFiles(files: string[]): Promise<void> {
    if (files.length === 0) return
    await Promise.all(
      files.map((file) =>
        unlink(file)
          .catch(() => {
            // The process may still be releasing the file, or it was already removed.
          })
          .finally(() => {
            activeScratchEntries.delete(path.basename(file))
          })
      )
    )
  }

  private setStatus(status: RuntimeStatus, processExited = false): void {
    this.status = status
    this.emit('status', status, processExited)
  }

  private observe(state: unknown): void {
    const next = sessionObservation(state)
    if (next.sessionId || next.sessionFile || next.isStreaming !== undefined) this.observed = next
    if (this.status.phase === 'ready' && state && typeof state === 'object') {
      const record = state as { sessionFile?: unknown; sessionId?: unknown }
      const hasFile = 'sessionFile' in record
      const hasId = 'sessionId' in record
      if (hasFile || hasId) {
        const sessionFile = hasFile ? next.sessionFile : this.status.sessionFile
        const sessionId = hasId ? next.sessionId : this.status.sessionId
        if (sessionFile !== this.status.sessionFile || sessionId !== this.status.sessionId) {
          this.status = { ...this.status, sessionFile, sessionId }
        }
      }
    }
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
  'pi-desktop-providers.mjs',
  'pi-desktop-subagent.mjs'
]
let legacyRuntimeFilesCleaned = false

interface StaticExtensionSources {
  provider: string
  computer: string
  image: string
  contextBreakdown: string
  generationTiming: string
  mermaid: string
}

interface StaticExtensionFilePaths {
  dir: string
  provider: string
  computer: string
  image: string
  contextBreakdown: string
  generationTiming: string
  mermaid: string
}

const STATIC_EXT_DIR_PREFIX = 'pi-desktop-ext-'
const PROCESS_STATIC_DIR_NAME = `${STATIC_EXT_DIR_PREFIX}${process.pid}-${randomUUID().slice(0, 8)}`
const activeScratchEntries = new Set<string>([PROCESS_STATIC_DIR_NAME])
const staticExtensionInFlight = new Map<string, Promise<StaticExtensionFilePaths>>()
const staticExtensionSettled = new Map<string, StaticExtensionFilePaths>()
const staticExtensionDirs = new Set<string>()
let staticExtensionSources: StaticExtensionSources | undefined

function getStaticExtensionSources(): StaticExtensionSources {
  if (!staticExtensionSources) {
    staticExtensionSources = {
      provider: providerControlsExtension(),
      computer: computerUseExtension(),
      image: imageToolExtension(),
      contextBreakdown: contextBreakdownExtension(),
      generationTiming: generationTimingExtension(),
      mermaid: mermaidPolicyExtension()
    }
  }
  return staticExtensionSources
}

function staticExtensionPaths(userData: string): StaticExtensionFilePaths {
  const dir = path.join(userData, PROCESS_STATIC_DIR_NAME)
  return {
    dir,
    provider: path.join(dir, 'pi-desktop-providers.mjs'),
    computer: path.join(dir, 'pi-desktop-computer.mjs'),
    image: path.join(dir, 'pi-desktop-image.mjs'),
    contextBreakdown: path.join(dir, 'pi-desktop-context-breakdown.mjs'),
    generationTiming: path.join(dir, 'pi-desktop-generation-timing.mjs'),
    mermaid: path.join(dir, 'pi-desktop-mermaid.mjs')
  }
}

function allStaticExtensionFilesExist(paths: StaticExtensionFilePaths): boolean {
  return (
    existsSync(paths.provider) &&
    existsSync(paths.computer) &&
    existsSync(paths.image) &&
    existsSync(paths.contextBreakdown) &&
    existsSync(paths.generationTiming) &&
    existsSync(paths.mermaid)
  )
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  const temp = `${target}.${randomUUID()}.tmp`
  try {
    await writeFile(temp, content, 'utf8')
    await rename(temp, target)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

export async function ensureStaticExtensionFiles(userData: string): Promise<StaticExtensionFilePaths> {
  const paths = staticExtensionPaths(userData)
  const { dir } = paths

  // Coalesce concurrent startups unconditionally while a write is in flight so
  // two launches never race to truncate and overwrite the same static files.
  const inFlight = staticExtensionInFlight.get(dir)
  if (inFlight) return inFlight

  const settled = staticExtensionSettled.get(dir)
  if (settled && allStaticExtensionFilesExist(settled)) return settled

  const task = (async () => {
    const sources = getStaticExtensionSources()
    await mkdir(dir, { recursive: true })
    staticExtensionDirs.add(dir)
    await Promise.all([
      writeFileAtomic(paths.provider, sources.provider),
      writeFileAtomic(paths.computer, sources.computer),
      writeFileAtomic(paths.image, sources.image),
      writeFileAtomic(paths.contextBreakdown, sources.contextBreakdown),
      writeFileAtomic(paths.generationTiming, sources.generationTiming),
      writeFileAtomic(paths.mermaid, sources.mermaid)
    ])
    staticExtensionSettled.set(dir, paths)
    return paths
  })().finally(() => {
    if (staticExtensionInFlight.get(dir) === task) staticExtensionInFlight.delete(dir)
  })
  staticExtensionInFlight.set(dir, task)
  return task
}

export function isActiveRuntimeScratchEntry(name: string): boolean {
  return activeScratchEntries.has(name)
}

export async function cleanupStaticExtensionCache(): Promise<void> {
  const dirs = [...staticExtensionDirs]
  staticExtensionDirs.clear()
  staticExtensionInFlight.clear()
  staticExtensionSettled.clear()
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => {})))
}

function describeExit(stderr: string[], code: number | null, signal: string | null): string {
  const tail = stderr
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
  const reason = `pi stopped unexpectedly (code ${code}, signal ${signal})`
  return tail.length > 0 ? `${reason}: ${tail.join(' ')}` : reason
}

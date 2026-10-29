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
  RuntimeStartOptions,
  RuntimeStatus
} from '@shared/types'
import { resolvePiLaunch } from './locate'
import { PiRpcClient } from './rpc-client'
import { canAutoApprove, parseToolApproval, permissionExtension } from './permissions'
import { ensurePatientRetrySettings } from './retry-policy'
import { taskModesExtension } from './task-modes'
import { providerControlsExtension } from './provider-controls'

export interface RuntimeOptions {
  customPiPath?: string
  /** Trust project-local configuration such as `.pi/settings.json`. */
  trustProject?: boolean
  getPermissionMode?: () => PermissionMode
}

/**
 * Owns the Pi child process for the currently open workspace.
 *
 * One process per workspace keeps Pi's own "sessions are grouped by working
 * directory" model intact while still allowing the UI to switch between
 * conversations with the `switch_session` command.
 *
 * Switching projects replaces that process. The replacement is a handoff,
 * not a disconnect: `stopped` is what the UI reads as a lost connection, and
 * a switch the user asked for is not one. The next process boots while the
 * previous one exits.
 */
export class PiRuntime extends EventEmitter {
  private client: PiRpcClient | null = null
  private status: RuntimeStatus = { phase: 'stopped' }
  private pendingApprovalId?: string
  private aborting = false
  /** Bumped on every start and stop so a superseded launch cannot publish status. */
  private generation = 0
  /** Scripts written for one process, removed once that process has exited. */
  private scratch = new Map<PiRpcClient, string[]>()

  constructor(private readonly options: RuntimeOptions = {}) {
    super()
  }

  get currentStatus(): RuntimeStatus {
    return { ...this.status }
  }

  get isRunning(): boolean {
    return this.client?.running ?? false
  }

  async start(options: RuntimeStartOptions): Promise<{ ok: boolean; error?: string }> {
    const generation = ++this.generation
    this.pendingApprovalId = undefined
    this.aborting = false
    // "starting" goes out before the old process is touched. Waiting for it
    // to exit, and publishing "stopped" while we wait, is the flash of
    // "Lost connection" on every project switch.
    this.setStatus({ phase: 'starting', cwd: options.cwd })
    const previous = this.client
    this.client = null
    if (previous) void this.dispose(previous)

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
    } catch {
      /* an unreadable settings file keeps Pi's own budget */
    }

    const client = new PiRpcClient({
      command: launch.command,
      args,
      cwd: options.cwd,
      env: launch.env
    })

    let permissionsReady = false
    let modesReady = false
    this.aborting = false
    client.on('event', (event: PiEvent) => {
      // A newer launch owns the wire. This process is only still exiting.
      if (this.generation !== generation) return
      if (event.type === 'agent_start') this.aborting = false
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
    client.on('exit', ({ code, signal }: { code: number | null; signal: string | null }) => {
      // A client that was replaced or stopped on purpose exits on purpose.
      if (this.client !== client || this.generation !== generation) return
      // Still coming up: the failed request below reports the error.
      // Publishing "stopped" here is what the UI reads as a lost connection.
      if (this.status.phase === 'starting') return
      this.setStatus({
        phase: 'stopped',
        cwd: options.cwd,
        error:
          code === 0 || signal === null
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
      const state = await client.request<PiState>({ type: 'get_state' }, 30_000)
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
    timeoutMs = 30_000
  ): Promise<T> {
    if (!this.client || !this.client.running) {
      throw new Error('Pi is not running. Open a workspace to start a session.')
    }
    if (command === 'abort' || command === 'abort_retry') {
      this.aborting = true
      if (this.pendingApprovalId) {
        this.client.respondUi(this.pendingApprovalId, { confirmed: false })
        this.pendingApprovalId = undefined
      }
    }
    return this.client.request<T>({ type: command, ...payload }, timeoutMs)
  }

  /**
   * Answer a blocking extension dialog so the agent can continue.
   * Silently ignored when the runtime is already gone.
   */
  respondUi(id: string, response: ExtensionUiResponse): void {
    if (id === this.pendingApprovalId) this.pendingApprovalId = undefined
    this.client?.respondUi(id, response)
  }

  async stop(): Promise<void> {
    const generation = ++this.generation
    this.pendingApprovalId = undefined
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

/** CLI flags for RPC mode, derived from the requested start options. */
export function buildRpcArgs(
  options: RuntimeStartOptions,
  trustProject = true,
  customInstructionsFile?: string,
  permissionFile?: string,
  modeFile?: string,
  providerFile?: string
): string[] {
  const args = ['--mode', 'rpc']
  if (providerFile) args.push('--extension', providerFile)
  if (modeFile) args.push('--extension', modeFile)
  if (permissionFile) args.push('--extension', permissionFile)
  if (options.sessionFile) {
    args.push('--session', options.sessionFile)
  }
  if (options.model) {
    args.push('--model', options.model)
  }
  if (options.thinkingLevel) {
    args.push('--thinking', options.thinkingLevel)
  }
  if (customInstructionsFile) {
    args.push('--append-system-prompt', customInstructionsFile)
  }
  // Project-local extensions, skills and settings are trust-gated. RPC mode
  // has nobody to ask, so the choice has to be made up front.
  args.push(trustProject ? '--approve' : '--no-approve')
  return args
}

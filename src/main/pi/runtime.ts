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
 */
export class PiRuntime extends EventEmitter {
  private client: PiRpcClient | null = null
  private status: RuntimeStatus = { phase: 'stopped' }
  private pendingApprovalId?: string
  private aborting = false

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
    await this.stop()

    const launch = resolvePiLaunch(this.options.customPiPath)
    if (launch.source === 'none') {
      const error =
        'Could not find the Pi CLI. Install it with "npm i -g @earendil-works/pi-coding-agent" or set a custom path in Settings.'
      this.setStatus({ phase: 'error', cwd: options.cwd, error })
      return { ok: false, error }
    }

    // A session that was deleted while the app was closed cannot be opened.
    const sessionFile =
      options.sessionFile && existsSync(options.sessionFile) ? options.sessionFile : undefined

    const customInstructionsFile = path.join(app.getPath('userData'), 'pi-desktop-instructions.md')
    const permissionFile = path.join(app.getPath('userData'), 'pi-desktop-permissions.mjs')
    const modeFile = path.join(app.getPath('userData'), 'pi-desktop-task-modes.mjs')
    const providerFile = path.join(app.getPath('userData'), 'pi-desktop-providers.mjs')
    const permissionTitle = `pi-desktop-permissions-${randomUUID()}`
    try {
      mkdirSync(path.dirname(permissionFile), { recursive: true })
      writeFileSync(permissionFile, permissionExtension(permissionTitle), 'utf8')
      writeFileSync(modeFile, taskModesExtension(), 'utf8')
      writeFileSync(providerFile, providerControlsExtension(), 'utf8')
      if (options.customInstructions?.trim()) {
        mkdirSync(path.dirname(customInstructionsFile), { recursive: true })
        writeFileSync(customInstructionsFile, options.customInstructions.trim(), 'utf8')
      } else if (existsSync(customInstructionsFile)) {
        unlinkSync(customInstructionsFile)
      }
    } catch (error) {
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

    this.setStatus({ phase: 'starting', cwd: options.cwd })

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
    client.on('error', (error: Error) => {
      this.setStatus({ phase: 'error', cwd: options.cwd, error: error.message })
    })
    client.on('exit', ({ code, signal }: { code: number | null; signal: string | null }) => {
      // A client that was replaced or stopped on purpose exits on purpose.
      if (this.client !== client) return
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
      this.client = client
      const state = await client.request<PiState>({ type: 'get_state' }, 30_000)
      // A newer start may have replaced this client while it was coming up.
      if (this.client !== client) return { ok: false }
      if (!permissionsReady) throw new Error('Pi did not load its tool approval controls. Restart the runtime to try again.')
      if (!modesReady) throw new Error('Pi did not load its task mode controls. Restart the runtime to try again.')
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
      if (this.client !== client) return { ok: false }
      const message = error instanceof Error ? error.message : String(error)
      await this.stop()
      // Pi usually explains itself on stderr before it gives up.
      const tail = client.stderrTail
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-2)
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
    this.pendingApprovalId = undefined
    const client = this.client
    this.client = null
    if (client) {
      // Pi can still emit records while it shuts down. Detach the forwarders
      // first so late output never reaches a window that may be closing.
      client.removeAllListeners('event')
      client.removeAllListeners('stderr')
      client.removeAllListeners('exit')
      await client.stop()
    }
    this.setStatus({ phase: 'stopped' })
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

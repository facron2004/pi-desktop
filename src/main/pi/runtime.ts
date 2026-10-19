import { EventEmitter } from 'node:events'
import type { PiEvent, PiState, RuntimeStartOptions, RuntimeStatus } from '@shared/types'
import { resolvePiLaunch } from './locate'
import { PiRpcClient } from './rpc-client'

export interface RuntimeOptions {
  customPiPath?: string
  /** Trust project-local configuration such as `.pi/settings.json`. */
  trustProject?: boolean
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

    const args = [...launch.prefixArgs, ...buildRpcArgs(options)]

    this.setStatus({ phase: 'starting', cwd: options.cwd })

    const client = new PiRpcClient({
      command: launch.command,
      args,
      cwd: options.cwd,
      env: launch.env
    })

    client.on('event', (event: PiEvent) => this.emit('event', event))
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
      this.setStatus({
        phase: 'stopped',
        cwd: options.cwd,
        error:
          code === 0 || signal === null
            ? undefined
            : `pi stopped unexpectedly (code ${code}, signal ${signal})`
      })
    })

    try {
      client.start()
      this.client = client
      const state = await client.request<PiState>({ type: 'get_state' }, 30_000)
      this.setStatus({
        phase: 'ready',
        cwd: options.cwd,
        sessionFile: state?.sessionFile,
        sessionId: state?.sessionId
      })
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.stop()
      this.setStatus({ phase: 'error', cwd: options.cwd, error: message })
      return { ok: false, error: message }
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
    return this.client.request<T>({ type: command, ...payload }, timeoutMs)
  }

  async stop(): Promise<void> {
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

/** CLI flags for RPC mode, derived from the requested start options. */
export function buildRpcArgs(options: RuntimeStartOptions): string[] {
  const args = ['--mode', 'rpc']
  if (options.sessionFile) {
    args.push('--session', options.sessionFile)
  }
  if (options.model) {
    args.push('--model', options.model)
  }
  if (options.thinkingLevel) {
    args.push('--thinking', options.thinkingLevel)
  }
  return args
}

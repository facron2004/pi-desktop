import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type * as pty from 'node-pty'
import {
  MAX_TERMINAL_SESSIONS,
  type TerminalCreateOptions,
  type TerminalSessionInfo
} from '@shared/types'
import { resolveShellSpec } from './shell'
import { canonicalPath } from './pi/session-file'
import { assertTerminalWorkingDirectory } from './terminal-path'
import { isPathWithin } from './workspace-files'

const MAX_COLS = 500
const MAX_ROWS = 300
const OUTPUT_HIGH_WATER_BYTES = 256 * 1024
const OUTPUT_LOW_WATER_BYTES = 64 * 1024
const OUTPUT_HIGH_WATER_CHUNKS = 1024
const OUTPUT_LOW_WATER_CHUNKS = 256
const TERMINAL_TREE_KILL_TIMEOUT_MS = 5_000

interface Session {
  process: pty.IPty
  cwd: string
  realCwd: string
  shell: string
  nextOutputSequence: number
  pendingOutput: Map<number, number>
  pendingOutputBytes: number
  outputPaused: boolean
  closing: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)))
}

function stopWindowsTerminalTree(pid: number): Promise<boolean> {
  const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
  return new Promise(resolve => {
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      timeout: TERMINAL_TREE_KILL_TIMEOUT_MS
    }, error => resolve(!error))
  })
}

/**
 * One real shell process per terminal view.
 *
 * The old terminal was a command runner over Pi's `bash` RPC: it could print
 * output but had no prompt, no cwd and no interactivity. A terminal is a PTY,
 * so it gets its own process and a byte stream, and the renderer only forwards
 * keystrokes and paints the output.
 */
export class TerminalManager {
  private readonly sessions = new Map<string, Session>()
  // Shell exit removes the session before native cleanup can finish.
  private readonly pendingStops = new Map<string, { session: Session; done: Promise<void> }>()
  private readonly closingCwds = new Map<string, number>()
  private disposal?: Promise<void>

  constructor(
    private readonly send: (channel: string, payload: unknown) => void,
    private readonly spawn: typeof pty.spawn,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly stopWindowsTree = stopWindowsTerminalTree
  ) {}

  create(options: TerminalCreateOptions): TerminalSessionInfo {
    if (this.sessions.size >= MAX_TERMINAL_SESSIONS) {
      throw new Error('Maximum number of terminals reached')
    }
    const cwd = options.cwd?.trim() || process.cwd()
    assertTerminalWorkingDirectory(cwd)
    const realCwd = canonicalPath(cwd)
    for (const root of this.closingCwds.keys()) {
      if (isPathWithin(root, realCwd)) throw new Error('Working folder is being closed.')
    }
    const shell = resolveShellSpec(options.shell)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'

    const spawnOptions: pty.IPtyForkOptions = {
      name: 'xterm-256color',
      cols: clamp(options.cols, 2, MAX_COLS),
      rows: clamp(options.rows, 2, MAX_ROWS),
      cwd,
      env
    }
    let processHandle: pty.IPty
    try {
      processHandle = this.spawn(shell.file, shell.args, spawnOptions)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Some supported Windows builds cannot create ConPTY even though the
      // bundled Winpty backend still works. Retry that specific startup failure
      // once; permission, cwd and shell errors must not spawn a second process.
      if (this.platform !== 'win32' || !/cannot launch conpty/i.test(message)) throw error
      console.warn('[pi-desktop] ConPTY is unavailable; starting this terminal with Winpty')
      processHandle = this.spawn(shell.file, shell.args, { ...spawnOptions, useConpty: false })
    }
    const id = randomUUID()
    const session: Session = {
      process: processHandle,
      cwd,
      realCwd,
      shell: shell.label,
      nextOutputSequence: 0,
      pendingOutput: new Map(),
      pendingOutputBytes: 0,
      outputPaused: false,
      closing: false
    }
    this.sessions.set(id, session)

    processHandle.onData((data) => {
      if (session.closing || this.sessions.get(id) !== session) return
      const sequence = ++session.nextOutputSequence
      const bytes = Buffer.byteLength(data, 'utf8')
      session.pendingOutput.set(sequence, bytes)
      session.pendingOutputBytes += bytes
      this.send('terminal:data', { id, data, sequence })
      if (
        !session.outputPaused &&
        (session.pendingOutputBytes >= OUTPUT_HIGH_WATER_BYTES ||
          session.pendingOutput.size >= OUTPUT_HIGH_WATER_CHUNKS)
      ) {
        session.outputPaused = true
        try {
          processHandle.pause()
        } catch {
          session.outputPaused = false
        }
      }
    })
    processHandle.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id)
      this.send('terminal:exit', { id, exitCode, signal })
    })

    return { id, pid: processHandle.pid, shell: shell.label, cwd }
  }

  write(id: string, data: string): boolean {
    const session = this.sessions.get(id)
    if (!session || session.closing || typeof data !== 'string') return false
    try {
      session.process.write(data)
      return true
    } catch {
      return false
    }
  }

  acknowledgeOutput(id: string, sequence: number): void {
    const session = this.sessions.get(id)
    if (!session || session.closing) return
    const bytes = session.pendingOutput.get(sequence)
    if (bytes === undefined) return
    session.pendingOutput.delete(sequence)
    session.pendingOutputBytes -= bytes
    if (
      session.outputPaused &&
      session.pendingOutputBytes <= OUTPUT_LOW_WATER_BYTES &&
      session.pendingOutput.size <= OUTPUT_LOW_WATER_CHUNKS
    ) {
      session.outputPaused = false
      try {
        session.process.resume()
      } catch {
        /* the shell may have exited between output and acknowledgement */
      }
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session || session.closing) return
    try {
      session.process.resize(clamp(cols, 2, MAX_COLS), clamp(rows, 2, MAX_ROWS))
    } catch {
      /* a resize after exit is harmless */
    }
  }

  kill(id: string): Promise<void> {
    const pendingStop = this.pendingStops.get(id)
    if (pendingStop) return pendingStop.done
    const session = this.sessions.get(id)
    if (!session) return Promise.resolve()
    session.closing = true
    const stopTask = Promise.resolve().then(async () => {
      const pid = session.process.pid
      // Close the tree while its shell still exists. ConPTY's own cleanup
      // only sees processes attached to the same console.
      const treeStopped = this.platform === 'win32' && Number.isSafeInteger(pid) && pid > 0
        ? await this.stopWindowsTree(pid).catch(() => false)
        : false
      // Release the native PTY unconditionally. The exit event removes the
      // session from the map the moment the shell dies — which is exactly
      // what the taskkill above just did — and the native handle and its
      // conout worker are only released through this call. Session ids are
      // UUIDs, so an entry gone from the map means "already exited", never
      // "replaced by a new session".
      try {
        // Also the fallback if taskkill failed.
        session.process.kill()
      } catch (error) {
        if (!treeStopped && this.sessions.get(id) === session) {
          // Keep the handle for a later cleanup pass if neither attempt worked.
          console.warn('[pi-desktop] failed to close terminal:', error)
          return
        }
      }
      this.sessions.delete(id)
    }).finally(() => {
      this.pendingStops.delete(id)
    })
    this.pendingStops.set(id, { session, done: stopTask })
    return stopTask
  }

  async waitForDisposal(): Promise<void> {
    const disposal = this.disposal
    await disposal
    if (disposal !== this.disposal) throw new Error('The terminal view was replaced before the shell could open.')

    const closing = new Set(this.pendingStops.keys())
    for (const [id, session] of this.sessions) {
      if (session.closing) closing.add(id)
    }
    if (closing.size === 0) return
    await this.finishClosing([...closing])
    if (disposal !== this.disposal) throw new Error('The terminal view was replaced before the shell could open.')
  }

  disposeAll(): Promise<void> {
    const ids = [...new Set([...this.sessions.keys(), ...this.pendingStops.keys()])]
    const disposal = this.disposeSessions(ids)
    // Report a failed disposal to its caller; a later terminal open can retry
    // the retained handles through waitForDisposal.
    this.disposal = disposal.catch(() => {})
    return disposal
  }

  disposeCwd(cwd: string): Promise<void> {
    const realRoot = canonicalPath(cwd)
    const sessions = new Map(this.sessions)
    for (const [id, { session }] of this.pendingStops) sessions.set(id, session)
    const ids: string[] = []
    for (const [id, session] of sessions) {
      if (isPathWithin(cwd, session.cwd) || isPathWithin(realRoot, session.realCwd)) ids.push(id)
    }
    return this.disposeSessions(ids)
  }

  async withCwdClosed<T>(cwd: string, action: () => Promise<T>): Promise<T> {
    const root = canonicalPath(cwd)
    this.closingCwds.set(root, (this.closingCwds.get(root) ?? 0) + 1)
    try {
      await this.disposeCwd(cwd)
      return await action()
    } finally {
      const count = this.closingCwds.get(root) ?? 0
      if (count <= 1) this.closingCwds.delete(root)
      else this.closingCwds.set(root, count - 1)
    }
  }

  private async disposeSessions(ids: string[]): Promise<void> {
    await Promise.all(ids.map(id => this.kill(id)))
    await this.finishClosing(ids)
  }

  private async finishClosing(ids: string[]): Promise<void> {
    await Promise.all(ids.map(id => this.kill(id)))
    if (ids.some(id => this.sessions.has(id))) {
      throw new Error('Could not close a previous terminal. Try again.')
    }
  }
}


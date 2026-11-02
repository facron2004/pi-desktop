import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import * as pty from 'node-pty'
import type { TerminalCreateOptions, TerminalSessionInfo } from '@shared/types'
import { resolveShellSpec } from './shell'

const MAX_COLS = 500
const MAX_ROWS = 300

interface Session {
  process: pty.IPty
  cwd: string
  shell: string
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(Number.isFinite(value) ? value : min)))
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

  constructor(private readonly send: (channel: string, payload: unknown) => void) {}

  create(options: TerminalCreateOptions): TerminalSessionInfo {
    const cwd = options.cwd?.trim() || process.cwd()
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })
    const shell = resolveShellSpec(options.shell)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'

    const processHandle = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: clamp(options.cols, 2, MAX_COLS),
      rows: clamp(options.rows, 2, MAX_ROWS),
      cwd,
      env
    })
    const id = randomUUID()
    this.sessions.set(id, { process: processHandle, cwd, shell: shell.label })

    processHandle.onData((data) => {
      this.send('terminal:data', { id, data })
    })
    processHandle.onExit(({ exitCode, signal }) => {
      this.sessions.delete(id)
      this.send('terminal:exit', { id, exitCode, signal })
    })

    return { id, pid: processHandle.pid, shell: shell.label, cwd }
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session || typeof data !== 'string') return
    try {
      session.process.write(data)
    } catch {
      /* the shell may have exited between the keystroke and this write */
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id)
    if (!session) return
    try {
      session.process.resize(clamp(cols, 2, MAX_COLS), clamp(rows, 2, MAX_ROWS))
    } catch {
      /* a resize after exit is harmless */
    }
  }

  kill(id: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    try {
      session.process.kill()
    } catch {
      /* already gone */
    }
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}


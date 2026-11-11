import { randomUUID } from 'node:crypto'
import type * as pty from 'node-pty'
import {
  MAX_TERMINAL_SESSIONS,
  type TerminalCreateOptions,
  type TerminalSessionInfo
} from '@shared/types'
import { resolveShellSpec } from './shell'
import { assertTerminalWorkingDirectory } from './terminal-path'

const MAX_COLS = 500
const MAX_ROWS = 300
const OUTPUT_HIGH_WATER_BYTES = 256 * 1024
const OUTPUT_LOW_WATER_BYTES = 64 * 1024
const OUTPUT_HIGH_WATER_CHUNKS = 1024
const OUTPUT_LOW_WATER_CHUNKS = 256

interface Session {
  process: pty.IPty
  cwd: string
  shell: string
  nextOutputSequence: number
  pendingOutput: Map<number, number>
  pendingOutputBytes: number
  outputPaused: boolean
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

  constructor(
    private readonly send: (channel: string, payload: unknown) => void,
    private readonly spawn: typeof pty.spawn
  ) {}

  create(options: TerminalCreateOptions): TerminalSessionInfo {
    if (this.sessions.size >= MAX_TERMINAL_SESSIONS) {
      throw new Error('Maximum number of terminals reached')
    }
    const cwd = options.cwd?.trim() || process.cwd()
    assertTerminalWorkingDirectory(cwd)
    const shell = resolveShellSpec(options.shell)
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value === 'string') env[key] = value
    }
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'

    const processHandle = this.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: clamp(options.cols, 2, MAX_COLS),
      rows: clamp(options.rows, 2, MAX_ROWS),
      cwd,
      env
    })
    const id = randomUUID()
    const session: Session = {
      process: processHandle,
      cwd,
      shell: shell.label,
      nextOutputSequence: 0,
      pendingOutput: new Map(),
      pendingOutputBytes: 0,
      outputPaused: false
    }
    this.sessions.set(id, session)

    processHandle.onData((data) => {
      if (this.sessions.get(id) !== session) return
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

  write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session || typeof data !== 'string') return
    try {
      session.process.write(data)
    } catch {
      /* the shell may have exited between the keystroke and this write */
    }
  }

  acknowledgeOutput(id: string, sequence: number): void {
    const session = this.sessions.get(id)
    if (!session) return
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


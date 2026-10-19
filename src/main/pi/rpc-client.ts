import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import type { ExtensionUiResponse, PiEvent, RpcResponse } from '@shared/types'

export interface RpcRequest {
  type: string
  id?: string
  [key: string]: unknown
}

export interface PiRpcClientOptions {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer?: NodeJS.Timeout
}

const LF = 0x0a
const CR = 0x0d
const MAX_STDERR_LINES = 200

/**
 * JSONL client for Pi's RPC mode.
 *
 * Framing rules taken from the Pi protocol docs:
 *  - one JSON object per record, terminated by LF
 *  - records must only be split on LF; U+2028 / U+2029 are valid inside JSON
 *    strings, so `readline` must not be used
 *  - an optional CR before the LF is stripped
 *  - stdout carries protocol records only, stderr carries diagnostics
 */
export class PiRpcClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly decoder = new StringDecoder('utf8')
  private buffer: Buffer = Buffer.alloc(0)
  private pending = new Map<string, Pending>()
  private sequence = 0
  private writeQueue: string[] = []
  private draining = false
  private closed = false
  private readonly stderrLines: string[] = []

  constructor(private readonly options: PiRpcClientOptions) {
    super()
  }

  get stderrTail(): string[] {
    return [...this.stderrLines]
  }

  get running(): boolean {
    return this.child !== null && !this.closed
  }

  start(): void {
    if (this.child) return
    const { command, args, cwd, env } = this.options
    this.child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.closed = false

    this.child.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
    this.child.stderr.on('data', (chunk: Buffer) => {
      const text = this.decoder.write(chunk)
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        this.stderrLines.push(line)
        if (this.stderrLines.length > MAX_STDERR_LINES) this.stderrLines.shift()
        this.emit('stderr', line)
      }
    })

    this.child.on('error', (error) => {
      this.failAll(new Error(`Failed to start pi: ${error.message}`))
      this.emit('error', error)
    })

    this.child.on('exit', (code, signal) => {
      this.closed = true
      this.child = null
      this.failAll(new Error(`pi exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`))
      this.emit('exit', { code, signal })
    })
  }

  /** Stop the child: close stdin for an orderly shutdown, then force kill. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.closed = true
    try {
      child.stdin.end()
    } catch {
      /* the pipe may already be gone */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        resolve()
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.kill('SIGTERM')
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    this.child = null
  }

  /**
   * Send a command and wait for its correlated response.
   * Commands that can legitimately take a long time (bash, compaction) pass
   * `timeoutMs: 0` to disable the deadline.
   */
  request<T = unknown>(request: RpcRequest, timeoutMs = 30_000): Promise<T> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error('pi process is not running'))
    }
    const id = request.id ?? `pi-${++this.sequence}`
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve: resolve as (v: unknown) => void, reject }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`Timed out waiting for "${request.type}" response`))
          }
        }, timeoutMs)
      }
      this.pending.set(id, entry)
      this.write({ ...request, id })
    })
  }

  /** Fire-and-forget command (no response expected). */
  notify(request: RpcRequest): void {
    this.write(request)
  }

  /**
   * Answer a blocking extension dialog.
   *
   * The record has to carry Pi's own request id, so it is written verbatim
   * instead of going through `request`, which would mint a new id and wait
   * for a response that never comes.
   */
  respondUi(id: string, response: ExtensionUiResponse): void {
    this.write({ type: 'extension_ui_response', id, ...response })
  }

  private write(request: RpcRequest): void {
    const child = this.child
    if (!child || this.closed) return
    const line = `${JSON.stringify(request)}\n`
    this.writeQueue.push(line)
    this.pump()
  }

  private pump(): void {
    const child = this.child
    if (!child || this.draining) return
    while (this.writeQueue.length > 0) {
      const line = this.writeQueue.shift()!
      const flushed = child.stdin.write(line)
      if (!flushed) {
        this.draining = true
        child.stdin.once('drain', () => {
          this.draining = false
          this.pump()
        })
        return
      }
    }
  }

  private consume(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    let index = this.buffer.indexOf(LF)
    while (index !== -1) {
      let line = this.buffer.subarray(0, index)
      this.buffer = this.buffer.subarray(index + 1)
      if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1)
      this.handleLine(line.toString('utf8'))
      index = this.buffer.indexOf(LF)
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return
    let record: PiEvent & Partial<RpcResponse>
    try {
      record = JSON.parse(line)
    } catch (error) {
      this.emit('protocol-error', { line, error })
      return
    }
    if (record?.type === 'response') {
      this.settle(record)
      return
    }
    this.emit('event', record)
  }

  private settle(record: Partial<RpcResponse> & { type: 'response' }): void {
    const id = record.id
    if (!id) {
      // Parse failures and other id-less responses surface as protocol events.
      this.emit('event', { ...record, type: 'protocol_response' })
      return
    }
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    if (record.success) {
      entry.resolve(record.data)
    } else {
      entry.reject(new Error(record.error ?? `pi command "${record.command}" failed`))
    }
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(error)
      this.pending.delete(id)
    }
  }
}

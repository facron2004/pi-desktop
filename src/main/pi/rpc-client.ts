import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import type { ExtensionUiResponse, PiEvent, RpcResponse } from '@shared/types'
import { describeCommand, type RpcCommandTrace, type RpcOutboundMeta } from './trace'

export interface RpcRequest {
  type: string
  id?: string
  [key: string]: unknown
}

export interface RpcBootInfo {
  at: number
  pid?: number
  executablePath: string
  argv: string[]
  cwd: string
}

export interface PiRpcClientOptions {
  command: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  /** Set only while development tracing is on. Sees the spawn that just happened. */
  onBoot?: (info: RpcBootInfo) => void
  /** Set only while development tracing is on. Sees each record about to be written. */
  onCommand?: (info: RpcCommandTrace) => void
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
  private traceSequence = 0
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

  get pid(): number | undefined {
    return this.child?.pid
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
    this.options.onBoot?.({
      at: Date.now(),
      pid: this.child.pid,
      executablePath: command,
      argv: args,
      cwd
    })

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

    this.child.stdin.on('error', (error: Error) => {
      if (this.closed) return
      this.writeQueue = []
      this.failAll(new Error(`Could not write to pi: ${error.message}`))
      if (this.listenerCount('error')) this.emit('error', error)
    })

    this.child.on('error', (error) => {
      this.closed = true
      this.writeQueue = []
      this.failAll(new Error(`Failed to start pi: ${error.message}`))
      if (this.listenerCount('error')) this.emit('error', error)
    })

    // close follows the final stdout bytes; exit can precede their delivery.
    this.child.on('close', (code, signal) => {
      const pid = this.child?.pid
      this.closed = true
      this.child = null
      this.failAll(new Error(`pi exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`))
      this.emit('exit', { code, signal, pid })
    })
  }

  /** Stop the child: close stdin for an orderly shutdown, then force kill. */
  async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    this.closed = true
    this.writeQueue = []
    this.failAll(new Error('pi stopped'))
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
      this.child = null
      return
    }
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL') } catch { /* exit still owns completion */ }
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    try {
      child.stdin.end()
    } catch {
      /* the pipe may already be gone */
    }
    await exited
  }

  /**
   * Send a command and wait for its correlated response.
   * Commands that can legitimately take a long time (bash, compaction) pass
   * `timeoutMs: 0` to disable the deadline.
   */
  request<T = unknown>(request: RpcRequest, timeoutMs = 30_000, meta?: RpcOutboundMeta): Promise<T> {
    if (!this.child || this.closed) {
      this.trace(request, meta, false)
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
      this.write({ ...request, id }, meta)
    })
  }

  /** Fire-and-forget command (no response expected). */
  notify(request: RpcRequest, meta?: RpcOutboundMeta): void {
    this.write(request, meta)
  }

  /**
   * Answer a blocking extension dialog.
   *
   * The record has to carry Pi's own request id, so it is written verbatim
   * instead of going through `request`, which would mint a new id and wait
   * for a response that never comes.
   */
  respondUi(id: string, response: ExtensionUiResponse, meta?: RpcOutboundMeta): void {
    this.write({ type: 'extension_ui_response', id, ...response }, meta)
  }

  private trace(request: RpcRequest, meta: RpcOutboundMeta | undefined, delivered: boolean): void {
    if (!this.options.onCommand) return
    const described = describeCommand(request.type, request)
    this.options.onCommand({
      kind: 'command',
      at: Date.now(),
      traceId: `cmd-${++this.traceSequence}`,
      requestId: typeof request.id === 'string' ? request.id : undefined,
      ...described,
      sourceAction: meta?.sourceAction,
      uiSessionId: meta?.uiSessionId,
      beforePiSessionId: meta?.beforePiSessionId,
      beforePiSessionFile: meta?.beforePiSessionFile,
      runtimeEpoch: meta?.runtimeEpoch ?? 0,
      caller: meta?.caller,
      pid: this.child?.pid,
      delivered
    })
  }

  private write(request: RpcRequest, meta?: RpcOutboundMeta): void {
    const child = this.child
    if (!child || this.closed) {
      this.trace(request, meta, false)
      return
    }
    this.trace(request, meta, true)
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

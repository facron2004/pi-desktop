import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
// Fixed-size pages keep heavily fragmented stdout from creating an unbounded slice list.
const RPC_RECORD_BUFFER_PAGE_BYTES = 64 * 1024
/** A valid image message can exceed 32 MiB after base64 encoding. */
export const MAX_RPC_RECORD_BYTES = 64 * 1024 * 1024

function killProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === 'win32' && child.pid) {
    return new Promise((resolve) => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10_000
      }, () => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL') } catch { /* the process may already have exited */ }
        }
        resolve()
      })
    })
  }

  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    try { child.kill('SIGKILL') } catch { /* the process may already have exited */ }
  }
  return Promise.resolve()
}

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
  private bufferedChunks: Buffer[] = []
  private bufferedBytes = 0
  private bufferedPage: Buffer | null = null
  private bufferedPageBytes = 0
  private discardingOversizedRecord = false
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
      detached: process.platform !== 'win32',
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
      let forcedKill: Promise<void> | undefined
      const timer = setTimeout(() => {
        forcedKill = killProcessTree(child)
      }, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        if (forcedKill) void forcedKill.then(resolve, resolve)
        else resolve()
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
    let start = 0
    if (this.discardingOversizedRecord) {
      const newline = chunk.indexOf(LF)
      if (newline === -1) return
      this.discardingOversizedRecord = false
      start = newline + 1
    }
    let index = chunk.indexOf(LF, start)
    while (index !== -1) {
      const segment = chunk.subarray(start, index)
      if (this.bufferedBytes + segment.length > MAX_RPC_RECORD_BYTES) {
        this.rejectOversizedRecord(false)
        start = index + 1
        index = chunk.indexOf(LF, start)
        continue
      }
      let line: Buffer
      if (this.bufferedBytes === 0) {
        line = segment
      } else {
        this.appendBuffered(segment)
        const chunks = this.bufferedChunks.slice()
        if (this.bufferedPageBytes > 0 && this.bufferedPage) {
          chunks.push(this.bufferedPage.subarray(0, this.bufferedPageBytes))
        }
        line = Buffer.concat(chunks, this.bufferedBytes)
        this.bufferedChunks = []
        this.bufferedBytes = 0
        this.bufferedPageBytes = 0
      }
      if (line.length > 0 && line[line.length - 1] === CR) line = line.subarray(0, line.length - 1)
      this.handleLine(line.toString('utf8'))
      start = index + 1
      index = chunk.indexOf(LF, start)
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start)
      if (this.bufferedBytes + tail.length > MAX_RPC_RECORD_BYTES) {
        this.rejectOversizedRecord(true)
      } else {
        this.appendBuffered(tail)
      }
    }
  }

  private appendBuffered(segment: Buffer): void {
    let offset = 0
    while (offset < segment.length) {
      if (!this.bufferedPage || this.bufferedPageBytes === RPC_RECORD_BUFFER_PAGE_BYTES) {
        if (this.bufferedPage) this.bufferedChunks.push(this.bufferedPage)
        this.bufferedPage = Buffer.allocUnsafe(RPC_RECORD_BUFFER_PAGE_BYTES)
        this.bufferedPageBytes = 0
      }
      const length = Math.min(RPC_RECORD_BUFFER_PAGE_BYTES - this.bufferedPageBytes, segment.length - offset)
      segment.copy(this.bufferedPage, this.bufferedPageBytes, offset, offset + length)
      this.bufferedPageBytes += length
      this.bufferedBytes += length
      offset += length
    }
  }

  private rejectOversizedRecord(discardUntilLf: boolean): void {
    this.bufferedChunks = []
    this.bufferedBytes = 0
    this.bufferedPageBytes = 0
    this.discardingOversizedRecord = discardUntilLf
    this.emit('protocol-error', {
      line: `Pi RPC record exceeded the ${MAX_RPC_RECORD_BYTES}-byte limit`
    })
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

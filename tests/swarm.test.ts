import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { StringDecoder } from 'node:string_decoder'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { Type } from 'typebox'
import { swarmExtension } from '../src/main/pi/swarm'
import { swarmWorkers } from '../src/renderer/src/lib/swarm'
import type { ToolItem } from '../src/renderer/src/lib/thread'

interface ToolResult {
  content: { text: string }[]
  details: { workers: { name: string; status: string }[] }
  isError?: boolean
}

class WorkerProcess extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly requests: Record<string, unknown>[] = []
  readonly stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: (line: string) => this.requests.push(JSON.parse(line))
  })

  emitRecord(event: Record<string, unknown>): void {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`))
  }

  complete(text: string): void {
    this.emitRecord({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } })
    this.emitRecord({ type: 'agent_settled', aborted: false })
  }
}

type ConfirmDialog = (title: string, message: string, options: { signal: AbortSignal }) => Promise<boolean>

function fixture(confirm?: ConfirmDialog) {
  const children: WorkerProcess[] = []
  const killed: number[] = []
  const handlers = new Map<string, () => void>()
  const commands = new Map<string, { handler: (name: string) => Promise<void> }>()
  const tools = new Map<string, {
    name: string
    execute: (id: string, params: object, signal: AbortSignal | undefined, update: undefined, ctx: unknown) => Promise<ToolResult>
  }>()
  const proc = Object.assign(new EventEmitter(), {
    argv: ['node', 'fake-pi'],
    execPath: 'node',
    platform: 'linux',
    kill: (pid: number) => killed.push(-pid)
  })
  const spawn = () => {
    const child = Object.assign(new WorkerProcess(), { pid: children.length + 1 })
    children.push(child)
    return child
  }
  const statuses = new Map<string, string>()
  const ctx = { cwd: process.cwd(), ui: { confirm, setStatus: (key: string, value: string) => statuses.set(key, value) } }
  const source = swarmExtension()
    .replace(/^import .*;$/gm, '')
    .replace('export default function', 'return function')
  const load = new Function('spawn', 'existsSync', 'StringDecoder', 'Type', 'process', source)
  const install = load(spawn, () => true, StringDecoder, Type, proc)
  install({
    on: (name: string, handler: () => void) => handlers.set(name, handler),
    registerCommand: (name: string, command: NonNullable<ReturnType<typeof commands.get>>) => commands.set(name, command),
    registerTool: (tool: NonNullable<ReturnType<typeof tools.get>>) => tools.set(tool.name, tool)
  })
  return {
    children,
    killed,
    handlers,
    proc,
    roster: () => JSON.parse(statuses.get('pi-desktop-swarm') ?? 'null'),
    call: (name: string, params: object, signal?: AbortSignal) => tools.get(`swarm_${name}`)!.execute('call', params, signal, undefined, ctx),
    stop: (name: string) => commands.get('desktop-swarm-stop')!.handler(name)
  }
}

test('collect waits for the running turn and returns its report', async () => {
  const f = fixture()
  await f.call('spawn', { name: 'worker' })
  await f.call('task', { name: 'worker', task: 'Inspect the fixture', wait: false })
  let collected = false
  const pending = f.call('collect', {}).then(result => { collected = true; return result })
  await setImmediate()
  assert.equal(collected, false)

  f.children[0].complete('First report')
  assert.match((await pending).content[0].text, /First report/)
})

test('a retired process cannot settle the replacement worker turn', async () => {
  const f = fixture()
  await f.call('spawn', { name: 'worker' })
  const retired = f.children[0]
  await f.stop('worker')
  const pending = f.call('task', { name: 'worker', task: 'New report' })
  await setImmediate()
  const current = f.children[1]
  assert.equal(current.requests.length, 1)

  retired.complete('Stale report')
  retired.emit('close')
  assert.equal(f.roster()[0].status, 'working')
  current.complete('Current report')
  const result = await pending
  assert.match(result.content[0].text, /Current report/)
  assert.equal(result.isError, false)
})

test('stopping a worker cancels its approval and keeps the reply away from the next process', async () => {
  let approvalSignal: AbortSignal | undefined
  const f = fixture((_title, _message, { signal }) => {
    approvalSignal = signal
    return new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true }))
  })
  await f.call('spawn', { name: 'worker' })
  const retired = f.children[0]
  retired.emitRecord({ type: 'extension_ui_request', method: 'confirm', id: 'old-request', title: 'Confirm' })
  await setImmediate()
  assert.equal(approvalSignal?.aborted, false)

  await f.stop('worker')
  await f.call('task', { name: 'worker', task: 'Next request', wait: false })
  assert.equal(approvalSignal?.aborted, true)
  assert.deepEqual(f.children[1].requests.map(request => request.type), ['prompt'])
})

test('a turn cancelled while waiting for a slot never sends a prompt', async () => {
  const f = fixture()
  for (let index = 0; index < 5; index += 1) await f.call('spawn', { name: `worker-${index}` })
  for (let index = 0; index < 4; index += 1) {
    await f.call('task', { name: `worker-${index}`, task: 'Occupy a slot', wait: false })
  }
  const controller = new AbortController()
  const pending = f.call('task', { name: 'worker-4', task: 'Cancelled request', wait: false }, controller.signal)
  await setImmediate()
  controller.abort()

  assert.equal((await pending).isError, true)
  assert.deepEqual(f.children[4].requests, [])
  f.children[0].complete('Free a slot')
  assert.equal((await f.call('task', { name: 'worker-4', task: 'New request', wait: false })).isError, undefined)
  assert.equal(f.children[4].requests.length, 1)
})

test('disband rejects an invalid name and publishes the empty roster after removal', async () => {
  const f = fixture()
  await f.call('spawn', { name: 'worker' })
  assert.equal((await f.call('disband', { name: 'invalid name' })).isError, true)
  assert.deepEqual(f.killed, [])
  await f.call('disband', { name: 'worker' })
  assert.deepEqual(f.roster(), [])
  assert.deepEqual(f.killed, [1])
})

test('a session shutdown closes workers and removes the exit listener', async () => {
  const f = fixture()
  await f.call('spawn', { name: 'worker' })
  f.handlers.get('session_shutdown')?.()
  assert.deepEqual(f.killed, [1])
  assert.equal(f.proc.listenerCount('exit'), 0)
})

test('a reopened conversation uses the newest complete roster, including removed workers', () => {
  const report = (toolName: string, timestamp: number, finishedAt: number, names: string[]): ToolItem => ({
    id: toolName,
    kind: 'tool',
    toolCallId: toolName,
    toolName,
    args: {},
    status: 'ok',
    timestamp,
    order: timestamp,
    finishedAt,
    details: { workers: names.map(name => ({ name, status: 'idle' })) }
  })
  const initial = report('swarm_spawn', 1, 2, ['worker-a', 'worker-b'])
  const disband = report('swarm_disband', 3, 6, ['worker-b'])
  const earlierResult = report('swarm_status', 4, 5, ['worker-a', 'worker-b'])
  assert.deepEqual(swarmWorkers([initial, disband, earlierResult]).map(worker => worker.name), ['worker-b'])
  assert.deepEqual(swarmWorkers([initial, report('swarm_disband', 3, 6, [])]), [])
})

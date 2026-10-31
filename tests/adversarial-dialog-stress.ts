import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { SessionSupervisor } from '../src/main/pi/supervisor'
import type { ExtensionUiResponse, PiEvent, RuntimeStartOptions, RuntimeStatus } from '../src/shared/types'

class MockManagedRuntime extends EventEmitter {
  running = false
  currentStatus: RuntimeStatus = { phase: 'stopped' }
  approvals: Array<{ id: string; response: ExtensionUiResponse }> = []
  pendingUiIds = new Set<string>()

  get isRunning(): boolean {
    return this.running
  }

  async start(options: RuntimeStartOptions): Promise<{ ok: boolean; error?: string }> {
    this.running = true
    this.currentStatus = { phase: 'ready', cwd: options.cwd, sessionFile: options.sessionFile }
    return { ok: true }
  }

  hasPendingUi(id: string): boolean {
    return this.pendingUiIds.has(id)
  }

  respondUi(id: string, response: ExtensionUiResponse): void {
    this.pendingUiIds.delete(id)
    this.approvals.push({ id, response })
  }

  async request<T = unknown>(_cmd: string, _args: unknown = {}): Promise<T> {
    return { ok: true } as T
  }

  async stop(): Promise<void> {
    this.running = false
    this.pendingUiIds.clear()
    this.currentStatus = { phase: 'stopped', cwd: this.currentStatus.cwd }
    this.emit('status', this.currentStatus)
  }
}

function supervisorOf(runtimes: MockManagedRuntime[]): SessionSupervisor {
  const pending = [...runtimes]
  return new SessionSupervisor(() => {
    const next = pending.shift()
    if (!next) throw new Error('unexpected runtime')
    return next
  })
}

test('BUG REPRODUCTION 1: Stale dialog from stopped session A answered with active session B key steals B approvals', async () => {
  const a = new MockManagedRuntime()
  const b = new MockManagedRuntime()
  const supervisor = supervisorOf([a, b])

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })

  a.pendingUiIds.add('dlg-a')
  a.emit('event', { type: 'extension_ui_request', id: 'dlg-a', method: 'confirm', sessionKey: 'A.jsonl' } as PiEvent)

  b.pendingUiIds.add('dlg-b')
  b.emit('event', { type: 'extension_ui_request', id: 'dlg-b', method: 'confirm', sessionKey: 'B.jsonl' } as PiEvent)

  const approvals = (supervisor as unknown as { approvals: Set<string> }).approvals
  assert.equal(approvals.has('B.jsonl'), true, 'Session B must have pending approval initially')

  // Session A is stopped
  await supervisor.stop('A.jsonl')
  assert.equal(a.isRunning, false)
  assert.equal(b.isRunning, true)
  assert.equal(approvals.has('B.jsonl'), true, 'Session B approval must survive A stop')

  // User is currently viewing Session B in the UI (or viewKeyOf returns B.jsonl)
  // Dialog dlg-a is answered or dismissed from UI: key='B.jsonl', id='dlg-a'
  supervisor.respondUi('B.jsonl', 'dlg-a', { confirmed: false })

  // Session B must NOT have its approval stolen from supervisor.approvals!
  assert.equal(
    approvals.has('B.jsonl'),
    true,
    'CRITICAL VULNERABILITY: Session B approval was stolen by stale dlg-a answered with key=B.jsonl!'
  )
})

test('BUG REPRODUCTION 2: Dialog of active session A answered with key=B.jsonl (cross-session fallback) steals B approvals', async () => {
  const a = new MockManagedRuntime()
  const b = new MockManagedRuntime()
  const supervisor = supervisorOf([a, b])

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })

  a.pendingUiIds.add('dlg-a')
  a.emit('event', { type: 'extension_ui_request', id: 'dlg-a', method: 'confirm', sessionKey: 'A.jsonl' } as PiEvent)

  b.pendingUiIds.add('dlg-b')
  b.emit('event', { type: 'extension_ui_request', id: 'dlg-b', method: 'confirm', sessionKey: 'B.jsonl' } as PiEvent)

  const approvals = (supervisor as unknown as { approvals: Set<string> }).approvals
  assert.equal(approvals.has('A.jsonl'), true)
  assert.equal(approvals.has('B.jsonl'), true)

  // Dialog belongs to A, but user clicked while viewing B, so key passed is 'B.jsonl'
  supervisor.respondUi('B.jsonl', 'dlg-a', { confirmed: true })

  // Dialog was delivered to A
  assert.equal(a.approvals.length, 1)
  assert.equal(a.approvals[0]?.id, 'dlg-a')
  // A's approval is cleaned up
  assert.equal(approvals.has('A.jsonl'), false)

  // BUT Session B is still waiting on its own dialog dlg-b!
  // Session B approval must NOT have been stolen!
  assert.equal(
    approvals.has('B.jsonl'),
    true,
    'CRITICAL VULNERABILITY: Session B approval was stolen when answering A dialog with key=B.jsonl!'
  )
})

test('PASS SCENARIO 3: Stale dialog arrival during in-flight asynchronous stop', async () => {
  let finishStop: () => void = () => {}
  const slowStopPromise = new Promise<void>((resolve) => {
    finishStop = resolve
  })

  class SlowStopRuntime extends MockManagedRuntime {
    override async stop(): Promise<void> {
      this.pendingUiIds.clear()
      await slowStopPromise
      this.running = false
      this.currentStatus = { phase: 'stopped', cwd: this.currentStatus.cwd }
      this.emit('status', this.currentStatus)
    }
  }

  const a = new SlowStopRuntime()
  const b = new MockManagedRuntime()
  const supervisor = supervisorOf([a, b])

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })

  a.pendingUiIds.add('dlg-a')
  a.emit('event', { type: 'extension_ui_request', id: 'dlg-a', method: 'confirm', sessionKey: 'A.jsonl' } as PiEvent)

  b.pendingUiIds.add('dlg-b')
  b.emit('event', { type: 'extension_ui_request', id: 'dlg-b', method: 'confirm', sessionKey: 'B.jsonl' } as PiEvent)

  // Start stop on A (asynchronous, pending slowStopPromise)
  const stopPromise = supervisor.stop('A.jsonl')

  // Stale dialog answer arrives while stop is in flight
  supervisor.respondUi('A.jsonl', 'dlg-a', { confirmed: false })

  // Session B must NOT receive dlg-a
  assert.equal(b.approvals.length, 0)
  assert.equal(b.hasPendingUi('dlg-b'), true)

  // Complete the slow stop
  finishStop()
  await stopPromise

  assert.equal(a.isRunning, false)
  assert.equal(b.isRunning, true)
  const approvals = (supervisor as unknown as { approvals: Set<string> }).approvals
  assert.equal(approvals.has('B.jsonl'), true)

  // Resolve B normally
  supervisor.respondUi('B.jsonl', 'dlg-b', { confirmed: true })
  assert.equal(b.approvals.length, 1)
  assert.equal(approvals.has('B.jsonl'), false)
})

test('PASS SCENARIO 4: Sole running runtime subjected to burst of invalid and stale dialogs', async () => {
  const b = new MockManagedRuntime()
  const supervisor = supervisorOf([b])

  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })
  assert.equal(b.isRunning, true)

  // Avalanche of random stale dialogs
  for (let i = 0; i < 50; i++) {
    supervisor.respondUi(`stale-${i}.jsonl`, `dlg-${i}`, { confirmed: false })
    supervisor.respondUi('', `dlg-${i}`, { confirmed: false })
  }

  // Runtime B has no pending dialogs and should have received nothing
  assert.equal(b.approvals.length, 0)
  const approvals = (supervisor as unknown as { approvals: Set<string> }).approvals
  assert.equal(approvals.size, 0)
})

test('PASS SCENARIO 5: CwdGate isolation and queue lock integrity when stopped session has stale dialog', async () => {
  const a = new MockManagedRuntime()
  const b = new MockManagedRuntime()
  const supervisor = supervisorOf([a, b])

  // Both share the same directory C:/same-ws
  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/same-ws', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/same-ws', sessionFile: 'B.jsonl' })

  // Session A begins prompt (acquires lock)
  await supervisor.request('A.jsonl', 'prompt', { message: 'task-a' })

  // Session A triggers blocking dialog
  a.pendingUiIds.add('dlg-a')
  a.emit('event', { type: 'extension_ui_request', id: 'dlg-a', method: 'confirm', sessionKey: 'A.jsonl' } as PiEvent)

  // Queue Session B on same directory
  let bExecuted = false
  const bPromise = supervisor.withCwdLock('C:/same-ws', async () => {
    bExecuted = true
    return 'b-success'
  })

  // Session A stops
  await supervisor.stop('A.jsonl')

  // B should now acquire lock and execute
  const bResult = await bPromise
  assert.equal(bExecuted, true)
  assert.equal(bResult, 'b-success')

  // While B is running or after, late dialog for A arrives
  supervisor.respondUi('A.jsonl', 'dlg-a', { confirmed: false })

  // Directory lock remains healthy
  const lockCheck = await supervisor.withCwdLock('C:/same-ws', async () => 'still-free')
  assert.equal(lockCheck, 'still-free')
})

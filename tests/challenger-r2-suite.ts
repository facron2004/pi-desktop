import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type {
  ExtensionUiResponse,
  PiEvent,
  RuntimeStartOptions,
  RuntimeStatus
} from '../src/shared/types'
import { SessionSupervisor, type ManagedSessionRuntime } from '../src/main/pi/supervisor'

class MockManagedRuntime extends EventEmitter implements ManagedSessionRuntime {
  readonly commands: { command: string; payload: Record<string, unknown> }[] = []
  readonly approvals: { id: string; response: ExtensionUiResponse }[] = []
  running = false
  status: RuntimeStatus = { phase: 'stopped' }
  pendingUiIds = new Set<string>()

  get isRunning(): boolean {
    return this.running
  }

  get currentStatus(): RuntimeStatus {
    return { ...this.status }
  }

  async start(options: RuntimeStartOptions): Promise<{ ok: boolean; error?: string }> {
    this.running = true
    this.status = { phase: 'ready', cwd: options.cwd, sessionFile: options.sessionFile, sessionId: 'pi' }
    return { ok: true }
  }

  async request<T = unknown>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ command, payload })
    if (command === 'abort' || command === 'abort_retry') {
      for (const id of this.pendingUiIds) {
        this.approvals.push({ id, response: { confirmed: false, cancelled: true } })
      }
      this.pendingUiIds.clear()
    }
    if (command === 'get_state') {
      return { sessionFile: this.status.sessionFile, sessionId: 'pi' } as T
    }
    if (command === 'prompt') {
      return { disposition: 'started' } as T
    }
    return { ok: true } as T
  }

  respondUi(id: string, response: ExtensionUiResponse): void {
    this.pendingUiIds.delete(id)
    this.approvals.push({ id, response })
  }

  hasPendingUi(id: string): boolean {
    return this.pendingUiIds.has(id)
  }

  async stop(): Promise<void> {
    this.running = false
    this.status = { phase: 'stopped', cwd: this.status.cwd }
  }
}

test('STRESS TEST 1: Stale dialog with Session B key must NOT strip Session B approval', async () => {
  const a = new MockManagedRuntime()
  const b = new MockManagedRuntime()
  const supervisor = new SessionSupervisor(() => (a.running ? b : a))

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })

  // Session A had dialog dlg-a
  a.pendingUiIds.add('dlg-a')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-a',
    method: 'confirm',
    sessionKey: 'A.jsonl'
  } as PiEvent)

  // Session B has dialog dlg-b
  b.pendingUiIds.add('dlg-b')
  b.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-b',
    method: 'confirm',
    sessionKey: 'B.jsonl'
  } as PiEvent)

  // Session A is stopped
  await supervisor.stop('A.jsonl')
  assert.equal(a.isRunning, false)
  assert.equal(b.isRunning, true)

  const internalApprovals = (supervisor as unknown as { approvals: Set<string> }).approvals
  assert.equal(internalApprovals.has('B.jsonl'), true, 'Session B must have pending approval tracked')

  // Stale dialog for Session A arrives, but user is currently viewing Session B,
  // so key is passed as B.jsonl
  supervisor.respondUi('B.jsonl', 'dlg-a', { confirmed: false })

  // CRITICAL CHECK: Session B must NOT lose its pending approval!
  assert.equal(
    internalApprovals.has('B.jsonl'),
    true,
    'BUG: Session B approval was stripped by stale dialog dlg-a sent with key B.jsonl!'
  )
})

test('STRESS TEST 2: Answering Session A dialog with fallback key B must NOT strip Session B approval', async () => {
  const a = new MockManagedRuntime()
  const b = new MockManagedRuntime()
  const supervisor = new SessionSupervisor(() => (a.running ? b : a))

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })

  // Both sessions have pending dialogs
  a.pendingUiIds.add('dlg-a')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-a',
    method: 'confirm',
    sessionKey: 'A.jsonl'
  } as PiEvent)

  b.pendingUiIds.add('dlg-b')
  b.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-b',
    method: 'confirm',
    sessionKey: 'B.jsonl'
  } as PiEvent)

  const internalApprovals = (supervisor as unknown as { approvals: Set<string> }).approvals
  assert.equal(internalApprovals.has('A.jsonl'), true)
  assert.equal(internalApprovals.has('B.jsonl'), true)

  // Answering dlg-a (which belongs to A), but with wrong sessionKey B.jsonl
  supervisor.respondUi('B.jsonl', 'dlg-a', { confirmed: true })

  // Dialog must be delivered to A
  assert.equal(a.approvals.length, 1)
  assert.equal(a.approvals[0]?.id, 'dlg-a')

  // CRITICAL CHECK: Session B's approval must still be tracked because Session B still has dlg-b pending!
  assert.equal(
    internalApprovals.has('B.jsonl'),
    true,
    'BUG: Session B approval was stripped when answering Session A dialog dlg-a with key B.jsonl!'
  )
})

test('STRESS TEST 3: Stripped approval leads to premature warm process termination', async () => {
  const a = new MockManagedRuntime()
  const b = new MockManagedRuntime()
  const supervisor = new SessionSupervisor(() => (a.running ? b : a))

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })

  // Session B encounters blocking confirmation dialog dlg-b
  b.pendingUiIds.add('dlg-b')
  b.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-b',
    method: 'confirm',
    sessionKey: 'B.jsonl'
  } as PiEvent)

  const internalApprovals = (supervisor as unknown as { approvals: Set<string> }).approvals
  assert.equal(internalApprovals.has('B.jsonl'), true)

  // A stale or unknown dialog arrives with sessionKey B.jsonl
  supervisor.respondUi('B.jsonl', 'dlg-unknown-or-stale', { confirmed: false })

  // If approval was stripped, simulate warm idle retirement check (supervisor.ts:539)
  const id = 'B.jsonl'
  const holdsGate = (supervisor as any).gate.holds(id)
  const holdsApproval = internalApprovals.has(id)
  const holdsQueued = [...(supervisor as any).queued.values()].some((jobs: any[]) =>
    jobs.some((job: any) => (supervisor as any).canonical(job.key) === id)
  )

  const isProtectedFromWarmRetirement = holdsGate || holdsApproval || holdsQueued

  assert.equal(
    isProtectedFromWarmRetirement,
    true,
    'BUG: Session B lost warm idle protection while actively waiting on dialog dlg-b!'
  )
})

test('STRESS TEST 4: Multi-session interleaved dialogs, view switches and aborts across 4 sessions', async () => {
  const runtimes = new Map<string, MockManagedRuntime>()
  const keys = ['A.jsonl', 'B.jsonl', 'C.jsonl', 'D.jsonl']
  for (const k of keys) {
    runtimes.set(k, new MockManagedRuntime())
  }

  const supervisor = new SessionSupervisor(() => {
    for (const [k, r] of runtimes) {
      if (!r.running) return r
    }
    throw new Error('No available runtime')
  })

  // Ensure all 4 sessions in different workspaces
  for (const k of keys) {
    await supervisor.ensure({ sessionKey: k, cwd: `C:/ws-${k}`, sessionFile: k })
  }

  // Each session triggers a dialog
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    const r = runtimes.get(k)!
    const dlgId = `dlg-${k}`
    r.pendingUiIds.add(dlgId)
    r.emit('event', {
      type: 'extension_ui_request',
      id: dlgId,
      method: 'confirm',
      sessionKey: k
    } as PiEvent)
  }

  const internalApprovals = (supervisor as unknown as { approvals: Set<string> }).approvals
  for (const k of keys) {
    assert.equal(internalApprovals.has(k), true, `Session ${k} must be in approvals`)
  }

  // Abort Session A
  await supervisor.request('A.jsonl', 'abort')
  const rA = runtimes.get('A.jsonl')!
  assert.equal(rA.approvals.length, 1)
  assert.equal(rA.approvals[0]?.response.cancelled, true)
  assert.equal(rA.hasPendingUi('dlg-A.jsonl'), false)

  // Verify B, C, D approvals remain completely intact after A's abort
  assert.equal(internalApprovals.has('B.jsonl'), true)
  assert.equal(internalApprovals.has('C.jsonl'), true)
  assert.equal(internalApprovals.has('D.jsonl'), true)

  // User views Session B, but answers Session C's dialog (passing current view B as key)
  supervisor.respondUi('B.jsonl', 'dlg-C.jsonl', { confirmed: true })

  const rC = runtimes.get('C.jsonl')!
  assert.equal(rC.approvals.length, 1)
  assert.equal(rC.approvals[0]?.id, 'dlg-C.jsonl')

  // CRITICAL: Session B must NOT lose its approval!
  assert.equal(
    internalApprovals.has('B.jsonl'),
    true,
    'Session B approval must not be stripped when answering Session C dialog!'
  )

  // Session D answers its own dialog with correct key
  supervisor.respondUi('D.jsonl', 'dlg-D.jsonl', { confirmed: true })
  const rD = runtimes.get('D.jsonl')!
  assert.equal(rD.approvals.length, 1)
  assert.equal(internalApprovals.has('D.jsonl'), false)

  // Session B must STILL have its approval
  assert.equal(
    internalApprovals.has('B.jsonl'),
    true,
    'Session B approval must not be stripped by other operations!'
  )
})

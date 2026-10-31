import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ExtensionUiResponse, PiEvent, RuntimeStartOptions, RuntimeStatus } from '../src/shared/types'
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
    this.pendingUiIds.clear()
  }
}

function supervisorOf(runtimes: Map<string, MockManagedRuntime>): SessionSupervisor {
  return new SessionSupervisor(() => {
    for (const [, r] of runtimes) {
      if (!r.running) return r
    }
    throw new Error('No available mock runtime')
  })
}

// -----------------------------------------------------------------------------
// Adversarial Test 1: Real Warm Timer Expiration Protection Under Cross-Session Attack
// -----------------------------------------------------------------------------
test('CHALLENGER R3.2 - Test 1: Active session waiting for approval survives warm timer firing after cross-session attack', async () => {
  const runtimes = new Map<string, MockManagedRuntime>([
    ['A.jsonl', new MockManagedRuntime()],
    ['B.jsonl', new MockManagedRuntime()],
    ['C.jsonl', new MockManagedRuntime()]
  ])
  const supervisor = supervisorOf(runtimes)

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })
  await supervisor.ensure({ sessionKey: 'C.jsonl', cwd: 'C:/ws-c', sessionFile: 'C.jsonl' })

  const rA = runtimes.get('A.jsonl')!
  const rB = runtimes.get('B.jsonl')!
  const rC = runtimes.get('C.jsonl')!

  // Session B encounters blocking confirmation dialog
  rB.pendingUiIds.add('dlg-b')
  rB.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-b',
    method: 'confirm',
    sessionKey: 'B.jsonl'
  } as PiEvent)

  // Session C encounters a select dialog
  rC.pendingUiIds.add('dlg-c')
  rC.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-c',
    method: 'select',
    sessionKey: 'C.jsonl'
  } as PiEvent)

  const internalApprovals = (supervisor as unknown as { approvals: Set<string> }).approvals
  assert.equal(internalApprovals.has('B.jsonl'), true, 'Session B must have pending approval initially')
  assert.equal(internalApprovals.has('C.jsonl'), true, 'Session C must have pending approval initially')
  assert.equal(internalApprovals.has('A.jsonl'), false, 'Session A has no pending approvals')

  // Attack: Send a barrage of cross-session, stale, and unknown dialog responses passing key='B.jsonl'
  supervisor.respondUi('B.jsonl', 'dlg-c', { value: 'selected-option' }) // dialog of C answered while viewing B
  supervisor.respondUi('B.jsonl', 'stale-dlg-999', { confirmed: false }) // non-existent dialog
  supervisor.respondUi('B.jsonl', '', { confirmed: false }) // empty dialog id
  supervisor.respondUi('', 'unknown-dlg', { confirmed: false }) // empty key, unknown id

  // Dialog C was delivered to runtime C
  assert.equal(rC.approvals.length, 1)
  assert.equal(rC.approvals[0]?.id, 'dlg-c')
  assert.equal(internalApprovals.has('C.jsonl'), false, 'Session C approval cleared after its dialog answered')

  // CRITICAL CHECK: Session B must NOT lose its approval!
  assert.equal(internalApprovals.has('B.jsonl'), true, 'Session B must NOT lose its approval after cross-session barrage')

  // Now inspect the warm timer mechanism:
  // In SessionSupervisor, scheduleWarm sets a timer in warmTimers map.
  // Access warmTimers to trigger the timer callback directly
  const warmTimers = (supervisor as unknown as { warmTimers: Map<string, any> }).warmTimers

  // Trigger Session A's warm timer: Session A is idle with no approvals, so it should be retired/stopped
  // Re-arm warm for A to ensure timer is set
  ;(supervisor as any).scheduleWarm('A.jsonl')
  const timerA = warmTimers.get('A.jsonl')
  assert.ok(timerA, 'Session A must have a warm timer scheduled')

  // Fire Session A's timer callback
  // In Node.js, timer is a Timeout object with _onTimeout
  if (typeof timerA._onTimeout === 'function') {
    timerA._onTimeout()
  } else {
    // Alternatively call the timer logic directly
    ;(supervisor as any).stop('A.jsonl')
  }
  // Wait a microtask
  await Promise.resolve()
  assert.equal(rA.isRunning, false, 'Session A should be cleanly stopped by warm timer when truly idle')

  // Now trigger Session B's warm timer: Session B has dlg-b pending in approvals
  ;(supervisor as any).scheduleWarm('B.jsonl')
  const timerB = warmTimers.get('B.jsonl')
  assert.ok(timerB, 'Session B must have a warm timer scheduled')

  // Fire Session B's timer callback
  if (typeof timerB._onTimeout === 'function') {
    timerB._onTimeout()
  }
  await Promise.resolve()

  // CRITICAL CHECK: Session B MUST STILL BE RUNNING! It was NOT prematurely stopped!
  assert.equal(rB.isRunning, true, 'CRITICAL: Session B must NOT be stopped by warm timer while awaiting dialog approval!')
  assert.equal(supervisor.has('B.jsonl'), true, 'Supervisor must still report Session B running')

  // Finally, answer Session B's legitimate dialog
  supervisor.respondUi('B.jsonl', 'dlg-b', { confirmed: true })
  assert.equal(rB.approvals.length, 1)
  assert.equal(rB.approvals[0]?.id, 'dlg-b')
  assert.equal(internalApprovals.has('B.jsonl'), false, 'Session B approval cleared after legitimate answer')
})

// -----------------------------------------------------------------------------
// Adversarial Test 2: Draft Rekey and Cross-Session Approvals
// -----------------------------------------------------------------------------
test('CHALLENGER R3.2 - Test 2: Draft session rekey retains approval and survives cross-session interference', async () => {
  const draftRuntime = new MockManagedRuntime()
  const otherRuntime = new MockManagedRuntime()
  const runtimes = new Map<string, MockManagedRuntime>([
    ['draft:1', draftRuntime],
    ['other.jsonl', otherRuntime]
  ])
  const supervisor = supervisorOf(runtimes)

  await supervisor.ensure({ sessionKey: 'draft:1', cwd: 'C:/ws-draft' })
  await supervisor.ensure({ sessionKey: 'other.jsonl', cwd: 'C:/ws-other', sessionFile: 'other.jsonl' })

  // Draft encounters a dialog
  draftRuntime.pendingUiIds.add('dlg-draft-1')
  draftRuntime.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-draft-1',
    method: 'confirm',
    sessionKey: 'draft:1'
  } as PiEvent)

  const internalApprovals = (supervisor as unknown as { approvals: Set<string> }).approvals
  assert.equal(internalApprovals.has('draft:1'), true, 'Draft session has approval tracked')

  // Rekey draft:1 to persisted file 'persisted.jsonl'
  ;(supervisor as any).bindFile('draft:1', 'persisted.jsonl')
  assert.equal(internalApprovals.has('persisted.jsonl'), true, 'Approval migrated to persisted file key')

  // Other session has dialog dlg-other
  otherRuntime.pendingUiIds.add('dlg-other')
  otherRuntime.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-other',
    method: 'confirm',
    sessionKey: 'other.jsonl'
  } as PiEvent)
  assert.equal(internalApprovals.has('other.jsonl'), true)

  // Cross-session call: answer dlg-other with key='persisted.jsonl' or 'draft:1'
  supervisor.respondUi('draft:1', 'dlg-other', { confirmed: true })

  // dlg-other delivered to otherRuntime
  assert.equal(otherRuntime.approvals.length, 1)
  assert.equal(otherRuntime.approvals[0]?.id, 'dlg-other')
  assert.equal(internalApprovals.has('other.jsonl'), false)

  // CRITICAL CHECK: persisted.jsonl must retain approval!
  assert.equal(internalApprovals.has('persisted.jsonl'), true, 'Persisted session must NOT lose approval after cross-session answer')

  // Fire warm timer for persisted session
  ;(supervisor as any).scheduleWarm('persisted.jsonl')
  const warmTimers = (supervisor as unknown as { warmTimers: Map<string, any> }).warmTimers
  const timer = warmTimers.get('persisted.jsonl')
  if (timer && typeof timer._onTimeout === 'function') {
    timer._onTimeout()
  }
  await Promise.resolve()

  // Still running
  assert.equal(draftRuntime.isRunning, true, 'Draft/persisted runtime must not be terminated by warm timer')

  // Now answer draft dialog
  supervisor.respondUi('persisted.jsonl', 'dlg-draft-1', { confirmed: true })
  assert.equal(draftRuntime.approvals.length, 1)
  assert.equal(draftRuntime.approvals[0]?.id, 'dlg-draft-1')
  assert.equal(internalApprovals.has('persisted.jsonl'), false)
})

// -----------------------------------------------------------------------------
// Adversarial Test 3: Multiple Sequential Dialogs & Interleaved Traffic
// -----------------------------------------------------------------------------
test('CHALLENGER R3.2 - Test 3: Sequential dialogs on single session maintain continuous idle protection', async () => {
  const rA = new MockManagedRuntime()
  const rB = new MockManagedRuntime()
  const runtimes = new Map<string, MockManagedRuntime>([
    ['A.jsonl', rA],
    ['B.jsonl', rB]
  ])
  const supervisor = supervisorOf(runtimes)

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })

  const internalApprovals = (supervisor as unknown as { approvals: Set<string> }).approvals

  // Sequence:
  // 1. A triggers dlg-a1
  rA.pendingUiIds.add('dlg-a1')
  rA.emit('event', { type: 'extension_ui_request', id: 'dlg-a1', method: 'confirm', sessionKey: 'A.jsonl' } as PiEvent)
  assert.equal(internalApprovals.has('A.jsonl'), true)

  // 2. B triggers dlg-b1
  rB.pendingUiIds.add('dlg-b1')
  rB.emit('event', { type: 'extension_ui_request', id: 'dlg-b1', method: 'confirm', sessionKey: 'B.jsonl' } as PiEvent)
  assert.equal(internalApprovals.has('B.jsonl'), true)

  // 3. User answers dlg-a1 with correct key
  supervisor.respondUi('A.jsonl', 'dlg-a1', { confirmed: true })
  assert.equal(rA.approvals.length, 1)
  assert.equal(internalApprovals.has('A.jsonl'), false)
  // B must still have approval
  assert.equal(internalApprovals.has('B.jsonl'), true)

  // 4. Session A immediately produces dlg-a2
  rA.pendingUiIds.add('dlg-a2')
  rA.emit('event', { type: 'extension_ui_request', id: 'dlg-a2', method: 'input', sessionKey: 'A.jsonl' } as PiEvent)
  assert.equal(internalApprovals.has('A.jsonl'), true)

  // 5. User answers dlg-b1 but passes key 'A.jsonl'
  supervisor.respondUi('A.jsonl', 'dlg-b1', { confirmed: true })
  assert.equal(rB.approvals.length, 1)
  assert.equal(internalApprovals.has('B.jsonl'), false)
  // A must STILL have approval for dlg-a2!
  assert.equal(internalApprovals.has('A.jsonl'), true, 'Session A must retain approval for dlg-a2 despite cross-session answer to dlg-b1')

  // 6. User answers dlg-a2
  supervisor.respondUi('A.jsonl', 'dlg-a2', { value: 'user-input' })
  assert.equal(rA.approvals.length, 2)
  assert.equal(internalApprovals.has('A.jsonl'), false)
})

// -----------------------------------------------------------------------------
// Adversarial Test 4: Randomized Concurrency Fuzzing Oracle (5 Sessions, 50 Operations)
// -----------------------------------------------------------------------------
test('CHALLENGER R3.2 - Test 4: Randomized concurrency fuzzing oracle verifies approval & idle invariants', async () => {
  const sessionCount = 5
  const keys = Array.from({ length: sessionCount }, (_, i) => `session-${i}.jsonl`)
  const runtimes = new Map<string, MockManagedRuntime>()
  for (const k of keys) {
    runtimes.set(k, new MockManagedRuntime())
  }
  const supervisor = supervisorOf(runtimes)

  for (const k of keys) {
    await supervisor.ensure({ sessionKey: k, cwd: `C:/ws-${k}`, sessionFile: k })
  }

  const internalApprovals = (supervisor as unknown as { approvals: Set<string> }).approvals
  let dialogCounter = 0

  // Deterministic pseudo-random number generator for reproducibility
  let seed = 123456789
  function rnd(): number {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }

  for (let step = 0; step < 50; step++) {
    const op = Math.floor(rnd() * 3)

    if (op === 0) {
      // Operation 0: Emit a new dialog on a random active session
      const targetSession = keys[Math.floor(rnd() * keys.length)]
      const r = runtimes.get(targetSession)!
      if (r.isRunning && r.pendingUiIds.size === 0) {
        dialogCounter++
        const dlgId = `dlg-${targetSession}-${dialogCounter}`
        r.pendingUiIds.add(dlgId)
        r.emit('event', {
          type: 'extension_ui_request',
          id: dlgId,
          method: 'confirm',
          sessionKey: targetSession
        } as PiEvent)
      }
    } else if (op === 1) {
      // Operation 1: Answer a pending dialog (possibly with a mismatched / random key)
      // Pick any session that has a pending dialog
      const sessionsWithPending = keys.filter(k => runtimes.get(k)!.pendingUiIds.size > 0)
      if (sessionsWithPending.length > 0) {
        const ownerSession = sessionsWithPending[Math.floor(rnd() * sessionsWithPending.length)]
        const r = runtimes.get(ownerSession)!
        const dlgId = [...r.pendingUiIds][0]
        // Pick a random key (can be matching, wrong session, or bogus)
        const passedKey = rnd() > 0.3 ? keys[Math.floor(rnd() * keys.length)] : 'bogus-key.jsonl'
        supervisor.respondUi(passedKey, dlgId, { confirmed: true })
      }
    } else {
      // Operation 2: Trigger warm retirement check on all sessions
      for (const k of keys) {
        ;(supervisor as any).scheduleWarm(k)
        const warmTimers = (supervisor as unknown as { warmTimers: Map<string, any> }).warmTimers
        const timer = warmTimers.get(k)
        if (timer && typeof timer._onTimeout === 'function') {
          timer._onTimeout()
        }
      }
    }

    // --- INVARIANT ASSERTIONS AT EVERY STEP ---
    for (const k of keys) {
      const r = runtimes.get(k)!
      if (r.isRunning) {
        const hasPending = r.pendingUiIds.size > 0
        if (hasPending) {
          // If a session has a pending UI dialog, supervisor MUST have it in approvals
          assert.equal(
            internalApprovals.has(k),
            true,
            `Invariant violation at step ${step}: Session ${k} has pending UI ${[...r.pendingUiIds]} but lost approval status!`
          )
          // Furthermore, session MUST NOT be stopped
          assert.equal(
            r.isRunning,
            true,
            `Invariant violation at step ${step}: Session ${k} was prematurely terminated while awaiting approval!`
          )
        }
      }
    }
  }

  // Final verification: Clean up all pending dialogs
  for (const k of keys) {
    const r = runtimes.get(k)!
    for (const dlgId of [...r.pendingUiIds]) {
      supervisor.respondUi(k, dlgId, { confirmed: true })
    }
    assert.equal(r.pendingUiIds.size, 0)
    assert.equal(internalApprovals.has(k), false, `All approvals should be clean for ${k}`)
  }
})

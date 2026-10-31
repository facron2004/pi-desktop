import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  PiEvent,
  RuntimeStartOptions,
  RuntimeStatus
} from '@shared/types'
import { SessionSupervisor, type ManagedSessionRuntime } from '../src/main/pi/supervisor'

interface RecordedCommand {
  command: string
  payload: Record<string, unknown>
}

class TestSessionRuntime extends EventEmitter implements ManagedSessionRuntime {
  readonly commands: RecordedCommand[] = []
  readonly approvals: { id: string; response: ExtensionUiResponse }[] = []
  starts = 0
  stops = 0
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
    this.starts += 1
    this.running = true
    this.status = { phase: 'ready', cwd: options.cwd, sessionFile: options.sessionFile, sessionId: 'pi' }
    return { ok: true }
  }

  async request<T = unknown>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ command, payload })
    if (command === 'abort' || command === 'abort_retry') {
      // Auto-cancel pending UI dialogs on abort per AGENTS.md Rule 7
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
    this.stops += 1
    this.running = false
    this.status = { phase: 'stopped', cwd: this.status.cwd }
  }
}

function supervisorOf(runtimes: TestSessionRuntime[]): SessionSupervisor {
  const pending = [...runtimes]
  return new SessionSupervisor(() => {
    const next = pending.shift()
    if (!next) throw new Error('unexpected runtime')
    return next
  })
}

test('cross-session routing: answering dialog delivers to originating session even when view switches', async () => {
  const a = new TestSessionRuntime()
  const b = new TestSessionRuntime()
  const supervisor = supervisorOf([a, b])

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/b', sessionFile: 'B.jsonl' })

  let capturedEvent: ExtensionUiRequest | undefined
  supervisor.on('event', (payload: { ownerId: string; event: PiEvent }) => {
    if (payload.event.type === 'extension_ui_request') {
      capturedEvent = payload.event as ExtensionUiRequest
    }
  })

  // Session A triggers a blocking confirmation dialog
  a.pendingUiIds.add('dlg-session-a')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-session-a',
    method: 'confirm',
    title: 'Confirm Operation',
    message: 'Perform critical action?'
  } as PiEvent)

  assert.ok(capturedEvent)
  assert.equal(capturedEvent.id, 'dlg-session-a')
  assert.equal(capturedEvent.sessionKey, 'A.jsonl')

  // User was browsing Session B, but answers dialog with originating sessionKey A.jsonl
  supervisor.respondUi('A.jsonl', 'dlg-session-a', { confirmed: true })

  assert.equal(a.approvals.length, 1)
  assert.equal(a.approvals[0]?.id, 'dlg-session-a')
  assert.deepEqual(a.approvals[0]?.response, { confirmed: true })
  assert.equal(b.approvals.length, 0, 'Session B must receive no dialog responses')
})

test('fallback routing: respondUi safely correlates by pending ID when sessionKey is missing or wrong', async () => {
  const a = new TestSessionRuntime()
  const b = new TestSessionRuntime()
  const supervisor = supervisorOf([a, b])

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/b', sessionFile: 'B.jsonl' })

  a.pendingUiIds.add('dlg-fallback-1')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-fallback-1',
    method: 'input',
    title: 'Input requested'
  } as PiEvent)

  // Call respondUi with empty sessionKey
  supervisor.respondUi('', 'dlg-fallback-1', { value: 'custom-answer' })

  assert.equal(a.approvals.length, 1)
  assert.equal(a.approvals[0]?.id, 'dlg-fallback-1')
  assert.deepEqual(a.approvals[0]?.response, { value: 'custom-answer' })
  assert.equal(b.approvals.length, 0)

  // Call respondUi with wrong sessionKey (pointing to B when dialog belongs to A)
  a.pendingUiIds.add('dlg-fallback-2')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-fallback-2',
    method: 'select',
    title: 'Select requested'
  } as PiEvent)

  supervisor.respondUi('B.jsonl', 'dlg-fallback-2', { value: 'choice-1' })
  assert.equal(a.approvals.length, 2)
  assert.equal(a.approvals[1]?.id, 'dlg-fallback-2')
  assert.deepEqual(a.approvals[1]?.response, { value: 'choice-1' })
  assert.equal(b.approvals.length, 0)
})

test('stale dialog of stopped session A must not be delivered to active session B or steal B approvals', async () => {
  const a = new TestSessionRuntime()
  const b = new TestSessionRuntime()
  const supervisor = supervisorOf([a, b])

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })

  // Session A encounters a blocking confirmation dialog dlg-a
  a.pendingUiIds.add('dlg-a')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-a',
    method: 'confirm',
    title: 'Session A Confirmation',
    sessionKey: 'A.jsonl'
  } as PiEvent)

  // Session B encounters its own blocking confirmation dialog dlg-b
  b.pendingUiIds.add('dlg-b')
  b.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-b',
    method: 'confirm',
    title: 'Session B Confirmation',
    sessionKey: 'B.jsonl'
  } as PiEvent)

  // Both sessions must be recorded in supervisor approvals
  const internalApprovals = (supervisor as unknown as { approvals: Set<string> }).approvals
  assert.equal(internalApprovals.has('A.jsonl'), true, 'Session A must have pending approval tracked')
  assert.equal(internalApprovals.has('B.jsonl'), true, 'Session B must have pending approval tracked')

  // Session A is stopped
  await supervisor.stop('A.jsonl')
  assert.equal(a.isRunning, false, 'Session A must be stopped')
  assert.equal(b.isRunning, true, 'Session B must remain running')
  assert.equal(internalApprovals.has('A.jsonl'), false, 'Session A must be removed from approvals')
  assert.equal(internalApprovals.has('B.jsonl'), true, 'Session B must still have approval pending')

  // Late answer arrives for Session A's stopped dialog dlg-a
  supervisor.respondUi('A.jsonl', 'dlg-a', { confirmed: false })

  // REGRESSION ASSERTION 1: Session B must NOT receive Session A's stale dialog response!
  assert.equal(
    b.approvals.some((app) => app.id === 'dlg-a'),
    false,
    'Regression: Session B received Session A stale dialog response!'
  )
  assert.equal(b.approvals.length, 0, 'Session B approvals must be empty before its own answer')

  // REGRESSION ASSERTION 2: Session B's own pending dialog dlg-b must remain pending
  assert.equal(b.hasPendingUi('dlg-b'), true, 'Session B pending dialog dlg-b was prematurely removed or corrupted!')

  // REGRESSION ASSERTION 3: Session B's approval tracking in supervisor must NOT have been stolen!
  assert.equal(
    internalApprovals.has('B.jsonl'),
    true,
    'Regression: Session B approval was stolen from supervisor.approvals by Session A stale dialog!'
  )

  // Legitimate answer arrives for Session B's own dialog dlg-b
  supervisor.respondUi('B.jsonl', 'dlg-b', { confirmed: true })
  assert.equal(b.approvals.length, 1)
  assert.equal(b.approvals[0]?.id, 'dlg-b')
  assert.deepEqual(b.approvals[0]?.response, { confirmed: true })
  assert.equal(b.hasPendingUi('dlg-b'), false)
  assert.equal(internalApprovals.has('B.jsonl'), false, 'Session B approval must be cleared after legitimate response')
})

test('sole running runtime must not receive unmatched stale dialogs', async () => {
  const a = new TestSessionRuntime()
  const b = new TestSessionRuntime()
  const supervisor = supervisorOf([a, b])

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })

  // Session A has pending dialog dlg-a
  a.pendingUiIds.add('dlg-a')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-a',
    method: 'confirm',
    title: 'Session A Confirmation',
    sessionKey: 'A.jsonl'
  } as PiEvent)

  // Session B is running normally with NO pending dialogs
  assert.equal(b.pendingUiIds.size, 0)

  // Session A is stopped, leaving Session B as the single running runtime (runtimes.size === 1)
  await supervisor.stop('A.jsonl')
  assert.equal(supervisor.runningKeys().length, 1)

  // Stale responses arrive for dlg-a (with original key, empty key, or mismatched key)
  supervisor.respondUi('A.jsonl', 'dlg-a', { confirmed: true })
  supervisor.respondUi('', 'dlg-a-unknown', { confirmed: true })
  supervisor.respondUi('B.jsonl', 'dlg-a-mismatched', { confirmed: true })

  // REGRESSION ASSERTION: Sole running runtime B must NOT receive unmatched stale dialogs via runtimes.size === 1 fallback
  assert.equal(b.approvals.length, 0, 'Sole running runtime must not receive unmatched stale dialogs')
})

test('abort auto-cancellation and approvals cleanup unblocks conversation', async () => {
  const a = new TestSessionRuntime()
  const supervisor = supervisorOf([a])

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })

  a.pendingUiIds.add('dlg-abort-test')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-abort-test',
    method: 'confirm',
    title: 'Needs user response'
  } as PiEvent)

  // Aborting the session must cancel the pending dialog and clear approvals
  await supervisor.request('A.jsonl', 'abort')

  assert.equal(a.approvals.length, 1)
  assert.equal(a.approvals[0]?.id, 'dlg-abort-test')
  assert.deepEqual(a.approvals[0]?.response, { confirmed: false, cancelled: true })
  assert.equal(a.hasPendingUi('dlg-abort-test'), false)
})

test('CwdGate release: aborting a session blocked on UI dialog unblocks workspace and Git lock', async () => {
  const a = new TestSessionRuntime()
  const b = new TestSessionRuntime()
  const supervisor = supervisorOf([a, b])
  const workspaceCwd = 'C:/shared-workspace'

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: workspaceCwd, sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: workspaceCwd, sessionFile: 'B.jsonl' })

  // Session A starts a prompt (claims CwdGate write lock)
  await supervisor.request('A.jsonl', 'prompt', { message: 'start work' })

  // Session A encounters a blocking dialog
  a.pendingUiIds.add('dlg-blocker')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-blocker',
    method: 'confirm',
    message: 'Allow tool?'
  } as PiEvent)

  // Attempting Git operation in this folder fails because Session A is working
  await assert.rejects(
    supervisor.withCwdLock(workspaceCwd, async () => 'git status'),
    /A conversation is working in this folder/
  )

  // Session B tries to prompt and gets queued behind Session A
  let bStarted = false
  const queuedPrompt = supervisor.request('B.jsonl', 'prompt', { message: 'queued prompt' }).then(() => {
    bStarted = true
  })
  await Promise.resolve()
  assert.equal(bStarted, false, 'Session B prompt must be queued while Session A is working')

  // User aborts Session A
  await supervisor.request('A.jsonl', 'abort')

  // Session A settles
  a.emit('event', { type: 'agent_settled', aborted: true } as PiEvent)

  // Now Session B's queued prompt unblocks and runs!
  await queuedPrompt
  assert.equal(bStarted, true, 'Session B prompt should unblock and run after Session A settles')

  // Session B completes and settles
  b.emit('event', { type: 'agent_settled' } as PiEvent)

  // Workspace Git lock is cleanly freed and subsequent operations succeed
  const gitResult = await supervisor.withCwdLock(workspaceCwd, async () => 'git ok')
  assert.equal(gitResult, 'git ok')
})

test('runtime status error clears approvals and releases CwdGate lock', async () => {
  const a = new TestSessionRuntime()
  const supervisor = supervisorOf([a])
  const workspaceCwd = 'C:/error-workspace'

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: workspaceCwd, sessionFile: 'A.jsonl' })

  // Start prompt claiming CwdGate
  await supervisor.request('A.jsonl', 'prompt', { message: 'work' })

  // Dialog arrives
  a.pendingUiIds.add('dlg-error-test')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-error-test',
    method: 'confirm'
  } as PiEvent)

  // Runtime experiences an unexpected error/crash
  a.running = false
  a.emit('status', { phase: 'error', error: 'Pi child process died', cwd: workspaceCwd } as RuntimeStatus)

  // Git lock should now be released, not deadlocked
  const gitResult = await supervisor.withCwdLock(workspaceCwd, async () => 'git recovered')
  assert.equal(gitResult, 'git recovered')
})

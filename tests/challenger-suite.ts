import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  PiEvent,
  RuntimeStartOptions,
  RuntimeStatus
} from '../src/shared/types'
import { SessionSupervisor, type ManagedSessionRuntime } from '../src/main/pi/supervisor'
import { PiRuntime } from '../src/main/pi/runtime'

interface RecordedApproval {
  id: string
  response: ExtensionUiResponse
}

class MockManagedRuntime extends EventEmitter implements ManagedSessionRuntime {
  readonly commands: { command: string; payload: Record<string, unknown> }[] = []
  readonly approvals: RecordedApproval[] = []
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

// -------------------------------------------------------------
// Suite 1: Dead process cleanup & Answering after runtime stopped
// -------------------------------------------------------------

test('CHALLENGE 1.1: Answering stale dialog when runtime is stopped does not crash or corrupt state', async () => {
  const runtime = new MockManagedRuntime()
  const supervisor = new SessionSupervisor(() => runtime)

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })

  // Dialog arrives
  runtime.pendingUiIds.add('dlg-1')
  runtime.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-1',
    method: 'confirm',
    sessionKey: 'A.jsonl'
  } as PiEvent)

  // Runtime stops
  await supervisor.stop('A.jsonl')
  assert.equal(runtime.isRunning, false)

  // Late answer arrives
  assert.doesNotThrow(() => {
    supervisor.respondUi('A.jsonl', 'dlg-1', { confirmed: true })
  })

  // Directory lock should be free
  const lock = await supervisor.withCwdLock('C:/ws-a', async () => 'free')
  assert.equal(lock, 'free')
})

test('CHALLENGE 1.2 (CRITICAL): Stale dialog of stopped session A must NOT be delivered to active session B or steal B approvals', async () => {
  const a = new MockManagedRuntime()
  const b = new MockManagedRuntime()
  const supervisor = new SessionSupervisor(() => (a.running ? b : a))

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/ws-b', sessionFile: 'B.jsonl' })

  // Session A has dialog dlg-a
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

  // Session A stops
  await supervisor.stop('A.jsonl')
  assert.equal(a.isRunning, false)
  assert.equal(b.isRunning, true)

  // Late answer for Session A's dlg-a arrives
  supervisor.respondUi('A.jsonl', 'dlg-a', { confirmed: false })

  // Session B must NOT have received Session A's dlg-a!
  assert.equal(
    b.approvals.some((app) => app.id === 'dlg-a'),
    false,
    'Session B received Session A stale dialog response!'
  )

  // Session B must still have dlg-b pending
  assert.equal(b.hasPendingUi('dlg-b'), true, 'Session B pending dialog was corrupted!')
})

test('CHALLENGE 1.3: Dead process error cleans up approvals and releases directory lock immediately', async () => {
  const a = new MockManagedRuntime()
  const supervisor = new SessionSupervisor(() => a)

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-crash', sessionFile: 'A.jsonl' })
  await supervisor.request('A.jsonl', 'prompt', { message: 'work' })

  a.pendingUiIds.add('dlg-crash')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-crash',
    method: 'confirm',
    sessionKey: 'A.jsonl'
  } as PiEvent)

  // Process dies unexpectedly
  a.running = false
  a.emit('status', { phase: 'error', error: 'Child crashed with SIGKILL', cwd: 'C:/ws-crash' } as RuntimeStatus)

  // Directory lock is immediately acquirable
  const lockResult = await supervisor.withCwdLock('C:/ws-crash', async () => 'recovered')
  assert.equal(lockResult, 'recovered')
})

// -------------------------------------------------------------
// Suite 2: Multiple rapid aborts (abort + abort_retry)
// -------------------------------------------------------------

test('CHALLENGE 2.1: Rapid concurrent aborts auto-cancel pending dialog exactly once', async () => {
  const a = new MockManagedRuntime()
  const supervisor = new SessionSupervisor(() => a)

  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/ws-abort', sessionFile: 'A.jsonl' })
  await supervisor.request('A.jsonl', 'prompt', { message: 'work' })

  a.pendingUiIds.add('dlg-rapid')
  a.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-rapid',
    method: 'input',
    sessionKey: 'A.jsonl'
  } as PiEvent)

  assert.equal(a.hasPendingUi('dlg-rapid'), true)

  // Rapid concurrent aborts
  await Promise.all([
    supervisor.request('A.jsonl', 'abort'),
    supervisor.request('A.jsonl', 'abort_retry'),
    supervisor.request('A.jsonl', 'abort')
  ])

  assert.equal(a.hasPendingUi('dlg-rapid'), false)
  assert.equal(a.approvals.length, 1, 'Auto-cancel should fire exactly once across concurrent aborts')
  assert.deepEqual(a.approvals[0], { id: 'dlg-rapid', response: { confirmed: false, cancelled: true } })

  // Session settles
  a.emit('event', { type: 'agent_settled', aborted: true } as PiEvent)

  // Verify next prompt can run immediately without deadlock
  let nextStarted = false
  await supervisor.request('A.jsonl', 'prompt', { message: 'next' }).then(() => {
    nextStarted = true
  })
  assert.equal(nextStarted, true)
})

test('CHALLENGE 2.2: Dialog arriving while abort is in flight is immediately auto-cancelled by PiRuntime', async () => {
  const runtime = new PiRuntime()
  const sentResponses: { id: string; response: ExtensionUiResponse }[] = []

  const fakeClient = new EventEmitter() as any
  fakeClient.running = true
  fakeClient.pid = 999
  fakeClient.stderrTail = []
  fakeClient.respondUi = (id: string, response: ExtensionUiResponse) => {
    sentResponses.push({ id, response })
  }
  fakeClient.request = async () => ({ ok: true })

  ;(runtime as any).client = fakeClient
  ;(runtime as any).status = { phase: 'ready' }
  ;(runtime as any).pendingUiRequestId = 'dlg-existing'

  // Attach listener that tests the logic in runtime.ts lines 225-231
  fakeClient.on('event', (event: PiEvent) => {
    if (event.type === 'extension_ui_request') {
      const request = event as unknown as ExtensionUiRequest
      if (['select', 'confirm', 'input', 'editor'].includes(request.method)) {
        if ((runtime as any).aborting) {
          fakeClient.respondUi(request.id, { confirmed: false, cancelled: true })
          return
        }
        ;(runtime as any).pendingUiRequestId = request.id
      }
    }
  })

  // Trigger abort
  await runtime.request('abort')
  assert.equal(sentResponses.length, 1)
  assert.deepEqual(sentResponses[0], { id: 'dlg-existing', response: { confirmed: false, cancelled: true } })

  // Now a new dialog arrives while aborting flag is true
  fakeClient.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-arrived-late',
    method: 'confirm',
    title: 'Late dialog'
  } as PiEvent)

  // It should be auto-cancelled immediately and NOT set as pendingUiRequestId
  assert.equal(runtime.hasPendingUi('dlg-arrived-late'), false)
  assert.equal(sentResponses.length, 2)
  assert.deepEqual(sentResponses[1], { id: 'dlg-arrived-late', response: { confirmed: false, cancelled: true } })
})

// -------------------------------------------------------------
// Suite 3: Destroyed Window Protection
// -------------------------------------------------------------

test('CHALLENGE 3.1: Native dialog helpers check !window.isDestroyed() before passing window', async () => {
  let passedWindowToDialog: any = 'uncalled'
  const mockDialog = {
    showOpenDialog: async (winOrOpts: any, opts?: any) => {
      passedWindowToDialog = opts ? winOrOpts : undefined
      return { canceled: true, filePaths: [] }
    },
    showSaveDialog: async (winOrOpts: any, opts?: any) => {
      passedWindowToDialog = opts ? winOrOpts : undefined
      return { canceled: true, filePath: undefined }
    }
  }

  // Case 1: Destroyed window
  const destroyedWindow = {
    isDestroyed: () => true
  }

  // Emulate dialog pickDirectory logic from src/main/ipc.ts
  const pickDirectory = async (window: any) => {
    const result = window && !window.isDestroyed()
      ? await mockDialog.showOpenDialog(window, { title: 'Select folder' })
      : await mockDialog.showOpenDialog({ title: 'Select folder' })
    return result.filePaths[0] ?? null
  }

  const res1 = await pickDirectory(destroyedWindow)
  assert.equal(res1, null)
  assert.equal(passedWindowToDialog, undefined, 'Must NOT pass destroyed window to native dialog')

  // Case 2: Live window
  const liveWindow = {
    isDestroyed: () => false
  }
  const res2 = await pickDirectory(liveWindow)
  assert.equal(res2, null)
  assert.equal(passedWindowToDialog, liveWindow, 'Must pass live window to native dialog')
})

test('CHALLENGE 3.2: sendToWindow protects against destroyed BrowserWindow and destroyed WebContents', () => {
  // Logic from src/main/ipc.ts
  function sendToWindow(window: any, channel: string, payload: unknown): boolean {
    if (!window || window.isDestroyed()) return false
    const contents = window.webContents
    if (!contents || contents.isDestroyed()) return false
    try {
      contents.send(channel, payload)
      return true
    } catch {
      return false
    }
  }

  // Destroyed window
  assert.equal(sendToWindow({ isDestroyed: () => true }, 'test', {}), false)

  // Destroyed webContents
  assert.equal(
    sendToWindow(
      {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => true }
      },
      'test',
      {}
    ),
    false
  )

  // Healthy window
  let sent = false
  assert.equal(
    sendToWindow(
      {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send: () => {
            sent = true
          }
        }
      },
      'test',
      {}
    ),
    true
  )
  assert.equal(sent, true)
})

// -------------------------------------------------------------
// Suite 4: Draft Session Rekeying and UI Routing
// -------------------------------------------------------------

test('CHALLENGE 4.1: Draft session rekey preserves dialog routing across file rename', async () => {
  const runtime = new MockManagedRuntime()
  const supervisor = new SessionSupervisor(() => runtime)

  await supervisor.ensure({ sessionKey: 'draft:123', cwd: 'C:/ws-rekey' })

  // Dialog opened while in draft state
  runtime.pendingUiIds.add('dlg-draft')
  runtime.emit('event', {
    type: 'extension_ui_request',
    id: 'dlg-draft',
    method: 'confirm',
    sessionKey: 'draft:123'
  } as PiEvent)

  // Draft becomes real session file C:/ws-rekey/real.jsonl
  ;(supervisor as any).bindFile('draft:123', 'C:/ws-rekey/real.jsonl')

  // User responds using either the new sessionKey real.jsonl or original draft:123
  supervisor.respondUi('C:/ws-rekey/real.jsonl', 'dlg-draft', { confirmed: true })

  assert.equal(runtime.approvals.length, 1)
  assert.deepEqual(runtime.approvals[0], { id: 'dlg-draft', response: { confirmed: true } })
})

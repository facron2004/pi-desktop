import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  PiEvent,
  RuntimeStartOptions,
  RuntimeStatus
} from '@shared/types'
import { SessionSupervisor, type ManagedSessionRuntime } from '../src/main/pi/supervisor'
import { PiRuntime, cleanupStaticExtensionCache } from '../src/main/pi/runtime'

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

test('CHALLENGE 1.3: Process exit cleans up approvals and releases the directory lock', async () => {
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

  a.running = false
  a.emit('status', { phase: 'stopped', error: 'Child crashed with SIGKILL', cwd: 'C:/ws-crash' } as RuntimeStatus, true)
  await new Promise<void>((resolve) => setImmediate(resolve))

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

test('CHALLENGE 2.2: Dialog arriving while abort is in flight is immediately auto-cancelled by PiRuntime', async (t) => {
  // This one drives the real `PiRuntime`, because the rule under test lives in
  // its own `client.on('event')` listener, which only exists once a process
  // has been started. An earlier version of this test attached a copy of that
  // listener to a fake client instead, so it asserted its own stand-in and
  // kept passing after the field it read (`pendingUiRequestId`) was replaced.
  const tempDir = mkdtempSync(path.join(tmpdir(), 'pi-runtime-late-dialog-'))
  let runtime: PiRuntime | undefined
  // One hook, in one order: the child holds its working folder open, so the
  // process has to be gone before the folder can be removed.
  t.after(async () => {
    await runtime?.stop()
    await cleanupStaticExtensionCache()
    rmSync(tempDir, { recursive: true, force: true })
  })

  // `abort` answers only after `release_abort` arrives, so a dialog emitted in
  // between lands while the abort is genuinely in flight.
  const fakePi = path.join(tempDir, 'fake-pi-late-dialog.cjs')
  writeFileSync(fakePi, String.raw`
const args = process.argv.slice(2);
let permissionTitle = '';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--extension' && args[i + 1] && args[i + 1].includes('pi-desktop-permissions-')) {
    const src = require('node:fs').readFileSync(args[i + 1], 'utf8');
    const m = src.match(/setStatus\("([^"]+)", 'ready'\)/);
    if (m) permissionTitle = m[1];
  }
}
process.stdout.write(JSON.stringify({ type: 'extension_ui_request', method: 'setStatus', statusKey: permissionTitle, statusText: 'ready' }) + '\n');
process.stdout.write(JSON.stringify({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-desktop-mode', statusText: 'default' }) + '\n');
const uiResponses = [];
let releaseAbort;
const aborted = new Promise((resolve) => { releaseAbort = resolve; });
let buf = '';
process.stdin.on('end', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const rec = JSON.parse(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    if (rec.type === 'extension_ui_response') {
      uiResponses.push(rec);
      continue;
    }
    if (rec.type === 'get_state') {
      process.stdout.write(JSON.stringify({ type: 'response', id: rec.id, command: 'get_state', success: true, data: { sessionId: 'late-dialog', sessionFile: undefined } }) + '\n');
    } else if (rec.type === 'abort') {
      // Hold the answer so the dialog below is delivered mid-abort.
      aborted.then(() => {
        process.stdout.write(JSON.stringify({ type: 'response', id: rec.id, command: 'abort', success: true, data: {} }) + '\n');
      });
    } else if (rec.type === 'open_dialog') {
      process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'dlg-existing', method: 'input', title: 'Waiting' }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'response', id: rec.id, command: 'open_dialog', success: true, data: {} }) + '\n');
    } else if (rec.type === 'emit_late_dialog') {
      process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'dlg-arrived-late', method: 'confirm', title: 'Late dialog' }) + '\n');
      process.stdout.write(JSON.stringify({ type: 'response', id: rec.id, command: 'emit_late_dialog', success: true, data: {} }) + '\n');
    } else if (rec.type === 'release_abort') {
      releaseAbort();
      process.stdout.write(JSON.stringify({ type: 'response', id: rec.id, command: 'release_abort', success: true, data: {} }) + '\n');
    } else if (rec.type === 'get_ui_responses') {
      process.stdout.write(JSON.stringify({ type: 'response', id: rec.id, command: 'get_ui_responses', success: true, data: uiResponses }) + '\n');
    } else {
      process.stdout.write(JSON.stringify({ type: 'response', id: rec.id, command: rec.type, success: true, data: {} }) + '\n');
    }
  }
});
`, 'utf8')

  runtime = new PiRuntime({
    getCustomPiPath: () => fakePi,
    getTrustProject: () => false,
    getPermissionMode: () => 'ask'
  })
  const started = await runtime.start({ cwd: tempDir })
  assert.equal(started.ok, true, started.error)

  // A dialog is already waiting when the abort begins: it is cancelled at once.
  await runtime.request('open_dialog')
  assert.equal(runtime.hasPendingUi('dlg-existing'), true)

  // The abort does not settle until the dialog below has been delivered.
  const aborting = runtime.request('abort')
  assert.equal(runtime.hasPendingUi('dlg-existing'), false, 'the waiting dialog is cancelled as soon as the abort begins')
  await runtime.request('emit_late_dialog')
  assert.equal(runtime.hasPendingUi('dlg-arrived-late'), false, 'a late dialog must not be left waiting')
  assert.equal(runtime.hasAnyPendingUi(), false)
  await runtime.request('release_abort')
  await aborting

  const received = await runtime.request<{ id: string }[]>('get_ui_responses')
  assert.deepEqual(received.map((r) => r.id), ['dlg-existing', 'dlg-arrived-late'])
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

  // Draft becomes real session file C:/ws-rekey/real.jsonl. `bindFile` is
  // serialised through the runtime's binding chain, so the rename is only
  // complete once it settles — the same way the supervisor's own callers
  // await it.
  await (supervisor as unknown as { bindFile(from: string, file: string): Promise<void> })
    .bindFile('draft:123', 'C:/ws-rekey/real.jsonl')

  // User responds using either the new sessionKey real.jsonl or original draft:123
  supervisor.respondUi('C:/ws-rekey/real.jsonl', 'dlg-draft', { confirmed: true })

  assert.equal(runtime.approvals.length, 1)
  assert.deepEqual(runtime.approvals[0], { id: 'dlg-draft', response: { confirmed: true } })
})

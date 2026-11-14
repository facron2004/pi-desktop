import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ExtensionUiResponse, PiEvent, RuntimeStartOptions, RuntimeStatus } from '@shared/types'
import { SessionSupervisor, MAX_IDLE_RUNTIMES, type ManagedSessionRuntime } from '../src/main/pi/supervisor'

interface RecordedCommand {
  command: string
  payload: Record<string, unknown>
}

class FakeRuntime extends EventEmitter implements ManagedSessionRuntime {
  readonly commands: RecordedCommand[] = []
  starts = 0
  stops = 0
  pid?: number
  approvals: { id: string; response: ExtensionUiResponse }[] = []
  running = false
  status: RuntimeStatus = { phase: 'stopped' }
  boundFile?: string
  failStart = false
  settleOnAbort = false
  pendingUiIds = new Set<string>()

  get isRunning(): boolean {
    return this.running
  }

  get currentStatus(): RuntimeStatus {
    return { ...this.status }
  }

  hasPendingUi(id: string): boolean {
    return this.pendingUiIds.has(id)
  }

  async start(options: RuntimeStartOptions): Promise<{ ok: boolean; error?: string }> {
    this.starts += 1
    if (this.failStart) {
      this.running = false
      this.status = { phase: 'error', cwd: options.cwd, error: 'boom' }
      return { ok: false, error: 'boom' }
    }
    this.running = true
    const sessionFile = options.sessionFile ?? this.boundFile
    this.status = { phase: 'ready', cwd: options.cwd, sessionFile, sessionId: 'pi' }
    return { ok: true }
  }

  async request<T = unknown>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.commands.push({ command, payload })
    if (command === 'get_state') {
      return { sessionFile: this.boundFile ?? this.status.sessionFile, sessionId: 'pi' } as T
    }
    if (command === 'prompt') return { disposition: 'started' } as T
    if (command === 'abort' && this.settleOnAbort) {
      this.emit('event', { type: 'agent_settled', aborted: true } as PiEvent)
    }
    return { ok: true } as T
  }

  respondUi(id: string, response: ExtensionUiResponse): void {
    this.approvals.push({ id, response })
    this.pendingUiIds.delete(id)
  }

  async stop(): Promise<void> {
    this.stops += 1
    this.running = false
    this.status = { phase: 'stopped', cwd: this.status.cwd }
  }
}

function supervisorOf(runtimes: FakeRuntime[], cwdLockDirectory?: string): SessionSupervisor {
  const pending = [...runtimes]
  return new SessionSupervisor(() => {
    const next = pending.shift()
    if (!next) {
      const fallback = new FakeRuntime()
      return fallback
    }
    return next
  }, cwdLockDirectory)
}

test('Stress: Boot 10+ distinct sessions sequentially and enforce MAX_IDLE_RUNTIMES cap', async () => {
  const runtimes: FakeRuntime[] = Array.from({ length: 12 }, () => new FakeRuntime())
  const supervisor = supervisorOf(runtimes)

  // Boot 12 distinct sessions sequentially
  for (let i = 0; i < 12; i++) {
    const res = await supervisor.ensure({ sessionKey: `session-${i}`, cwd: `C:/test/cwd-${i}` })
    assert.deepEqual(res, { ok: true })
  }

  // Allow any pending prune promises to settle
  await new Promise((r) => setTimeout(r, 50))

  const runningKeys = supervisor.runningKeys()
  const runningCount = runtimes.filter((r) => r.isRunning).length
  assert.ok(
    runningCount <= MAX_IDLE_RUNTIMES,
    `Running idle runtimes count (${runningCount}) must be <= MAX_IDLE_RUNTIMES (${MAX_IDLE_RUNTIMES})`
  )
  assert.equal(runningKeys.length, runningCount)

  // Exactly 12 - 4 = 8 oldest runtimes should be evicted
  const stoppedCount = runtimes.filter((r) => r.stops >= 1).length
  assert.equal(stoppedCount, 12 - MAX_IDLE_RUNTIMES)

  // The last 4 (session-8, 9, 10, 11) should still be running
  for (let i = 8; i < 12; i++) {
    assert.equal(runtimes[i].isRunning, true, `session-${i} should still be running`)
  }

  await supervisor.stop()
})

test('Stress: Boot 10+ distinct sessions concurrently and enforce MAX_IDLE_RUNTIMES cap without failing ensure', async () => {
  const runtimes: FakeRuntime[] = Array.from({ length: 12 }, () => new FakeRuntime())
  const supervisor = supervisorOf(runtimes)

  // Boot 12 distinct sessions concurrently
  const promises = runtimes.map((_, i) =>
    supervisor.ensure({ sessionKey: `session-${i}`, cwd: `C:/test/cwd-${i}` })
  )
  const results = await Promise.all(promises)
  const failures = results.map((res, i) => ({ i, res })).filter((x) => !x.res.ok)
  
  // Note: If pruneIdleRuntimes evicts runtimes while their ensure() is still in-flight,
  // ensure() returns { ok: false }!
  assert.equal(
    failures.length,
    0,
    `Concurrent ensure() failed for ${failures.length} sessions! Failures: ${JSON.stringify(failures)}`
  )

  await supervisor.stop()
})

test('Stress: Process with activity.writes > 0 is NEVER evicted even when oldest', async () => {
  const runtimes: FakeRuntime[] = Array.from({ length: 8 }, () => new FakeRuntime())
  const supervisor = supervisorOf(runtimes)

  await supervisor.ensure({ sessionKey: 'session-0', cwd: 'C:/test/cwd-0' })

  // Simulate an in-flight write command that takes time to respond
  let finishPrompt: (val: unknown) => void = () => {}
  const slowPromptPromise = new Promise((resolve) => {
    finishPrompt = resolve
  })
  runtimes[0].request = async (command: string, payload: Record<string, unknown> = {}) => {
    runtimes[0].commands.push({ command, payload })
    if (command === 'prompt') {
      await slowPromptPromise
      return { disposition: 'started' }
    }
    return { ok: true }
  }

  // Launch prompt in background (writes becomes 1)
  const promptTask = supervisor.request('session-0', 'prompt')

  // Boot 6 more idle sessions
  for (let i = 1; i <= 6; i++) {
    await supervisor.ensure({ sessionKey: `session-${i}`, cwd: `C:/test/cwd-${i}` })
  }

  await new Promise((r) => setTimeout(r, 30))

  // session-0 has writes > 0 (even before disposition sets running = true)
  assert.equal(runtimes[0].stops, 0, 'session-0 with writes > 0 must NOT be evicted')
  assert.equal(runtimes[0].isRunning, true)

  // Complete prompt
  finishPrompt({ disposition: 'started' })
  await promptTask

  // Settle session-0
  runtimes[0].emit('event', { type: 'agent_settled' } as PiEvent)
  await supervisor.stop()
})

test('Stress: Active running process (activity.running === true) is NEVER evicted even when oldest', async () => {
  const runtimes: FakeRuntime[] = Array.from({ length: 12 }, () => new FakeRuntime())
  const supervisor = supervisorOf(runtimes)

  // Start Session 0 and make it active running
  await supervisor.ensure({ sessionKey: 'session-0', cwd: 'C:/test/cwd-0' })
  await supervisor.request('session-0', 'prompt')
  runtimes[0].emit('event', { type: 'agent_start' } as PiEvent)
  assert.equal(supervisor.sessionInfo('session-0')?.running, true)

  // Now boot 10 subsequent idle sessions (session-1 to session-10)
  for (let i = 1; i <= 10; i++) {
    await supervisor.ensure({ sessionKey: `session-${i}`, cwd: `C:/test/cwd-${i}` })
  }

  await new Promise((r) => setTimeout(r, 50))

  // Session 0 was the oldest, but it is active running!
  assert.equal(runtimes[0].stops, 0, 'Active running session-0 must NEVER be evicted')
  assert.equal(runtimes[0].isRunning, true)

  // The running count should be 1 (active) + 4 (max idle) = 5
  const runningRuntimes = runtimes.filter((r) => r.isRunning)
  assert.equal(runningRuntimes.length, 1 + MAX_IDLE_RUNTIMES)

  // Settle Session 0
  runtimes[0].emit('event', { type: 'agent_settled' } as PiEvent)
  await supervisor.stop()
})

test('Stress: Process with pending UI approvals is NEVER evicted even when oldest', async () => {
  const runtimes: FakeRuntime[] = Array.from({ length: 10 }, () => new FakeRuntime())
  const supervisor = supervisorOf(runtimes)

  // Start Session 0 and emit an extension UI request
  await supervisor.ensure({ sessionKey: 'session-0', cwd: 'C:/test/cwd-0' })
  runtimes[0].pendingUiIds.add('confirm-1')
  runtimes[0].emit('event', {
    type: 'extension_ui_request',
    method: 'confirm',
    id: 'confirm-1'
  } as PiEvent)

  // Boot 8 subsequent idle sessions
  for (let i = 1; i <= 8; i++) {
    await supervisor.ensure({ sessionKey: `session-${i}`, cwd: `C:/test/cwd-${i}` })
  }

  await new Promise((r) => setTimeout(r, 50))

  // Session 0 must not be evicted
  assert.equal(runtimes[0].stops, 0, 'Session with pending UI approval must NOT be evicted')
  assert.equal(runtimes[0].isRunning, true)

  await supervisor.stop()
})

test('Stress: Process holding CWD gate or with queued jobs is NEVER evicted even when oldest', async () => {
  const runtimes: FakeRuntime[] = Array.from({ length: 10 }, () => new FakeRuntime())
  const supervisor = supervisorOf(runtimes)

  // session-0 and session-1 share the same CWD
  await supervisor.ensure({ sessionKey: 'session-0', cwd: 'C:/shared-cwd' })
  await supervisor.ensure({ sessionKey: 'session-1', cwd: 'C:/shared-cwd' })

  // session-0 claims the CWD gate via prompt
  const p0 = supervisor.request('session-0', 'prompt')
  // session-1 queues behind session-0
  const p1 = supervisor.request('session-1', 'prompt')

  // Boot 7 more independent sessions
  for (let i = 2; i <= 8; i++) {
    await supervisor.ensure({ sessionKey: `session-${i}`, cwd: `C:/test/cwd-${i}` })
  }

  await new Promise((r) => setTimeout(r, 50))

  // Neither session-0 (holding lease) nor session-1 (queued) should be evicted
  assert.equal(runtimes[0].stops, 0, 'CWD lease holder session-0 must NOT be evicted')
  assert.equal(runtimes[1].stops, 0, 'Queued session-1 must NOT be evicted')

  // Clean up
  runtimes[0].emit('event', { type: 'agent_settled' } as PiEvent)
  runtimes[1].emit('event', { type: 'agent_settled' } as PiEvent)
  await p0
  await p1
  await supervisor.stop()
})

test('Stress: Sub-millisecond sequential access properly updates lastAccessed and protects touched runtime', async () => {
  const runtimes: FakeRuntime[] = Array.from({ length: 8 }, () => new FakeRuntime())
  const supervisor = supervisorOf(runtimes)

  // Boot 4 sessions in sub-millisecond tight loop
  await supervisor.ensure({ sessionKey: 'session-0', cwd: 'C:/test/cwd-0' })
  await supervisor.ensure({ sessionKey: 'session-1', cwd: 'C:/test/cwd-1' })
  await supervisor.ensure({ sessionKey: 'session-2', cwd: 'C:/test/cwd-2' })
  await supervisor.ensure({ sessionKey: 'session-3', cwd: 'C:/test/cwd-3' })

  // Sub-millisecond touch: re-access session-0
  await supervisor.ensure({ sessionKey: 'session-0', cwd: 'C:/test/cwd-0' })

  // Boot session-4 (5th idle runtime, triggers prune)
  await supervisor.ensure({ sessionKey: 'session-4', cwd: 'C:/test/cwd-4' })
  await new Promise((r) => setTimeout(r, 20))

  // session-0 was touched, so session-1 must be the one evicted!
  assert.equal(runtimes[0].stops, 0, 'Touched session-0 must NOT be evicted')
  assert.equal(runtimes[1].stops, 1, 'Untouched oldest session-1 should be evicted')

  // Now touch session-2
  await supervisor.request('session-2', 'get_state')

  // Boot session-5 (triggers prune)
  await supervisor.ensure({ sessionKey: 'session-5', cwd: 'C:/test/cwd-5' })
  await new Promise((r) => setTimeout(r, 20))

  // session-3 was older than touched session-2 and touched session-0, so session-3 should be evicted
  assert.equal(runtimes[2].stops, 0, 'Touched session-2 must NOT be evicted')
  assert.equal(runtimes[3].stops, 1, 'Untouched session-3 should be evicted')

  await supervisor.stop()
})

test('Adversarial Challenge: respondUi lastAccessed timestamp bug', async () => {
  const runtimes: FakeRuntime[] = Array.from({ length: 6 }, () => new FakeRuntime())
  const supervisor = supervisorOf(runtimes)

  // Boot 4 idle runtimes: A, B, C, D
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/a' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/b' })
  await supervisor.ensure({ sessionKey: 'C', cwd: 'C:/c' })
  await supervisor.ensure({ sessionKey: 'D', cwd: 'C:/d' })

  // Session A has a pending dialog
  runtimes[0].pendingUiIds.add('dlg-1')
  runtimes[0].emit('event', {
    type: 'extension_ui_request',
    method: 'confirm',
    id: 'dlg-1'
  } as PiEvent)

  // User responds to the dialog on A
  // This executes: supervisor.respondUi('A', 'dlg-1', { confirmed: true })
  supervisor.respondUi('A', 'dlg-1', { confirmed: true })

  // Session A is now idle, and was literally JUST touched by the user via respondUi!
  // It is the MOST RECENTLY interacted session.
  // Now ensure E (making 5 idle sessions: A, B, C, D, E)
  await supervisor.ensure({ sessionKey: 'E', cwd: 'C:/e' })
  await new Promise((r) => setTimeout(r, 30))

  // In a correct LRU implementation, B (or C) should be evicted as least recently used,
  // and A must NOT be evicted because user just interacted with A.
  // However, because respondUi sets lastAccessed = Date.now() (milliseconds)
  // while touchRuntime sets lastAccessed = Date.now() * 1000 + accessClock (microseconds),
  // A's timestamp is 1000x smaller (Jan 1970 in microsecond units), so A gets wrongly evicted!
  const aEvicted = runtimes[0].stops > 0
  const bEvicted = runtimes[1].stops > 0

  assert.equal(
    aEvicted,
    false,
    `BUG DETECTED: Session A was evicted right after respondUi! aEvicted=${aEvicted}, bEvicted=${bEvicted}. This is caused by respondUi assigning Date.now() instead of this.touchRuntime(activity).`
  )

  await supervisor.stop()
})

test('Stress: Rapid concurrent start/stop and prune under CWD contention', async () => {
  const runtimes: FakeRuntime[] = Array.from({ length: 20 }, () => new FakeRuntime())
  const supervisor = supervisorOf(runtimes)

  // Blast concurrent operations across overlapping and independent cwds
  const operations: Promise<unknown>[] = []
  for (let i = 0; i < 20; i++) {
    const cwd = `C:/cwd-${i % 4}` // 4 shared CWDs to force contention
    const key = `session-${i}`
    operations.push(
      (async () => {
        await supervisor.ensure({ sessionKey: key, cwd })
        if (i % 2 === 0) {
          await supervisor.request(key, 'get_state').catch(() => {})
        }
        if (i % 5 === 0) {
          await supervisor.stop(key).catch(() => {})
        }
      })()
    )
  }

  await Promise.all(operations)
  await new Promise((r) => setTimeout(r, 100))

  // Ensure no deadlocks and supervisor is responsive
  assert.ok(true, 'Rapid concurrent start/stop completed without deadlock')
  await supervisor.stop()
})

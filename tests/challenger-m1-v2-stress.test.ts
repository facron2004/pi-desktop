import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ExtensionUiResponse, PiEvent, RuntimeStartOptions, RuntimeStatus } from '@shared/types'
import { SessionSupervisor, MAX_IDLE_RUNTIMES, type ManagedSessionRuntime } from '../src/main/pi/supervisor'

interface RecordedCommand {
  command: string
  payload: Record<string, unknown>
}

class AdvancedFakeRuntime extends EventEmitter implements ManagedSessionRuntime {
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
  startDelayMs = 0
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
    if (this.startDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.startDelayMs))
    }
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
    if (command === 'set_session_name') return { ok: true } as T
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

function supervisorOf(runtimes: AdvancedFakeRuntime[], cwdLockDirectory?: string): SessionSupervisor {
  const pending = [...runtimes]
  return new SessionSupervisor(() => {
    const next = pending.shift()
    if (!next) {
      return new AdvancedFakeRuntime()
    }
    return next
  }, cwdLockDirectory)
}

test('Challenger Stress: 24 concurrent boots with asynchronous spawn latency all succeed with ok: true', async () => {
  const count = 24
  const runtimes: AdvancedFakeRuntime[] = Array.from({ length: count }, (_, i) => {
    const r = new AdvancedFakeRuntime()
    // Simulated variable async spawn latency between 5ms and 30ms
    r.startDelayMs = 5 + (i % 5) * 5
    return r
  })
  const supervisor = supervisorOf(runtimes)

  // Launch 24 concurrent boots
  const bootPromises = runtimes.map((_, i) =>
    supervisor.ensure({
      sessionKey: `session-${i}`,
      cwd: `C:/test/cwd-${i}`
    })
  )

  const results = await Promise.all(bootPromises)
  const failed = results.filter((r) => !r.ok)

  assert.equal(
    failed.length,
    0,
    `All 24 concurrent boots must succeed with ok: true. Failed: ${JSON.stringify(failed)}`
  )

  // Allow pending background prunes to settle
  await new Promise((r) => setTimeout(r, 60))

  const runningRuntimes = runtimes.filter((r) => r.isRunning)
  assert.ok(
    runningRuntimes.length <= MAX_IDLE_RUNTIMES,
    `Running idle count (${runningRuntimes.length}) must be <= MAX_IDLE_RUNTIMES (${MAX_IDLE_RUNTIMES})`
  )

  const runningKeys = supervisor.runningKeys()
  assert.equal(
    runningKeys.length,
    runningRuntimes.length,
    'supervisor.runningKeys() must match number of running runtimes'
  )

  // Exactly count - MAX_IDLE_RUNTIMES runtimes should have been evicted
  const stoppedCount = runtimes.filter((r) => r.stops >= 1).length
  assert.equal(stoppedCount, count - runningRuntimes.length)

  await supervisor.stop()
})

test('Challenger Adversarial: Strict multi-session respondUi LRU eviction order validation', async () => {
  const runtimes: AdvancedFakeRuntime[] = Array.from({ length: 8 }, () => new AdvancedFakeRuntime())
  const supervisor = supervisorOf(runtimes)

  // Boot 4 idle runtimes: S0, S1, S2, S3
  await supervisor.ensure({ sessionKey: 'S0', cwd: 'C:/s0' })
  await supervisor.ensure({ sessionKey: 'S1', cwd: 'C:/s1' })
  await supervisor.ensure({ sessionKey: 'S2', cwd: 'C:/s2' })
  await supervisor.ensure({ sessionKey: 'S3', cwd: 'C:/s3' })

  // Attach pending dialogs to S0 and S1
  runtimes[0].pendingUiIds.add('dlg-0')
  runtimes[0].emit('event', { type: 'extension_ui_request', method: 'confirm', id: 'dlg-0' } as PiEvent)

  runtimes[1].pendingUiIds.add('dlg-1')
  runtimes[1].emit('event', { type: 'extension_ui_request', method: 'confirm', id: 'dlg-1' } as PiEvent)

  // S0 and S1 have approvals. Now respond to S0 first
  supervisor.respondUi('S0', 'dlg-0', { confirmed: true })

  // Small delay to ensure distinct microseconds if clock advances
  await new Promise((r) => setTimeout(r, 5))

  // Now respond to S1 second (S1 is more recently accessed than S0)
  supervisor.respondUi('S1', 'dlg-1', { confirmed: true })

  // At this point:
  // S2: boot time (oldest of untouched)
  // S3: boot time (newer than S2)
  // S0: responded at T1 (newer than S3)
  // S1: responded at T2 (newest)
  // Current idle count = 4: S2, S3, S0, S1.

  // Boot S4 -> triggers prune of 1 oldest idle runtime. Oldest is S2!
  await supervisor.ensure({ sessionKey: 'S4', cwd: 'C:/s4' })
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(runtimes[2].stops, 1, 'Oldest untouched S2 must be evicted first')
  assert.equal(runtimes[3].stops, 0, 'S3 must still be running')
  assert.equal(runtimes[0].stops, 0, 'Responded S0 must NOT be evicted')
  assert.equal(runtimes[1].stops, 0, 'Responded S1 must NOT be evicted')

  // Boot S5 -> triggers prune of next oldest idle runtime. Next oldest is S3!
  await supervisor.ensure({ sessionKey: 'S5', cwd: 'C:/s5' })
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(runtimes[3].stops, 1, 'S3 must be evicted next')
  assert.equal(runtimes[0].stops, 0, 'Responded S0 must STILL be running')
  assert.equal(runtimes[1].stops, 0, 'Responded S1 must STILL be running')

  // Boot S6 -> triggers prune of next oldest. Next oldest is S0 (responded before S1)!
  await supervisor.ensure({ sessionKey: 'S6', cwd: 'C:/s6' })
  await new Promise((r) => setTimeout(r, 30))

  assert.equal(runtimes[0].stops, 1, 'S0 was responded to before S1, so S0 must now be evicted')
  assert.equal(runtimes[1].stops, 0, 'S1 was responded to most recently, so S1 must STILL be running!')

  await supervisor.stop()
})

test('Challenger Adversarial: Hot rename refreshes LRU timestamp and prevents eviction', async () => {
  const runtimes: AdvancedFakeRuntime[] = Array.from({ length: 6 }, () => new AdvancedFakeRuntime())
  const supervisor = supervisorOf(runtimes)

  // Boot 4 idle runtimes: S0, S1, S2, S3
  await supervisor.ensure({ sessionKey: 'S0', cwd: 'C:/s0', sessionFile: 'C:/s0/session.jsonl' })
  await supervisor.ensure({ sessionKey: 'S1', cwd: 'C:/s1', sessionFile: 'C:/s1/session.jsonl' })
  await supervisor.ensure({ sessionKey: 'S2', cwd: 'C:/s2', sessionFile: 'C:/s2/session.jsonl' })
  await supervisor.ensure({ sessionKey: 'S3', cwd: 'C:/s3', sessionFile: 'C:/s3/session.jsonl' })

  // S0 was the oldest. Hot rename S0:
  const renamed = await supervisor.rename('C:/s0/session.jsonl', 'New Title For S0')
  assert.equal(renamed, true, 'Hot rename must succeed')

  // Boot S4 (5th idle runtime, triggers prune)
  await supervisor.ensure({ sessionKey: 'S4', cwd: 'C:/s4' })
  await new Promise((r) => setTimeout(r, 30))

  // Since S0 was renamed, its LRU timestamp was refreshed via touchRuntime.
  // The oldest untouched runtime is now S1!
  assert.equal(runtimes[0].stops, 0, 'Hot renamed S0 must NOT be evicted')
  assert.equal(runtimes[1].stops, 1, 'Untouched S1 must be evicted')

  await supervisor.stop()
})

test('Challenger Stress: CWD gate contention, directory queueing, and process cleanup under load', async () => {
  const runtimes: AdvancedFakeRuntime[] = Array.from({ length: 16 }, () => new AdvancedFakeRuntime())
  const supervisor = supervisorOf(runtimes)

  const sharedCwd = 'C:/repo'

  // Boot session-0 and session-1 in the same CWD
  await supervisor.ensure({ sessionKey: 'session-0', cwd: sharedCwd })
  await supervisor.ensure({ sessionKey: 'session-1', cwd: sharedCwd })

  // session-0 takes the CWD gate
  let finishP0: (v: unknown) => void = () => {}
  const p0Delay = new Promise((resolve) => {
    finishP0 = resolve
  })

  runtimes[0].request = async (command: string, payload: Record<string, unknown> = {}) => {
    runtimes[0].commands.push({ command, payload })
    if (command === 'prompt') {
      await p0Delay
      return { disposition: 'started' }
    }
    return { ok: true }
  }

  // S0 starts prompt and holds CWD lock
  const p0 = supervisor.request('session-0', 'prompt')

  // S1 queues behind S0
  const p1 = supervisor.request('session-1', 'prompt')

  // While S0 is writing and S1 is queued, boot 10 independent idle sessions
  for (let i = 2; i < 12; i++) {
    await supervisor.ensure({ sessionKey: `session-${i}`, cwd: `C:/other-${i}` })
  }

  await new Promise((r) => setTimeout(r, 40))

  // S0 (holding lock) and S1 (queued in directory gate) must NEVER be evicted!
  assert.equal(runtimes[0].stops, 0, 'S0 holding CWD lock must not be evicted')
  assert.equal(runtimes[1].stops, 0, 'S1 queued at CWD gate must not be evicted')

  // Finish S0 prompt
  finishP0({ disposition: 'started' })
  await p0

  // Settle S0 -> lock transfers to queued S1
  runtimes[0].emit('event', { type: 'agent_settled' } as PiEvent)

  // Now S1 completes its prompt
  await p1
  runtimes[1].emit('event', { type: 'agent_settled' } as PiEvent)

  // Settle everything and shut down
  await supervisor.stop()

  // All runtimes must be stopped cleanly
  assert.equal(supervisor.runningKeys().length, 0)
})

test('Challenger Adversarial: Abort mid-flight during heavy concurrent operations leaves clean state', async () => {
  const count = 16
  const runtimes: AdvancedFakeRuntime[] = Array.from({ length: count }, () => {
    const r = new AdvancedFakeRuntime()
    r.startDelayMs = 10
    return r
  })
  const supervisor = supervisorOf(runtimes)

  // Launch concurrent ensure calls
  const ensures = runtimes.map((_, i) =>
    supervisor.ensure({ sessionKey: `burst-${i}`, cwd: `C:/burst-${i % 3}` })
  )

  // Immediately initiate supervisor shutdown while boots are still in-flight
  await new Promise((r) => setTimeout(r, 5))
  const stopPromise = supervisor.stop()

  const [ensureResults] = await Promise.all([
    Promise.allSettled(ensures),
    stopPromise
  ])

  // None should have thrown an unhandled rejection
  for (const res of ensureResults) {
    if (res.status === 'fulfilled') {
      // Either ok: false (due to shutting down) or ok: true before shutdown hit
      assert.ok(typeof res.value.ok === 'boolean')
    }
  }

  // All runtimes must be stopped
  assert.equal(supervisor.runningKeys().length, 0)
  for (const r of runtimes) {
    assert.equal(r.isRunning, false, 'No runtime should remain running after supervisor.stop()')
  }
})

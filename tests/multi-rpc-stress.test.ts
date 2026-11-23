import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExtensionUiResponse, PiEvent, RuntimeStartOptions, RuntimeStatus } from '@shared/types'
import { SessionSupervisor, MAX_IDLE_RUNTIMES, type ManagedSessionRuntime } from '../src/main/pi/supervisor'
import { CwdGate } from '../src/main/pi/cwd-gate'

interface RecordedCommand {
  command: string
  payload: Record<string, unknown>
  timestamp: number
}

class StressRuntime extends EventEmitter implements ManagedSessionRuntime {
  readonly commands: RecordedCommand[] = []
  starts = 0
  stops = 0
  pid?: number
  running = false
  status: RuntimeStatus = { phase: 'stopped' }
  boundFile?: string
  failStart = false
  startDelayMs = 0
  settleOnAbort = true
  pendingUiIds = new Set<string>()
  approvals: { id: string; response: ExtensionUiResponse }[] = []
  activeStreaming = false
  streamingTimer?: NodeJS.Timeout

  constructor(public readonly id = Math.random().toString(36).slice(2)) {
    super()
    this.pid = 10000 + Math.floor(Math.random() * 50000)
  }

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
      this.status = { phase: 'error', cwd: options.cwd, error: 'simulated-boot-failure' }
      return { ok: false, error: 'simulated-boot-failure' }
    }
    this.running = true
    const sessionFile = options.sessionFile ?? this.boundFile
    this.status = { phase: 'ready', cwd: options.cwd, sessionFile, sessionId: `pi-${this.id}` }
    return { ok: true }
  }

  async request<T = unknown>(
    command: string,
    payload: Record<string, unknown> = {}
  ): Promise<T> {
    this.commands.push({ command, payload, timestamp: Date.now() })
    if (command === 'get_state') {
      return { sessionFile: this.boundFile ?? this.status.sessionFile, sessionId: `pi-${this.id}` } as T
    }
    if (command === 'prompt') {
      return { disposition: 'started' } as T
    }
    if (command === 'set_session_name') {
      return { ok: true } as T
    }
    if (command === 'clear_queue') {
      return { steering: [], followUp: [] } as T
    }
    if (command === 'abort') {
      if (this.streamingTimer) {
        clearInterval(this.streamingTimer)
        this.streamingTimer = undefined
      }
      this.activeStreaming = false
      if (this.settleOnAbort) {
        this.emit('event', { type: 'agent_settled', aborted: true } as PiEvent)
      }
      return { ok: true } as T
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
    if (this.streamingTimer) {
      clearInterval(this.streamingTimer)
      this.streamingTimer = undefined
    }
    this.activeStreaming = false
    this.status = { phase: 'stopped', cwd: this.status.cwd }
  }

  /**
   * Helper to simulate streaming tokens and final settlement
   */
  async simulateStream(tokenCount = 5, intervalMs = 10): Promise<void> {
    this.activeStreaming = true
    this.emit('event', { type: 'agent_start' } as PiEvent)
    return new Promise<void>((resolve) => {
      let count = 0
      this.streamingTimer = setInterval(() => {
        if (!this.running || !this.activeStreaming) {
          if (this.streamingTimer) clearInterval(this.streamingTimer)
          this.streamingTimer = undefined
          resolve()
          return
        }
        count++
        this.emit('event', {
          type: 'message_delta',
          delta: `token-${count} `
        } as unknown as PiEvent)

        if (count >= tokenCount) {
          if (this.streamingTimer) clearInterval(this.streamingTimer)
          this.streamingTimer = undefined
          this.activeStreaming = false
          this.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
          resolve()
        }
      }, intervalMs)
    })
  }

  /**
   * Helper to simulate abrupt process crash mid-stream
   */
  simulateCrash(errorReason = 'Process crashed abruptly with SIGSEGV'): void {
    if (this.streamingTimer) {
      clearInterval(this.streamingTimer)
      this.streamingTimer = undefined
    }
    this.activeStreaming = false
    this.running = false
    this.status = { phase: 'stopped', error: errorReason, cwd: this.status.cwd }
    this.emit('status', this.status, true)
  }

  /**
   * Helper to simulate an extension UI dialog request
   */
  simulateExtensionUi(dialogId: string, method: 'select' | 'confirm' | 'input' | 'editor' = 'confirm'): void {
    this.pendingUiIds.add(dialogId)
    this.emit('event', {
      type: 'extension_ui_request',
      method,
      id: dialogId
    } as unknown as PiEvent)
  }
}

function supervisorOf(runtimes: StressRuntime[], cwdLockDirectory?: string): SessionSupervisor {
  const pending = [...runtimes]
  return new SessionSupervisor(() => {
    const next = pending.shift()
    if (!next) {
      return new StressRuntime()
    }
    return next
  }, cwdLockDirectory)
}

test('Multi-RPC Stress: Parallel multi-session streaming across independent workspaces executes non-blocking with isolated event routing', async () => {
  const count = 4
  const workspaces = Array.from({ length: count }, (_, i) => `C:/workspaces/project-${String.fromCharCode(97 + i)}`)
  const runtimes = Array.from({ length: count }, (_, i) => new StressRuntime(`session-${i}`))
  const supervisor = supervisorOf(runtimes)

  const receivedEvents: { ownerId: string; type: string }[] = []
  supervisor.on('event', ({ ownerId, event }) => {
    receivedEvents.push({ ownerId, type: event.type })
  })

  // 1. Ensure all 4 independent sessions concurrently
  const ensureResults = await Promise.all(
    workspaces.map((cwd, i) => supervisor.ensure({ sessionKey: `session-${i}`, cwd }))
  )
  for (const res of ensureResults) {
    assert.deepEqual(res, { ok: true })
  }

  // 2. Dispatch prompt concurrently across all 4 sessions
  const activeStreams: { sessionKey: string; start: number; end?: number }[] = []
  let peakConcurrency = 0
  let currentConcurrency = 0

  const streamPromises = runtimes.map(async (runtime, i) => {
    const key = `session-${i}`
    await supervisor.request(key, 'prompt', { message: `Prompt ${i}` })
    currentConcurrency++
    peakConcurrency = Math.max(peakConcurrency, currentConcurrency)
    const streamRecord: { sessionKey: string; start: number; end?: number } = {
      sessionKey: key,
      start: Date.now()
    }
    activeStreams.push(streamRecord)

    // Simulate multi-token streaming
    await runtime.simulateStream(8, 15)

    streamRecord.end = Date.now()
    currentConcurrency--
  })

  await Promise.all(streamPromises)

  // Verify high concurrency: all 4 sibling workspaces ran concurrently without blocking
  assert.equal(peakConcurrency, 4, 'All 4 independent workspaces must stream in parallel')
  assert.equal(runtimes.every((r) => r.stops === 0), true, 'No runtime should have been stopped')

  // Verify event isolation: each session received its own agent_start, message_deltas, and agent_settled
  for (let i = 0; i < count; i++) {
    const sessionKey = `session-${i}`
    const eventsForSession = receivedEvents.filter((e) => e.ownerId === sessionKey)
    assert.ok(eventsForSession.length >= 10, `Session ${sessionKey} must receive all stream events`)
    assert.equal(eventsForSession[0].type, 'agent_start')
    assert.equal(eventsForSession[eventsForSession.length - 1].type, 'agent_settled')
  }

  await supervisor.stop()
})

test('Multi-RPC Stress: Same-cwd and nested-cwd sessions execute and stream in parallel with isolated event routing', async () => {
  const specs = [
    { key: 'root-1', cwd: 'C:/repos/monorepo' },
    { key: 'root-2', cwd: 'C:/repos/monorepo' },
    { key: 'nested-core', cwd: 'C:/repos/monorepo/packages/core' },
    { key: 'nested-web', cwd: 'C:/repos/monorepo/packages/web' },
    { key: 'root-3', cwd: 'C:/repos/monorepo' },
    { key: 'sibling-unrelated', cwd: 'C:/repos/independent-repo' }
  ]
  const runtimes = specs.map((spec) => new StressRuntime(spec.key))
  const supervisor = supervisorOf(runtimes)

  const queueEvents: { ownerId: string; queued: boolean }[] = []
  const receivedEvents: { ownerId: string; type: string }[] = []
  supervisor.on('queued', (event) => queueEvents.push({ ownerId: event.ownerId, queued: event.queued }))
  supervisor.on('event', ({ ownerId, event }) => {
    receivedEvents.push({ ownerId, type: event.type })
  })

  let peakConcurrency = 0
  let currentConcurrency = 0
  const streamPromises: Promise<unknown>[] = []
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]
    await supervisor.ensure({ sessionKey: spec.key, cwd: spec.cwd })
    // Dispatch each prompt before ensuring the next runtime so active sessions stay protected from idle LRU pruning.
    const p = supervisor.request(spec.key, 'prompt', { message: `Parallel ${spec.key}` }).then(async (res) => {
      currentConcurrency++
      peakConcurrency = Math.max(peakConcurrency, currentConcurrency)
      await runtimes[i].simulateStream(6, 15)
      currentConcurrency--
      return res
    })
    streamPromises.push(p)
  }
  const dispositions = await Promise.all(streamPromises)

  for (const res of dispositions) {
    assert.deepEqual(res, { disposition: 'started' })
  }
  assert.equal(queueEvents.length, 0, 'Same-cwd and nested shared conversations must never queue behind each other')
  assert.equal(peakConcurrency, specs.length, 'All 5 same/nested repo sessions and sibling must stream concurrently')
  for (const spec of specs) {
    const sessionEvents = receivedEvents.filter((e) => e.ownerId === spec.key)
    assert.ok(sessionEvents.length >= 8, `Session ${spec.key} must receive all stream events`)
    assert.equal(sessionEvents[0].type, 'agent_start')
    assert.equal(sessionEvents[sessionEvents.length - 1].type, 'agent_settled')
  }

  await supervisor.stop()
})

test('Multi-RPC Stress: Exclusive withCwdLock serializes identical and nested directories and drains queued writers concurrently in FIFO-per-cwd order', async () => {
  const rRoot1 = new StressRuntime('root-1')
  const rRoot2 = new StressRuntime('root-2')
  const rNestedCore = new StressRuntime('nested-core')
  const rNestedWeb = new StressRuntime('nested-web')
  const rRoot3 = new StressRuntime('root-3')
  const rSibling = new StressRuntime('sibling-unrelated')

  const supervisor = supervisorOf([rRoot1, rRoot2, rNestedCore, rNestedWeb, rRoot3, rSibling])

  let releaseLock!: () => void
  const lockPromise = supervisor.withCwdLock('C:/repos/monorepo', () => new Promise<void>((resolve) => {
    releaseLock = resolve
  }))

  const executionOrder: string[] = []
  const queueStarted = new Set<string>()
  supervisor.on('queued', (event) => {
    if (event.queued) queueStarted.add(event.ownerId)
  })

  let pRoot1: Promise<void> = Promise.resolve()
  let pRoot2: Promise<void> = Promise.resolve()
  let pNestedCore: Promise<void> = Promise.resolve()
  let pNestedWeb: Promise<void> = Promise.resolve()
  let pRoot3: Promise<void> = Promise.resolve()
  let pSibling: Promise<void> = Promise.resolve()

  try {
    // Ensure and enqueue each session sequentially so queued waiters remain protected from idle LRU pruning.
    await supervisor.ensure({ sessionKey: 'root-1', cwd: 'C:/repos/monorepo' })
    pRoot1 = supervisor.request('root-1', 'prompt', { message: 'first' }).then(() => {
      executionOrder.push('root-1')
    })
    await supervisor.ensure({ sessionKey: 'root-2', cwd: 'C:/repos/monorepo' })
    pRoot2 = supervisor.request('root-2', 'prompt', { message: 'second' }).then(() => {
      executionOrder.push('root-2')
    })
    await supervisor.ensure({ sessionKey: 'nested-core', cwd: 'C:/repos/monorepo/packages/core' })
    pNestedCore = supervisor.request('nested-core', 'prompt', { message: 'third' }).then(() => {
      executionOrder.push('nested-core')
    })
    await supervisor.ensure({ sessionKey: 'nested-web', cwd: 'C:/repos/monorepo/packages/web' })
    pNestedWeb = supervisor.request('nested-web', 'prompt', { message: 'fourth' }).then(() => {
      executionOrder.push('nested-web')
    })
    await supervisor.ensure({ sessionKey: 'root-3', cwd: 'C:/repos/monorepo' })
    pRoot3 = supervisor.request('root-3', 'prompt', { message: 'fifth' }).then(() => {
      executionOrder.push('root-3')
    })

    // Sibling on independent repository runs in parallel immediately!
    await supervisor.ensure({ sessionKey: 'sibling-unrelated', cwd: 'C:/repos/independent-repo' })
    let siblingExecuted = false
    pSibling = supervisor.request('sibling-unrelated', 'prompt', { message: 'independent' }).then(async () => {
      siblingExecuted = true
      rSibling.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
    })

    await pSibling
    assert.equal(siblingExecuted, true, 'Sibling in unrelated workspace must execute without waiting for C:/repos/monorepo lock')
    assert.equal(executionOrder.length, 0, 'Queued jobs for monorepo must still be waiting on exclusive withCwdLock')
    assert.deepEqual(
      [...queueStarted].sort(),
      ['nested-core', 'nested-web', 'root-1', 'root-2', 'root-3']
    )

    // Release the exclusive lock: all 5 queued shared jobs must dispatch concurrently in one drain pass
    releaseLock()
    await lockPromise
    await Promise.all([pRoot1, pRoot2, pNestedCore, pNestedWeb, pRoot3])

    assert.deepEqual(
      executionOrder,
      ['root-1', 'root-2', 'root-3', 'nested-core', 'nested-web'],
      'All queued shared writers must dispatch concurrently in FIFO-per-cwd order once the exclusive lock releases'
    )
    for (const key of ['root-1', 'root-2', 'root-3', 'nested-core', 'nested-web']) {
      assert.equal(supervisor.sessionInfo(key)?.running, true, `${key} should be active concurrently before settling`)
    }

    rRoot1.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
    rRoot2.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
    rRoot3.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
    rNestedCore.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
    rNestedWeb.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
  } finally {
    releaseLock()
    await supervisor.stop()
    await Promise.allSettled([lockPromise, pRoot1, pRoot2, pNestedCore, pNestedWeb, pRoot3, pSibling])
  }
})

test('Multi-RPC Stress: CWD queue saturation backpressure rejects requests at capacity and recovers gracefully', async () => {
  const queuedRuntimes = Array.from({ length: 65 }, (_, i) => new StressRuntime(`queued-${i}`))
  const supervisor = supervisorOf(queuedRuntimes)

  let releaseLock!: () => void
  const lockPromise = supervisor.withCwdLock('C:/queue-burst-repo', () => new Promise<void>((resolve) => {
    releaseLock = resolve
  }))

  // Fill directory queue up to MAX_QUEUED_JOBS_PER_CWD (64)
  const pendingJobs: Promise<unknown>[] = []
  try {
    for (let i = 0; i < 64; i++) {
      const key = `queued-${i}`
      await supervisor.ensure({ sessionKey: key, cwd: 'C:/queue-burst-repo' })
      const p = supervisor.request(key, 'prompt', { message: `Queued prompt ${i}` })
      p.catch(() => {})
      pendingJobs.push(p)
    }

    // The 65th queued job must be rejected with backpressure error
    const overflowKey = 'queued-64'
    await supervisor.ensure({ sessionKey: overflowKey, cwd: 'C:/queue-burst-repo' })
    await assert.rejects(
      supervisor.request(overflowKey, 'prompt', { message: 'Overflow prompt' }),
      /The working-folder queue is full/
    )

    // Verify clear_queue cancels queued prompts cleanly for a session
    const cleared = await supervisor.request<{ steering: string[] }>('queued-10', 'clear_queue')
    assert.ok(cleared, 'clear_queue should succeed')
    const cancelledResult = await pendingJobs[10]
    assert.deepEqual(cancelledResult, { disposition: 'handled', cancelled: true })
  } finally {
    // Stopping supervisor discharges queued jobs before the exclusive lock resolves
    await supervisor.stop()
    releaseLock()
    await Promise.allSettled([lockPromise, ...pendingJobs])
  }
})

test('Multi-RPC Stress: Rapid Abort Storm during concurrent streaming settles cleanly without orphaned processes or leaked gates', async () => {
  const count = 8
  const runtimes = Array.from({ length: count }, (_, i) => new StressRuntime(`abort-target-${i}`))
  const supervisor = supervisorOf(runtimes)

  const settledEvents: { ownerId: string; aborted: boolean }[] = []
  supervisor.on('event', ({ ownerId, event }) => {
    if (event.type === 'agent_settled') {
      settledEvents.push({ ownerId, aborted: Boolean((event as { aborted?: boolean }).aborted) })
    }
  })

  // Boot 8 distinct sessions across separate directories and immediately start prompting
  for (let i = 0; i < count; i++) {
    const key = `abort-target-${i}`
    await supervisor.ensure({ sessionKey: key, cwd: `C:/abort-workspaces/ws-${i}` })
    await supervisor.request(key, 'prompt', { message: 'Stream work' })
    void runtimes[i].simulateStream(50, 10)
  }

  // Allow streams to emit multiple tokens
  await new Promise((r) => setTimeout(r, 35))

  // Rapid Abort Storm: Fire stop() concurrently across all 8 sessions simultaneously
  const abortPromises = Array.from({ length: count }, (_, i) => supervisor.stop(`abort-target-${i}`))
  await Promise.all(abortPromises)

  // Verify all 8 processes were stopped cleanly
  assert.equal(runtimes.every((r) => r.stops >= 1), true, 'All runtimes must be stopped')
  assert.equal(runtimes.every((r) => !r.isRunning), true, 'Zero runtimes should remain running')

  // Verify all 8 sessions emitted agent_settled with aborted: true
  for (let i = 0; i < count; i++) {
    const key = `abort-target-${i}`
    const settled = settledEvents.find((e) => e.ownerId === key)
    assert.ok(settled, `Session ${key} must have settled`)
    assert.equal(settled.aborted, true, `Session ${key} must settle with aborted: true`)
  }

  // Verify no dangling gates or running keys in supervisor
  assert.equal(supervisor.runningKeys().length, 0, 'No keys should be running in supervisor')

  // Verify rapid reboot ability: Sessions can be immediately re-ensured without lock collision
  const restartRuntimes = Array.from({ length: 4 }, (_, i) => new StressRuntime(`reboot-${i}`))
  const rebootSupervisor = supervisorOf(restartRuntimes)
  const rebootResults = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      rebootSupervisor.ensure({ sessionKey: `reboot-${i}`, cwd: `C:/abort-workspaces/ws-${i}` })
    )
  )
  assert.equal(rebootResults.every((res) => res.ok), true, 'All sessions must restart cleanly after abort storm')

  await rebootSupervisor.stop()
  await supervisor.stop()
})

test('Multi-RPC Stress: Unexpected child process termination mid-stream synthesizes agent_settled crash event without disrupting same-cwd peers', async () => {
  const rCrashA = new StressRuntime('crash-a')
  const rPeerB = new StressRuntime('peer-b')
  const rSiblingC = new StressRuntime('sibling-c')

  const supervisor = supervisorOf([rCrashA, rPeerB, rSiblingC])

  const settledEvents: { ownerId: string; crashed?: boolean; aborted?: boolean }[] = []
  supervisor.on('event', ({ ownerId, event }) => {
    if (event.type === 'agent_settled') {
      settledEvents.push({
        ownerId,
        crashed: (event as { crashed?: boolean }).crashed,
        aborted: (event as { aborted?: boolean }).aborted
      })
    }
  })

  // Ensure sessions
  await supervisor.ensure({ sessionKey: 'crash-a', cwd: 'C:/shared-crash-repo' })
  await supervisor.ensure({ sessionKey: 'peer-b', cwd: 'C:/shared-crash-repo' })
  await supervisor.ensure({ sessionKey: 'sibling-c', cwd: 'C:/independent-repo' })

  // 1. Crash-A and Peer-B both start writing and streaming concurrently in the same folder
  await supervisor.request('crash-a', 'prompt', { message: 'will crash' })
  await supervisor.request('peer-b', 'prompt', { message: 'co-holder peer' })
  void rCrashA.simulateStream(30, 10)
  let peerCompleted = false
  const pPeerB = rPeerB.simulateStream(8, 12).then(() => {
    peerCompleted = true
  })

  // 2. Sibling-C starts and streams independently
  let siblingCompleted = false
  const pSiblingC = supervisor.request('sibling-c', 'prompt', { message: 'independent run' }).then(async () => {
    await rSiblingC.simulateStream(5, 10)
    siblingCompleted = true
  })

  // Give streams a moment to become active and verify exclusive lock is blocked by shared co-holders
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(supervisor.sessionInfo('peer-b')?.running, true, 'Peer-B must execute concurrently with Crash-A')
  await assert.rejects(
    supervisor.withCwdLock('C:/shared-crash-repo', async () => {}),
    /Wait for it to finish/
  )

  // 3. Simulate unexpected process crash on Crash-A
  rCrashA.simulateCrash('Child terminated unexpectedly with exit code 1')

  // 4. Verify synthesized crash settlement while Peer-B continues unaffected
  await new Promise((r) => setTimeout(r, 30))
  const crashSettled = settledEvents.find((e) => e.ownerId === 'crash-a')
  assert.ok(crashSettled, 'Supervisor must synthesize agent_settled for crashed process')
  assert.equal(crashSettled.crashed, true, 'Synthesized settlement must carry crashed: true')
  assert.equal(crashSettled.aborted, false)
  assert.equal(supervisor.sessionInfo('peer-b')?.running, true, 'Peer-B must stay running after Crash-A crashes')
  await assert.rejects(
    supervisor.withCwdLock('C:/shared-crash-repo', async () => {}),
    /Wait for it to finish/,
    'Exclusive lock must remain blocked while Peer-B still holds its shared lease'
  )

  // 5. Verify Peer-B and Sibling-C complete normally and all shared leases release cleanly
  await Promise.all([pPeerB, pSiblingC])
  assert.equal(peerCompleted, true, 'Peer-B must complete unaffected')
  assert.equal(siblingCompleted, true, 'Sibling-C must complete unaffected')
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(
    await supervisor.withCwdLock('C:/shared-crash-repo', async () => 'acquired'),
    'acquired',
    'Exclusive lock must succeed once all shared holders settle or crash'
  )

  await supervisor.stop()
})

test('Multi-RPC Stress: Crash before initial prompt disposition synthesizes crash settlement and releases gate reservation', async () => {
  const rCrash = new StressRuntime('crash-early')
  const rNext = new StressRuntime('next-worker')
  const supervisor = supervisorOf([rCrash, rNext])

  const settledEvents: { ownerId: string; crashed?: boolean }[] = []
  supervisor.on('event', ({ ownerId, event }) => {
    if (event.type === 'agent_settled') {
      settledEvents.push({ ownerId, crashed: (event as { crashed?: boolean }).crashed })
    }
  })

  await supervisor.ensure({ sessionKey: 'crash-early', cwd: 'C:/early-crash-repo' })
  await supervisor.ensure({ sessionKey: 'next-worker', cwd: 'C:/early-crash-repo' })

  // Override request on rCrash to simulate dying during prompt request before returning disposition
  rCrash.request = async (command: string) => {
    if (command === 'prompt') {
      // Simulate crash right inside the request
      rCrash.simulateCrash('Transport died before prompt acknowledgment')
      throw new Error('RPC connection closed')
    }
    return { ok: true }
  }

  // Prompt crash-early; it will reject
  await assert.rejects(
    supervisor.request('crash-early', 'prompt', { message: 'crash before ack' }),
    /RPC connection closed/
  )

  // Verify crash settlement was minted
  assert.ok(settledEvents.some((e) => e.ownerId === 'crash-early' && e.crashed === true))

  // Verify gate was released: next-worker can claim C:/early-crash-repo immediately
  const nextRes = await supervisor.request('next-worker', 'prompt', { message: 'should work' })
  assert.deepEqual(nextRes, { disposition: 'started' })

  rNext.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
  await supervisor.stop()
})

test('Multi-RPC Stress: LRU capacity eviction under complex active, gate-holding, dialog-holding, and queued loads', async () => {
  const rActive = new StressRuntime('active-run')
  const rDialog = new StressRuntime('dialog-holder')
  const rGate = new StressRuntime('gate-holder')
  const rQueued = new StressRuntime('queued-waiter')
  const rIdle1 = new StressRuntime('idle-1')
  const rIdle2 = new StressRuntime('idle-2')
  const rIdle3 = new StressRuntime('idle-3')
  const rIdle4 = new StressRuntime('idle-4')
  const rIdle5 = new StressRuntime('idle-5')
  const rIdle6 = new StressRuntime('idle-6')

  const supervisor = supervisorOf([
    rActive,
    rDialog,
    rGate,
    rQueued,
    rIdle1,
    rIdle2,
    rIdle3,
    rIdle4,
    rIdle5,
    rIdle6
  ])

  // 1. Setup rActive: start prompt and stream
  await supervisor.ensure({ sessionKey: 'active-run', cwd: 'C:/lru-active' })
  await supervisor.request('active-run', 'prompt', { message: 'stream' })
  rActive.emit('event', { type: 'agent_start' } as PiEvent)
  assert.equal(supervisor.sessionInfo('active-run')?.running, true)

  // 2. Setup rDialog: emit extension UI request
  await supervisor.ensure({ sessionKey: 'dialog-holder', cwd: 'C:/lru-dialog' })
  rDialog.simulateExtensionUi('approval-1', 'confirm')
  assert.equal(supervisor.sessionInfo('dialog-holder')?.waitingForInput, true)

  // 3. Setup rGate (shared on C:/lru-shared) & rQueued (queued behind exclusive withCwdLock on C:/lru-locked)
  await supervisor.ensure({ sessionKey: 'gate-holder', cwd: 'C:/lru-shared' })
  await supervisor.ensure({ sessionKey: 'queued-waiter', cwd: 'C:/lru-locked' })
  let releaseLruLock!: () => void
  const lruLock = supervisor.withCwdLock('C:/lru-locked', () => new Promise<void>((resolve) => {
    releaseLruLock = resolve
  }))
  const pGate = supervisor.request('gate-holder', 'prompt', { message: 'holds gate' })
  const pQueued = supervisor.request('queued-waiter', 'prompt', { message: 'waits in queue' })
  await pGate
  assert.equal(
    rQueued.commands.some((c) => c.command === 'prompt'),
    false,
    'queued-waiter must stay queued while C:/lru-locked is exclusively locked'
  )

  try {
    // 4. Boot 4 idle runtimes sequentially: idle-1, idle-2, idle-3, idle-4
    await supervisor.ensure({ sessionKey: 'idle-1', cwd: 'C:/lru-idle-1' })
    await supervisor.ensure({ sessionKey: 'idle-2', cwd: 'C:/lru-idle-2' })
    await supervisor.ensure({ sessionKey: 'idle-3', cwd: 'C:/lru-idle-3' })
    await supervisor.ensure({ sessionKey: 'idle-4', cwd: 'C:/lru-idle-4' })

    // Verify none of the 8 runtimes have been stopped yet
    assert.equal(rActive.stops, 0)
    assert.equal(rDialog.stops, 0)
    assert.equal(rGate.stops, 0)
    assert.equal(rQueued.stops, 0)
    assert.equal(rIdle1.stops, 0)
    assert.equal(rIdle2.stops, 0)
    assert.equal(rIdle3.stops, 0)
    assert.equal(rIdle4.stops, 0)

    // 5. Ensure 5th idle runtime: idle-5. This exceeds MAX_IDLE_RUNTIMES (4).
    // Protected runtimes (active, dialog, gate, queued) must NEVER be evicted!
    // Oldest idle runtime is idle-1 -> idle-1 must be evicted!
    await supervisor.ensure({ sessionKey: 'idle-5', cwd: 'C:/lru-idle-5' })

    assert.equal(rActive.stops, 0, 'Active running runtime must NOT be evicted')
    assert.equal(rDialog.stops, 0, 'Dialog-holding runtime must NOT be evicted')
    assert.equal(rGate.stops, 0, 'Gate-holding runtime must NOT be evicted')
    assert.equal(rQueued.stops, 0, 'Queued runtime must NOT be evicted')
    assert.equal(rIdle1.stops, 1, 'Oldest idle runtime idle-1 should be evicted')
    assert.equal(rIdle2.stops, 0)
    assert.equal(rIdle3.stops, 0)
    assert.equal(rIdle4.stops, 0)
    assert.equal(rIdle5.stops, 0)

    // 6. Touch idle-2 via supervisor.ensure to refresh its LRU timestamp
    await supervisor.ensure({ sessionKey: 'idle-2', cwd: 'C:/lru-idle-2' })

    // 7. Ensure 6th idle runtime: idle-6
    // Since idle-2 was touched, idle-3 is now the least recently used idle runtime!
    await supervisor.ensure({ sessionKey: 'idle-6', cwd: 'C:/lru-idle-6' })

    assert.equal(rIdle2.stops, 0, 'Touched idle runtime idle-2 must NOT be evicted')
    assert.equal(rIdle3.stops, 1, 'Unrefreshed idle runtime idle-3 should be evicted')

    // Clean up active states
    rActive.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
    supervisor.respondUi('dialog-holder', 'approval-1', { confirmed: true })
    rGate.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
    releaseLruLock()
    await lruLock
    await pQueued
    rQueued.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
  } finally {
    releaseLruLock()
    await Promise.allSettled([lruLock, pGate, pQueued])
    await supervisor.stop()
  }
})

test('Multi-RPC Stress: High-churn concurrent session bootstrapping and rapid recycling with interprocess locks', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-multi-stress-locks-'))
  const locksDir = path.join(root, 'locks')
  mkdirSync(locksDir, { recursive: true })

  const count = 12
  const runtimes = Array.from({ length: count }, (_, i) => new StressRuntime(`churn-${i}`))
  const supervisor = supervisorOf(runtimes, locksDir)

  t.after(async () => {
    await supervisor.stop()
    rmSync(root, { recursive: true, force: true })
  })

  // Rapidly ensure and dispatch work across 12 distinct workspace directories in 3 concurrent waves
  for (let wave = 0; wave < 3; wave++) {
    const waveIndices = [0, 1, 2, 3].map((offset) => wave * 4 + offset)
    const waveOps = waveIndices.map(async (i) => {
      const key = `churn-${i}`
      const cwd = path.join(root, `project-${i}`)
      await supervisor.ensure({ sessionKey: key, cwd })
      await supervisor.request(key, 'prompt', { message: `Work ${i}` })
      runtimes[i].emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
    })
    await Promise.all(waveOps)
  }

  // All 12 operations should finish cleanly
  assert.equal(runtimes.every((r) => r.starts === 1), true, 'All runtimes must have started')

  await supervisor.stop()
})

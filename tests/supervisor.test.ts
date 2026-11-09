import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ExtensionUiResponse, PiEvent, RuntimeStartOptions, RuntimeStatus } from '@shared/types'
import { SessionSupervisor, type ManagedSessionRuntime } from '../src/main/pi/supervisor'
import { InterprocessCwdGate } from '../src/main/pi/cwd-gate'
import { properLockfile } from '../src/main/proper-lockfile'

interface RecordedCommand {
  command: string
  payload: Record<string, unknown>
}

class FakeRuntime extends EventEmitter implements ManagedSessionRuntime {
  readonly commands: RecordedCommand[] = []
  starts = 0
  stops = 0
  approvals: { id: string; response: ExtensionUiResponse }[] = []
  running = false
  status: RuntimeStatus = { phase: 'stopped' }
  /** Reported by get_state so a draft can bind to the file Pi created. */
  boundFile?: string
  failStart = false
  settleOnAbort = false

  get isRunning(): boolean {
    return this.running
  }

  get currentStatus(): RuntimeStatus {
    return { ...this.status }
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
    if (!next) throw new Error('unexpected runtime')
    return next
  }, cwdLockDirectory)
}

function forbidden(runtime: FakeRuntime): string[] {
  return runtime.commands
    .map((entry) => entry.command)
    .filter((command) => command === 'abort' || command === 'abort_retry' || command === 'switch_session')
}

test('starting B does not abort A, and each session keeps its own runtime', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  const seen: string[] = []
  supervisor.on('event', (payload: { ownerId: string; event: PiEvent }) => {
    seen.push(`${payload.ownerId}:${payload.event.type}`)
  })

  assert.deepEqual(await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' }), { ok: true })
  assert.deepEqual(await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/b', sessionFile: 'B.jsonl' }), { ok: true })
  await supervisor.request('B.jsonl', 'get_state')

  assert.equal(a.starts, 1)
  assert.equal(b.starts, 1)
  assert.deepEqual(forbidden(a), [])
  assert.deepEqual(a.commands, [])
  assert.deepEqual(b.commands.map((entry) => entry.command), ['get_state'])
  assert.deepEqual(supervisor.runningKeys().sort(), ['A.jsonl', 'B.jsonl'])

  a.emit('event', { type: 'message_update' } as PiEvent)
  assert.deepEqual(seen, ['A.jsonl:message_update'])
})

test('two ensures of one session start a single runtime', async () => {
  const a = new FakeRuntime()
  let entered = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const original = a.start.bind(a)
  a.start = async (options) => {
    entered += 1
    await gate
    return original(options)
  }
  const supervisor = supervisorOf([a])
  const first = supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })
  const second = supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })
  await Promise.resolve()
  assert.equal(entered, 1)
  release()
  assert.deepEqual(await first, { ok: true })
  assert.deepEqual(await second, { ok: true })
  assert.equal(a.starts, 1)
})

test('the same session file spelled two ways has one writer', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'draft:1', cwd: 'C:/proj', sessionFile: 'C:/proj/a.jsonl' })
  await supervisor.ensure({
    sessionKey: 'C:\\proj\\a.jsonl',
    cwd: 'C:/proj',
    sessionFile: 'C:\\proj\\a.jsonl'
  })
  assert.equal(a.starts, 1)
  assert.equal(b.starts, 0)
  assert.equal(supervisor.has('draft:1'), true)
  assert.equal(supervisor.has('C:\\proj\\a.jsonl'), true)
})

test('dot segments cannot start a second writer for the same JSONL', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'first', cwd: 'C:/proj', sessionFile: 'C:/proj/a.jsonl' })
  await supervisor.ensure({ sessionKey: 'second', cwd: 'C:/proj', sessionFile: 'C:/proj/nested/../a.jsonl' })
  assert.equal(a.starts, 1)
  assert.equal(b.starts, 0)
})

test('a draft binds to the session file its own process reports', async () => {
  const a = new FakeRuntime()
  a.boundFile = 'C:/proj/real.jsonl'
  const supervisor = supervisorOf([a])
  const rebound: { from: string; to: string }[] = []
  supervisor.on('rekey', (change: { from: string; to: string }) => rebound.push(change))
  await supervisor.ensure({ sessionKey: 'draft:1', cwd: 'C:/proj' })
  assert.deepEqual(rebound, [{ from: 'draft:1', to: 'C:/proj/real.jsonl' }])
  assert.equal(supervisor.has('draft:1'), true)
  await supervisor.request('draft:1', 'get_state')
  assert.deepEqual(forbidden(a), [])
  assert.equal(supervisor.runningKeys().length, 1)
})

test('restarting an unpersisted session keeps pending commands on its replacement', async () => {
  const a = new FakeRuntime()
  const start = a.start.bind(a)
  a.boundFile = 'replacement.jsonl'
  a.start = async options => {
    const result = await start(options)
    a.status.sessionFile = a.boundFile
    return result
  }
  const supervisor = supervisorOf([a])
  const changes: unknown[] = []
  supervisor.on('rekey', change => changes.push(change))
  await supervisor.ensure({ sessionKey: 'unpersisted.jsonl', sessionFile: 'unpersisted.jsonl', cwd: 'C:/a' })
  await supervisor.request('unpersisted.jsonl', 'prompt')
  assert.deepEqual(changes, [{ from: 'unpersisted.jsonl', to: 'replacement.jsonl', replace: true }])
  assert.equal(a.commands[0]?.command, 'prompt')
})

test('renaming B does not switch or abort A', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  const renamed: unknown[] = []
  supervisor.on('rename', change => renamed.push(change))
  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/b', sessionFile: 'B.jsonl' })
  assert.equal(await supervisor.rename('B.jsonl', 'Later name'), true)
  assert.deepEqual(forbidden(a), [])
  assert.deepEqual(a.commands, [])
  assert.equal(b.commands.at(-1)?.command, 'set_session_name')
  assert.equal(b.commands.at(-1)?.payload.name, 'Later name')
  // A hot rename publishes its name on the runtime stream; the session list
  // still needs one signal so the sidebar and title bar re-read it.
  assert.deepEqual(renamed, [{ file: 'B.jsonl', name: 'Later name' }])
  assert.equal(a.stops, 0)
  assert.equal(b.stops, 0)
})

test('a cold rename appends the sample and does not touch the hot runtime', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-supervisor-'))
  const cold = path.join(dir, 'cold.jsonl')
  const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'sessions', 'branch.jsonl')
  try {
    const sample = readFileSync(fixture)
    copyFileSync(fixture, cold)
    const a = new FakeRuntime()
    const supervisor = supervisorOf([a])
    const renamed: unknown[] = []
    supervisor.on('rename', change => renamed.push(change))
    await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })
    assert.equal(await supervisor.rename(cold, 'From the list'), true)
    // A cold rename only appends to the JSONL, so without this push the UI
    // would never learn the new name.
    assert.deepEqual(renamed, [{ file: cold, name: 'From the list' }])
    const last = readFileSync(cold, 'utf8').trim().split('\n').at(-1)
    const entry = JSON.parse(last ?? '{}') as { type?: string; name?: string; parentId?: string }
    assert.equal(entry.type, 'session_info')
    assert.equal(entry.name, 'From the list')
    assert.equal(entry.parentId, 'm2')
    assert.deepEqual(a.commands, [])
    assert.equal(a.stops, 0)
    assert.deepEqual(readFileSync(fixture), sample)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a second prompt in another session waits and does not abort the first', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/same', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/same', sessionFile: 'B.jsonl' })
  await supervisor.request('A.jsonl', 'prompt', { message: 'keep going' })
  let settled = false
  const waiting = supervisor.request('B.jsonl', 'prompt', { message: 'later' }).then(() => {
    settled = true
  })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.deepEqual(forbidden(a), [])
  assert.deepEqual(b.commands, [])

  a.emit('event', { type: 'agent_settled' } as PiEvent)
  await waiting
  assert.equal(settled, true)
  assert.deepEqual(forbidden(a), [])
  assert.equal(b.commands[0]?.command, 'prompt')
  assert.equal(a.stops, 0)
  assert.equal(b.stops, 0)
})

test('stopping A leaves B running', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/b', sessionFile: 'B.jsonl' })
  await supervisor.stop('A.jsonl')
  assert.equal(a.stops, 1)
  assert.equal(b.stops, 0)
  assert.equal(supervisor.has('A.jsonl'), false)
  assert.equal(supervisor.has('B.jsonl'), true)
})

test('an approval response is delivered only to the session that asked', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })
  await supervisor.ensure({ sessionKey: 'B.jsonl', cwd: 'C:/b', sessionFile: 'B.jsonl' })
  supervisor.respondUi('A.jsonl', 'req-a', { confirmed: true })
  assert.deepEqual(a.approvals, [{ id: 'req-a', response: { confirmed: true } }])
  assert.deepEqual(b.approvals, [])
  assert.deepEqual(forbidden(b), [])
})

test('a failed start releases the session file so the next start can own it', async () => {
  const first = new FakeRuntime()
  const second = new FakeRuntime()
  first.failStart = true
  const supervisor = supervisorOf([first, second])
  const failed = await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })
  assert.deepEqual(failed, { ok: false, error: 'boom' })
  const started = await supervisor.ensure({ sessionKey: 'A.jsonl', cwd: 'C:/a', sessionFile: 'A.jsonl' })
  assert.deepEqual(started, { ok: true })
  assert.equal(first.starts, 1)
  assert.equal(second.starts, 1)
  assert.equal(supervisor.has('A.jsonl'), true)
})

test('separate supervisors cannot open or mutate the same session file at once', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-supervisor-lock-'))
  const sessionFile = path.join(dir, 'session.jsonl')
  writeFileSync(sessionFile, '{"type":"session"}\n')
  const firstRuntime = new FakeRuntime()
  const secondRuntime = new FakeRuntime()
  const first = supervisorOf([firstRuntime])
  const second = supervisorOf([secondRuntime])
  let draft: SessionSupervisor | undefined
  let competing: SessionSupervisor | undefined
  try {
    assert.deepEqual(await first.ensure({ sessionKey: sessionFile, sessionFile, cwd: dir }), { ok: true })

    const blocked = await second.ensure({ sessionKey: sessionFile, sessionFile, cwd: dir })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error ?? '', /already open/)
    assert.equal(secondRuntime.starts, 0)

    const lockfilePath = createRequire(path.join(process.cwd(), 'package.json')).resolve('proper-lockfile')
    const competingProcess = spawnSync(process.execPath, ['-e', `
      const lockfile = require(${JSON.stringify(lockfilePath)})
      try {
        const release = lockfile.lockSync(${JSON.stringify(sessionFile)}, { realpath: false, retries: 0 })
        release()
        process.exit(2)
      } catch (error) {
        if (error.code === 'ELOCKED') process.exit(0)
        throw error
      }
    `], { encoding: 'utf8' })
    assert.equal(competingProcess.status, 0, competingProcess.stderr)

    let mutated = false
    await assert.rejects(
      second.withSessionFileMutation(sessionFile, async () => { mutated = true }),
      /already open/
    )
    assert.equal(mutated, false)

    await first.stop(sessionFile)
    assert.deepEqual(await second.ensure({ sessionKey: sessionFile, sessionFile, cwd: dir }), { ok: true })
    assert.equal(secondRuntime.starts, 1)

    await second.stop(sessionFile)
    const futureFile = path.join(dir, 'future-session.jsonl')
    const draftRuntime = new FakeRuntime()
    draftRuntime.boundFile = futureFile
    draft = supervisorOf([draftRuntime])
    const competingRuntime = new FakeRuntime()
    competing = supervisorOf([competingRuntime])
    assert.deepEqual(await draft.ensure({ sessionKey: 'draft:future', cwd: dir }), { ok: true })
    const blockedDraft = await competing.ensure({ sessionKey: futureFile, sessionFile: futureFile, cwd: dir })
    assert.equal(blockedDraft.ok, false)
    assert.equal(competingRuntime.starts, 0)
    await draft.stop(futureFile)
  } finally {
    await first.stop()
    await second.stop()
    await draft?.stop()
    await competing?.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('directory queue uses the same identity as the write lock', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/Same/' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'c:\\same' })
  await supervisor.request('A', 'prompt')
  const waiting = supervisor.request('B', 'prompt')
  a.emit('event', { type: 'agent_settled' })
  await Promise.resolve()
  assert.equal(b.commands[0]?.command, 'prompt')
  await waiting
})

test('stopping a writer releases the directory only after the process exits', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/same' })
  await supervisor.request('A', 'prompt')
  const waiting = supervisor.request('B', 'prompt')
  let finishStop!: () => void
  let stopStarted!: () => void
  const stopInvoked = new Promise<void>((resolve) => { stopStarted = resolve })
  a.stop = () => new Promise<void>((resolve) => {
    finishStop = resolve
    stopStarted()
  })
  const stopped = supervisor.stop('A')
  await stopInvoked
  assert.equal(b.commands.length, 0, 'the old writer still owns its files')
  a.running = false
  finishStop()
  await stopped
  await Promise.resolve()
  assert.equal(b.commands[0]?.command, 'prompt')
  await waiting
})

test('stopping an active process publishes its final cancellation after exit', async () => {
  const a = new FakeRuntime()
  const supervisor = supervisorOf([a])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/a' })
  await supervisor.request('A', 'prompt')
  const events: { ownerId: string; event: PiEvent }[] = []
  supervisor.on('event', (payload) => events.push(payload))
  await supervisor.stop('A')
  assert.equal(a.isRunning, false)
  assert.deepEqual(a.commands.slice(-2).map((entry) => entry.command), ['clear_queue', 'abort'])
  assert.deepEqual(events, [{ ownerId: 'A', event: { type: 'agent_settled', aborted: true, runtimeStopped: true } }])
})

test('stopping a run uses Pi settlement without publishing a duplicate', async () => {
  const a = new FakeRuntime()
  a.settleOnAbort = true
  const supervisor = supervisorOf([a])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/a' })
  await supervisor.request('A', 'prompt')
  const events: { ownerId: string; event: PiEvent }[] = []
  supervisor.on('event', (payload) => events.push(payload))

  await supervisor.stop('A')

  assert.deepEqual(events, [{ ownerId: 'A', event: { type: 'agent_settled', aborted: true } }])
})

test('stopping an idle process does not send abort commands', async () => {
  const a = new FakeRuntime()
  const supervisor = supervisorOf([a])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/a' })

  await supervisor.stop('A')

  assert.deepEqual(a.commands, [])
})

test('a process that dies during a run settles it instead of leaving it open', async () => {
  const a = new FakeRuntime()
  const supervisor = supervisorOf([a])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/a' })
  await supervisor.request('A', 'prompt')
  const events: { ownerId: string; event: PiEvent }[] = []
  supervisor.on('event', (payload) => events.push(payload))

  a.running = false
  a.status = { phase: 'error', cwd: 'C:/a', error: 'the process died' }
  a.emit('status', a.status)
  assert.deepEqual(events, [
    { ownerId: 'A', event: { type: 'agent_settled', aborted: false, crashed: true } }
  ])

  // The exit usually reports "error" and then "stopped"; one death is one
  // settle.
  a.emit('status', { phase: 'stopped', cwd: 'C:/a' })
  assert.equal(events.length, 1)
})

test('a process that dies before the first prompt response still settles the run', async () => {
  const a = new FakeRuntime()
  const supervisor = supervisorOf([a])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/a' })
  let rejectPrompt!: (error: Error) => void
  a.request = async <T>(command: string): Promise<T> => {
    if (command === 'prompt') return await new Promise<T>((_resolve, reject) => { rejectPrompt = reject })
    return { ok: true } as T
  }
  const events: { ownerId: string; event: PiEvent }[] = []
  supervisor.on('event', (payload) => events.push(payload))
  const prompt = supervisor.request('A', 'prompt')
  await Promise.resolve()

  a.running = false
  a.status = { phase: 'error', cwd: 'C:/a', error: 'the process died' }
  a.emit('status', a.status)
  rejectPrompt(new Error('pi exited'))
  await assert.rejects(prompt, /pi exited/)

  assert.deepEqual(events, [
    { ownerId: 'A', event: { type: 'agent_settled', aborted: false, crashed: true } }
  ])
})

test('an RPC error does not release a live writer or its directory gate', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/same' })
  await supervisor.request('A', 'prompt')

  const waiting = supervisor.request('B', 'prompt')
  a.status = { phase: 'error', cwd: 'C:/same', error: 'pipe failed' }
  a.emit('status', a.status)

  assert.equal(a.isRunning, true)
  assert.equal(supervisor.sessionInfo('A')?.running, true)
  assert.equal(b.commands.some(({ command }) => command === 'prompt'), false)
  await assert.rejects(
    supervisor.withCwdLock('C:/same', async () => {}),
    /conversation is working/
  )

  a.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
  await waiting
  assert.equal(b.commands.filter(({ command }) => command === 'prompt').length, 1)
})

test('a failed prompt response keeps its directory reserved until Pi settles', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/same' })
  a.request = async (command) => {
    if (command === 'prompt') throw new Error('Timed out waiting for prompt response')
    return { ok: true }
  }

  await assert.rejects(supervisor.request('A', 'prompt'), /Timed out/)
  assert.equal(supervisor.sessionInfo('A')?.running, true)
  await assert.rejects(
    supervisor.withCwdLock('C:/same', async () => {}),
    /conversation is working/
  )
  const waiting = supervisor.request('B', 'prompt')
  assert.equal(b.commands.some(({ command }) => command === 'prompt'), false)

  a.emit('event', { type: 'agent_settled', aborted: false } as PiEvent)
  await waiting
  assert.equal(b.commands.filter(({ command }) => command === 'prompt').length, 1)
})

test('a run that already settled normally is not reported as crashed', async () => {
  const a = new FakeRuntime()
  const supervisor = supervisorOf([a])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/a' })
  await supervisor.request('A', 'prompt')
  a.emit('event', { type: 'agent_start' })
  a.emit('event', { type: 'agent_settled' })

  const events: { ownerId: string; event: PiEvent }[] = []
  supervisor.on('event', (payload) => events.push(payload))
  a.running = false
  a.status = { phase: 'stopped', cwd: 'C:/a' }
  a.emit('status', a.status)
  assert.deepEqual(events, [])
})

test('a non-holder settling cannot dispatch another writer into a busy directory', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const c = new FakeRuntime()
  const supervisor = supervisorOf([a, b, c])
  for (const sessionKey of ['A', 'B', 'C']) await supervisor.ensure({ sessionKey, cwd: 'C:/same' })
  await supervisor.request('A', 'prompt')
  const waiting = supervisor.request('B', 'prompt')
  c.emit('event', { type: 'agent_settled' })
  await Promise.resolve()
  assert.equal(b.commands.length, 0)
  a.emit('event', { type: 'agent_settled' })
  await waiting
})

test('a completed bash releases its lock without an agent_settled event', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/same' })
  await supervisor.request('A', 'bash', { command: 'echo hello' })
  const waiting = supervisor.request('B', 'prompt')
  await Promise.resolve()
  assert.equal(b.commands[0]?.command, 'prompt')
  await waiting
})

test('a handled command during an active run cannot release that run\'s lock', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/same' })
  await supervisor.request('A', 'prompt')
  a.emit('event', { type: 'agent_start' })
  const waiting = supervisor.request('B', 'prompt')
  const request = a.request.bind(a)
  a.request = async <T>(command: string, payload?: Record<string, unknown>) => {
    if (command === 'prompt') return { disposition: 'handled' } as T
    return request<T>(command, payload)
  }
  await supervisor.request('A', 'prompt', { message: '/extension-command' })
  assert.equal(b.commands.length, 0)
  a.emit('event', { type: 'agent_settled' })
  await waiting
})

test('a rejected steer cannot release the original run\'s directory', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/same' })
  await supervisor.request('A', 'prompt')
  a.emit('event', { type: 'agent_start' })
  const waiting = supervisor.request('B', 'prompt')
  a.request = async () => { throw new Error('steer rejected') }
  await assert.rejects(supervisor.request('A', 'prompt'), /steer rejected/)
  assert.equal(b.commands.length, 0)
  a.emit('event', { type: 'agent_settled' })
  await waiting
})

test('clear_queue cancels prompts still waiting at the directory gate', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/same' })
  await supervisor.request('A', 'prompt')
  const waiting = supervisor.request<{ cancelled?: boolean }>('B', 'prompt', { message: 'later' })
  const cleared = await supervisor.request<{ steering: string[] }>('B', 'clear_queue')
  a.emit('event', { type: 'agent_settled' })
  const result = await waiting
  assert.equal(result.cancelled, true)
  assert.deepEqual(cleared.steering, ['later'])
  assert.equal(b.commands.some(({ command }) => command === 'prompt'), false)
})

test('forking leaves the original file available to an independent runtime', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A.jsonl', sessionFile: 'A.jsonl', cwd: 'C:/same' })
  a.boundFile = 'fork.jsonl'
  await supervisor.request('A.jsonl', 'fork', { entryId: 'user-1' })
  await supervisor.ensure({ sessionKey: 'A.jsonl', sessionFile: 'A.jsonl', cwd: 'C:/same' })
  assert.equal(b.starts, 1)
  assert.deepEqual(supervisor.runningKeys().sort(), ['A.jsonl', 'fork.jsonl'])
})

test('a session identity learned from get_state also keeps one writer', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A.jsonl', sessionFile: 'A.jsonl', cwd: 'C:/same' })
  a.boundFile = 'changed-by-extension.jsonl'
  await supervisor.request('A.jsonl', 'get_state')
  await supervisor.ensure({ sessionKey: a.boundFile, sessionFile: a.boundFile, cwd: 'C:/same' })
  assert.equal(b.starts, 0)
  assert.deepEqual(supervisor.runningKeys(), [a.boundFile])
})

test('late traffic from a stopped runtime cannot affect its replacement', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/a' })
  await supervisor.stop('A')
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/a' })
  const seen: unknown[] = []
  supervisor.on('event', (event: unknown) => seen.push(event))
  a.emit('event', { type: 'agent_settled' })
  assert.deepEqual(seen, [])
})

test('closing a workspace cancels all its waiters without starting their commands', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const c = new FakeRuntime()
  const supervisor = supervisorOf([a, b, c])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'C', cwd: 'C:/elsewhere' })
  await supervisor.request('A', 'prompt')
  const waiting = supervisor.request<{ cancelled?: boolean }>('B', 'prompt')
  await supervisor.stopCwd('c:\\same\\')
  assert.equal((await waiting).cancelled, true)
  assert.equal(b.commands.length, 0)
  assert.equal(c.isRunning, true)
})

test('closing a workspace stops sessions running in its nested folders', async () => {
  const nested = new FakeRuntime()
  const sibling = new FakeRuntime()
  const supervisor = supervisorOf([nested, sibling])
  await supervisor.ensure({ sessionKey: 'nested', cwd: 'C:/tree/packages/app' })
  await supervisor.ensure({ sessionKey: 'sibling', cwd: 'C:/elsewhere' })
  await supervisor.stopCwd('C:/tree')
  assert.equal(nested.isRunning, false)
  assert.equal(sibling.isRunning, true)
})

test('a start completing after a stop cannot resurrect its runtime', async () => {
  const a = new FakeRuntime()
  let finish!: () => void
  const start = a.start.bind(a)
  a.start = async (options) => {
    await new Promise<void>((resolve) => { finish = resolve })
    return start(options)
  }
  const supervisor = supervisorOf([a])
  const starting = supervisor.ensure({ sessionKey: 'A', cwd: 'C:/a' })
  const stopping = supervisor.stop('A')
  finish()
  assert.equal((await starting).ok, false)
  await stopping
  assert.equal(a.isRunning, false)
  assert.equal(supervisor.has('A'), false)
})

test('shutdown waits for a session lock request and prevents its runtime from starting', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-supervisor-start-stop-'))
  const sessionFile = path.join(root, 'session.jsonl')
  writeFileSync(sessionFile, '{}\n')
  const runtime = new FakeRuntime()
  const supervisor = supervisorOf([runtime])
  const originalLock = properLockfile.lock
  let signalLockRequest!: () => void
  let releaseLockRequest!: () => void
  const lockRequested = new Promise<void>((resolve) => { signalLockRequest = resolve })
  const lockGate = new Promise<void>((resolve) => { releaseLockRequest = resolve })
  properLockfile.lock = async () => {
    signalLockRequest()
    await lockGate
    return async () => {}
  }

  try {
    const starting = supervisor.ensure({
      sessionKey: sessionFile,
      sessionFile,
      cwd: root
    })
    await lockRequested

    let stopResolved = false
    const stopping = supervisor.stop().then(() => { stopResolved = true })
    await Promise.resolve()
    assert.equal(stopResolved, false)

    releaseLockRequest()
    assert.equal((await starting).ok, false)
    await stopping
    assert.equal(runtime.starts, 0)
    assert.equal(supervisor.has(sessionFile), false)
  } finally {
    releaseLockRequest()
    properLockfile.lock = originalLock
    await supervisor.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('closing a workspace cancels a runtime that is still waiting for its session-file lock', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-supervisor-workspace-stop-'))
  const sessionFile = path.join(root, 'session.jsonl')
  writeFileSync(sessionFile, '{}\n')
  const runtime = new FakeRuntime()
  const supervisor = supervisorOf([runtime])
  const originalLock = properLockfile.lock
  let signalLockRequest!: () => void
  let releaseLockRequest!: () => void
  const lockRequested = new Promise<void>((resolve) => { signalLockRequest = resolve })
  const lockGate = new Promise<void>((resolve) => { releaseLockRequest = resolve })
  properLockfile.lock = async () => {
    signalLockRequest()
    await lockGate
    return async () => {}
  }

  try {
    const starting = supervisor.ensure({ sessionKey: sessionFile, sessionFile, cwd: root })
    await lockRequested

    const closing = supervisor.stopCwd(root)
    releaseLockRequest()
    await closing

    assert.equal((await starting).ok, false)
    assert.equal(runtime.starts, 0)
    assert.equal(supervisor.has(sessionFile), false)
  } finally {
    releaseLockRequest()
    properLockfile.lock = originalLock
    await supervisor.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('Git writes cannot change a directory owned by a background run', async () => {
  const a = new FakeRuntime()
  const supervisor = supervisorOf([a])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.request('A', 'prompt')
  let writes = 0
  await assert.rejects(supervisor.withCwdLock('C:/same', async () => { writes += 1 }), /conversation is working/)
  assert.equal(writes, 0)
  a.emit('event', { type: 'agent_settled' })
  await supervisor.withCwdLock('C:/same', async () => { writes += 1 })
  assert.equal(writes, 1)
})

test('separate supervisors serialize writes to overlapping workspaces', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-supervisor-cwd-'))
  const lockDirectory = path.join(root, 'cwd-gate')
  const firstRuntime = new FakeRuntime()
  const secondRuntime = new FakeRuntime()
  const first = supervisorOf([firstRuntime], lockDirectory)
  const second = supervisorOf([secondRuntime], lockDirectory)
  t.after(async () => {
    await Promise.all([first.stop(), second.stop()])
    rmSync(root, { recursive: true, force: true })
  })

  await first.ensure({ sessionKey: 'first', cwd: 'C:/shared' })
  await second.ensure({ sessionKey: 'second', cwd: 'C:/shared' })
  await first.request('first', 'prompt')
  const queued = second.request('second', 'prompt')
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(secondRuntime.commands.some(({ command }) => command === 'prompt'), false)

  firstRuntime.emit('event', { type: 'agent_settled' } as PiEvent)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      queued,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('queued prompt did not resume')), 5000)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
  assert.equal(secondRuntime.commands.filter(({ command }) => command === 'prompt').length, 1)

  await second.stop('second')
  assert.equal(secondRuntime.isRunning, false)
  const probe = new InterprocessCwdGate(lockDirectory)
  let acquired = false
  for (let attempt = 0; attempt < 20 && !acquired; attempt += 1) {
    acquired = await probe.acquire('C:/shared')
    if (!acquired) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal(acquired, true, 'stopping a writer releases its cross-process lease')
  await probe.release('C:/shared')
})

test('a prompt waits for an in-flight desktop write and starts after it finishes', async () => {
  const a = new FakeRuntime()
  const supervisor = supervisorOf([a])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  let finish!: () => void
  const writing = supervisor.withCwdLock('C:/same', () => new Promise<void>(resolve => { finish = resolve }))
  const prompt = supervisor.request('A', 'prompt')
  assert.equal(a.commands.length, 0)
  finish()
  await writing
  await prompt
  assert.equal(a.commands[0]?.command, 'prompt')
})

test('a nested prompt waits for a desktop write in its parent directory', async () => {
  const a = new FakeRuntime()
  const supervisor = supervisorOf([a])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same/nested' })
  let finish!: () => void
  const writing = supervisor.withCwdLock('C:/same', () => new Promise<void>(resolve => { finish = resolve }))
  const prompt = supervisor.request('A', 'prompt')
  assert.equal(a.commands.length, 0)
  finish()
  await writing
  await prompt
  assert.equal(a.commands[0]?.command, 'prompt')
})

test('a queued prompt is rejected when its dispatch preflight no longer passes', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/same' })
  await supervisor.request('A', 'prompt')

  let authorized = true
  const queued = supervisor.request('B', 'prompt', {}, 30_000, undefined, () => {
    if (!authorized) throw new Error('remote device was revoked')
  })
  authorized = false
  a.emit('event', { type: 'agent_settled' })

  await assert.rejects(queued, /remote device was revoked/)
  assert.equal(b.commands.some((command) => command.command === 'prompt'), false)
  await supervisor.withCwdLock('C:/same', async () => 'released')
})

test('an early settlement is not undone by a late prompt acknowledgement', async () => {
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A', cwd: 'C:/same' })
  await supervisor.ensure({ sessionKey: 'B', cwd: 'C:/same' })
  let finish!: (value: unknown) => void
  const request = a.request.bind(a)
  a.request = async <T>(command: string, payload?: Record<string, unknown>) => {
    if (command === 'prompt') return new Promise<T>((resolve) => { finish = value => resolve(value as T) })
    return request<T>(command, payload)
  }
  const starting = supervisor.request('A', 'prompt')
  const waiting = supervisor.request('B', 'prompt')
  a.emit('event', { type: 'agent_start' })
  a.emit('event', { type: 'agent_settled' })
  assert.equal(b.commands.length, 0, 'the pending command still owns its gate')
  finish({ disposition: 'started' })
  await starting
  await waiting
  assert.equal(b.commands[0]?.command, 'prompt')
})

test('a fork idle timer cannot retire the original session reopened later', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const a = new FakeRuntime()
  const b = new FakeRuntime()
  const supervisor = supervisorOf([a, b])
  await supervisor.ensure({ sessionKey: 'A.jsonl', sessionFile: 'A.jsonl', cwd: 'C:/same' })
  a.boundFile = 'fork.jsonl'
  await supervisor.request('A.jsonl', 'fork', { entryId: 'user-1' })
  t.mock.timers.tick(1000)
  await supervisor.ensure({ sessionKey: 'A.jsonl', sessionFile: 'A.jsonl', cwd: 'C:/same' })
  t.mock.timers.tick(599000)
  assert.equal(a.stops, 1, 'the fork has been idle for ten minutes')
  assert.equal(b.stops, 0, 'the reopened original has not reached its deadline')
  await supervisor.stop()
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SessionSupervisor, type ManagedSessionRuntime } from '../src/main/pi/supervisor'
import type { SettingsStore } from '../src/main/settings'
import { ScheduledTaskService } from '../src/main/scheduled-tasks'
import type { RuntimeStartOptions, RuntimeStatus, ScheduledTaskInput } from '../src/shared/types'

/**
 * A scheduled task either starts a new conversation for every run or continues
 * the one it started before. The choice is the task's own, so the service has
 * to keep the conversation across runs — and forget it when the task goes back
 * to a fresh conversation.
 */
class ReuseSupervisor extends EventEmitter {
  ensures: { sessionKey: string; sessionFile?: string; cwd: string }[] = []
  sessions = new Map<string, string>()

  async ensure(options: { sessionKey: string; sessionFile?: string; cwd: string }): Promise<{ ok: boolean }> {
    this.ensures.push(options)
    return { ok: true }
  }

  async request<T>(
    key: string, command: string, _payload?: unknown, _timeout?: number, _trace?: unknown,
    preflight?: (ownerId: string, busy: boolean) => void
  ): Promise<T> {
    preflight?.(this.ensures.find((entry) => entry.sessionKey === key)?.sessionFile ?? key, false)
    if (command === 'prompt') return { disposition: 'started' } as T
    return {} as T
  }

  sessionInfo(): { cwd: string; externalContext: boolean; running: boolean } {
    return { cwd: '', externalContext: false, running: false }
  }

  async stop(): Promise<void> {}

  /** Bind a session key to the JSONL Pi wrote, the way a real rekey does. */
  bind(key: string, file: string): void {
    this.sessions.set(key, file)
    this.emit('rekey', { from: key, to: file })
  }

  settle(key: string, file: string): void {
    this.bind(key, file)
    this.emit('event', { ownerId: file, event: { type: 'agent_settled', aborted: false } })
  }
}

function makeService(root: string) {
  const supervisor = new ReuseSupervisor()
  const service = createService(root, supervisor as unknown as SessionSupervisor)
  return { service, supervisor }
}

function createService(root: string, supervisor: SessionSupervisor): ScheduledTaskService {
  const settings = {
    get: () => ({
      externalChatFolder: path.join(root, 'sessions'),
      workspaces: [{ id: 'project', path: root }, { id: 'other', path: path.join(root, 'other-project') }]
    })
  } as unknown as SettingsStore
  return new ScheduledTaskService({
    userData: root,
    settings,
    supervisor,
    customInstructions: () => undefined
  })
}

function writeConversation(root: string, cwd: string, id = 'task'): string {
  const sessionFile = path.join(root, 'sessions', `${id}.jsonl`)
  mkdirSync(path.dirname(sessionFile), { recursive: true })
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'session', id, version: 3, cwd })}\n`, 'utf8')
  return sessionFile
}

class WarmRuntime extends EventEmitter implements ManagedSessionRuntime {
  currentStatus: RuntimeStatus = { phase: 'stopped' }
  prompts: unknown[] = []
  starts = 0

  constructor(private readonly file: string) { super() }

  get isRunning(): boolean { return this.currentStatus.phase === 'ready' }

  async start(options: RuntimeStartOptions): Promise<{ ok: boolean }> {
    this.starts += 1
    this.currentStatus = { phase: 'ready', cwd: options.cwd, sessionFile: this.file }
    return { ok: true }
  }

  async request<T>(command: string, payload?: Record<string, unknown>): Promise<T> {
    if (command === 'get_state') return { sessionFile: this.file } as T
    if (command === 'prompt') {
      this.prompts.push(payload?.message)
      this.emit('event', { type: 'agent_start' })
      return { disposition: 'started' } as T
    }
    return {} as T
  }

  respondUi(): boolean { return false }

  async stop(): Promise<void> { this.currentStatus = { phase: 'stopped' } }

  settle(): void { this.emit('event', { type: 'agent_settled', aborted: false }) }
}

for (const scenario of [
  'settles its second run',
  'leaves a user turn alone',
  'leaves a user turn alone when settings differ',
  'stops while checking settings',
  'stops before dispatch'
] as const) {
  test(`a scheduled task ${scenario} in a warm conversation`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-warm-'))
    const file = writeConversation(root, root)
    const runtime = new WarmRuntime(file)
    const supervisor = new SessionSupervisor(() => runtime)
    const service = createService(root, supervisor)
    t.after(async () => {
      service.dispose()
      await supervisor.stop()
      rmSync(root, { recursive: true, force: true })
    })
    const [task] = service.create({
      title: 'Project review', prompt: 'Review the project', workspaceId: 'project',
      schedule: { kind: 'daily', time: '15:20' }, sessionMode: 'reuse'
    })
    await service.runNow(task.id)
    runtime.settle()
    assert.equal(service.list()[0].lastStatus, 'completed')
    assert.equal(service.list()[0].reuseSessionFile, file)

    if (scenario.startsWith('leaves a user turn')) {
      await supervisor.request(file, 'prompt', { message: 'User turn' })
      if (scenario === 'leaves a user turn alone when settings differ') {
        service.update(task.id, { ...task, model: 'fixture/other', thinkingLevel: 'high' })
      }
      await assert.rejects(service.runNow(task.id), /active run/i)
      assert.equal(supervisor.sessionInfo(file)?.running, true)
      assert.deepEqual(runtime.prompts, ['Review the project', 'User turn'])
      runtime.settle()
      assert.equal(service.list()[0].lastStatus, 'error')
    } else if (scenario === 'stops while checking settings') {
      service.update(task.id, { ...task, model: 'fixture/other' })
      const checking = Promise.withResolvers<void>()
      const checked = Promise.withResolvers<void>()
      const request = runtime.request.bind(runtime)
      runtime.request = async <T>(command: string, payload?: Record<string, unknown>): Promise<T> => {
        if (command === 'get_state') {
          checking.resolve()
          await checked.promise
        }
        return request<T>(command, payload)
      }
      const launch = service.runNow(task.id)
      await Promise.race([checking.promise, launch.then(() => assert.fail('task did not check settings'))])
      assert.equal(await service.stopRun(task.id), true)
      checked.resolve()
      await launch
      assert.equal(runtime.isRunning, true)
      assert.deepEqual(runtime.prompts, ['Review the project'])
      assert.equal(service.list()[0].lastStatus, 'aborted')
    } else if (scenario === 'stops before dispatch') {
      let launch: ReturnType<ScheduledTaskService['runNow']> | undefined
      await supervisor.withCwdLock(root, async () => {
        const queued = once(supervisor, 'queued')
        launch = service.runNow(task.id)
        await Promise.race([queued, launch.then(() => assert.fail('task did not queue'))])
        assert.equal(await service.stopRun(task.id), true)
        assert.equal(service.list()[0].lastStatus, 'aborted')
        assert.equal(runtime.isRunning, true)
      })
      await launch
      assert.deepEqual(runtime.prompts, ['Review the project'])
      assert.equal(service.list()[0].lastStatus, 'aborted')
    } else {
      await service.runNow(task.id)
      assert.equal(service.list()[0].lastStatus, 'running')
      runtime.settle()
      const [saved] = JSON.parse(readFileSync(path.join(root, 'scheduled-tasks.json'), 'utf8'))
      assert.equal(saved.lastStatus, 'completed')
      assert.equal(saved.lastSessionFile, file)
      assert.deepEqual(runtime.prompts, ['Review the project', 'Review the project'])
    }
    assert.equal(runtime.starts, 1)
  })
}

test('a reuse task continues the conversation its previous run wrote', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-reuse-'))
  const { service, supervisor } = makeService(root)
  try {
    const created = service.create({
      title: 'Daily review',
      prompt: 'Review the market',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '15:20' },
      sessionMode: 'reuse'
    })
    const task = created[0]
    assert.equal(task.sessionMode, 'reuse')
    assert.equal(task.reuseSessionFile, undefined)

    // First run: nothing to continue yet, so it starts a conversation.
    await service.runNow(task.id)
    const firstKey = supervisor.ensures[0].sessionKey
    assert.equal(supervisor.ensures[0].sessionFile, undefined)
    const sessionFile = writeConversation(root, root)
    supervisor.settle(firstKey, sessionFile)

    const afterFirst = service.list().find((entry) => entry.id === task.id)
    assert.equal(afterFirst?.reuseSessionFile, sessionFile)
    assert.equal(afterFirst?.lastSessionFile, sessionFile)

    // Second run: it resumes the same conversation.
    await service.runNow(task.id)
    assert.equal(supervisor.ensures[1].sessionFile, sessionFile)
    supervisor.settle(supervisor.ensures[1].sessionKey, sessionFile)

    // Going back to a new conversation per run forgets the file. The renderer
    // sends the cleared choice as an explicit undefined over IPC.
    const updated = service.update(task.id, {
      title: task.title,
      prompt: task.prompt,
      workspaceId: task.workspaceId,
      schedule: task.schedule,
      sessionMode: undefined
    })
    assert.equal(updated[0].sessionMode, undefined)
    assert.equal(updated[0].reuseSessionFile, undefined)
    // The same goes for the file, which is what a restart reads.
    const stored = JSON.parse(readFileSync(path.join(root, 'scheduled-tasks.json'), 'utf8'))[0]
    assert.equal(stored.sessionMode, undefined)
    assert.equal(stored.reuseSessionFile, undefined)
  } finally {
    await service.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

for (const editingDuringRun of [false, true]) {
  test(`changing the project ${editingDuringRun ? 'during' : 'after'} a run keeps the next run in the new project`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-move-'))
    const { service, supervisor } = makeService(root)
    t.after(() => {
      service.dispose()
      rmSync(root, { recursive: true, force: true })
    })
    const input: ScheduledTaskInput = {
      title: 'Project review', prompt: 'Review the project', workspaceId: 'project',
      schedule: { kind: 'daily', time: '15:20' }, sessionMode: 'reuse'
    }
    const [task] = service.create(input)
    await service.runNow(task.id)
    const session = writeConversation(root, root)
    if (!editingDuringRun) supervisor.settle(supervisor.ensures[0].sessionKey, session)

    service.update(task.id, { ...input, workspaceId: 'other' })
    if (editingDuringRun) supervisor.settle(supervisor.ensures[0].sessionKey, session)

    const [saved] = JSON.parse(readFileSync(path.join(root, 'scheduled-tasks.json'), 'utf8'))
    assert.equal(saved.workspaceId, 'other')
    assert.equal(saved.reuseSessionFile, undefined)
    assert.equal(saved.lastSessionFile, session)
    await service.runNow(task.id)
    const next = supervisor.ensures[1]
    assert.equal(next.cwd, path.join(root, 'other-project'))
    assert.equal(next.sessionFile, undefined)
    const nextSession = writeConversation(root, next.cwd, 'other-task')
    supervisor.settle(next.sessionKey, nextSession)
    await service.runNow(task.id)
    assert.equal(supervisor.ensures[2].sessionFile, nextSession)
    supervisor.settle(supervisor.ensures[2].sessionKey, nextSession)
  })
}

test('a stored conversation from a different project is skipped when the task starts', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-stale-conversation-'))
  const sessionFile = writeConversation(root, root)
  const workspaceId = 'other'
  writeFileSync(path.join(root, 'scheduled-tasks.json'), JSON.stringify([{
    id: 'task', title: 'Project review', prompt: 'Review the project', workspaceId,
    enabled: true, createdAt: Date.now(), schedule: { kind: 'daily', time: '15:20' },
    sessionMode: 'reuse', reuseSessionFile: sessionFile
  }]))
  const { service, supervisor } = makeService(root)
  t.after(() => {
    service.dispose()
    rmSync(root, { recursive: true, force: true })
  })

  await service.runNow('task')
  assert.equal(supervisor.ensures[0].sessionFile, undefined)
})

test('stopping a task while its saved conversation is checked prevents launch', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-cancel-resume-'))
  const { service, supervisor } = makeService(root)
  t.after(() => {
    service.dispose()
    rmSync(root, { recursive: true, force: true })
  })
  const [task] = service.create({
    title: 'Project review', prompt: 'Review the project', workspaceId: 'project',
    schedule: { kind: 'daily', time: '15:20' }, sessionMode: 'reuse'
  })
  await service.runNow(task.id)
  supervisor.settle(supervisor.ensures[0].sessionKey, writeConversation(root, root))

  const launch = service.runNow(task.id)
  assert.equal(await service.stopRun(task.id), true)
  await launch
  assert.equal(supervisor.ensures.length, 1)
  assert.equal(service.list()[0].lastStatus, 'aborted')
})

test('a new-conversation task never resumes, even after a run wrote a session', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-new-'))
  const { service, supervisor } = makeService(root)
  try {
    const task = service.create({
      title: 'Fresh each time',
      prompt: 'Say hello',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '09:00' }
    })[0]
    await service.runNow(task.id)
    const file = path.join(root, 'a.jsonl')
    supervisor.settle(supervisor.ensures[0].sessionKey, file)
    await service.runNow(task.id)
    assert.equal(supervisor.ensures[1].sessionFile, undefined)
    assert.equal(service.list()[0].reuseSessionFile, undefined)
  } finally {
    await service.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a reuse task starts over when the conversation it names is gone', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-missing-'))
  const { service, supervisor } = makeService(root)
  try {
    const task = service.create({
      title: 'Continue a deleted chat',
      prompt: 'Continue',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '10:00' },
      sessionMode: 'reuse'
    })[0]
    await service.runNow(task.id)
    supervisor.settle(supervisor.ensures[0].sessionKey, path.join(root, 'gone.jsonl'))
    await service.runNow(task.id)
    // The file was never written on disk, so the run starts a fresh one.
    assert.equal(supervisor.ensures[1].sessionFile, undefined)
  } finally {
    await service.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

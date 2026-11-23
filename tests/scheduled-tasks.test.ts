import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ScheduledTaskService } from '../src/main/scheduled-tasks'
import { properLockfile } from '../src/main/proper-lockfile'
import type { SettingsStore } from '../src/main/settings'
import type { SessionSupervisor } from '../src/main/pi/supervisor'

class FakeSupervisor extends EventEmitter {
  ownerId: string | undefined
  ensureCalls = 0
  lastEnsure: {
    sessionKey: string
    model?: string
    thinkingLevel?: string
    rememberDefaults?: boolean
  } | undefined

  async ensure(options: {
    sessionKey: string
    model?: string
    thinkingLevel?: string
    rememberDefaults?: boolean
  }): Promise<{ ok: boolean }> {
    this.ownerId = options.sessionKey
    this.ensureCalls += 1
    this.lastEnsure = options
    return { ok: true }
  }

  async request<T>(_key: string, command: string): Promise<T> {
    return (command === 'prompt' ? { disposition: 'started' } : {}) as T
  }

  sessionInfo(): { cwd: string; externalContext: boolean; running: boolean } {
    return { cwd: '', externalContext: false, running: false }
  }
}

class RecordingSupervisor extends FakeSupervisor {
  ownerIds: string[] = []

  async ensure(options: { sessionKey: string }): Promise<{ ok: boolean }> {
    const result = await super.ensure(options)
    this.ownerIds.push(options.sessionKey)
    return result
  }
}

class RecordingProcessOwnedSupervisor extends RecordingSupervisor {
  constructor(private readonly processId: number) {
    super()
  }

  sessionInfo(): { cwd: string; externalContext: boolean; running: boolean; pid: number } {
    return { cwd: '', externalContext: false, running: true, pid: this.processId }
  }
}

class CompletingSupervisor extends FakeSupervisor {
  async request<T>(key: string, command: string): Promise<T> {
    if (command === 'prompt') {
      this.emit('event', {
        ownerId: key,
        event: { type: 'agent_settled', aborted: false }
      })
      return { disposition: 'handled' } as T
    }
    return {} as T
  }
}

class CancelledPromptSupervisor extends FakeSupervisor {
  async request<T>(_key: string, command: string): Promise<T> {
    return (command === 'prompt' ? { disposition: 'handled', cancelled: true } : {}) as T
  }
}

class RunningRequestFailureSupervisor extends FakeSupervisor {
  running = false
  failNextPrompt = true

  async request<T>(key: string, command: string): Promise<T> {
    if (command !== 'prompt') return {} as T
    this.running = true
    if (this.failNextPrompt) {
      this.failNextPrompt = false
      throw new Error('Timed out waiting for prompt response')
    }
    return { disposition: 'started' } as T
  }

  sessionInfo(): { cwd: string; externalContext: boolean; running: boolean } {
    return { cwd: '', externalContext: false, running: this.running }
  }
}

class SettledRequestFailureSupervisor extends FakeSupervisor {
  async request<T>(key: string, command: string): Promise<T> {
    if (command === 'prompt') {
      this.emit('event', {
        ownerId: key,
        event: { type: 'agent_settled', aborted: false }
      })
      throw new Error('Late RPC failure')
    }
    return {} as T
  }

  sessionInfo(): { cwd: string; externalContext: boolean; running: boolean } {
    return { cwd: '', externalContext: false, running: false }
  }
}

class RpcErrorWhileRunningSupervisor extends FakeSupervisor {
  running = false

  async request<T>(key: string, command: string): Promise<T> {
    if (command === 'prompt') this.running = true
    return (command === 'prompt' ? { disposition: 'started' } : {}) as T
  }

  sessionInfo(): { cwd: string; externalContext: boolean; running: boolean } {
    return { cwd: '', externalContext: false, running: this.running }
  }
}

class ProcessOwnedSupervisor extends FakeSupervisor {
  constructor(private readonly processId: number) {
    super()
  }

  async request<T>(_key: string, command: string): Promise<T> {
    return (command === 'prompt' ? { disposition: 'started' } : {}) as T
  }

  sessionInfo(): { cwd: string; externalContext: boolean; running: boolean; pid: number } {
    return { cwd: '', externalContext: false, running: true, pid: this.processId }
  }
}

async function startIdleProcess(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    windowsHide: true
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  return child
}

async function stopIdleProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill()
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
}

function unusedProcessId(): number {
  for (let pid = 1_000_000; pid > 1; pid -= 1) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return pid
    }
  }
  throw new Error('Could not find an unused process id for the test.')
}

test('failed persistence does not publish a scheduled task into memory', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-persist-test-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    mkdirSync(path.join(userData, 'scheduled-tasks.json'))
    assert.throws(() => service.create({
      title: 'Do not publish',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    }))
    assert.deepEqual(service.list(), [])
    assert.deepEqual(readdirSync(userData), ['scheduled-tasks.json'])
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('separate task services merge edits and serialize runs through the shared file', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-multi-'))
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const firstSupervisor = new FakeSupervisor()
  const secondSupervisor = new FakeSupervisor()
  const first = new ScheduledTaskService({
    userData,
    settings,
    supervisor: firstSupervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  const second = new ScheduledTaskService({
    userData,
    settings,
    supervisor: secondSupervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const create = (title: string) => ({
      title,
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once' as const, at: Date.now() + 60 * 60 * 1000 }
    })
    const firstTask = first.create(create('From first window'))[0]
    const secondTask = second.create(create('From second window')).find((task) => task.title === 'From second window')
    assert.ok(firstTask)
    assert.ok(secondTask)
    assert.deepEqual(first.list().map((task) => task.title).sort(), ['From first window', 'From second window'])
    assert.deepEqual(second.list().map((task) => task.title).sort(), ['From first window', 'From second window'])

    const outcomes = await Promise.allSettled([
      first.runNow(firstTask.id),
      second.runNow(firstTask.id)
    ])
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1)
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1)
    assert.equal(firstSupervisor.ensureCalls + secondSupervisor.ensureCalls, 1)

    const runner = firstSupervisor.ensureCalls ? firstSupervisor : secondSupervisor
    const winner = firstSupervisor.ensureCalls ? first : second
    runner.emit('event', {
      ownerId: runner.ownerId!,
      event: { type: 'agent_settled', aborted: false }
    })
    assert.equal(winner.list().find((task) => task.id === firstTask.id)?.lastStatus, 'completed')
    assert.equal(first.list().find((task) => task.id === secondTask.id)?.title, 'From second window')
    assert.equal(second.list().find((task) => task.id === secondTask.id)?.title, 'From second window')
  } finally {
    first.dispose()
    second.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('scheduled task runs share a four-process limit across app instances', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-run-slots-'))
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const firstSupervisor = new RecordingSupervisor()
  const secondSupervisor = new RecordingSupervisor()
  const first = new ScheduledTaskService({
    userData,
    settings,
    supervisor: firstSupervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  const second = new ScheduledTaskService({
    userData,
    settings,
    supervisor: secondSupervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const tasks = Array.from({ length: 5 }, (_, index) => first.create({
      title: `Task ${index}`,
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once' as const, at: Date.now() + 60 * 60 * 1000 }
    }).at(-1)!)
    await Promise.all(tasks.slice(0, 4).map((task) => first.runNow(task.id)))
    assert.equal(firstSupervisor.ensureCalls, 4)
    await assert.rejects(second.runNow(tasks[4]!.id), /run slots are busy/)
    assert.equal(secondSupervisor.ensureCalls, 0)

    firstSupervisor.emit('event', {
      ownerId: firstSupervisor.ownerIds[0],
      event: { type: 'agent_settled', aborted: false }
    })
    await second.runNow(tasks[4]!.id)
    assert.equal(secondSupervisor.ensureCalls, 1)
  } finally {
    for (const ownerId of firstSupervisor.ownerIds) {
      firstSupervisor.emit('event', { ownerId, event: { type: 'agent_settled', aborted: false } })
    }
    for (const ownerId of secondSupervisor.ownerIds) {
      secondSupervisor.emit('event', { ownerId, event: { type: 'agent_settled', aborted: false } })
    }
    first.dispose()
    second.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('stale run slots stay occupied while their Pi processes are alive', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-live-slots-'))
  const piProcess = await startIdleProcess()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const firstSupervisor = new RecordingProcessOwnedSupervisor(piProcess.pid!)
  const secondSupervisor = new FakeSupervisor()
  const first = new ScheduledTaskService({
    userData,
    settings,
    supervisor: firstSupervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  const second = new ScheduledTaskService({
    userData,
    settings,
    supervisor: secondSupervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const tasks = Array.from({ length: 5 }, (_, index) => first.create({
      title: `Orphaned task ${index}`,
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once' as const, at: Date.now() + 60 * 60 * 1000 }
    }).at(-1)!)
    await Promise.all(tasks.slice(0, 4).map((task) => first.runNow(task.id)))

    for (let slot = 0; slot < 4; slot += 1) {
      const lockFile = path.join(userData, `scheduled-task-run-slot-${slot}`)
      const ownerFile = `${lockFile}.owner.json`
      const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as Record<string, unknown>
      assert.equal(owner.piPid, piProcess.pid)
      writeFileSync(ownerFile, JSON.stringify({ ...owner, ownerPid: unusedProcessId() }))
      const staleTime = new Date(Date.now() - 90_000)
      utimesSync(`${lockFile}.lock`, staleTime, staleTime)
    }

    await assert.rejects(second.runNow(tasks[4]!.id), /run slots are busy/)
    assert.equal(secondSupervisor.ensureCalls, 0)
  } finally {
    for (const ownerId of firstSupervisor.ownerIds) {
      firstSupervisor.emit('event', { ownerId, event: { type: 'agent_settled', aborted: false } })
    }
    first.dispose()
    second.dispose()
    rmSync(userData, { recursive: true, force: true })
    await stopIdleProcess(piProcess)
  }
})

test('a running task lock uses the same stale timeout as its heartbeat', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-live-lock-'))
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const first = new ScheduledTaskService({
    userData,
    settings,
    supervisor: new FakeSupervisor() as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  let second: ScheduledTaskService | undefined

  try {
    const task = first.create({
      title: 'Long running task',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once', at: Date.now() + 60 * 60 * 1000 }
    })[0]
    assert.ok(task)
    await first.runNow(task.id)

    const digest = createHash('sha256').update(task.id).digest('hex')
    const lockDirectory = path.join(userData, `scheduled-task-${digest}.run.lock`)
    const staleForDefaultCheck = new Date(Date.now() - 15_000)
    utimesSync(lockDirectory, staleForDefaultCheck, staleForDefaultCheck)

    second = new ScheduledTaskService({
      userData,
      settings,
      supervisor: new FakeSupervisor() as unknown as SessionSupervisor,
      customInstructions: () => undefined
    })
    assert.equal(second.list()[0]?.lastStatus, 'running')
  } finally {
    second?.dispose()
    first.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('stopping the scheduler keeps active-run settlement handling until shutdown completes', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-shutdown-'))
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const supervisor = new FakeSupervisor()
  supervisor.sessionInfo = () => ({ cwd: userData, externalContext: false, running: true })
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  let reopened: ScheduledTaskService | undefined

  try {
    const task = service.create({
      title: 'Shutdown task',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once', at: Date.now() + 60 * 60 * 1000 }
    })[0]
    assert.ok(task)
    await service.runNow(task.id)

    service.stopScheduling()
    await assert.rejects(() => service.runNow(task.id), /shutting down/)
    supervisor.emit('event', {
      ownerId: supervisor.ownerId,
      event: { type: 'agent_settled', aborted: true, runtimeStopped: true }
    })

    assert.equal(service.list()[0]?.lastStatus, 'aborted')
    reopened = new ScheduledTaskService({
      userData,
      settings,
      supervisor: new FakeSupervisor() as unknown as SessionSupervisor,
      customInstructions: () => undefined
    })
    await assert.doesNotReject(() => reopened!.runNow(task.id))
  } finally {
    reopened?.dispose()
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a task left running at startup is recovered after its lease expires', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-expired-lock-'))
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const first = new ScheduledTaskService({
    userData,
    settings,
    supervisor: new FakeSupervisor() as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  let second: ScheduledTaskService | undefined

  try {
    const task = first.create({
      title: 'Recover after a crash',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once', at: Date.now() + 60 * 60 * 1000 }
    })[0]
    assert.ok(task)
    await first.runNow(task.id)

    second = new ScheduledTaskService({
      userData,
      settings,
      supervisor: new FakeSupervisor() as unknown as SessionSupervisor,
      customInstructions: () => undefined
    })
    assert.equal(second.list()[0]?.lastStatus, 'running')

    const digest = createHash('sha256').update(task.id).digest('hex')
    const lockDirectory = path.join(userData, `scheduled-task-${digest}.run.lock`)
    const staleTime = new Date(Date.now() - 90_000)
    const ownerFile = `${path.join(userData, `scheduled-task-${digest}.run`)}.owner.json`
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as Record<string, unknown>
    writeFileSync(ownerFile, JSON.stringify({ ...owner, ownerPid: unusedProcessId() }))
    let stopWaiting!: () => void
    const recovered = new Promise<void>((resolve, reject) => {
      const onChanged = (tasks: { id: string; lastStatus?: string }[]) => {
        if (tasks.find((entry) => entry.id === task.id)?.lastStatus !== 'error') return
        clearTimeout(timeout)
        second?.off('changed', onChanged)
        resolve()
      }
      const timeout = setTimeout(() => {
        second?.off('changed', onChanged)
        reject(new Error('expired task lease was not recovered'))
      }, 5000)
      second?.on('changed', onChanged)
      stopWaiting = () => {
        clearTimeout(timeout)
        second?.off('changed', onChanged)
      }
    })
    try {
      utimesSync(lockDirectory, staleTime, staleTime)
      await recovered
    } finally {
      stopWaiting()
    }

    assert.equal(second.list()[0]?.lastStatus, 'error')
    assert.equal(second.list()[0]?.lastError, 'Pi Desktop closed before this task finished.')
  } finally {
    second?.dispose()
    first.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('an expired lease does not relaunch a due task while its Pi process is alive', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-live-process-'))
  const piProcess = await startIdleProcess()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const firstSupervisor = new ProcessOwnedSupervisor(piProcess.pid!)
  const first = new ScheduledTaskService({
    userData,
    settings,
    supervisor: firstSupervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  let second: ScheduledTaskService | undefined

  try {
    const task = first.create({
      title: 'Do not overlap after restart',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    assert.ok(task)
    await first.runNow(task.id)

    const taskFile = path.join(userData, 'scheduled-tasks.json')
    const saved = JSON.parse(readFileSync(taskFile, 'utf8')) as Array<Record<string, unknown>>
    writeFileSync(taskFile, JSON.stringify(saved.map((entry) => ({
      ...entry,
      nextRunAt: Date.now() - 1_000
    }))))

    const digest = createHash('sha256').update(task.id).digest('hex')
    const ownerFile = `${path.join(userData, `scheduled-task-${digest}.run`)}.owner.json`
    const owner = JSON.parse(readFileSync(ownerFile, 'utf8')) as Record<string, unknown>
    assert.equal(owner.piPid, piProcess.pid)
    assert.equal(owner.lastRunAt, first.list()[0]?.lastRunAt)
    writeFileSync(ownerFile, JSON.stringify({ ...owner, ownerPid: unusedProcessId() }))

    const lockDirectory = path.join(userData, `scheduled-task-${digest}.run.lock`)
    const staleTime = new Date(Date.now() - 90_000)
    utimesSync(lockDirectory, staleTime, staleTime)

    const secondSupervisor = new FakeSupervisor()
    second = new ScheduledTaskService({
      userData,
      settings,
      supervisor: secondSupervisor as unknown as SessionSupervisor,
      customInstructions: () => undefined
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    assert.equal(second.list()[0]?.lastStatus, 'running')
    assert.equal(secondSupervisor.ensureCalls, 0)
  } finally {
    second?.dispose()
    first.dispose()
    rmSync(userData, { recursive: true, force: true })
    await stopIdleProcess(piProcess)
  }
})

for (const state of ['unclaimed', 'replacement lease', 'crashed', 'running', 'legacy running'] as const) {
  test(`a due recurring occurrence is only skipped for a matching live run (${state})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const userData = mkdtempSync(path.join(tmpdir(), 'pi-schedule-overlap-'))
    const file = path.join(userData, 'scheduled-tasks.json')
    const now = Date.now()
    const dueAt = now - 1000
    const lastRunAt = now - 24 * 60 * 60 * 1000
    const id = 'daily-job'
    const lock = path.join(userData, `scheduled-task-${createHash('sha256').update(id).digest('hex')}.run`)
    const ownerFile = `${lock}.owner.json`
    mkdirSync(`${lock}.lock`)
    writeFileSync(ownerFile, JSON.stringify({
      token: 'lease',
      ownerPid: state === 'crashed' ? unusedProcessId() : process.pid,
      ...(state === 'legacy running'
        ? { piPid: process.pid }
        : { lastRunAt: state === 'unclaimed' || state === 'replacement lease' ? now : lastRunAt })
    }))
    writeFileSync(file, JSON.stringify([{
      id, title: 'Daily job', prompt: 'Run the daily job', workspaceId: 'project', enabled: true,
      createdAt: lastRunAt, nextRunAt: dueAt, schedule: { kind: 'daily', time: '00:00' },
      ...(state === 'unclaimed' ? {} : { lastStatus: 'running', lastRunAt })
    }]))
    const supervisor = new CompletingSupervisor()
    const service = new ScheduledTaskService({
      userData,
      settings: { get: () => ({ workspaces: [{ id: 'project', path: userData }] }) } as unknown as SettingsStore,
      supervisor: supervisor as unknown as SessionSupervisor,
      customInstructions: () => undefined
    })
    try {
      t.mock.timers.tick(2_000)
      assert.equal(supervisor.ensureCalls, 0)
      if (state === 'running' || state === 'legacy running') {
        assert.ok((service.list()[0]?.nextRunAt ?? 0) > now)
        return
      }
      assert.equal(service.list()[0]?.nextRunAt, dueAt, 'the lease alone must not consume the occurrence')

      if (state === 'crashed') {
        const expiredAt = new Date(now - 90_000)
        utimesSync(`${lock}.lock`, expiredAt, expiredAt)
      } else {
        rmdirSync(`${lock}.lock`)
        unlinkSync(ownerFile)
      }
      t.mock.timers.tick(2_000)
      t.mock.timers.tick(250)
      await new Promise<void>(resolve => setImmediate(resolve))

      assert.equal(supervisor.ensureCalls, 1, 'the original occurrence starts once the lease clears')
      assert.equal(service.list()[0]?.lastStatus, 'completed')
    } finally {
      service.dispose()
      rmSync(userData, { recursive: true, force: true })
    }
  })
}

test('a task whose running status cannot be saved is released for retry', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-start-persist-test-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Retry after disk recovers',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once', at: Date.now() + 60 * 60 * 1000 }
    })[0]
    assert.ok(task)
    const file = path.join(userData, 'scheduled-tasks.json')
    unlinkSync(file)
    mkdirSync(file)

    await assert.rejects(service.runNow(task.id))
    assert.equal(service.list()[0]?.lastStatus, 'error')
    assert.equal(supervisor.ensureCalls, 0)

    rmSync(file, { recursive: true })
    await service.runNow(task.id)
    assert.equal(service.list()[0]?.lastStatus, 'running')
    assert.equal(supervisor.ensureCalls, 1)
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a failing automatic launch backs off instead of retrying in a tight loop', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-backoff-test-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  const originalError = console.error
  let attempts = 0

  try {
    const task = service.create({
      title: 'Unwritable task file',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once', at: Date.now() + 400 }
    })[0]
    assert.ok(task)
    // Every write now fails: the task file becomes a directory. An automatic
    // launch cannot advance the schedule, so the task stays due.
    const file = path.join(userData, 'scheduled-tasks.json')
    unlinkSync(file)
    mkdirSync(file)
    console.error = () => { attempts += 1 }

    await new Promise((resolve) => setTimeout(resolve, 1_500))

    // Without a backoff the timer re-armed at 0ms and ran ~30 attempts in this
    // window; one backed-off attempt is the expected shape.
    assert.ok(attempts <= 3, `expected one backed-off attempt, saw ${attempts}`)
    assert.equal(supervisor.ensureCalls, 0)
    assert.ok((service.list()[0]?.nextRunAt ?? 0) > Date.now())
  } finally {
    console.error = originalError
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a scheduled run that crashes is recorded as an error, not completed', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-test-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Scheduled task',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once', at: Date.now() + 60 * 60 * 1000 }
    })[0]
    assert.ok(task)

    await service.runNow(task.id)
    assert.ok(supervisor.ownerId)
    supervisor.emit('event', {
      ownerId: supervisor.ownerId,
      event: { type: 'agent_settled', aborted: false, crashed: true }
    })

    const updated = service.list()[0]
    assert.equal(updated?.lastStatus, 'error')
    assert.equal(updated?.lastError, 'Pi exited unexpectedly before this task finished.')
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('scheduled tasks record the final model outcome when Pi settles', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-model-outcome-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const [task] = service.create({
      title: 'Check model outcome',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })
    const modelError = 'Provider rejected the request'
    const sessionFile = path.join(userData, 'test-session.jsonl')
    for (const outcome of ['error', 'completed', 'aborted'] as const) {
      await service.runNow(task.id)
      const ownerId = supervisor.ownerId
      const willRetry = outcome !== 'error'
      supervisor.emit('event', {
        ownerId,
        event: {
          type: 'agent_end',
          willRetry,
          messages: [
            { role: 'assistant', content: 'Starting', stopReason: 'toolUse' },
            { role: 'assistant', content: [], stopReason: 'error', errorMessage: modelError }
          ]
        }
      })
      assert.equal(service.list()[0]?.lastStatus, 'running')
      supervisor.emit('rekey', { from: ownerId, to: sessionFile })
      if (outcome === 'completed') {
        supervisor.emit('event', {
          ownerId: sessionFile,
          event: { type: 'agent_end', messages: [{ role: 'assistant', content: 'Done', stopReason: 'stop' }] }
        })
      }
      supervisor.emit('event', {
        ownerId: sessionFile,
        event: { type: 'agent_settled', aborted: outcome === 'aborted' }
      })

      const [saved] = JSON.parse(readFileSync(path.join(userData, 'scheduled-tasks.json'), 'utf8'))
      assert.equal(saved.lastStatus, outcome)
      assert.equal(saved.lastError, outcome === 'error' ? modelError : undefined)
      assert.equal(saved.lastSessionFile, sessionFile)
    }
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('an RPC error keeps a scheduled task reserved while its agent is still running', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-rpc-error-test-'))
  const supervisor = new RpcErrorWhileRunningSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Keep the run reserved',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    assert.ok(task)
    await service.runNow(task.id)
    assert.ok(supervisor.ownerId)

    supervisor.emit('status', {
      ownerId: supervisor.ownerId,
      status: { phase: 'error', cwd: userData, error: 'pipe failed' }
    })
    assert.equal(service.list()[0]?.lastStatus, 'running')
    await assert.rejects(service.runNow(task.id), /already running/)
    assert.equal(supervisor.ensureCalls, 1)

    supervisor.running = false
    supervisor.emit('event', {
      ownerId: supervisor.ownerId,
      event: { type: 'agent_settled', aborted: false }
    })
    assert.equal(service.list()[0]?.lastStatus, 'completed')
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('runNow rejects a task whose previous agent run has not settled', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-overlap-test-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'One task at a time',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    assert.ok(task)

    await service.runNow(task.id)
    await assert.rejects(service.runNow(task.id), /already running/)
    assert.equal(supervisor.ensureCalls, 1)
    assert.equal(service.list()[0]?.lastStatus, 'running')

    assert.ok(supervisor.ownerId)
    supervisor.emit('event', {
      ownerId: supervisor.ownerId,
      event: { type: 'agent_settled', aborted: false }
    })
    await service.runNow(task.id)
    assert.equal(supervisor.ensureCalls, 2, 'a new run is allowed after the previous run settles')
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a failed prompt response keeps a still-running task reserved until settle', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-timeout-test-'))
  const supervisor = new RunningRequestFailureSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'No overlapping retry',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    assert.ok(task)

    await assert.rejects(service.runNow(task.id), /Timed out/)
    await assert.rejects(service.runNow(task.id), /already running/)
    assert.equal(supervisor.ensureCalls, 1)
    assert.equal(service.list()[0]?.lastStatus, 'running')

    assert.ok(supervisor.ownerId)
    supervisor.running = false
    supervisor.emit('event', {
      ownerId: supervisor.ownerId,
      event: { type: 'agent_settled', aborted: false }
    })
    assert.equal(service.list()[0]?.lastStatus, 'completed')

    await service.runNow(task.id)
    assert.equal(supervisor.ensureCalls, 2)
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a late prompt response failure does not overwrite an already settled task', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-late-failure-test-'))
  const supervisor = new SettledRequestFailureSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Keep settled result',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    assert.ok(task)

    await assert.rejects(service.runNow(task.id), /Late RPC failure/)
    assert.equal(service.list()[0]?.lastStatus, 'completed')
    await assert.rejects(service.runNow(task.id), /Late RPC failure/)
    assert.equal(supervisor.ensureCalls, 2, 'a new run is allowed after the previous run settles')
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a late RPC failure cannot finish or unlock the next run of the same task', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-late-response-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const open = (owner: FakeSupervisor) => new ScheduledTaskService({
    userData,
    settings,
    supervisor: owner as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  const service = open(supervisor)
  const peerSupervisor = new FakeSupervisor()
  const peer = open(peerSupervisor)

  const firstPrompt = Promise.withResolvers<string>()
  const firstResponse = Promise.withResolvers<never>()
  supervisor.request = async <T>(key: string, command: string): Promise<T> => {
    if (command !== 'prompt') return {} as T
    if (supervisor.ensureCalls === 1) {
      firstPrompt.resolve(key)
      return firstResponse.promise
    }
    return { disposition: 'started' } as T
  }

  try {
    const [task] = service.create({
      title: 'Keep the next run reserved',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })
    const firstRun = assert.rejects(service.runNow(task.id), /Late RPC failure/)
    const firstKey = await firstPrompt.promise
    const firstFile = path.join(userData, 'first-session.jsonl')
    supervisor.emit('rekey', { from: firstKey, to: firstFile })
    supervisor.emit('event', { ownerId: firstFile, event: { type: 'agent_settled', aborted: false } })

    await service.runNow(task.id)
    const secondKey = supervisor.ownerId
    assert.notEqual(secondKey, firstKey)
    firstResponse.reject(new Error('Late RPC failure'))
    await firstRun

    const [saved] = JSON.parse(readFileSync(path.join(userData, 'scheduled-tasks.json'), 'utf8'))
    assert.equal(saved.lastStatus, 'running')
    assert.equal(saved.lastError, undefined)
    await assert.rejects(service.runNow(task.id), /already running/)
    await assert.rejects(peer.runNow(task.id), /already running/)
    assert.equal(supervisor.ensureCalls, 2)
    assert.equal(peerSupervisor.ensureCalls, 0)

    supervisor.emit('event', { ownerId: secondKey, event: { type: 'agent_settled', aborted: false } })
    assert.equal(service.list()[0]?.lastStatus, 'completed')
  } finally {
    service.dispose()
    peer.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a handled prompt settles the run after its draft acquires a session file', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-handled-rekey-'))
  const sessionFile = path.join(userData, 'handled-session.jsonl')
  const supervisor = new FakeSupervisor()
  supervisor.request = async <T>(key: string, command: string): Promise<T> => {
    if (command !== 'prompt') return {} as T
    supervisor.emit('rekey', { from: key, to: sessionFile })
    return { disposition: 'handled' } as T
  }
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const [task] = service.create({
      title: 'Handled after rekey',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })
    const [completed] = await service.runNow(task.id)
    assert.equal(completed.lastStatus, 'completed')
    assert.equal(completed.lastSessionFile, sessionFile)
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a prompt removed from the supervisor queue is recorded as aborted', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-cancelled-test-'))
  const supervisor = new CancelledPromptSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Cancelled before start',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    assert.ok(task)

    await service.runNow(task.id)

    assert.equal(service.list()[0]?.lastStatus, 'aborted')
    assert.equal(supervisor.ensureCalls, 1)
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a completion persistence failure does not interrupt supervisor event delivery', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-persist-test-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  const originalError = console.error
  let laterListenerReceivedEvent = false

  try {
    const task = service.create({
      title: 'Persist completion',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    assert.ok(task)
    await service.runNow(task.id)
    assert.ok(supervisor.ownerId)

    const serviceInternals = service as unknown as { write: () => void }
    const originalWrite = serviceInternals.write
    serviceInternals.write = () => { throw new Error('disk full') }
    supervisor.on('event', () => { laterListenerReceivedEvent = true })
    console.error = () => {}

    assert.doesNotThrow(() => supervisor.emit('event', {
      ownerId: supervisor.ownerId!,
      event: { type: 'agent_settled', aborted: false }
    }))
    assert.equal(laterListenerReceivedEvent, true)
    assert.equal(service.list()[0]?.lastStatus, 'completed')

    serviceInternals.write = originalWrite
    service.dispose()
    const [saved] = JSON.parse(readFileSync(path.join(userData, 'scheduled-tasks.json'), 'utf8'))
    assert.equal(saved.lastStatus, 'completed', 'shutdown flushes the result if storage has recovered')
  } finally {
    console.error = originalError
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a completion blocked by another writer persists without losing a concurrent edit', async (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-retry-result-'))
  const file = path.join(userData, 'scheduled-tasks.json')
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const open = (owner = new FakeSupervisor()) => new ScheduledTaskService({
    userData,
    settings,
    supervisor: owner as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  const first = open(supervisor)
  const services = [first]

  try {
    const [task] = first.create({
      title: 'Durable result',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once', at: Date.now() + 3_600_000 }
    })
    await first.runNow(task.id)
    const sessionFile = path.join(userData, 'result.jsonl')
    supervisor.emit('rekey', { from: supervisor.ownerId, to: sessionFile })
    const release = properLockfile.lockSync(file, { realpath: false })
    const log = t.mock.method(console, 'error', () => {})
    try {
      supervisor.emit('event', { ownerId: sessionFile, event: { type: 'agent_settled', aborted: false } })
      assert.equal(first.list()[0]?.lastStatus, 'completed')
      assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0]?.lastStatus, 'running')
    } finally {
      log.mock.restore()
      release()
    }

    const second = open()
    services.push(second)
    assert.equal(second.list()[0]?.lastStatus, 'running', 'a peer must not recover a result being saved')
    second.update(task.id, { ...task, title: 'Edited in the second instance' })

    const deadline = Date.now() + 6_000
    while (Date.now() < deadline && JSON.parse(readFileSync(file, 'utf8'))[0]?.lastStatus !== 'completed') {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0]?.lastStatus, 'completed', 'the scheduler retries without a user edit')
    first.dispose()
    const reopened = open()
    services.push(reopened)
    const [saved] = reopened.list()
    assert.equal(saved?.lastStatus, 'completed')
    assert.equal(saved?.lastSessionFile, sessionFile)
    assert.equal(saved?.title, 'Edited in the second instance')
    assert.equal(saved?.enabled, false)
  } finally {
    for (const service of services) service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('runNow consumes an overdue recurring occurrence instead of launching it again', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-overdue-test-'))
  const supervisor = new CompletingSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const originalNow = Date.now
  let now = new Date(2030, 0, 2, 8, 0, 0, 0).getTime()
  Date.now = () => now
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Daily task',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '08:01' }
    })[0]
    assert.ok(task)

    now += 2 * 60_000
    await service.runNow(task.id)
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(supervisor.ensureCalls, 1)
    assert.ok((service.list()[0]?.nextRunAt ?? 0) > now)
  } finally {
    service.dispose()
    Date.now = originalNow
    rmSync(userData, { recursive: true, force: true })
  }
})

test('invalid persisted schedules are ignored before reaching the timer', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-invalid-test-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const now = Date.now()
  const validTask = {
    id: 'valid-task',
    title: 'Valid task',
    prompt: 'Do the work',
    workspaceId: 'project',
    schedule: { kind: 'once', at: now + 60 * 60 * 1000 },
    enabled: true,
    createdAt: now,
    nextRunAt: now + 60 * 60 * 1000
  }
  const invalidTask = {
    ...validTask,
    id: 'invalid-task',
    title: 'Invalid task',
    schedule: null,
    nextRunAt: now - 1
  }
  writeFileSync(path.join(userData, 'scheduled-tasks.json'), JSON.stringify([validTask, invalidTask]))
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    assert.deepEqual(service.list().map((task) => task.id), ['valid-task'])
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(supervisor.ensureCalls, 0)
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a scheduled task runs with its pinned model and reasoning effort', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-model-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'app/default',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Pinned model',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' },
      model: 'provider/special',
      thinkingLevel: 'high'
    })[0]
    assert.ok(task)
    assert.equal(task.model, 'provider/special')
    assert.equal(task.thinkingLevel, 'high')

    await service.runNow(task.id)
    assert.equal(supervisor.lastEnsure?.model, 'provider/special')
    assert.equal(supervisor.lastEnsure?.thinkingLevel, 'high')
    // The task's choice must not become the app-wide default.
    assert.equal(supervisor.lastEnsure?.rememberDefaults, false)

    supervisor.emit('event', {
      ownerId: supervisor.ownerId,
      event: { type: 'agent_settled', aborted: false }
    })
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a task without its own choice follows the app defaults', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-defaults-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'app/default',
      thinkingLevel: 'medium'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'App defaults',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    assert.ok(task)
    assert.equal(task.model, undefined)
    assert.equal(task.thinkingLevel, undefined)

    await service.runNow(task.id)
    assert.equal(supervisor.lastEnsure?.model, 'app/default')
    assert.equal(supervisor.lastEnsure?.thinkingLevel, 'medium')
    assert.equal(supervisor.lastEnsure?.rememberDefaults, true)

    supervisor.emit('event', {
      ownerId: supervisor.ownerId,
      event: { type: 'agent_settled', aborted: false }
    })
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a finished one-time task can be edited without rescheduling it', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-edit-past-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'app/default',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Once',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once', at: Date.now() + 60 * 60 * 1000 },
      model: 'provider/first',
      thinkingLevel: 'low'
    })[0]
    assert.ok(task)

    // Make it look like a task that already ran: past date, paused, completed.
    const file = path.join(userData, 'scheduled-tasks.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
    const pastAt = Date.now() - 60_000
    saved[0] = {
      ...saved[0],
      schedule: { kind: 'once', at: pastAt },
      enabled: false,
      lastStatus: 'completed'
    }
    writeFileSync(file, JSON.stringify(saved))

    const updated = service.update(task.id, {
      title: 'Renamed after it ran',
      prompt: 'Rewrite the summary',
      workspaceId: 'project',
      schedule: { kind: 'once', at: pastAt },
      model: 'provider/second',
      thinkingLevel: 'high'
    })[0]
    assert.ok(updated)
    assert.equal(updated.title, 'Renamed after it ran')
    assert.equal(updated.enabled, false, 'editing does not silently re-enable the task')
    assert.deepEqual(updated.schedule, { kind: 'once', at: pastAt })
    assert.equal(updated.model, 'provider/second')
    assert.equal(updated.thinkingLevel, 'high')
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('an enabled one-time task still rejects a past date', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-edit-enabled-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Still armed',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'once', at: Date.now() + 60 * 60 * 1000 }
    })[0]
    assert.ok(task)
    assert.throws(() => service.update(task.id, {
      title: task.title,
      prompt: task.prompt,
      workspaceId: task.workspaceId,
      schedule: { kind: 'once', at: Date.now() - 60_000 }
    }), /future date/)
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('clearing a task model and effort makes it follow the app defaults', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-clear-model-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Pinned then cleared',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' },
      model: 'provider/model',
      thinkingLevel: 'low'
    })[0]
    assert.ok(task)

    const updated = service.update(task.id, {
      title: task.title,
      prompt: task.prompt,
      workspaceId: task.workspaceId,
      schedule: task.schedule
    })[0]
    assert.ok(updated)
    assert.equal(updated.model, undefined)
    assert.equal(updated.thinkingLevel, undefined)
    const saved = JSON.parse(readFileSync(path.join(userData, 'scheduled-tasks.json'), 'utf8'))
    assert.equal(Object.hasOwn(saved[0], 'model'), false)
    assert.equal(Object.hasOwn(saved[0], 'thinkingLevel'), false)
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('unusable persisted model values fall back to the app defaults', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-bad-model-'))
  const supervisor = new FakeSupervisor()
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const now = Date.now()
  writeFileSync(path.join(userData, 'scheduled-tasks.json'), JSON.stringify([{
    id: 'stored-task',
    title: 'Stored task',
    prompt: 'Do the work',
    workspaceId: 'project',
    schedule: { kind: 'once', at: now + 60 * 60 * 1000 },
    enabled: true,
    createdAt: now,
    nextRunAt: now + 60 * 60 * 1000,
    model: 'x'.repeat(1_000),
    thinkingLevel: 'turbo'
  }]))
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const [task] = service.list()
    assert.ok(task, 'the task survives an unusable model choice')
    assert.equal(task.model, undefined)
    assert.equal(task.thinkingLevel, undefined)
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

/** Starts runs that keep running until it is told to stop. */
class StoppableRunSupervisor extends FakeSupervisor {
  running = false
  stopCalls: string[] = []

  async request<T>(_key: string, command: string): Promise<T> {
    if (command === 'prompt') this.running = true
    return (command === 'prompt' ? { disposition: 'started' } : {}) as T
  }

  async stop(key: string): Promise<void> {
    this.stopCalls.push(key)
    this.running = false
  }

  sessionInfo(): { cwd: string; externalContext: boolean; running: boolean } {
    return { cwd: '', externalContext: false, running: this.running }
  }
}

test('a running task can be stopped without touching its schedule', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-stop-run-'))
  const supervisor = new StoppableRunSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Stop me',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    assert.ok(task)
    await service.runNow(task.id)
    assert.equal(service.list()[0]?.lastStatus, 'running')
    const scheduledFor = service.list()[0]?.nextRunAt

    // The detail pane's stop action is the only way out of a run that hangs:
    // it must reach the run's own Pi process, not just the schedule.
    assert.equal(await service.stopRun(task.id), true)
    assert.deepEqual(supervisor.stopCalls, [supervisor.ownerId])
    assert.equal(supervisor.running, false)

    const stopped = service.list()[0]
    assert.ok(stopped)
    assert.equal(stopped.lastStatus, 'aborted')
    assert.equal(stopped.enabled, true, 'stopping a run must not pause the task')
    assert.equal(stopped.nextRunAt, scheduledFor, 'the next occurrence is unchanged')

    // A settle that arrives after the stop (or a duplicate) changes nothing.
    supervisor.emit('event', {
      ownerId: supervisor.ownerId,
      event: { type: 'agent_settled', aborted: true }
    })
    assert.equal(service.list()[0]?.lastStatus, 'aborted')

    // The run lock was released, so the task can run again.
    await service.runNow(task.id)
    assert.equal(service.list()[0]?.lastStatus, 'running')
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('stopping a task that is not running reports that there is nothing to stop', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-stop-idle-'))
  const supervisor = new StoppableRunSupervisor()
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Idle task',
      prompt: 'Do nothing',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    assert.ok(task)
    assert.equal(await service.stopRun(task.id), false)
    assert.deepEqual(supervisor.stopCalls, [])
    assert.equal(service.list()[0]?.lastStatus, undefined, 'a task that never ran keeps no outcome')
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

/** The quarantined copies of an unreadable task file, newest first. */
const quarantined = (userData: string): string[] =>
  readdirSync(userData).filter((name) => name.startsWith('scheduled-tasks.corrupt-')).sort()

test('an unreadable task file is set aside so the page can recover', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-corrupt-start-'))
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const file = path.join(userData, 'scheduled-tasks.json')
  writeFileSync(file, '{ this is not json', 'utf8')
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: new FakeSupervisor() as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    // The page starts empty rather than wedged.
    assert.deepEqual(service.list(), [])

    // Nothing is thrown away: the exact bytes live under a name a reader can find.
    const [backup] = quarantined(userData)
    assert.ok(backup, 'the unreadable file was not preserved')
    assert.equal(readFileSync(path.join(userData, backup), 'utf8'), '{ this is not json')
    assert.equal(readdirSync(userData).includes('scheduled-tasks.json'), false, 'the bad file is still in the way')

    // And the service works again — this is what the pinned fingerprint blocked.
    const created = service.create({
      title: 'Fresh task',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '09:00' }
    })
    assert.equal(created.length, 1)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1)
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a file that turns unreadable while the app runs clears the list and is set aside', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-corrupt-live-'))
  const settings = {
    get: () => ({
      workspaces: [{ id: 'project', path: userData }],
      model: 'provider/model',
      thinkingLevel: 'off'
    })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: new FakeSupervisor() as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    service.create({
      title: 'Survivor',
      prompt: 'Do the work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '09:00' }
    })
    assert.equal(service.list().length, 1)

    const published: number[] = []
    service.on('changed', (tasks: unknown[]) => published.push(tasks.length))

    // Something outside the app truncated the file.
    writeFileSync(path.join(userData, 'scheduled-tasks.json'), '[{"id":', 'utf8')
    assert.deepEqual(service.list(), [], 'the page kept records no file backs')
    assert.equal(quarantined(userData).length, 1, 'the unreadable file was not preserved')
    assert.deepEqual(published.slice(-1), [0], 'the page was not told the list is gone')
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('corruption recovery waits for the writer and keeps a peer’s replacement file', (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-corrupt-race-'))
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const file = path.join(userData, 'scheduled-tasks.json')
  const input = {
    title: 'Original task',
    prompt: 'Do the work',
    workspaceId: 'project',
    schedule: { kind: 'once' as const, at: Date.now() + 60 * 60 * 1000 }
  }
  const open = () => new ScheduledTaskService({
    userData,
    settings,
    supervisor: new FakeSupervisor() as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  const service = open()
  let peer: ScheduledTaskService | undefined
  const log = t.mock.method(console, 'error', () => {})

  try {
    service.create(input)
    const corrupt = '[{"id":'
    writeFileSync(file, corrupt, 'utf8')

    const release = properLockfile.lockSync(file, { realpath: false })
    try {
      assert.equal(service.list()[0]?.title, input.title)
      assert.deepEqual(quarantined(userData), [])
      assert.equal(readFileSync(file, 'utf8'), corrupt)
    } finally {
      release()
    }

    const originalLock = properLockfile.lockSync
    const lock = t.mock.method(properLockfile, 'lockSync', (target, options) => {
      if (target === file && !peer) {
        lock.mock.restore()
        // The peer wins the lock after the original service has already read
        // the bad bytes and before it can re-check or move the file.
        peer = open()
        peer.create({ ...input, title: 'Saved by the peer' })
      }
      return originalLock(target, options)
    })

    assert.equal(service.list()[0]?.title, 'Saved by the peer')
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0]?.title, 'Saved by the peer')
    const backups = quarantined(userData)
    assert.equal(backups.length, 1)
    assert.equal(readFileSync(path.join(userData, backups[0]), 'utf8'), corrupt)
    assert.equal(log.mock.callCount(), 1, 'only the successful quarantine should be logged')
  } finally {
    service.dispose()
    peer?.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('stopping a scheduled task while ensure() is booting stops the newly started Pi process', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-scheduled-task-stop-boot-'))
  let resolveEnsure!: (value: { ok: true }) => void
  const stoppedKeys: string[] = []
  let startedKey = ''
  const supervisor = Object.assign(new EventEmitter(), {
    ensure: (options: { sessionKey: string }) => {
      startedKey = options.sessionKey
      return new Promise<{ ok: true }>((resolve) => { resolveEnsure = resolve })
    },
    request: async () => ({}),
    stop: async (key: string) => { stoppedKeys.push(key) },
    sessionInfo: () => ({ cwd: userData, externalContext: false, running: false })
  })
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: userData }] })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })

  try {
    const task = service.create({
      title: 'Slow boot',
      prompt: 'Do work',
      workspaceId: 'project',
      schedule: { kind: 'daily', time: '23:59' }
    })[0]
    const runPromise = service.runNow(task.id)
    // Wait until ensure() has started, then stop the task before ensure() finishes.
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.ok(startedKey.startsWith('draft:'))
    assert.equal(await service.stopRun(task.id), true)
    assert.equal(stoppedKeys.length, 1)

    resolveEnsure({ ok: true })
    await runPromise
    assert.equal(stoppedKeys.length, 2, 'newly booted runtime must be stopped when cancelled during ensure()')
    assert.equal(stoppedKeys[1], startedKey)
  } finally {
    service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

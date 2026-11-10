import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ScheduledTaskService } from '../src/main/scheduled-tasks'
import type { SettingsStore } from '../src/main/settings'
import type { SessionSupervisor } from '../src/main/pi/supervisor'

class FakeSupervisor extends EventEmitter {
  ownerId: string | undefined
  ensureCalls = 0

  async ensure(options: { sessionKey: string }): Promise<{ ok: boolean }> {
    this.ownerId = options.sessionKey
    this.ensureCalls += 1
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
    serviceInternals.write = () => { throw new Error('disk full') }
    supervisor.on('event', () => { laterListenerReceivedEvent = true })
    console.error = () => {}

    assert.doesNotThrow(() => supervisor.emit('event', {
      ownerId: supervisor.ownerId!,
      event: { type: 'agent_settled', aborted: false }
    }))
    assert.equal(laterListenerReceivedEvent, true)
    assert.equal(service.list()[0]?.lastStatus, 'completed')
  } finally {
    console.error = originalError
    service.dispose()
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

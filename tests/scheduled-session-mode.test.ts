import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SessionSupervisor } from '../src/main/pi/supervisor'
import type { SettingsStore } from '../src/main/settings'
import { ScheduledTaskService } from '../src/main/scheduled-tasks'

/**
 * A scheduled task either starts a new conversation for every run or continues
 * the one it started before. The choice is the task's own, so the service has
 * to keep the conversation across runs — and forget it when the task goes back
 * to a fresh conversation.
 */
class ReuseSupervisor extends EventEmitter {
  ensures: { sessionKey: string; sessionFile?: string }[] = []
  sessions = new Map<string, string>()

  async ensure(options: { sessionKey: string; sessionFile?: string }): Promise<{ ok: boolean }> {
    this.ensures.push({ sessionKey: options.sessionKey, sessionFile: options.sessionFile })
    return { ok: true }
  }

  async request<T>(key: string, command: string): Promise<T> {
    if (command === 'prompt') return { disposition: 'started' } as T
    return {} as T
  }

  sessionInfo(): { cwd: string; externalContext: boolean; running: boolean } {
    return { cwd: '', externalContext: false, running: false }
  }

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
  const settings = {
    get: () => ({ workspaces: [{ id: 'project', path: root }] })
  } as unknown as SettingsStore
  const service = new ScheduledTaskService({
    userData: root,
    settings,
    supervisor: supervisor as unknown as SessionSupervisor,
    customInstructions: () => undefined
  })
  return { service, supervisor }
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
    const sessionFile = path.join(root, 'sessions', 'task.jsonl')
    mkdirSync(path.dirname(sessionFile), { recursive: true })
    writeFileSync(sessionFile, '{}\n', 'utf8')
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

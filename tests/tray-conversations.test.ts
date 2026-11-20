import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionMeta } from '@shared/types'
import type { SessionThread } from '../src/renderer/src/store/useAppStore'
import { trayConversationGroups, trayConversations } from '../src/renderer/src/lib/tray-conversations'

/** The shape the store keeps for one conversation, with the fields under test. */
function thread(patch: Partial<SessionThread> = {}): SessionThread {
  return {
    items: [],
    run: { phase: 'idle', turns: 0, settled: true },
    isStreaming: false,
    transport: 'connected',
    uiRequests: [],
    uiStatuses: [],
    uiWidgets: [],
    queue: { steering: [], followUp: [] },
    status: { phase: 'ready' },
    forkTargets: [],
    agentMode: 'default',
    models: [],
    thinkingLevels: [],
    commands: [],
    clientKey: 'client-test',
    version: 0,
    ...patch
  }
}

const disk = (file: string, updatedAt: number, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id: file,
  file,
  cwd: 'E:/work/demo',
  preview: `preview of ${file}`,
  updatedAt,
  messageCount: 2,
  ...extra
})

test('running conversations come first and are marked streaming', () => {
  const sessions = [
    disk('E:/sessions/a.jsonl', 300),
    disk('E:/sessions/b.jsonl', 200),
    disk('E:/sessions/c.jsonl', 100)
  ]
  const threads = {
    'E:/sessions/b.jsonl': thread({ isStreaming: true })
  }
  const groups = trayConversationGroups(sessions, threads, undefined)
  assert.equal(groups.running.length, 1)
  assert.equal(groups.running[0].key, 'E:/sessions/b.jsonl')
  assert.equal(groups.running[0].isStreaming, true)
  assert.ok(!groups.recent.some((item) => item.key === 'E:/sessions/b.jsonl'))
  const flat = trayConversations(sessions, threads, undefined)
  assert.equal(flat[0].key, 'E:/sessions/b.jsonl')
})

test('at most three recent conversations, newest first', () => {
  const sessions = [
    disk('E:/sessions/1.jsonl', 500),
    disk('E:/sessions/2.jsonl', 400),
    disk('E:/sessions/3.jsonl', 300),
    disk('E:/sessions/4.jsonl', 200),
    disk('E:/sessions/5.jsonl', 100)
  ]
  const groups = trayConversationGroups(sessions, {}, undefined)
  assert.equal(groups.recent.length, 3)
  assert.deepEqual(
    groups.recent.map((item) => item.key),
    ['E:/sessions/1.jsonl', 'E:/sessions/2.jsonl', 'E:/sessions/3.jsonl']
  )
})

test('at most three running conversations', () => {
  const sessions = [1, 2, 3, 4, 5].map((n) => disk(`E:/sessions/${n}.jsonl`, n * 100))
  const threads: Record<string, SessionThread> = {}
  for (const session of sessions) threads[session.file] = thread({ isStreaming: true })
  const groups = trayConversationGroups(sessions, threads, undefined)
  assert.equal(groups.running.length, 3)
  assert.equal(groups.recent.length, 0)
})

test('session name wins over preview and long titles are truncated to one line', () => {
  const long = 'A very long conversation title that keeps going and going beyond the menu label budget'
  const sessions = [disk('E:/sessions/n.jsonl', 100, { name: long.replace(/ /g, '\n') })]
  const groups = trayConversationGroups(sessions, {}, undefined)
  const title = groups.recent[0].title
  assert.ok(!title.includes('\n'))
  assert.ok(title.length <= 48)
  assert.ok(title.endsWith('…'))
})

test('a live unflushed streaming chat is reachable from the menu', () => {
  const key = 'draft:abc123'
  const threads = {
    [key]: thread({
      isStreaming: true,
      items: [{ kind: 'user', text: 'hello from a new chat', id: 'u1', order: 0 }] as never
    })
  }
  const groups = trayConversationGroups([], threads, 'E:/work/demo')
  assert.equal(groups.running.length, 1)
  assert.equal(groups.running[0].key, key)
  assert.equal(groups.running[0].isStreaming, true)
})

test('a conversation is listed once even when a live key matches a disk path', () => {
  const sessions = [disk('E:/sessions/a.jsonl', 100)]
  const threads = { 'E:/sessions/a.jsonl': thread({ isStreaming: true }) }
  const flat = trayConversations(sessions, threads, undefined)
  assert.equal(flat.length, 1)
})

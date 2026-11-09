import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionMeta } from '@shared/types'
import { activeConversationTitle, conversationRows, updateThreadSessionName } from '../src/renderer/src/lib/live-sessions'
import type { SessionThread } from '../src/renderer/src/store/useAppStore'

/** The shape the store keeps for one conversation, with the fields under test. */
function thread(patch: Partial<SessionThread> = {}): SessionThread {
  return {
    items: [],
    run: { phase: 'idle', turns: 0, settled: true },
    isStreaming: false,
    transport: 'connected',
    uiStatuses: [],
    uiWidgets: [],
    queue: { steering: [], followUp: [] },
    status: { phase: 'ready' },
    forkTargets: [],
    agentMode: 'default',
    models: [],
    thinkingLevels: [],
    commands: [],
    version: 0,
    ...patch
  }
}

const onDisk = (file: string, cwd = 'E:/work/demo'): SessionMeta => ({
  id: file,
  file,
  cwd,
  preview: file,
  updatedAt: 100,
  messageCount: 2
})

test('a conversation with a prompt in flight is listed before Pi writes its file', () => {
  // The sidebar is built from the session folder, and Pi only writes a JSONL
  // once the first prompt reaches it. A prompt that is still on its way is a
  // real conversation, so it must be in the list the reader sees.
  const rows = conversationRows(
    [],
    {
      'draft:pending': thread({
        items: [
          { id: 'u1', kind: 'user', text: 'fix the build', images: [], timestamp: 5, order: 1 }
        ],
        run: { phase: 'queued', turns: 0, settled: false },
        isStreaming: true
      })
    },
    'E:/work/demo'
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].onDisk, false)
  assert.equal(rows[0].preview, 'fix the build')
  // A draft belongs to the project the reader is in.
  assert.equal(rows[0].cwd, 'E:/work/demo')
})

test('a prompt that has not reached Pi yet is still listed', () => {
  // `send` sets the run to queued before any event arrives, so a thread with
  // no items at all is still work the reader must be able to find.
  const rows = conversationRows(
    [],
    { 'draft:sending': thread({ run: { phase: 'queued', turns: 0, settled: false } }) },
    'E:/work/demo'
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].onDisk, false)
})

test('an abandoned empty chat is not a conversation', () => {
  // "New chat" opens a blank composer, and the welcome screen already stands
  // for it; listing every abandoned draft would fill the sidebar with ghosts.
  const rows = conversationRows([], { 'draft:blank': thread() }, 'E:/work/demo')
  assert.deepEqual(rows, [])
})

test('a conversation already on disk is listed once, from the disk row', () => {
  // The live row exists only for a key disk does not cover, so the handover
  // from a draft (or an unflushed path) to the file renames the same row.
  const rows = conversationRows(
    [onDisk('E:/work/demo/a.jsonl')],
    {
      'E:/work/demo/a.jsonl': thread({
        items: [{ id: 'u1', kind: 'user', text: 'hi', images: [], timestamp: 5, order: 1 }]
      })
    },
    'E:/work/demo'
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].onDisk, true)
  assert.equal(rows[0].file, 'E:/work/demo/a.jsonl')
})

test('two conversations created in quick succession are both listed', () => {
  // The reported bug: conversation one is still running and conversation two
  // is queued behind it in the same folder, so neither has a JSONL yet and
  // both were missing from the sidebar at once.
  const rows = conversationRows(
    [],
    {
      'draft:first': thread({
        items: [{ id: 'u1', kind: 'user', text: 'CASE:A', images: [], timestamp: 10, order: 1 }],
        run: { phase: 'working', turns: 1, settled: false },
        isStreaming: true
      }),
      'draft:second': thread({
        items: [{ id: 'u2', kind: 'user', text: 'CASE:B', images: [], timestamp: 20, order: 2 }],
        run: { phase: 'queued', turns: 0, settled: false },
        isStreaming: true
      })
    },
    'E:/work/demo'
  )
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.onDisk), [false, false])
  // The one being worked on leads the project.
  assert.equal(rows[0].preview, 'CASE:B')
  assert.equal(rows[1].preview, 'CASE:A')
})

test('a conversation on disk keeps its place when a live one appears', () => {
  const rows = conversationRows(
    [onDisk('E:/work/demo/a.jsonl')],
    {
      'draft:new': thread({
        items: [{ id: 'u1', kind: 'user', text: 'new work', images: [], timestamp: 50, order: 1 }],
        run: { phase: 'queued', turns: 0, settled: false },
        isStreaming: true
      })
    },
    'E:/work/demo'
  )
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((row) => row.onDisk), [false, true])
})

test('a settled conversation without a file is not kept alive forever', () => {
  // A run that settled and produced no file was an extension command or a
  // failed launch; the empty transcript is not something to hold on to.
  const rows = conversationRows([], { 'draft:dead': thread({ run: { phase: 'idle', turns: 0, settled: true } }) }, 'E:/work/demo')
  assert.deepEqual(rows, [])
})

test('a queued follow-up counts as work even with an empty transcript', () => {
  const rows = conversationRows(
    [],
    { 'draft:queued': thread({ queue: { steering: [], followUp: ['one more thing'] } }) },
    'E:/work/demo'
  )
  assert.equal(rows.length, 1)
})

test('the title bar reads the same live row as the sidebar, not the project name', () => {
  // A long run has not flushed its JSONL yet: `sessions` is empty, but the
  // sidebar shows the first prompt. Reading only the disk list used to make
  // the title bar fall back to the project name for exactly this window.
  const prompt = '继续优化咖啡机控制的后端，压力在 9bar 附近来回横跳'
  const title = activeConversationTitle(
    [],
    {
      'draft:coffee': thread({
        items: [{ id: 'u1', kind: 'user', text: prompt, images: [], timestamp: 5, order: 1 }],
        run: { phase: 'working', turns: 1, settled: false },
        isStreaming: true
      })
    },
    'draft:coffee'
  )
  assert.equal(title, prompt)
})

test('Pi owns the name of a live conversation', () => {
  // A hot `set_session_name` reaches the thread before the JSONL is re-read,
  // so the live name wins over the first prompt in both places.
  const title = activeConversationTitle(
    [],
    {
      'draft:coffee': thread({
        items: [{ id: 'u1', kind: 'user', text: 'a long first prompt', images: [], timestamp: 5, order: 1 }],
        piState: { isStreaming: true, isCompacting: false, sessionName: '压力稳定性修复' },
        run: { phase: 'working', turns: 1, settled: false },
        isStreaming: true
      })
    },
    'draft:coffee'
  )
  assert.equal(title, '压力稳定性修复')
})

test('a conversation on disk wears the disk row name, like the sidebar', () => {
  const title = activeConversationTitle(
    [{ ...onDisk('E:/work/demo/a.jsonl'), name: 'Renamed on disk' }],
    {
      'E:/work/demo/a.jsonl': thread({
        piState: { isStreaming: false, isCompacting: false, sessionName: 'Stale live name' }
      })
    },
    'E:/work/demo/a.jsonl'
  )
  assert.equal(title, 'Renamed on disk')
})

test('renaming a background conversation updates its cached Pi name', () => {
  const stale = thread({
    piState: { isStreaming: false, isCompacting: false, sessionName: 'Old title' }
  })
  const other = thread({ piState: { isStreaming: false, isCompacting: false, sessionName: 'Other title' } })
  const threads = {
    'E:/work/demo/a.jsonl': stale,
    'E:/work/demo/b.jsonl': other
  }

  const next = updateThreadSessionName(threads, 'e:\\work\\demo\\a.jsonl', 'New title')

  assert.equal(next['E:/work/demo/a.jsonl'].piState?.sessionName, 'New title')
  assert.equal(next['E:/work/demo/a.jsonl'].version, stale.version + 1)
  assert.equal(next['E:/work/demo/b.jsonl'], other)
})

test('a disk row with no name still shows its preview', () => {
  const title = activeConversationTitle([onDisk('E:/work/demo/a.jsonl')], {}, 'E:/work/demo/a.jsonl')
  assert.equal(title, 'E:/work/demo/a.jsonl')
})

test('a blank chat has no conversation title', () => {
  // The welcome screen may then fall back to the project name.
  assert.equal(activeConversationTitle([], { 'draft:blank': thread() }, 'draft:blank'), '')
  assert.equal(activeConversationTitle([], {}, undefined), '')
})

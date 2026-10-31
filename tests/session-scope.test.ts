import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendSessionName, readSessionMessages } from '../src/main/sessions'
import { hydrationStale, scopeEvent } from '../src/renderer/src/lib/session-scope'

test('a bare event belongs to the view, a scoped event keeps its owner', () => {
  const bare = scopeEvent({ type: 'agent_start' }, 'view.jsonl')
  assert.equal(bare?.ownerId, 'view.jsonl')
  assert.equal(bare?.event.type, 'agent_start')
  const scoped = scopeEvent({ ownerId: 'other.jsonl', event: { type: 'text' } }, 'view.jsonl')
  assert.equal(scoped?.ownerId, 'other.jsonl')
  assert.equal(hydrationStale(1, 1, false), false)
  assert.equal(hydrationStale(1, 2, false), true)
  assert.equal(hydrationStale(1, 1, true), true)
})

test('cold history is the active branch and a rename appends session_info', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-session-'))
  const file = path.join(dir, 'chat.jsonl')
  try {
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'session', version: 3, id: 'header', cwd: 'C:/project' }),
        JSON.stringify({
          type: 'message',
          id: 'm1',
          parentId: null,
          message: { role: 'user', content: 'hello', timestamp: 10 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'old',
          parentId: null,
          message: { role: 'user', content: 'not on the leaf branch', timestamp: 1 }
        }),
        JSON.stringify({
          type: 'message',
          id: 'm2',
          parentId: 'm1',
          message: { role: 'assistant', content: 'hi', timestamp: 11 }
        })
      ].join('\n') + '\n',
      'utf8'
    )
    const messages = await readSessionMessages(file)
    assert.deepEqual(messages.map((message) => message.content), ['hello', 'hi'])
    assert.equal(await appendSessionName(file, 'Named\nchat'), true)
    const last = readFileSync(file, 'utf8').trim().split('\n').at(-1)
    const entry = JSON.parse(last ?? '{}') as { type?: string; parentId?: string; name?: string }
    assert.equal(entry.type, 'session_info')
    assert.equal(entry.parentId, 'm2')
    assert.equal(entry.name, 'Named chat')
    assert.equal(await appendSessionName(file, '   '), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

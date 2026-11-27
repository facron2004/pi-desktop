import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendSessionName, openSessionFile, readSessionMessages } from '../src/main/sessions'
import { SessionSupervisor } from '../src/main/pi/supervisor'
import { needsSessionHydration, scopeEvent } from '../src/renderer/src/lib/session-scope'

test('a bare event belongs to the view, a scoped event keeps its owner', () => {
  const bare = scopeEvent({ type: 'agent_start' }, 'view.jsonl')
  assert.equal(bare?.ownerId, 'view.jsonl')
  assert.equal(bare?.event.type, 'agent_start')
  const scoped = scopeEvent({ ownerId: 'other.jsonl', event: { type: 'text' } }, 'view.jsonl')
  assert.equal(scoped?.ownerId, 'other.jsonl')
  assert.equal(scoped?.event.type, 'text')
})

test('a session file can be read until its history is cached', () => {
  assert.equal(needsSessionHydration('chat.jsonl'), true)
  assert.equal(needsSessionHydration('chat.jsonl', { historyLoaded: true, items: [] }), true)
  assert.equal(needsSessionHydration('draft:chat'), false)
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

test('a cold rename refuses a session replaced while reading its last entry', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-cold-rename-replaced-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'chat.jsonl')
  const moved = path.join(dir, 'moved.jsonl')
  const original = '{"type":"session","id":"original","version":3}\n'
  const replacement = '{"type":"session","id":"replaced","version":3}\n'
  writeFileSync(file, original)
  const opened = await openSessionFile(file, dir, true)
  assert.ok(opened)
  const supervisor = new SessionSupervisor(() => assert.fail('cold rename started Pi'))
  const renamed: unknown[] = []
  supervisor.on('rename', (event) => renamed.push(event))
  const read = opened.handle.read.bind(opened.handle)
  let replaced = false
  t.mock.method(opened.handle, 'read', async (buffer: Buffer, offset: number, length: number, position: number) => {
    const result = await read(buffer, offset, length, position)
    if (!replaced) {
      renameSync(file, moved)
      writeFileSync(file, replacement)
      replaced = true
    }
    return result
  })

  try {
    assert.equal(await supervisor.rename(opened.target, 'Wrong chat', opened.handle), false)
    assert.equal(replaced, true)
    assert.equal(readFileSync(moved, 'utf8'), original)
    assert.equal(readFileSync(file, 'utf8'), replacement)
    assert.deepEqual(renamed, [])
  } finally {
    await opened.handle.close()
  }

  const retry = await openSessionFile(file, dir, true)
  assert.ok(retry)
  try {
    assert.equal(await supervisor.rename(retry.target, 'Current chat', retry.handle), true)
    assert.match(readFileSync(file, 'utf8'), /"name":"Current chat"/)
    assert.equal(readFileSync(moved, 'utf8'), original)
  } finally {
    await retry.handle.close()
  }
})

for (const torn of [false, true]) {
  test(`cold rename separates a ${torn ? 'torn' : 'valid'} unterminated record from the title`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pi-session-tail-'))
    const file = path.join(dir, 'chat.jsonl')
    const original = [
      JSON.stringify({ type: 'session', version: 3, id: 'header', cwd: dir }),
      JSON.stringify({
        type: 'message', id: 'prompt', parentId: null,
        message: { role: 'user', content: 'Keep this prompt', timestamp: 1 }
      }),
      JSON.stringify({
        type: 'message', id: 'answer', parentId: 'prompt',
        message: { role: 'assistant', content: 'Keep this answer', timestamp: 2 }
      }),
      ...(torn ? ['{"type":"message","id":"interrupted"'] : [])
    ].join('\n')
    try {
      writeFileSync(file, original)
      const verified = await openSessionFile(file, dir, true)
      assert.ok(verified)
      try {
        assert.equal(await appendSessionName(verified.target, 'Renamed', verified.handle), true)
      } finally {
        await verified.handle.close()
      }
      const contents = readFileSync(file, 'utf8')
      assert.ok(contents.startsWith(original + '\n'))
      const title = JSON.parse(contents.slice(original.length + 1))
      assert.equal(title.type, 'session_info')
      assert.equal(title.name, 'Renamed')
      assert.equal(title.parentId, 'answer')
      assert.deepEqual((await readSessionMessages(file)).map(message => message.content), [
        'Keep this prompt', 'Keep this answer'
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

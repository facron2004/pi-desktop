import test from 'node:test'
import assert from 'node:assert/strict'
import { collectProjects, sortProjects } from '../src/renderer/src/lib/projects'
import { normalisePathKey, samePath } from '../src/renderer/src/lib/path'

test('normalisePathKey handles Windows backslashes, trailing slashes, and casing', () => {
  assert.equal(normalisePathKey('E:\\Program\\Pi Desktop\\'), 'e:/program/pi desktop')
  assert.equal(normalisePathKey('e:/Program/Pi Desktop'), 'e:/program/pi desktop')
  assert.equal(samePath('E:\\Program\\Pi Desktop', 'e:/program/pi desktop/'), true)
})

test('collectProjects deduplicates workspaces and sessions pointing to the same folder', () => {
  const workspaces = [
    {
      id: 'ws-1',
      path: 'E:\\Program\\Pi Desktop',
      name: 'Pi Desktop',
      lastOpenedAt: 1000
    }
  ]
  const sessions = [
    {
      id: 'sess-1',
      file: 'sess-1.json',
      cwd: 'e:/Program/Pi Desktop',
      updatedAt: 2000
    },
    {
      id: 'sess-2',
      file: 'sess-2.json',
      cwd: 'E:\\Program\\Pi Desktop\\',
      updatedAt: 3000
    }
  ]

  const projects = collectProjects(workspaces, sessions)
  assert.equal(projects.length, 1, 'Only one project should exist after deduplication')
  assert.equal(projects[0].name, 'Pi Desktop')
  assert.equal(projects[0].registered, true)
  assert.equal(projects[0].sessions.length, 2, 'Sessions should be merged into the single project')
})

test('sortProjects keeps creation order even when another project was opened later', () => {
  const projects = [
    {
      path: 'C:\\Users\\User\\Other',
      name: 'Other',
      registered: true,
      lastOpenedAt: 5000,
      sessions: []
    },
    {
      path: 'E:\\Program\\Pi Desktop',
      name: 'Pi Desktop',
      registered: true,
      lastOpenedAt: 1000,
      sessions: []
    }
  ]

  const sorted = sortProjects(projects, 'e:/Program/Pi Desktop/')
  assert.deepEqual(sorted.map((project) => project.name), ['Other', 'Pi Desktop'])
})

test('a removed project stays gone even when its conversations are still on disk', () => {
  const sessions = [
    { id: 's', file: 's.jsonl', cwd: 'E:\\Work\\demo', preview: 'hi', updatedAt: 1, messageCount: 1 }
  ]
  assert.equal(collectProjects([], sessions, ['e:/work/demo']).length, 0)
  const broughtBack = collectProjects(
    [{ id: 'w', path: 'E:\\Work\\demo', name: 'demo', lastOpenedAt: 1 }],
    sessions,
    ['e:/work/demo']
  )
  assert.equal(broughtBack.length, 1)
  assert.equal(broughtBack[0].registered, true)
  assert.equal(broughtBack[0].sessions.length, 1)
})

test('chats without a project do not create a project entry', () => {
  const sessions = [
    { id: 'chat', file: 'chat.jsonl', cwd: '', preview: 'General chat', updatedAt: 1, messageCount: 1 }
  ]
  assert.deepEqual(collectProjects([], sessions), [])
})

test('projectOrder keeps a session-only project in place when it becomes registered', () => {
  const sessions = [
    { id: 'a', file: 'a.jsonl', cwd: 'C:/alpha', preview: 'a', updatedAt: 30, messageCount: 1 },
    { id: 'b', file: 'b.jsonl', cwd: 'C:/beta', preview: 'b', updatedAt: 20, messageCount: 1 }
  ]
  const order = ['C:/alpha', 'C:/beta']

  assert.deepEqual(
    collectProjects([], sessions, [], order).map((project) => project.name),
    ['alpha', 'beta']
  )
  // Registering beta (as opening it does) must not move it ahead of alpha.
  assert.deepEqual(
    collectProjects(
      [{ id: 'beta', path: 'C:/beta', name: 'beta', lastOpenedAt: Date.now() }],
      sessions,
      [],
      order
    ).map((project) => project.name),
    ['alpha', 'beta']
  )
})

test('a project missing from projectOrder joins at the end', () => {
  const sessions = [
    { id: 'a', file: 'a.jsonl', cwd: 'C:/alpha', preview: 'a', updatedAt: 30, messageCount: 1 },
    { id: 'b', file: 'b.jsonl', cwd: 'C:/beta', preview: 'b', updatedAt: 20, messageCount: 1 }
  ]

  assert.deepEqual(
    collectProjects([], sessions, [], ['C:/beta']).map((project) => project.name),
    ['beta', 'alpha']
  )
})

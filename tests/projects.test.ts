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

test('sortProjects prioritises active project regardless of path separator differences', () => {
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
  assert.equal(sorted[0].name, 'Pi Desktop')
})

test('chats without a project do not create a project entry', () => {
  const sessions = [
    { id: 'chat', file: 'chat.jsonl', cwd: '', preview: 'General chat', updatedAt: 1, messageCount: 1 }
  ]
  assert.deepEqual(collectProjects([], sessions), [])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionMeta } from '@shared/types'
import {
  filterByArchive,
  flatSessions,
  groupArchivedByProject,
  projectDepths,
  sortByMode
} from '../src/renderer/src/lib/sidebar-view'

const session = (file: string, updatedAt: number): SessionMeta => ({
  file,
  cwd: 'C:/work/project',
  name: file,
  updatedAt,
  createdAt: updatedAt
} as SessionMeta)

test('archive filter hides, shows or isolates archived conversations by path', () => {
  const rows = [session('C:/work/a.jsonl', 3), session('C:/work/b.jsonl', 2)]
  const archived = new Set(['c:\\WORK\\b.JSONL'])

  assert.deepEqual(filterByArchive(rows, archived, 'hidden').map((s) => s.file), [rows[0]!.file])
  assert.deepEqual(filterByArchive(rows, archived, 'all').map((s) => s.file), rows.map((s) => s.file))
  assert.deepEqual(filterByArchive(rows, archived, 'archived').map((s) => s.file), [rows[1]!.file])
  assert.equal(rows.length, 2)
})

test('updated sorting reorders projects and their conversations without mutating the input', () => {
  const old = session('C:/work/old.jsonl', 10)
  const newOne = session('C:/work/new.jsonl', 30)
  const projects = [
    { path: 'a', lastOpenedAt: 20, sessions: [old] },
    { path: 'b', lastOpenedAt: 25, sessions: [newOne] }
  ]

  assert.deepEqual(sortByMode(projects, 'manual'), projects)
  const updated = sortByMode(projects, 'updated')
  assert.deepEqual(updated.map((p) => p.path), ['b', 'a'])
  assert.equal(projects[0]!.sessions[0], old, 'the source list is unchanged')
  assert.notEqual(updated[0]!.sessions, projects[1]!.sessions)

  const mixed = [{ path: 'x', lastOpenedAt: 0, sessions: [old, newOne] }]
  assert.deepEqual(
    sortByMode(mixed, 'updated')[0]!.sessions.map((s) => s.file),
    [newOne.file, old.file]
  )
})

test('workspace tree derives depth from containing project folders', () => {
  const projects = [
    { path: 'C:\\Dev\\root' },
    { path: 'C:/dev/root/sub' },
    { path: 'C:/dev/root/sub/deep' },
    { path: 'D:/elsewhere' }
  ]
  const depths = projectDepths(projects)
  assert.equal(depths.get('c:/dev/root'), 0)
  assert.equal(depths.get('c:/dev/root/sub'), 1)
  assert.equal(depths.get('c:/dev/root/sub/deep'), 2)
  assert.equal(depths.get('d:/elsewhere'), 0)
})

test('the single list is one newest-first column', () => {
  const rows = [session('older', 5), session('newest', 20), session('middle', 10)]
  assert.deepEqual(flatSessions(rows).map((s) => s.file), ['newest', 'middle', 'older'])
  assert.equal(rows[0]!.file, 'older')
})

const inProject = (file: string, cwd: string, updatedAt: number): SessionMeta => ({
  ...session(file, updatedAt),
  cwd
})

test('archived conversations are grouped by the project they came from', () => {
  const rows = [
    inProject('a-old', 'C:/work/alpha', 10),
    inProject('b-new', 'C:/work/beta', 30),
    inProject('a-new', 'C:/work/alpha', 40),
    inProject('b-old', 'C:/work/beta', 20)
  ]
  const groups = groupArchivedByProject(rows, {
    projectName: (path) => ({ 'c:/work/alpha': 'Alpha', 'c:/work/beta': 'Beta' })[
      path.replace(/\\/g, '/').toLowerCase()
    ],
    projectlessName: 'No project',
    order: ['C:\\work\\alpha', 'C:/work/beta']
  })

  // The caller's project order wins over newest activity.
  assert.deepEqual(groups.map((group) => group.key), ['c:/work/alpha', 'c:/work/beta'])
  assert.deepEqual(groups.map((group) => group.name), ['Alpha', 'Beta'])
  // Inside a group the newest conversation is on top.
  assert.deepEqual(groups[0]!.sessions.map((s) => s.file), ['a-new', 'a-old'])
  assert.deepEqual(groups[1]!.sessions.map((s) => s.file), ['b-new', 'b-old'])
})

test('archived groups fall back to the folder name and put projectless chats last', () => {
  const rows = [
    inProject('loose', 'C:/work/unknown', 5),
    inProject('chat', '', 99),
    inProject('named', 'C:/work/alpha', 1)
  ]
  const groups = groupArchivedByProject(rows, {
    projectName: (path) => (path.toLowerCase().includes('alpha') ? 'Alpha' : undefined),
    projectlessName: 'No project',
    order: ['C:/work/alpha']
  })

  // A known project keeps its place; a folder the order does not name still gets
  // a heading from its own folder name and follows; chats with no folder close it.
  assert.deepEqual(groups.map((group) => group.name), ['Alpha', 'unknown', 'No project'])
  assert.deepEqual(groups.map((group) => group.sessions.length), [1, 1, 1])
  assert.equal(groups[2]!.key, '')
})

test('folders outside the project order come newest-first, and no rows make no groups', () => {
  const rows = [
    inProject('older-folder', 'C:/work/one', 10),
    inProject('newer-folder', 'C:/work/two', 50)
  ]
  const groups = groupArchivedByProject(rows, { projectlessName: 'No project' })
  assert.deepEqual(groups.map((group) => group.name), ['two', 'one'])
  assert.deepEqual(groupArchivedByProject([], { projectlessName: 'No project' }), [])
})

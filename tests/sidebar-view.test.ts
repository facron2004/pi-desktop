import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionMeta } from '@shared/types'
import {
  filterByArchive,
  flatSessions,
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

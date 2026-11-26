import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  readCollapsedArchiveGroups,
  toggleCollapsedArchiveGroup,
  writeCollapsedArchiveGroups
} from '../src/renderer/src/lib/archive-fold'

function fakeStore(): {
  data: Map<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
} {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) }
  }
}

test('toggling an archived group leaves the caller set alone', () => {
  const original = new Set(['project:a'])
  const next = toggleCollapsedArchiveGroup(original, 'project:b')
  assert.deepEqual([...original], ['project:a'])
  assert.deepEqual([...next].sort(), ['project:a', 'project:b'])
})

test('toggling the same archived group again reopens it', () => {
  const once = toggleCollapsedArchiveGroup(new Set(), 'project:a')
  const twice = toggleCollapsedArchiveGroup(once, 'project:a')
  assert.equal(twice.size, 0)
})

test('folded archived groups survive a write/read round trip', () => {
  const store = fakeStore()
  const collapsed = new Set(['', 'project:C%3A%5Cwork'])
  writeCollapsedArchiveGroups(collapsed, store)
  assert.deepEqual([...readCollapsedArchiveGroups(store)].sort(), [...collapsed].sort())
})

test('broken or unrelated storage reads as nothing folded', () => {
  const store = fakeStore()
  store.data.set('pi-desktop.archive.collapsed', '{not json')
  assert.equal(readCollapsedArchiveGroups(store).size, 0)

  store.data.set('pi-desktop.archive.collapsed', JSON.stringify({ project: true }))
  assert.equal(readCollapsedArchiveGroups(store).size, 0)

  store.data.set('pi-desktop.archive.collapsed', JSON.stringify(['project:a', 7, null]))
  assert.deepEqual([...readCollapsedArchiveGroups(store)], ['project:a'])
})

test('a store that refuses writes does not break the page', () => {
  const throwing = {
    getItem: () => null,
    setItem: () => { throw new Error('quota') }
  }
  assert.doesNotThrow(() => writeCollapsedArchiveGroups(new Set(['project:a']), throwing))
})

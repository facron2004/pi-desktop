import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  readCollapsedMemoryGroups,
  toggleCollapsedMemoryGroup,
  writeCollapsedMemoryGroups
} from '../src/renderer/src/lib/memory-fold'

function fakeStore(): { getItem(key: string): string | null; setItem(key: string, value: string): void; data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) }
  }
}

test('toggling a group does not mutate the caller set', () => {
  const original = new Set(['project:a'])
  const next = toggleCollapsedMemoryGroup(original, 'project:b')
  assert.deepEqual([...original], ['project:a'])
  assert.deepEqual([...next].sort(), ['project:a', 'project:b'])
})

test('toggling the same group again reopens it', () => {
  const once = toggleCollapsedMemoryGroup(new Set(), 'global')
  const twice = toggleCollapsedMemoryGroup(once, 'global')
  assert.equal(twice.size, 0)
})

test('fold preferences survive a write/read round trip', () => {
  const store = fakeStore()
  const collapsed = new Set(['global', 'project:C%3A%5Cwork'])
  writeCollapsedMemoryGroups(collapsed, store)
  assert.deepEqual([...readCollapsedMemoryGroups(store)].sort(), [...collapsed].sort())
})

test('broken or unrelated storage is read as no folds', () => {
  const store = fakeStore()
  store.data.set('pi-desktop.memory.collapsed', '{not json')
  assert.equal(readCollapsedMemoryGroups(store).size, 0)
  store.data.set('pi-desktop.memory.collapsed', JSON.stringify([1, null, 'project:x']))
  assert.deepEqual([...readCollapsedMemoryGroups(store)], ['project:x'])
})

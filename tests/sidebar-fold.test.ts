import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  readCollapsedSidebarSections,
  sidebarSectionExpanded,
  toggleCollapsedSidebarSection,
  writeCollapsedSidebarSections
} from '../src/renderer/src/lib/sidebar-fold'

function fakeStore(): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  data: Map<string, string>
} {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) }
  }
}

test('a section starts open and remembers what was folded', () => {
  const store = fakeStore()
  assert.deepEqual(readCollapsedSidebarSections(store), new Set())
  assert.equal(sidebarSectionExpanded(readCollapsedSidebarSections(store), 'chats', false), true)

  const folded = toggleCollapsedSidebarSection(readCollapsedSidebarSections(store), 'chats')
  writeCollapsedSidebarSections(folded, store)
  const reloaded = readCollapsedSidebarSections(store)
  assert.equal(sidebarSectionExpanded(reloaded, 'chats', false), false)
  // Folding the single list does not fold the list of chats with no project.
  assert.equal(sidebarSectionExpanded(reloaded, 'chats-without-project', false), true)

  const reopened = toggleCollapsedSidebarSection(reloaded, 'chats')
  assert.equal(sidebarSectionExpanded(reopened, 'chats', false), true)
  assert.deepEqual([...reopened], [])
})

test('a filter opens a folded section so a match cannot hide inside it', () => {
  const store = fakeStore()
  writeCollapsedSidebarSections(['chats'], store)
  const folded = readCollapsedSidebarSections(store)
  assert.equal(sidebarSectionExpanded(folded, 'chats', false), false)
  assert.equal(sidebarSectionExpanded(folded, 'chats', true), true)
})

test('the conversation lists keep their own fold', () => {
  // Only a head that labels conversations folds: the single list and the
  // conversations without a project. The project rows are the tree itself.
  const lists = ['chats', 'chats-without-project']
  let collapsed = new Set<string>()
  for (const key of lists) collapsed = toggleCollapsedSidebarSection(collapsed, key)
  assert.deepEqual([...collapsed].sort(), [...lists].sort())
  for (const key of lists) {
    assert.equal(sidebarSectionExpanded(collapsed, key, false), false, key)
  }
  const reopened = toggleCollapsedSidebarSection(collapsed, 'chats')
  assert.equal(sidebarSectionExpanded(reopened, 'chats', false), true)
  assert.equal(sidebarSectionExpanded(reopened, 'chats-without-project', false), false)
})

test('an unreadable or broken store means nothing is folded', () => {
  const broken = fakeStore()
  broken.setItem('pi-desktop.sidebar.collapsed-sections', '{not json')
  assert.deepEqual(readCollapsedSidebarSections(broken), new Set())

  const wrongShape = fakeStore()
  wrongShape.setItem('pi-desktop.sidebar.collapsed-sections', '{"chats":true}')
  assert.deepEqual(readCollapsedSidebarSections(wrongShape), new Set())

  // Writing never throws, even when the store refuses the value.
  const refusing = {
    getItem: () => null,
    setItem: () => { throw new Error('quota') }
  }
  assert.doesNotThrow(() => writeCollapsedSidebarSections(['chats'], refusing))
})

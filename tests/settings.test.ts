import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import path from 'node:path'
import { SettingsStore, dedupeWorkspaces } from '../src/main/settings'
import type { Workspace } from '../src/shared/types'

const workspace = (id: string, path: string, lastOpenedAt: number): Workspace => ({
  id,
  path,
  name: id,
  lastOpenedAt
})

test('workspace order follows the list, not last use', () => {
  const alpha = workspace('alpha', 'C:/alpha', 100)
  const beta = workspace('beta', 'C:/beta', 9000)
  const gamma = workspace('gamma', 'C:/gamma', 500)

  assert.deepEqual(
    dedupeWorkspaces([alpha, beta, gamma]).map((item) => item.id),
    ['alpha', 'beta', 'gamma']
  )
})

test('a duplicate replaces its entry without moving it', () => {
  const original = workspace('alpha', 'C:/alpha', 100)
  const newer = workspace('alpha-new', 'c:/alpha/', 9000)
  const beta = workspace('beta', 'C:/beta', 100)

  const result = dedupeWorkspaces([original, beta, newer])

  assert.deepEqual(result.map((item) => item.id), ['alpha-new', 'beta'])
})

test('a workspace added later joins at the end', () => {
  const alpha = workspace('alpha', 'C:/alpha', 9000)
  const beta = workspace('beta', 'C:/beta', 100)
  const gamma = workspace('gamma', 'C:/gamma', 50)

  assert.deepEqual(
    dedupeWorkspaces([alpha, beta, gamma]).map((item) => item.id),
    ['alpha', 'beta', 'gamma']
  )
})

test('an unrelated settings save keeps the workspace order', () => {
  const fileName = `settings-order-${process.pid}.json`
  const store = new SettingsStore(fileName)
  try {
    store.patch({
      workspaces: [
        workspace('alpha', 'C:/alpha', 100),
        workspace('beta', 'C:/beta', 9000),
        workspace('gamma', 'C:/gamma', 500)
      ]
    })
    store.patch({ theme: 'light' })

    assert.deepEqual(
      store.get().workspaces.map((item) => item.id),
      ['alpha', 'beta', 'gamma']
    )
    // A restart reads the same order back; nothing re-sorts it on load.
    assert.deepEqual(
      new SettingsStore(fileName).get().workspaces.map((item) => item.id),
      ['alpha', 'beta', 'gamma']
    )
  } finally {
    rmSync(path.join('C:/tmp', fileName), { force: true })
  }
})

test('projectOrder keeps the display order and drops duplicate paths', () => {
  const fileName = `project-order-${process.pid}.json`
  const store = new SettingsStore(fileName)
  try {
    store.patch({
      projectOrder: ['C:/alpha', 'c:/alpha/', 'C:/beta']
    })
    assert.deepEqual(store.get().projectOrder, ['C:/alpha', 'C:/beta'])
    assert.deepEqual(new SettingsStore(fileName).get().projectOrder, ['C:/alpha', 'C:/beta'])
  } finally {
    rmSync(path.join('C:/tmp', fileName), { force: true })
  }
})

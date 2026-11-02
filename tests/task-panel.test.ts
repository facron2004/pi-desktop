import test from 'node:test'
import assert from 'node:assert/strict'
import { buildDeliverableTree, summariseDiff } from '../src/renderer/src/lib/task-panel'
import type { GitStatus } from '../src/shared/types'

function repo(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: true,
    root: 'C:/project',
    branch: 'main',
    detached: false,
    ahead: 0,
    behind: 0,
    files: [],
    staged: 0,
    unstaged: 0,
    clean: true,
    ...overrides
  }
}

test('a file in a folder becomes a folder with the file inside', () => {
  const tree = buildDeliverableTree([{ path: 'audit/hover-check.mjs' }])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].kind, 'folder')
  assert.equal(tree[0].kind === 'folder' && tree[0].name, 'audit')
  const children = tree[0].kind === 'folder' ? tree[0].children : []
  assert.equal(children.length, 1)
  assert.equal(children[0].kind === 'file' && children[0].name, 'hover-check.mjs')
  assert.equal(children[0].kind === 'file' && children[0].path, 'audit/hover-check.mjs')
})

test('a file at the root of the project is not put in a folder', () => {
  const tree = buildDeliverableTree([{ path: 'README.md' }])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].kind, 'file')
  assert.equal(tree[0].kind === 'file' && tree[0].path, 'README.md')
})

test('folders come before files, and both are read in order', () => {
  const tree = buildDeliverableTree([
    { path: 'zeta.md' },
    { path: 'src/renderer/app.tsx' },
    { path: 'alpha.md' },
    { path: 'docs/readme.md' }
  ])
  assert.deepEqual(
    tree.map((node) => node.name),
    ['docs', 'src', 'alpha.md', 'zeta.md']
  )
})

test('nested folders keep their depth', () => {
  const tree = buildDeliverableTree([{ path: 'output/audit/shot.png' }])
  const output = tree[0]
  assert.equal(output.kind === 'folder' && output.name, 'output')
  const audit = output.kind === 'folder' ? output.children[0] : undefined
  assert.equal(audit?.kind === 'folder' && audit.name, 'audit')
  const file = audit?.kind === 'folder' ? audit.children[0] : undefined
  assert.equal(file?.kind === 'file' && file.name, 'shot.png')
})

test('a file that was written twice is listed once', () => {
  const tree = buildDeliverableTree([{ path: 'src/app.ts' }, { path: 'src/app.ts' }])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].kind === 'folder' && tree[0].children.length, 1)
})

test('the tree keeps the path a file is opened with', () => {
  const tree = buildDeliverableTree([
    { path: 'src/app.ts', target: 'C:/project/src/app.ts' }
  ])
  const folder = tree[0]
  const file = folder.kind === 'folder' ? folder.children[0] : undefined
  assert.equal(file?.kind === 'file' && file.target, 'C:/project/src/app.ts')
})

test('the line counts of the working tree add up', () => {
  const summary = summariseDiff(
    repo({
      files: [
        { path: 'a.ts', status: ' M', worktree: 'M', staged: false, untracked: false, added: 12, removed: 3 },
        { path: 'b.ts', status: ' M', worktree: 'M', staged: false, untracked: false, added: 5, removed: 1 }
      ]
    })
  )
  assert.equal(summary?.added, 17)
  assert.equal(summary?.removed, 4)
  assert.equal(summary?.files, 2)
  assert.equal(summary?.hasLineStats, true)
})

test('git reported no line counts, so only the files are known', () => {
  const summary = summariseDiff(
    repo({
      files: [
        { path: 'new.ts', status: '??', worktree: '?', staged: false, untracked: true }
      ]
    })
  )
  assert.equal(summary?.hasLineStats, false)
  assert.equal(summary?.files, 1)
})

test('a folder that is not a repository has no diff to summarise', () => {
  assert.equal(summariseDiff(repo({ isRepo: false })), null)
  assert.equal(summariseDiff(undefined), null)
})

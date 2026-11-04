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

test('a folder that holds one file is a path, not a group', () => {
  const tree = buildDeliverableTree([{ path: 'audit/hover-check.mjs' }])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].kind, 'file')
  assert.equal(tree[0].kind === 'file' && tree[0].name, 'hover-check.mjs')
  assert.equal(tree[0].kind === 'file' && tree[0].path, 'audit/hover-check.mjs')
  assert.equal(tree[0].kind === 'file' && tree[0].dir, 'audit')
})

test('a chain of folders with one file at the end collapses to the file', () => {
  const tree = buildDeliverableTree([{ path: 'output/audit/shot.png' }])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].kind === 'file' && tree[0].name, 'shot.png')
  assert.equal(tree[0].kind === 'file' && tree[0].dir, 'output/audit')
})

test('a folder with two files stays a folder and keeps its children inside', () => {
  const tree = buildDeliverableTree([
    { path: 'audit/shot.png' },
    { path: 'audit/hover-check.mjs' },
    { path: 'note.md' }
  ])
  assert.deepEqual(
    tree.map((node) => node.name),
    ['audit', 'note.md']
  )
  const folder = tree[0]
  assert.equal(folder.kind, 'folder')
  assert.deepEqual(
    folder.kind === 'folder' ? folder.children.map((child) => child.name) : [],
    ['hover-check.mjs', 'shot.png']
  )
})

test('a folder whose only child is a folder is still a folder', () => {
  const tree = buildDeliverableTree([{ path: 'docs/sub/a.md' }, { path: 'docs/sub/b.md' }])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].kind === 'folder' && tree[0].name, 'docs')
  const inner = tree[0].kind === 'folder' ? tree[0].children[0] : undefined
  assert.equal(inner?.kind === 'folder' && inner.name, 'sub')
})

test('a file at the root of the project is not put in a folder', () => {
  const tree = buildDeliverableTree([{ path: 'README.md' }])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].kind, 'file')
  assert.equal(tree[0].kind === 'file' && tree[0].path, 'README.md')
  assert.equal(tree[0].kind === 'file' && tree[0].dir, '')
})

test('folders come before files, and both are read in order', () => {
  const tree = buildDeliverableTree([
    { path: 'zeta.md' },
    { path: 'src/renderer/app.tsx' },
    { path: 'src/renderer/store.ts' },
    { path: 'alpha.md' },
    { path: 'docs/readme.md' },
    { path: 'docs/design.md' }
  ])
  assert.deepEqual(
    tree.map((node) => node.name),
    ['docs', 'src', 'alpha.md', 'zeta.md']
  )
})

test('a file that was written twice is listed once', () => {
  const tree = buildDeliverableTree([{ path: 'src/app.ts' }, { path: 'src/app.ts' }])
  assert.equal(tree.length, 1)
  assert.equal(tree[0].kind === 'file' && tree[0].path, 'src/app.ts')
})

test('the tree keeps the path a file is opened with', () => {
  const tree = buildDeliverableTree([
    { path: 'src/app.ts', target: 'C:/project/src/app.ts' }
  ])
  assert.equal(tree[0].kind === 'file' && tree[0].target, 'C:/project/src/app.ts')
})

test('a folder with two files keeps the open path of each', () => {
  const tree = buildDeliverableTree([
    { path: 'src/app.ts', target: 'C:/project/src/app.ts' },
    { path: 'src/store.ts', target: 'C:/project/src/store.ts' }
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

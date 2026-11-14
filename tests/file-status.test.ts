import test from 'node:test'
import assert from 'node:assert/strict'
import type { GitFileStatus, GitStatus } from '../src/shared/types'
import {
  changeFor,
  changeKind,
  changedFileTree,
  fileChangeIndex,
  type ChangedFolderNode
} from '../src/renderer/src/lib/file-status'

function file(path: string, patch: Partial<GitFileStatus> = {}): GitFileStatus {
  return { path, index: ' ', worktree: ' ', staged: false, untracked: false, ...patch }
}

function status(files: GitFileStatus[], root = 'C:/project'): GitStatus {
  return {
    isRepo: true,
    root,
    detached: false,
    ahead: 0,
    behind: 0,
    files,
    staged: 0,
    unstaged: files.length,
    clean: files.length === 0
  }
}

test('changeKind reads porcelain codes as one mark per file', () => {
  assert.equal(changeKind(file('a.ts', { worktree: 'M' })), 'modified')
  assert.equal(changeKind(file('a.ts', { index: 'M' })), 'modified')
  assert.equal(changeKind(file('a.ts', { index: 'A' })), 'added')
  assert.equal(changeKind(file('a.ts', { index: 'D' })), 'deleted')
  assert.equal(changeKind(file('a.ts', { index: 'R', oldPath: 'b.ts' })), 'renamed')
  assert.equal(changeKind(file('a.ts', { untracked: true })), 'added')
  assert.equal(changeKind(file('a.ts', { index: 'U', worktree: 'U' })), 'conflicted')
  assert.equal(changeKind(file('a.ts')), undefined)
})

test('fileChangeIndex keys changes by the absolute path the tree rows use', () => {
  const index = fileChangeIndex(status([file('src/main/ipc.ts', { worktree: 'M' })]), 'C:/project')
  assert.equal(changeFor(index, 'C:/project/src/main/ipc.ts', 'file'), 'modified')
  assert.equal(changeFor(index, 'C:/project/src/main/ipc.ts', 'directory'), undefined)
})

test('a folder wears the strongest change below it', () => {
  const index = fileChangeIndex(
    status([
      file('src/main/a.ts', { worktree: 'M' }),
      file('src/main/b.ts', { index: 'A' }),
      file('src/main/c.ts', { index: 'D' })
    ]),
    'C:/project'
  )
  // deleted outranks modified, which outranks added.
  assert.equal(changeFor(index, 'C:/project/src', 'directory'), 'deleted')
  assert.equal(changeFor(index, 'C:/project/src/main', 'directory'), 'deleted')
  assert.equal(changeFor(index, 'C:/project/src/main/a.ts', 'file'), 'modified')
})

test('an added-only folder stays added', () => {
  const index = fileChangeIndex(
    status([file('docs/readme.md', { untracked: true })]),
    'C:/project'
  )
  assert.equal(changeFor(index, 'C:/project/docs', 'directory'), 'added')
  assert.equal(changeFor(index, 'C:/project/docs/readme.md', 'file'), 'added')
})

test('a workspace inside a larger repository only marks its own files', () => {
  const index = fileChangeIndex(
    status([
      file('app/src/a.ts', { worktree: 'M' }),
      file('other/b.ts', { worktree: 'M' })
    ], 'C:/repo'),
    'C:/repo/app'
  )
  assert.equal(changeFor(index, 'C:/repo/app/src/a.ts', 'file'), 'modified')
  assert.equal(changeFor(index, 'C:/repo/other/b.ts', 'file'), undefined)
  assert.equal(index.files.size, 1)
})

test('a repository with no changes produces an empty index', () => {
  assert.equal(fileChangeIndex(undefined, 'C:/project').files.size, 0)
  assert.equal(fileChangeIndex({ ...status([]), isRepo: false }, 'C:/project').files.size, 0)
  assert.equal(fileChangeIndex(status([]), 'C:/project').files.size, 0)
})

test('path lookup is case- and separator-insensitive', () => {
  const index = fileChangeIndex(status([file('src/Main/App.tsx', { worktree: 'M' })]), 'C:/project')
  assert.equal(changeFor(index, 'C:\\project\\src\\main\\app.tsx', 'file'), 'modified')
})

test('changedFileTree groups only changed files by their folders', () => {
  const index = fileChangeIndex(
    status([
      file('src/main/ipc.ts', { worktree: 'M' }),
      file('src/main/pi/runtime.ts', { worktree: 'M' }),
      file('README.md', { untracked: true })
    ]),
    'C:/project'
  )
  const tree = changedFileTree(index, 'C:/project')
  // Folders come before files, alphabetical.
  assert.equal(tree[0].kind, 'folder')
  assert.equal(tree[0].name, 'src')
  const src = tree[0] as ChangedFolderNode
  assert.equal(src.children[0].name, 'main')
  const main = src.children[0] as ChangedFolderNode
  assert.deepEqual(main.children.map((node) => node.name), ['pi', 'ipc.ts'])
  assert.equal(tree[1].kind, 'file')
  assert.equal(tree[1].name, 'README.md')
})

test('a changed folder keeps the strongest change of its children', () => {
  const index = fileChangeIndex(
    status([
      file('src/a.ts', { worktree: 'M' }),
      file('src/b.ts', { index: 'D' })
    ]),
    'C:/project'
  )
  const tree = changedFileTree(index, 'C:/project')
  assert.equal(tree[0].kind, 'folder')
  assert.equal((tree[0] as ChangedFolderNode).change, 'deleted')
})

test('the changed tree filters on the relative path and drops empty folders', () => {
  const index = fileChangeIndex(
    status([
      file('src/main/ipc.ts', { worktree: 'M' }),
      file('docs/readme.md', { worktree: 'M' })
    ]),
    'C:/project'
  )
  const tree = changedFileTree(index, 'C:/project', 'ipc')
  assert.equal(tree.length, 1)
  assert.equal(tree[0].name, 'src')
  assert.deepEqual(changedFileTree(index, 'C:/project', 'nothing'), [])
})

test('the changed tree is empty without a repository or changes', () => {
  assert.deepEqual(changedFileTree(fileChangeIndex(undefined, 'C:/project'), 'C:/project'), [])
  assert.deepEqual(changedFileTree(fileChangeIndex(status([]), 'C:/project'), 'C:/project'), [])
})

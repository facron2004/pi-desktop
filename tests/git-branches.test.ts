import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readBranches, readStatus, readFileDiff } from '../src/main/git'

function createTempDir(prefix: string): { dir: string; cleanup: () => void } {
  const temp = realpathSync(os.tmpdir())
  const dir = mkdtempSync(path.join(temp, prefix))
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

function gitRepoFixture(): { root: string; git: (...args: string[]) => string; cleanup: () => void } {
  const { dir: root, cleanup } = createTempDir('pi-desktop-git-branch-test-')
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '--quiet')
  git('config', 'user.name', 'Pi Desktop test')
  git('config', 'user.email', 'test@example.invalid')
  return { root, git, cleanup }
}

test('readBranches returns { isRepo: false } on non-git directories without throwing', async () => {
  const { dir, cleanup } = createTempDir('pi-desktop-nongit-test-')
  try {
    const result = await readBranches(dir)
    assert.equal(result.isRepo, false)
    assert.equal(result.detached, false)
    assert.deepEqual(result.branches, [])
    assert.deepEqual(result.worktrees, [])
  } finally {
    cleanup()
  }
})

test('readBranches returns { isRepo: false } on empty root path', async () => {
  const result = await readBranches('')
  assert.equal(result.isRepo, false)
  assert.equal(result.detached, false)
  assert.deepEqual(result.branches, [])
  assert.deepEqual(result.worktrees, [])
})

test('readBranches returns { isRepo: true } and active branches on a real git repository', async () => {
  const { root, git, cleanup } = gitRepoFixture()
  try {
    writeFileSync(path.join(root, 'file.txt'), 'hello world\n')
    git('add', 'file.txt')
    git('commit', '-qm', 'initial commit')

    const result = await readBranches(root)
    assert.equal(result.isRepo, true)
    assert.ok(result.branches.length > 0)
    assert.ok(result.current)
    assert.equal(result.detached, false)
  } finally {
    cleanup()
  }
})

test('countUntracked bounds reading: large files > 512KB count as 1 line without reading whole file', async () => {
  const { root, git, cleanup } = gitRepoFixture()
  try {
    // Normal small untracked file (3 lines)
    writeFileSync(path.join(root, 'small.txt'), 'line 1\nline 2\nline 3\n')

    // Large untracked file (> 512 KB, e.g. 600 KB)
    const largeSize = 600 * 1024
    const largeBuffer = Buffer.alloc(largeSize, 0x61) // 'a'
    writeFileSync(path.join(root, 'large.txt'), largeBuffer)

    const status = await readStatus(root)
    const fileMap = new Map(status.files.map((f) => [f.path, f]))

    // Small file lines counted accurately
    const smallFile = fileMap.get('small.txt')
    assert.ok(smallFile)
    assert.equal(smallFile.added, 3)

    // Large file bounded to 1 line count per specification
    const largeFile = fileMap.get('large.txt')
    assert.ok(largeFile)
    assert.equal(largeFile.added, 1)
  } finally {
    cleanup()
  }
})

test('readFileDiff treats large file > 2MB gracefully as binary', async () => {
  const { root, git, cleanup } = gitRepoFixture()
  try {
    const hugeSize = 2.5 * 1024 * 1024 // 2.5MB > MAX_DIFF_FILE_BYTES (2MB)
    const hugeBuffer = Buffer.alloc(hugeSize, 0x78) // 'x'
    const hugePath = 'huge-file.txt'
    writeFileSync(path.join(root, hugePath), hugeBuffer)

    const diff = await readFileDiff(root, hugePath)
    assert.equal(diff.binary, true)
    assert.equal(diff.oldText, '')
    assert.equal(diff.newText, '')
  } finally {
    cleanup()
  }
})

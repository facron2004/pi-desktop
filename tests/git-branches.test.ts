import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { addWorktree, readBranches, readStatus, readFileDiff, removeWorktree } from '../src/main/git'

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

test('removeWorktree stops its runtime only after validating the registered target', async () => {
  const { root, git, cleanup } = gitRepoFixture()
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-secondary`)
  try {
    writeFileSync(path.join(root, 'file.txt'), 'initial\n')
    git('add', 'file.txt')
    git('commit', '-qm', 'initial commit')
    const added = await addWorktree(root, worktree, 'secondary', true)
    assert.equal(added.ok, true)
    assert.equal(added.path, worktree)

    let invalidTargetStopped = false
    const invalid = await removeWorktree(root, path.join(root, 'not-a-worktree'), async () => {
      invalidTargetStopped = true
      return { ok: false }
    })
    assert.equal(invalid.ok, false)
    assert.equal(invalidTargetStopped, false)

    let stoppedPath: string | undefined
    let runtimeStopped = false
    const removalSteps: string[] = []
    const removed = await removeWorktree(root, path.relative(root, worktree), async (target, remove) => {
      stoppedPath = target
      removalSteps.push('stop')
      runtimeStopped = true
      assert.equal(existsSync(target), true)
      removalSteps.push('lock')
      assert.equal(target, worktree)
      assert.equal(runtimeStopped, true, 'stop the target runtime before taking its write lock')
      const result = await remove()
      removalSteps.push('remove')
      return result
    })
    assert.equal(removed.ok, true)
    assert.equal(stoppedPath, worktree)
    assert.deepEqual(removalSteps, ['stop', 'lock', 'remove'])
    assert.equal(existsSync(worktree), false)
  } finally {
    rmSync(worktree, { recursive: true, force: true })
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

test('readFileDiff does not follow a directory link outside the repository', async (t) => {
  const { root, cleanup } = gitRepoFixture()
  const outside = mkdtempSync(path.join(path.dirname(root), 'pi-desktop-git-outside-'))
  try {
    writeFileSync(path.join(outside, 'secret.txt'), 'private external content\n')
    try {
      symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
        t.diagnostic(`directory links are unavailable (${code})`)
        return
      }
      throw error
    }

    const diff = await readFileDiff(root, path.join('linked', 'secret.txt'))
    assert.equal(diff.newText, '')
    assert.doesNotMatch(diff.newText, /private external content/)
  } finally {
    cleanup()
    rmSync(outside, { recursive: true, force: true })
  }
})

test('readFileDiff does not read a hard link to a file outside the repository', async (t) => {
  const { root, cleanup } = gitRepoFixture()
  const outside = path.join(path.dirname(root), `${path.basename(root)}-private.txt`)
  try {
    writeFileSync(outside, 'private external content\n')
    try {
      linkSync(outside, path.join(root, 'alias.txt'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP' || code === 'EXDEV') {
        t.skip(`hard links are unavailable (${code})`)
        return
      }
      throw error
    }

    const diff = await readFileDiff(root, 'alias.txt')
    assert.equal(diff.newText, '')
    assert.doesNotMatch(diff.newText, /private external content/)
  } finally {
    cleanup()
    rmSync(outside, { force: true })
  }
})

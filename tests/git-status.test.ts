import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readFileDiff, readStatus } from '../src/main/git'

function fixture(): { root: string; git: (...args: string[]) => string; cleanup: () => void } {
  const temp = realpathSync(os.tmpdir())
  const root = mkdtempSync(path.join(temp, 'pi-desktop-git-test-'))
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '--quiet')
  git('config', 'user.name', 'Pi Desktop test')
  git('config', 'user.email', 'pi-desktop-test@example.invalid')
  git('config', 'core.autocrlf', 'true')
  return {
    root,
    git,
    cleanup: () => {
      const target = realpathSync(root)
      assert.equal(path.dirname(target), temp)
      assert.ok(path.basename(target).startsWith('pi-desktop-git-test-'))
      rmSync(target, { recursive: true, force: true })
    }
  }
}

test('working-tree counts compare HEAD to disk for staged, unstaged, renamed and Unicode paths', async () => {
  const { root, git, cleanup } = fixture()
  try {
    const mixed = '测试 mixed.txt'
    const oldPath = 'old name.txt'
    const newPath = 'renamed 文件.txt'
    const original = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\r\n') + '\r\n'
    writeFileSync(path.join(root, mixed), original)
    writeFileSync(path.join(root, oldPath), original)
    git('add', '.')
    git('commit', '-qm', 'baseline')

    const staged = original.replace('line 3\r\n', 'staged line 3\r\n')
    writeFileSync(path.join(root, mixed), staged)
    git('add', mixed)
    writeFileSync(path.join(root, mixed), staged.replace('line 12\r\n', 'unstaged line 12\r\nextra line\r\n'))
    git('mv', oldPath, newPath)
    writeFileSync(path.join(root, newPath), original + 'new line\r\n')
    writeFileSync(path.join(root, 'untracked.txt'), 'one\ntwo\n')

    const status = await readStatus(root)
    const entries = new Map(status.files.map((file) => [file.path, file]))
    assert.deepEqual([entries.get(mixed)?.added, entries.get(mixed)?.removed], [3, 2])
    assert.deepEqual([entries.get(newPath)?.oldPath, entries.get(newPath)?.added, entries.get(newPath)?.removed], [oldPath, 1, 0])
    assert.deepEqual([entries.get('untracked.txt')?.added, entries.get('untracked.txt')?.removed], [2, 0])
    const renamedDiff = await readFileDiff(root, newPath)
    assert.ok(renamedDiff.oldText.includes('line 1'))
    assert.ok(renamedDiff.newText.includes('new line'))
  } finally {
    cleanup()
  }
})

test('working-tree counts include unstaged edits in a repository without a first commit', async () => {
  const { root, git, cleanup } = fixture()
  try {
    writeFileSync(path.join(root, 'new.txt'), 'one\ntwo\n')
    git('add', 'new.txt')
    writeFileSync(path.join(root, 'new.txt'), 'one\ntwo\nthree\n')
    const status = await readStatus(root)
    assert.deepEqual([status.files[0]?.added, status.files[0]?.removed], [3, 0])
  } finally {
    cleanup()
  }
})

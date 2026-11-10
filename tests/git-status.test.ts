import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { applyPatch, readCommitDetail, readCommitFileDiff, readFileDiff, readPatch, readStatus, revertFile, stageFile, unstageFile } from '../src/main/git'

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

test('commit rename diffs preserve paths containing tabs and newlines', async () => {
  const { root, git, cleanup } = fixture()
  try {
    const oldPath = 'old\tname.txt'
    const newPath = 'new\nname.txt'
    const blob = execFileSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], {
      input: 'original content\n',
      encoding: 'utf8'
    }).trim()
    const writeTree = (file: string) => execFileSync('git', ['-C', root, 'mktree', '-z'], {
      input: Buffer.from(`100644 blob ${blob}\t${file}\0`, 'utf8'),
      encoding: 'utf8'
    }).trim()
    const parentTree = writeTree(oldPath)
    const parent = git('commit-tree', parentTree, '-m', 'baseline').trim()
    const renamedTree = writeTree(newPath)
    const commit = git('commit-tree', renamedTree, '-p', parent, '-m', 'rename').trim()

    const detail = await readCommitDetail(root, commit)
    assert.ok(detail)
    assert.equal(detail.files[0]?.path, newPath)
    assert.equal(detail.files[0]?.oldPath, oldPath)

    const diff = await readCommitFileDiff(root, commit, newPath)
    assert.ok(diff)
    assert.equal(diff.oldText, 'original content\n')
    assert.equal(diff.newText, 'original content\n')
  } finally {
    cleanup()
  }
})

test('Git diff previews and patches stay within their UTF-8 byte budgets', async () => {
  const { root, git, cleanup } = fixture()
  try {
    const file = 'unicode.txt'
    writeFileSync(path.join(root, file), 'baseline\n')
    git('add', file)
    git('commit', '-qm', 'baseline')
    writeFileSync(path.join(root, file), '界'.repeat(400_000))

    const diff = await readFileDiff(root, file)
    assert.equal(diff.truncated, true)
    assert.ok(Buffer.byteLength(diff.newText, 'utf8') <= 512 * 1024)

    const patch = await readPatch(root)
    assert.equal(patch.truncated, true)
    assert.ok(Buffer.byteLength(patch.text, 'utf8') <= 1024 * 1024)
  } finally {
    cleanup()
  }
})

test('commit patches are byte capped and oversized multibyte patch input is rejected', async () => {
  const { root, git, cleanup } = fixture()
  try {
    const file = 'unicode.txt'
    writeFileSync(path.join(root, file), '界'.repeat(400_000))
    git('add', file)
    git('commit', '-qm', 'large Unicode file')

    const detail = await readCommitDetail(root, git('rev-parse', 'HEAD').trim())
    assert.ok(detail)
    assert.equal(detail.truncated, true)
    assert.ok(Buffer.byteLength(detail.patch, 'utf8') <= 1024 * 1024)

    const oversized = `diff --git a/file b/file\n${'界'.repeat(400_000)}`
    assert.ok(oversized.length < 1024 * 1024)
    assert.ok(Buffer.byteLength(oversized, 'utf8') > 1024 * 1024)
    const result = await applyPatch(root, oversized)
    assert.equal(result.ok, false)
    assert.match(result.error ?? '', /patch is too large/i)
  } finally {
    cleanup()
  }
})

test('single-file staging treats pathspec syntax as a literal filename', async () => {
  const { root, git, cleanup } = fixture()
  try {
    writeFileSync(path.join(root, 'one.txt'), 'one\n')
    writeFileSync(path.join(root, 'two.txt'), 'two\n')
    git('add', '-A')
    git('commit', '-qm', 'baseline')
    writeFileSync(path.join(root, 'one.txt'), 'one changed\n')
    writeFileSync(path.join(root, 'two.txt'), 'two changed\n')

    assert.equal((await readPatch(root, ':(glob)**')).text, '')

    await stageFile(root, ':(glob)**')
    let files = (await readStatus(root)).files
    assert.equal(files.length, 2)
    assert.ok(files.every((file) => !file.staged))

    git('add', '-A')
    await unstageFile(root, ':(glob)**')
    files = (await readStatus(root)).files
    assert.ok(files.every((file) => file.staged))
  } finally {
    cleanup()
  }
})

test('file-scoped Git operations do not expand pathspec magic in a filename', {
  skip: process.platform === 'win32'
}, async () => {
  const { root, git, cleanup } = fixture()
  try {
    const magicFile = ':(glob)**'
    const otherFile = 'other.txt'
    writeFileSync(path.join(root, magicFile), 'magic original\n')
    writeFileSync(path.join(root, otherFile), 'other original\n')
    git('add', '-A')
    git('commit', '-qm', 'baseline')

    writeFileSync(path.join(root, magicFile), 'magic changed\n')
    writeFileSync(path.join(root, otherFile), 'other changed\n')

    const fileDiff = await readFileDiff(root, magicFile)
    assert.equal(fileDiff.oldText, 'magic original\n')
    assert.equal(fileDiff.newText, 'magic changed\n')

    const patch = await readPatch(root, magicFile)
    assert.ok(patch.text.includes('magic changed'))
    assert.ok(!patch.text.includes('other changed'))

    assert.equal((await stageFile(root, magicFile)).ok, true)
    let entries = new Map((await readStatus(root)).files.map((file) => [file.path, file]))
    assert.equal(entries.get(magicFile)?.staged, true)
    assert.equal(entries.get(otherFile)?.staged, false)

    assert.equal((await unstageFile(root, magicFile)).ok, true)
    assert.equal((await revertFile(root, magicFile)).ok, true)
    assert.equal((await readFileDiff(root, magicFile)).newText, 'magic original\n')
    entries = new Map((await readStatus(root)).files.map((file) => [file.path, file]))
    assert.equal(entries.get(magicFile), undefined)
    assert.equal(entries.get(otherFile)?.worktree, 'M')
  } finally {
    cleanup()
  }
})

test('file-scoped Git operations accept filenames beginning with two dots', async () => {
  const { root, git, cleanup } = fixture()
  const file = '..notes.txt'
  try {
    writeFileSync(path.join(root, file), 'before\n')
    git('add', '-A')
    git('commit', '-qm', 'baseline')
    writeFileSync(path.join(root, file), 'after\n')

    const diff = await readFileDiff(root, file)
    assert.equal(diff.oldText, 'before\n')
    assert.equal(diff.newText, 'after\n')
    assert.equal((await stageFile(root, file)).ok, true)
    assert.equal((await unstageFile(root, file)).ok, true)
  } finally {
    cleanup()
  }
})

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { lstat, open, readlink, realpath, stat, type FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  GitBranch,
  GitBranches,
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitCommitFileDiff,
  GitCommitResult,
  GitFileDiff,
  GitFileStatus,
  GitPatch,
  GitStatus,
  GitWorktree,
  GitWorktreeResult
} from '@shared/types'

const run = promisify(execFile)

const STATUS_TIMEOUT_MS = 10_000
const COMMIT_TIMEOUT_MS = 120_000
/** Untracked files larger than this are counted as one line instead of read. */
const MAX_UNTRACKED_BYTES = 512 * 1024
const MAX_UNTRACKED_STATS = 60
/** How much of either side of a review diff is sent to the renderer. */
const MAX_DIFF_BYTES = 512 * 1024
/** Files larger than this are treated as binary to avoid buffering huge files into memory. */
const MAX_DIFF_FILE_BYTES = 2 * 1024 * 1024
/** How much of a patch is sent to the renderer. */
const MAX_PATCH_BYTES = 1024 * 1024
const WORKTREE_READ_FLAGS = constants.O_RDONLY |
  (constants.O_NOFOLLOW ?? 0) |
  (constants.O_NONBLOCK ?? 0)

interface GitOutput {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run git in a directory without letting a missing binary or a non-zero exit
 * become an exception. Every caller decides what a failure means.
 */
async function git(root: string, args: string[], timeoutMs = STATUS_TIMEOUT_MS): Promise<GitOutput> {
  try {
    const { stdout, stderr } = await run('git', ['-C', root, ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      // A repository owned by another user makes git refuse to run; the UI
      // would rather see the error than a hung process.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' }
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown }
    return {
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
      stderr:
        typeof failure.stderr === 'string' && failure.stderr
          ? failure.stderr
          : typeof failure.message === 'string'
            ? failure.message
            : ''
    }
  }
}

/** Run a file-scoped command without interpreting a filename as Git pathspec magic. */
function gitLiteralPathspecs(
  root: string,
  args: string[],
  timeoutMs = STATUS_TIMEOUT_MS
): Promise<GitOutput> {
  return git(root, ['--literal-pathspecs', ...args], timeoutMs)
}

const NO_REPOSITORY: GitStatus = {
  isRepo: false,
  detached: false,
  ahead: 0,
  behind: 0,
  files: [],
  staged: 0,
  unstaged: 0,
  clean: true
}

const inFlightStatus = new Map<string, Promise<GitStatus>>()
const inFlightBranches = new Map<string, Promise<GitBranches>>()
const gitWriteGenerations = new Map<string, number>()

function repoCacheKey(root: string): string {
  const resolved = path.resolve(root)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function invalidateGitReadCache(root: string): void {
  if (!root) return
  const key = repoCacheKey(root)
  gitWriteGenerations.set(key, (gitWriteGenerations.get(key) ?? 0) + 1)
  inFlightStatus.delete(key)
  inFlightBranches.delete(key)
}

async function withGitMutation<T>(root: string, action: () => Promise<T>): Promise<T> {
  invalidateGitReadCache(root)
  try {
    return await action()
  } finally {
    invalidateGitReadCache(root)
  }
}

function nthTokenOffset(text: string, tokenCount: number): number {
  let seen = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 32) {
      seen += 1
      if (seen === tokenCount) return i + 1
    }
  }
  return -1
}

function parsePorcelainV2(raw: string): {
  files: GitFileStatus[]
  branch?: string
  head?: string
  unborn: boolean
  ahead: number
  behind: number
} {
  const files: GitFileStatus[] = []
  let branch: string | undefined
  let head: string | undefined
  let unborn = false
  let ahead = 0
  let behind = 0
  if (!raw) return { files, branch, head, unborn, ahead, behind }

  const fields = raw.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field) continue
    if (field.startsWith('# ')) {
      if (field.startsWith('# branch.oid ')) {
        const oid = field.slice('# branch.oid '.length).trim()
        if (oid === '(initial)') {
          unborn = true
          head = undefined
        } else if (oid) {
          head = oid.slice(0, 7)
        }
      } else if (field.startsWith('# branch.head ')) {
        const name = field.slice('# branch.head '.length).trim()
        branch = name && name !== '(detached)' && name !== '(unknown)' ? name : undefined
      } else if (field.startsWith('# branch.ab ')) {
        const match = /^\+(\d+)\s+-(\d+)$/.exec(field.slice('# branch.ab '.length).trim())
        if (match) {
          ahead = Number(match[1]) || 0
          behind = Number(match[2]) || 0
        }
      }
      continue
    }

    if (field.startsWith('? ')) {
      const filePath = field.slice(2)
      if (!filePath) continue
      files.push({
        path: filePath,
        index: '?',
        worktree: '?',
        staged: false,
        untracked: true
      })
      continue
    }

    if (field.startsWith('1 ') || field.startsWith('2 ') || field.startsWith('u ')) {
      const kind = field[0]
      const xy = field.slice(2, 4)
      if (xy.length < 2) continue
      const headerTokens = kind === '1' ? 8 : kind === '2' ? 9 : 10
      const pathStart = nthTokenOffset(field, headerTokens)
      if (pathStart < 0) continue
      const filePath = field.slice(pathStart)
      let oldPath: string | undefined
      if (kind === '2') {
        oldPath = fields[index + 1]
        index += 1
      }
      if (!filePath) continue
      const indexStatus = xy[0] === '.' ? ' ' : xy[0]!
      const worktreeStatus = xy[1] === '.' ? ' ' : xy[1]!
      files.push({
        path: filePath,
        oldPath,
        index: indexStatus,
        worktree: worktreeStatus,
        staged: indexStatus !== ' ' && indexStatus !== '?',
        untracked: false
      })
    }
  }

  return { files, branch, head, unborn, ahead, behind }
}

/** Read the working tree of `root` the way the review panel needs it. */
export async function readStatus(root: string): Promise<GitStatus> {
  if (!root) return { ...NO_REPOSITORY }
  const key = repoCacheKey(root)
  const existing = inFlightStatus.get(key)
  if (existing) return existing

  const startGeneration = gitWriteGenerations.get(key) ?? 0
  const task = (async (): Promise<GitStatus> => {
    const [porcelain, topLevel, diffHead] = await Promise.all([
      git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z']),
      git(root, ['rev-parse', '--show-toplevel']),
      git(root, ['diff', '--numstat', '-z', '-M', 'HEAD', '--'])
    ])
    if (porcelain.code !== 0) return { ...NO_REPOSITORY }

    const parsed = parsePorcelainV2(porcelain.stdout)
    const files = parsed.files
    const hasTrackedChanges = files.some((file) => !file.untracked)

    let stats: Map<string, { added: number; removed: number }>
    if (!hasTrackedChanges) {
      stats = new Map()
    } else if (!parsed.unborn && diffHead.code === 0) {
      stats = new Map()
      for (const file of parseNumstatZ(diffHead.stdout)) {
        stats.set(file.path, { added: file.added, removed: file.removed })
      }
    } else {
      // Unborn repository (or missing HEAD): compare staged index against the empty tree.
      const objectFormat = await git(root, ['rev-parse', '--show-object-format'])
      const emptyTree = createHash(objectFormat.stdout.trim() === 'sha256' ? 'sha256' : 'sha1')
        .update('tree 0\0')
        .digest('hex')
      stats = await lineCounts(root, ['diff', '--numstat', '-z', '-M', emptyTree, '--'])
    }

    for (const file of files) {
      const known = stats.get(file.path)
      if (known) {
        file.added = known.added
        file.removed = known.removed
      }
    }
    await countUntracked(root, files)

    return {
      isRepo: true,
      root: topLevel.code === 0 ? topLevel.stdout.trim() || root : root,
      branch: parsed.branch,
      head: parsed.head,
      detached: !parsed.branch,
      ahead: parsed.ahead,
      behind: parsed.behind,
      files,
      staged: files.filter((file) => file.staged).length,
      unstaged: files.filter((file) => !file.staged).length,
      clean: files.length === 0
    }
  })()

  inFlightStatus.set(key, task)
  try {
    const result = await task
    if ((gitWriteGenerations.get(key) ?? 0) !== startGeneration) {
      if (inFlightStatus.get(key) === task) inFlightStatus.delete(key)
      return await readStatus(root)
    }
    return result
  } finally {
    if (inFlightStatus.get(key) === task) inFlightStatus.delete(key)
  }
}

/** The commits of the current branch, newest first. */
export async function readLog(root: string, limit = 20): Promise<GitCommit[]> {
  if (!root) return []
  const count = Math.min(Math.max(limit, 1), 100)
  // Unit separators survive subjects that contain spaces or punctuation.
  const result = await git(root, [
    'log',
    `-n${count}`,
    '--pretty=format:%h%x1f%s%x1f%an%x1f%at'
  ])
  if (result.code !== 0 || !result.stdout.trim()) return []
  return result.stdout
    .split('\n')
    .map((line) => line.split('\u001f'))
    .filter((parts) => parts.length >= 4)
    .map((parts) => ({
      hash: parts[0] ?? '',
      subject: parts[1] ?? '',
      author: parts[2] ?? '',
      date: Number(parts[3]) * 1000 || 0
    }))
}

/** Build a compact subject from the staged paths when the user leaves it blank. */
function generatedCommitMessage(paths: string[]): string {
  const normalized = paths
    .map((path) => path.replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const unique = [...new Set(normalized)]
  if (unique.length === 0) return 'chore: update project files'

  const summary = unique.length <= 2
    ? unique.join(' and ')
    : `${unique[0]} and ${unique.length - 1} more`
  const subject = `chore: update ${summary}`
  return subject.length <= 72 ? subject : `chore: update ${unique.length} files`
}

/** Stage everything in the work tree and commit it. */
export async function commitWorkingTree(
  root: string,
  message: string,
  includeUnstaged = false
): Promise<GitCommitResult> {
  const trimmed = message.trim()
  if (!root) return { ok: false, error: 'No project is open.' }

  return withGitMutation(root, async () => {
    const statusOut = await git(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z'])
    if (statusOut.code !== 0) return { ok: false, error: 'This folder is not a git repository.' }
    const statusFiles = parsePorcelain(statusOut.stdout)
    if (statusFiles.length === 0) return { ok: false, error: 'There is nothing to commit.' }

    if (includeUnstaged) {
      const added = await git(root, ['add', '-A'], COMMIT_TIMEOUT_MS)
      if (added.code !== 0) {
        return { ok: false, error: cleanError(added.stderr) || 'git add failed.' }
      }
    } else {
      // Not staging anything would commit with an empty index, so say so
      // instead of committing a surprise.
      const staged = await git(root, ['diff', '--cached', '--quiet'])
      if (staged.code === 0) {
        return { ok: false, error: 'Nothing is staged. Stage a file or include unstaged changes.' }
      }
      if (staged.code !== 1) {
        return { ok: false, error: cleanError(staged.stderr) || 'Could not read the index.' }
      }
    }

    const stagedFiles = await git(root, ['diff', '--cached', '--name-only', '-z'])
    const stagedPaths = stagedFiles.code === 0 ? stagedFiles.stdout.split('\0').filter(Boolean) : []
    const count = stagedPaths.length
    const commitMessage = trimmed || generatedCommitMessage(stagedPaths)

    const committed = await git(root, ['commit', '-m', commitMessage], COMMIT_TIMEOUT_MS)
    if (committed.code !== 0) {
      const detail = cleanError(committed.stderr) || cleanError(committed.stdout)
      return { ok: false, error: detail || 'git commit failed.' }
    }

    const head = await git(root, ['rev-parse', '--short', 'HEAD'])
    return {
      ok: true,
      hash: head.code === 0 ? head.stdout.trim() || undefined : undefined,
      files: count || statusFiles.length
    }
  })
}

/** Move one file into the index. Deleted and new files go in as well. */
export async function stageFile(root: string, filePath: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  if (!filePath) return { ok: false, error: 'No file was given.' }
  return withGitMutation(root, async () => {
    const result = await gitLiteralPathspecs(root, ['add', '-A', '--', filePath], COMMIT_TIMEOUT_MS)
    if (result.code !== 0) {
      return { ok: false, error: cleanError(result.stderr) || 'git add failed.' }
    }
    return { ok: true }
  })
}

/** Move one file out of the index, keeping its working-tree changes. */
export async function unstageFile(root: string, filePath: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  if (!filePath) return { ok: false, error: 'No file was given.' }
  return withGitMutation(root, async () => {
    // `restore --staged` needs a HEAD; a repository without a commit has to
    // fall back to removing the entry from the index instead.
    let result = await gitLiteralPathspecs(root, ['restore', '--staged', '--', filePath], COMMIT_TIMEOUT_MS)
    if (result.code !== 0) {
      result = await gitLiteralPathspecs(root, ['reset', '-q', 'HEAD', '--', filePath], COMMIT_TIMEOUT_MS)
    }
    if (result.code !== 0) {
      result = await gitLiteralPathspecs(root, ['rm', '--cached', '-q', '--', filePath], COMMIT_TIMEOUT_MS)
    }
    if (result.code !== 0) {
      return { ok: false, error: cleanError(result.stderr) || 'git restore failed.' }
    }
    return { ok: true }
  })
}

export async function stageAll(root: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  return withGitMutation(root, async () => {
    const result = await git(root, ['add', '-A'], COMMIT_TIMEOUT_MS)
    if (result.code !== 0) return { ok: false, error: cleanError(result.stderr) || 'git add failed.' }
    return { ok: true }
  })
}

export async function unstageAll(root: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  return withGitMutation(root, async () => {
    let result = await git(root, ['reset', '-q'], COMMIT_TIMEOUT_MS)
    if (result.code !== 0) {
      result = await git(root, ['rm', '-r', '--cached', '-q', '.'], COMMIT_TIMEOUT_MS)
    }
    if (result.code !== 0) {
      return { ok: false, error: cleanError(result.stderr) || 'git reset failed.' }
    }
    return { ok: true }
  })
}

/** Trim the noise git puts around its diagnostics before the UI shows it. */
function cleanError(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^\(use "git /i.test(line) && !/^hint:/i.test(line))
    .slice(0, 4)
    .join(' ')
}

/** Resolve a repository-relative path, or null when it escapes the work tree. */
function insideWorkTree(root: string, relative: string): string | null {
  const target = path.resolve(root, relative)
  const relation = path.relative(path.resolve(root), target)
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) return null
  return target
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

interface WorktreeFileRead {
  buffer: Buffer | null
  size: number
  mode: number
}

/** Read a regular worktree file by handle, rejecting hard links, or read a symlink's text. */
async function readWorktreeFile(
  root: string,
  relative: string,
  maxBytes: number
): Promise<WorktreeFileRead | null> {
  const target = insideWorkTree(root, relative)
  if (!target) return null

  let handle: FileHandle | undefined
  try {
    const [realRoot, info] = await Promise.all([realpath(root), lstat(target)])
    if (info.isSymbolicLink()) {
      const buffer = Buffer.from(await readlink(target), 'utf8')
      return {
        buffer: buffer.length <= maxBytes ? buffer : null,
        size: buffer.length,
        mode: 0o120000
      }
    }
    if (!info.isFile()) return null
    if (info.nlink > 1) return null

    const realTarget = await realpath(target)
    const relation = path.relative(realRoot, realTarget)
    if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation)) return null

    handle = await open(realTarget, WORKTREE_READ_FLAGS)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink > 1n) return null
    const [currentRoot, currentTarget] = await Promise.all([realpath(root), realpath(target)])
    if (currentRoot !== realRoot || currentTarget !== realTarget) return null
    const named = await stat(currentTarget, { bigint: true })
    if (opened.dev !== named.dev || opened.ino !== named.ino || named.nlink > 1n) return null

    const size = opened.size > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(opened.size)
    const mode = opened.mode & 0o111n ? 0o100755 : 0o100644
    if (opened.size > BigInt(maxBytes)) return { buffer: null, size, mode }

    const buffer = Buffer.alloc(size)
    let totalRead = 0
    while (totalRead < buffer.length) {
      const { bytesRead } = await handle.read(buffer, totalRead, buffer.length - totalRead, totalRead)
      if (bytesRead === 0) return null
      totalRead += bytesRead
    }
    return { buffer, size, mode }
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0)
}

function capUtf8Text(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return { text, truncated: false }
  let end = maxBytes
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

function capText(text: string): { text: string; truncated: boolean } {
  return capUtf8Text(text, MAX_DIFF_BYTES)
}

/**
 * Both sides of one working-tree file.
 *
 * The review tab builds a line diff from these, so it can reuse the renderer
 * the thread already uses for tool edits. Keeping it to two strings also means
 * the diff looks the same whether the change came from Pi or from an editor.
 */
export async function readFileDiff(root: string, filePath: string): Promise<GitFileDiff> {
  const blank: GitFileDiff = {
    path: filePath,
    status: '',
    untracked: false,
    oldText: '',
    newText: '',
    binary: false,
    truncated: false
  }
  if (!root || !filePath) return { ...blank, error: 'No file was given.' }
  const target = insideWorkTree(root, filePath)
  if (!target) return { ...blank, error: 'The file is outside the project.' }

  const status = await gitLiteralPathspecs(root, ['status', '--porcelain=v1', '-z', '--', filePath])
  let entry = parsePorcelain(status.stdout)[0]
  // A pathspec can turn a staged rename into an addition. Resolve that
  // ambiguous status against the whole tree before reading the old side.
  if (entry?.index === 'A' && !entry.oldPath) {
    const wholeStatus = await git(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z'])
    entry = parsePorcelain(wholeStatus.stdout).find((file) => file.path === filePath) ?? entry
  }
  const letters = entry ? `${entry.index}${entry.worktree}` : ' M'
  const untracked = entry?.untracked ?? letters === '??'
  // A renamed file's old content lives under the old path in HEAD.
  const oldPath = entry?.oldPath ?? filePath

  // The old side comes from HEAD; a file that was never committed has none.
  let oldText = ''
  let oldTruncated = false
  let binary = false
  if (!untracked) {
    const shown = await git(root, ['show', `HEAD:${oldPath.replace(/\\/g, '/')}`])
    if (shown.code === 0) {
      if (shown.stdout.includes('\u0000')) {
        binary = true
      } else {
        const capped = capText(shown.stdout)
        oldText = capped.text
        oldTruncated = capped.truncated
      }
    }
  }

  // The new side comes from disk; a deleted file has none.
  let newText = ''
  let newTruncated = false
  const working = await readWorktreeFile(root, filePath, MAX_DIFF_FILE_BYTES)
  if (working) {
    if (working.size > MAX_DIFF_FILE_BYTES) {
      binary = true
    } else if (working.buffer) {
      const buffer = working.buffer
      if (looksBinary(buffer)) {
        binary = true
      } else {
        const capped = capText(buffer.toString('utf8'))
        newText = capped.text
        newTruncated = capped.truncated
      }
    }
  }

  if (binary) {
    oldText = ''
    newText = ''
  }
  return {
    path: filePath,
    status: letters,
    untracked,
    oldText,
    newText,
    binary,
    truncated: oldTruncated || newTruncated
  }
}

/** Build a new-file patch for a file git does not track yet. */
function untrackedPatch(
  relative: string,
  content: string,
  truncated: boolean,
  mode: number,
  emptyBlobHash?: string
): string {
  const clean = relative.replace(/\\/g, '/')
  const hasFinalNewline = content.endsWith('\n')
  const lines = content ? content.split('\n') : []
  if (hasFinalNewline) lines.pop()
  const body = lines.map((line) => `+${line}`).join('\n')
  const modeLine = `new file mode ${mode.toString(8)}\n`
  const indexLine = lines.length === 0 && emptyBlobHash
    ? `index 0000000..${emptyBlobHash.slice(0, 7)}\n`
    : ''
  const header = `diff --git a/${clean} b/${clean}\n${modeLine}${indexLine}--- /dev/null\n+++ b/${clean}\n`
  if (lines.length === 0) return header

  const marker = !truncated && !hasFinalNewline
    ? '\n\\ No newline at end of file'
    : ''
  return `${header}@@ -0,0 +1,${lines.length} @@\n${body}${marker}\n`
}

/**
 * A unified patch of the working tree against HEAD.
 *
 * `git diff HEAD` covers staged and unstaged changes at once, which is what a
 * reviewer wants to copy out; untracked files are appended by hand because git
 * does not diff them without being told to add them first.
 */
export async function readPatch(root: string, filePath?: string): Promise<GitPatch> {
  if (!root) return { text: '', truncated: false }

  const args = ['-c', 'core.quotepath=false', 'diff', 'HEAD', '--no-color', '--no-ext-diff']
  if (filePath) args.push('--', filePath)
  const statusArgs = ['status', '--porcelain=v1', '--untracked-files=all', '-z']
  if (filePath) statusArgs.push('--', filePath)

  const [diff, statusOut] = await Promise.all([
    filePath
      ? gitLiteralPathspecs(root, args, COMMIT_TIMEOUT_MS)
      : git(root, args, COMMIT_TIMEOUT_MS),
    filePath
      ? gitLiteralPathspecs(root, statusArgs)
      : git(root, statusArgs)
  ])
  const cappedDiff = capUtf8Text(diff.code === 0 ? diff.stdout : '', MAX_PATCH_BYTES)
  let text = cappedDiff.text
  let truncated = cappedDiff.truncated

  const untracked = (statusOut.code === 0 ? parsePorcelain(statusOut.stdout) : []).filter(
    (file) => file.untracked && (!filePath || file.path === filePath)
  )
  let textBytes = Buffer.byteLength(text, 'utf8')
  for (const file of untracked) {
    const remainingBytes = MAX_PATCH_BYTES - textBytes
    if (remainingBytes <= 0) {
      truncated = true
      break
    }
    const clean = file.path.replace(/\\/g, '/')
    const working = await readWorktreeFile(root, file.path, Math.min(MAX_PATCH_BYTES, remainingBytes))
    if (!working) continue
    if (working.size > MAX_PATCH_BYTES || (working.buffer && looksBinary(working.buffer))) {
      const summary = `diff --git a/${clean} b/${clean}\nnew file mode ${working.mode.toString(8)}\nBinary files /dev/null and b/${clean} differ\n`
      const summaryBytes = Buffer.byteLength(summary, 'utf8')
      if (summaryBytes > remainingBytes) {
        truncated = true
        break
      }
      text += summary
      textBytes += summaryBytes
      continue
    }
    const buffer = working.buffer
    if (!buffer) {
      // The file fits the per-file limit but not the remaining patch budget.
      truncated = true
      break
    }
    const capped = capText(buffer.toString('utf8'))
    let emptyBlobHash: string | undefined
    if (buffer.length === 0) {
      const format = await git(root, ['rev-parse', '--show-object-format'])
      const algorithm = format.code === 0 && format.stdout.trim() === 'sha256' ? 'sha256' : 'sha1'
      emptyBlobHash = createHash(algorithm).update('blob 0\0').digest('hex')
    }
    const patch = untrackedPatch(file.path, capped.text, capped.truncated, working.mode, emptyBlobHash)
    const patchBytes = Buffer.byteLength(patch, 'utf8')
    if (patchBytes > remainingBytes) {
      truncated = true
      break
    }
    text += patch
    textBytes += patchBytes
    truncated = truncated || capped.truncated
  }

  const cappedPatch = capUtf8Text(text, MAX_PATCH_BYTES)
  return { text: cappedPatch.text, truncated: truncated || cappedPatch.truncated }
}

/** Hashes arrive from a dialog; keep whatever runs in git to hex. */
function isHash(value: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(value)
}

/** Parse `git show --name-status` (rename-aware) by the new path. */
function parseNameStatus(raw: string): Map<string, { status: string; oldPath?: string }> {
  const map = new Map<string, { status: string; oldPath?: string }>()
  const fields = raw.split('\0')
  for (let index = 0; index < fields.length;) {
    const code = fields[index++] ?? ''
    if (!code) continue
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = fields[index++]
      const newPath = fields[index++]
      if (!newPath) continue
      map.set(newPath, { status: code[0] ?? 'M', oldPath })
      continue
    }
    const target = fields[index++]
    if (target) map.set(target, { status: code[0] ?? 'M' })
  }
  return map
}

/**
 * Parse `git show --numstat --format= -M -z`.
 *
 * A rename is split over three NUL fields (`added\tremoved\t`, old path, new
 * path), so the loop steps over the pair instead of treating it as two files.
 */
function parseNumstatZ(raw: string): GitCommitFile[] {
  const files: GitCommitFile[] = []
  const fields = raw.split('\0')
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field) continue
    const firstTab = field.indexOf('\t')
    const secondTab = field.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) continue
    const addedRaw = field.slice(0, firstTab)
    const removedRaw = field.slice(firstTab + 1, secondTab)
    let path = field.slice(secondTab + 1)
    let oldPath: string | undefined
    if (!path && index + 2 < fields.length) {
      oldPath = fields[index + 1]
      path = fields[index + 2]
      index += 2
    }
    if (!path) continue
    const binary = addedRaw === '-' || removedRaw === '-'
    files.push({
      path,
      oldPath,
      status: oldPath ? 'R' : 'M',
      added: binary ? 0 : Number(addedRaw) || 0,
      removed: binary ? 0 : Number(removedRaw) || 0,
      binary
    })
  }
  return files
}

/** Metadata, file list and patch of one commit. */
export async function readCommitDetail(
  root: string,
  hash: string
): Promise<GitCommitDetail | null> {
  if (!root || !isHash(hash)) return null

  const [metaAndStatus, numstat, shown] = await Promise.all([
    git(
      root,
      [
        '-c',
        'core.quotepath=false',
        'show',
        '--format=%H%x1f%s%x1f%an%x1f%at%x1f%P%x1f%b%x00',
        '--name-status',
        '-M',
        '-z',
        hash
      ],
      COMMIT_TIMEOUT_MS
    ),
    git(root, ['show', '--numstat', '--format=', '-M', '-z', hash], COMMIT_TIMEOUT_MS),
    git(root, ['show', '--no-color', '--format=', '-M', hash], COMMIT_TIMEOUT_MS)
  ])
  if (metaAndStatus.code !== 0 || !metaAndStatus.stdout.trim()) return null

  const firstNull = metaAndStatus.stdout.indexOf('\0')
  const metaText = firstNull === -1 ? metaAndStatus.stdout : metaAndStatus.stdout.slice(0, firstNull)
  const nameStatusRaw = firstNull === -1
    ? ''
    : metaAndStatus.stdout.slice(firstNull + 1).replace(/^\0*[\r\n]*/, '')

  const parts = metaText.split('\u001f')
  const fullHash = parts[0]?.trim() ?? hash
  const subject = parts[1] ?? ''
  const author = parts[2] ?? ''
  const seconds = Number(parts[3]) || 0
  const parentHash = parts[4]?.trim().split(' ')[0] || undefined
  const body = parts.slice(5).join('\u001f').trim()

  const statuses = parseNameStatus(nameStatusRaw)
  const files = parseNumstatZ(numstat.stdout).map((file) => {
    const known = statuses.get(file.path)
    return {
      ...file,
      oldPath: known?.oldPath ?? file.oldPath,
      status: known?.status ?? file.status
    }
  })

  const cappedPatch = capUtf8Text(shown.code === 0 ? shown.stdout : '', MAX_PATCH_BYTES)
  const patch = cappedPatch.text
  const truncated = cappedPatch.truncated

  return {
    hash: fullHash,
    parentHash,
    subject,
    author,
    date: seconds * 1000,
    body,
    files,
    patch,
    truncated
  }
}

/** Both sides of one file as they were in one commit. */
async function commitSides(
  root: string,
  hash: string,
  filePath: string,
  against: 'parent' | 'worktree'
): Promise<GitCommitFileDiff | null> {
  if (!root || !isHash(hash) || !filePath) return null
  const posix = filePath.replace(/\\/g, '/')

  // A pathspec would make git call the rename an addition (the old path is not
  // in the pathspec), so the whole commit's name-status is read instead.
  const nameStatus = await git(root, ['-c', 'core.quotepath=false', 'show', '--name-status', '--format=', '-M', '-z', hash])
  const entry = parseNameStatus(nameStatus.stdout).get(filePath)
  const oldPath = (entry?.oldPath ?? filePath).replace(/\\/g, '/')

  const showSide = async (revision: string): Promise<string> => {
    const shown = await git(root, ['show', revision])
    return shown.code === 0 ? shown.stdout : ''
  }

  let oldRaw = ''
  let newRaw = ''
  if (against === 'parent') {
    const parent = await git(root, ['rev-parse', '--verify', `${hash}^`])
    if (parent.code === 0) oldRaw = await showSide(`${hash}^:${oldPath}`)
    newRaw = await showSide(`${hash}:${posix}`)
  } else {
    // Commit → working tree: the commit is the old side, the disk the new one.
    oldRaw = await showSide(`${hash}:${oldPath}`)
    const working = await readWorktreeFile(root, filePath, MAX_DIFF_FILE_BYTES)
    if (working?.size && working.size > MAX_DIFF_FILE_BYTES) {
      newRaw = '\u0000'
      oldRaw = `${oldRaw}\u0000`
    } else if (working?.buffer) {
      newRaw = working.buffer.toString('utf8')
      if (looksBinary(working.buffer)) oldRaw = `${oldRaw}\u0000`
    }
  }

  const binary = oldRaw.includes('\u0000') || newRaw.includes('\u0000')
  const oldCapped = binary ? { text: '', truncated: false } : capText(oldRaw)
  const newCapped = binary ? { text: '', truncated: false } : capText(newRaw)

  return {
    path: filePath,
    oldText: oldCapped.text,
    newText: newCapped.text,
    binary,
    truncated: oldCapped.truncated || newCapped.truncated
  }
}

/** Both sides of one file as they were between a commit's parent and the commit. */
export function readCommitFileDiff(
  root: string,
  hash: string,
  filePath: string
): Promise<GitCommitFileDiff | null> {
  return commitSides(root, hash, filePath, 'parent')
}

/** Both sides of one file between a commit and the file on disk. */
export function readCommitWorktreeDiff(
  root: string,
  hash: string,
  filePath: string
): Promise<GitCommitFileDiff | null> {
  return commitSides(root, hash, filePath, 'worktree')
}

/** A branch name we are willing to hand to git as a value (not an option). */
function cleanBranch(value: string): string | null {
  const name = value.trim()
  if (!name || name.length > 240 || name.startsWith('-')) return null
  return name
}

/** Apply a unified patch to the working tree, optionally in reverse. */
export async function applyPatch(
  root: string,
  patch: string,
  reverse = false
): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    return { ok: false, error: 'The patch is too large to apply.' }
  }
  const trimmed = patch.trim()
  if (!trimmed.startsWith('diff --git ')) {
    return { ok: false, error: 'That does not look like a patch.' }
  }

  return withGitMutation(root, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pi-desktop-patch-'))
    const file = path.join(dir, 'change.patch')
    try {
      // The body is written as it came: trailing spaces and an empty last
      // context line are part of the patch, even though the prefix check used
      // a trimmed copy.
      writeFileSync(file, patch.endsWith('\n') ? patch : `${patch}\n`, 'utf8')
      const args = ['apply', '--whitespace=nowarn']
      if (reverse) args.push('--reverse')
      args.push(file)
      const result = await git(root, args, COMMIT_TIMEOUT_MS)
      if (result.code !== 0) {
        return {
          ok: false,
          error: cleanError(result.stderr) || cleanError(result.stdout) || 'git apply failed.'
        }
      }
      return { ok: true }
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* a temp directory that cannot be removed is not worth an error */
      }
    }
  })
}

/** Local branches and worktrees of the open repository. */
export async function readBranches(root: string): Promise<GitBranches> {
  const empty: GitBranches = { isRepo: false, detached: false, branches: [], worktrees: [] }
  if (!root) return empty
  const key = repoCacheKey(root)
  const existing = inFlightBranches.get(key)
  if (existing) return existing

  const startGeneration = gitWriteGenerations.get(key) ?? 0
  const task = (async (): Promise<GitBranches> => {
    const [topLevelOut, currentOut, refs, worktreesOut] = await Promise.all([
      git(root, ['rev-parse', '--show-toplevel']),
      git(root, ['branch', '--show-current']),
      git(root, [
        'for-each-ref',
        // for-each-ref does not understand %x1f; a literal tab is the separator
        // it can carry through every git version.
        '--format=%(refname:short)\t%(upstream:short)\t%(objectname:short)\t%(contents:subject)',
        'refs/heads'
      ]),
      git(root, ['worktree', 'list', '--porcelain'])
    ])
    if (topLevelOut.code !== 0) {
      return empty
    }
    const failed = [currentOut, refs, worktreesOut].find((result) => result.code !== 0)
    if (failed) {
      throw new Error(cleanError(failed.stderr) || 'Could not read branches and worktrees.')
    }

    const currentRoot = path.resolve(topLevelOut.stdout.trim() || root)
    const current = currentOut.stdout.trim() || undefined
    const branches: GitBranch[] = refs.stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const [name = '', upstream = '', tip = '', ...subjectParts] = line.split('\t')
        return {
          name,
          current: name === current,
          tip: tip || undefined,
          subject: subjectParts.join('\t') || undefined,
          upstream: upstream || undefined
        }
      })
      .filter((branch) => branch.name)
      .sort((a, b) => a.name.localeCompare(b.name))

    const worktrees: GitWorktree[] = []
    let block: { path?: string; branch?: string; bare?: boolean } = {}
    const flush = () => {
      if (!block.path) return
      worktrees.push({
        path: block.path,
        branch: block.branch,
        bare: block.bare === true,
        current: path.relative(currentRoot, path.resolve(block.path)) === ''
      })
      block = {}
    }
    for (const line of worktreesOut.stdout.split('\n')) {
      if (!line.trim()) {
        flush()
        continue
      }
      const space = line.indexOf(' ')
      const k = space === -1 ? line : line.slice(0, space)
      const value = space === -1 ? '' : line.slice(space + 1)
      if (k === 'worktree') {
        flush()
        block.path = value
      } else if (k === 'branch') {
        block.branch = value.replace(/^refs\/heads\//, '')
      } else if (k === 'bare') {
        block.bare = true
      }
    }
    flush()

    // A worktree is useful only when the menu says whether it has work in it;
    // status per worktree is a handful of processes for a handful of folders.
    await Promise.all(
      worktrees
        .filter((worktree) => !worktree.bare)
        .slice(0, 20)
        .map(async (worktree) => {
          const status = await git(worktree.path, ['status', '--porcelain', '--no-renames', '--untracked-files=all'])
          if (status.code !== 0) return
          const lines = status.stdout.split('\n').filter((line) => line.trim()).length
          worktree.dirty = lines
        })
    )

    return { isRepo: true, current, detached: !current, branches, worktrees }
  })()

  inFlightBranches.set(key, task)
  try {
    const result = await task
    if ((gitWriteGenerations.get(key) ?? 0) !== startGeneration) {
      if (inFlightBranches.get(key) === task) inFlightBranches.delete(key)
      return await readBranches(root)
    }
    return result
  } finally {
    if (inFlightBranches.get(key) === task) inFlightBranches.delete(key)
  }
}

/** Remove a registered worktree, refusing the one the app is looking at. */
export async function removeWorktree(
  root: string,
  target: string,
  withRemoveLock?: (
    resolvedTarget: string,
    remove: () => Promise<GitCommitResult>
  ) => Promise<GitCommitResult>
): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  if (!target) return { ok: false, error: 'No worktree was given.' }
  const resolved = path.resolve(root, target)
  const topLevel = await git(root, ['rev-parse', '--show-toplevel'])
  const currentRoot = path.resolve(topLevel.stdout.trim() || root)

  if (pathContains(resolved, currentRoot)) {
    return { ok: false, error: 'The worktree containing the open project cannot be removed.' }
  }

  const list = await git(root, ['worktree', 'list', '--porcelain'])
  const registered = list.stdout
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => path.resolve(line.slice('worktree '.length)))
  if (!registered.includes(resolved)) {
    return { ok: false, error: 'That folder is not a worktree of this repository.' }
  }

  const remove = async (): Promise<GitCommitResult> => withGitMutation(root, async () => {
    invalidateGitReadCache(resolved)
    try {
      const result = await git(root, ['worktree', 'remove', resolved], COMMIT_TIMEOUT_MS)
      if (result.code !== 0) {
        const detail = cleanError(result.stderr) || cleanError(result.stdout)
        return {
          ok: false,
          error: detail || 'Could not remove the worktree. It may still have uncommitted changes.'
        }
      }
      return { ok: true }
    } finally {
      invalidateGitReadCache(resolved)
    }
  })
  return withRemoveLock ? withRemoveLock(resolved, remove) : remove()
}

/** Check out a local branch. */
export async function switchBranch(root: string, name: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  const branch = cleanBranch(name)
  if (!branch) return { ok: false, error: 'That is not a branch name.' }

  return withGitMutation(root, async () => {
    let result = await git(root, ['switch', branch], COMMIT_TIMEOUT_MS)
    if (result.code !== 0) {
      // Older git or a branch that only exists as a path: checkout understands
      // both, so it is the fallback rather than a second command to maintain.
      result = await git(root, ['checkout', branch], COMMIT_TIMEOUT_MS)
    }
    if (result.code !== 0) {
      return { ok: false, error: cleanError(result.stderr) || 'Could not switch branch.' }
    }
    return { ok: true }
  })
}

/** Create a local branch, checking it out unless `checkout` is false. */
export async function createBranch(
  root: string,
  name: string,
  checkout = true
): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  const branch = cleanBranch(name)
  if (!branch) return { ok: false, error: 'That is not a branch name.' }

  return withGitMutation(root, async () => {
    const format = await git(root, ['check-ref-format', '--branch', branch])
    if (format.code !== 0) return { ok: false, error: 'That is not a valid branch name.' }

    const result = await git(
      root,
      checkout ? ['switch', '-c', branch] : ['branch', branch],
      COMMIT_TIMEOUT_MS
    )
    if (result.code !== 0) {
      return { ok: false, error: cleanError(result.stderr) || 'Could not create the branch.' }
    }
    return { ok: true }
  })
}

/**
 * Add a worktree next to the repository.
 *
 * A worktree without its own branch would have to check out a branch that is
 * already checked out here, which git refuses; so the common case — create a
 * new branch for the worktree — is the default. An empty path means a sibling
 * folder named after the repository and the branch.
 */
export async function addWorktree(
  root: string,
  rawPath: string,
  rawBranch: string,
  create = true
): Promise<GitWorktreeResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  const branch = cleanBranch(rawBranch)
  if (!branch) return { ok: false, error: 'That is not a branch name.' }
  const format = await git(root, ['check-ref-format', '--branch', branch])
  if (format.code !== 0) return { ok: false, error: 'That is not a valid branch name.' }

  const parent = path.dirname(path.resolve(root))
  const suggested = `${path.basename(root)}-${branch.replace(/[^A-Za-z0-9._-]+/g, '-')}`
  const target = rawPath.trim()
    ? path.isAbsolute(rawPath.trim())
      ? path.resolve(rawPath.trim())
      : path.resolve(root, rawPath.trim())
    : path.join(parent, suggested)

  if (insideWorkTree(root, target)) {
    return { ok: false, error: 'The worktree has to be outside the project folder.' }
  }

  return withGitMutation(root, async () => {
    const args = ['worktree', 'add']
    if (create) args.push('-b', branch)
    args.push(target)
    if (!create) args.push(branch)

    const result = await git(root, args, COMMIT_TIMEOUT_MS)
    if (result.code !== 0) {
      return { ok: false, error: cleanError(result.stderr) || 'Could not add the worktree.' }
    }
    return { ok: true, path: target, branch }
  })
}

/**
 * Discard the working-tree changes of one tracked file.
 *
 * Restoring from HEAD also unstages the file, which is what "revert" means
 * here. A file that was never committed is left alone — deleting it is the
 * user's decision, not a diff button's.
 */
export async function revertFile(root: string, filePath: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  return withGitMutation(root, async () => {
    const [statusOut, head] = await Promise.all([
      gitLiteralPathspecs(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z', '--', filePath]),
      git(root, ['rev-parse', '--verify', 'HEAD'])
    ])
    if (statusOut.code !== 0) return { ok: false, error: 'This folder is not a git repository.' }
    const file = parsePorcelain(statusOut.stdout).find((entry) => entry.path === filePath)
    if (!file) return { ok: false, error: 'That file has no uncommitted changes.' }
    if (file.untracked) {
      return { ok: false, error: 'A new file is not reverted; delete it if you do not want it.' }
    }
    if (head.code !== 0) return { ok: false, error: 'The repository has no commit to go back to.' }

    const result = await gitLiteralPathspecs(root, ['checkout', 'HEAD', '--', filePath], COMMIT_TIMEOUT_MS)
    if (result.code !== 0) {
      return { ok: false, error: cleanError(result.stderr) || 'git checkout failed.' }
    }
    return { ok: true }
  })
}

/** Push the current branch to its upstream remote, setting `-u origin HEAD` when no upstream is configured. */
export async function pushBranch(root: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  return withGitMutation(root, async () => {
    const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    const args = upstream.code === 0 && upstream.stdout.trim() ? ['push'] : ['push', '-u', 'origin', 'HEAD']
    const result = await git(root, args, COMMIT_TIMEOUT_MS)
    if (result.code !== 0) {
      return {
        ok: false,
        error: cleanError(result.stderr) || cleanError(result.stdout) || 'git push failed.'
      }
    }
    return { ok: true }
  })
}

/** Pull the latest changes from the upstream remote. */
export async function pullBranch(root: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  return withGitMutation(root, async () => {
    const result = await git(root, ['pull'], COMMIT_TIMEOUT_MS)
    if (result.code !== 0) {
      return {
        ok: false,
        error: cleanError(result.stderr) || cleanError(result.stdout) || 'git pull failed.'
      }
    }
    return { ok: true }
  })
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * A rename or copy carries the original path as a second NUL-delimited field,
 * so the parser has to step over it rather than treat it as another entry.
 */
function parsePorcelain(raw: string): GitFileStatus[] {
  if (!raw) return []
  const fields = raw.split('\0')
  const files: GitFileStatus[] = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field || field.length < 4) continue
    const indexStatus = field[0] ?? ' '
    const worktreeStatus = field[1] ?? ' '
    const filePath = field.slice(3)
    let oldPath: string | undefined
    if (indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C') {
      oldPath = fields[index + 1]
      index += 1
    }
    const untracked = indexStatus === '?' && worktreeStatus === '?'
    files.push({
      path: filePath,
      oldPath,
      index: indexStatus,
      worktree: worktreeStatus,
      staged: !untracked && indexStatus !== ' ' && indexStatus !== '?',
      untracked
    })
  }
  return files
}

/** Parse `git diff --numstat -z` into per-path added/removed counts. */
async function lineCounts(root: string, args: string[]): Promise<Map<string, { added: number; removed: number }>> {
  const result = await git(root, args)
  const counts = new Map<string, { added: number; removed: number }>()
  if (result.code !== 0) return counts
  for (const file of parseNumstatZ(result.stdout)) {
    counts.set(file.path, { added: file.added, removed: file.removed })
  }
  return counts
}

/**
 * Count the lines of the untracked files.
 *
 * `git diff --numstat` ignores them, but the review panel wants to say how
 * much a new file brings in. Files are read with a ceiling so a stray binary
 * cannot stall the status call.
 */
async function countUntracked(root: string, files: GitFileStatus[]): Promise<void> {
  const pending = files.filter((file) => file.untracked).slice(0, MAX_UNTRACKED_STATS)
  await Promise.all(
    pending.map(async (file) => {
      try {
        const working = await readWorktreeFile(root, file.path, MAX_UNTRACKED_BYTES)
        if (!working) return
        if (working.size > MAX_UNTRACKED_BYTES) {
          file.added = 1
          file.removed = 0
          return
        }
        if (!working.buffer) return
        const content = working.buffer.toString('utf8')
        const lines = content.split('\n')
        file.added = Math.max(0, lines.length - (content.endsWith('\n') ? 1 : 0))
        file.removed = 0
      } catch {
        /* a binary or a file that vanished is simply shown without a count */
      }
    })
  )
}

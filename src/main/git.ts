import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import type {
  GitCommit,
  GitCommitDetail,
  GitCommitFile,
  GitCommitFileDiff,
  GitCommitResult,
  GitFileDiff,
  GitFileStatus,
  GitPatch,
  GitStatus
} from '@shared/types'

const run = promisify(execFile)

const STATUS_TIMEOUT_MS = 10_000
const COMMIT_TIMEOUT_MS = 120_000
/** Untracked files larger than this are counted as one line instead of read. */
const MAX_UNTRACKED_BYTES = 512 * 1024
const MAX_UNTRACKED_STATS = 60
/** How much of either side of a review diff is sent to the renderer. */
const MAX_DIFF_BYTES = 512 * 1024
/** How much of a patch is sent to the renderer. */
const MAX_PATCH_BYTES = 1024 * 1024

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

/** Read the working tree of `root` the way the review panel needs it. */
export async function readStatus(root: string): Promise<GitStatus> {
  if (!root) return { ...NO_REPOSITORY }

  const inside = await git(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { ...NO_REPOSITORY }

  const [topLevel, branchName, head, porcelain, upstream] = await Promise.all([
    git(root, ['rev-parse', '--show-toplevel']),
    git(root, ['branch', '--show-current']),
    git(root, ['rev-parse', '--short', 'HEAD']),
    git(root, ['status', '--porcelain=v1', '--untracked-files=all', '-z']),
    git(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])
  ])

  const files = parsePorcelain(porcelain.stdout)
  const counts = await Promise.all([
    lineCounts(root, ['diff', '--numstat']),
    lineCounts(root, ['diff', '--cached', '--numstat'])
  ])
  const stats = new Map([...counts[0], ...counts[1]])
  for (const file of files) {
    const known = stats.get(file.path)
    if (known) {
      file.added = known.added
      file.removed = known.removed
    }
  }
  await countUntracked(root, files)

  let ahead = 0
  let behind = 0
  if (upstream.code === 0 && upstream.stdout.trim()) {
    const [behindRaw, aheadRaw] = upstream.stdout.trim().split(/\s+/)
    behind = Number(behindRaw) || 0
    ahead = Number(aheadRaw) || 0
  }

  const branch = branchName.stdout.trim() || undefined
  return {
    isRepo: true,
    root: topLevel.stdout.trim() || root,
    branch,
    head: head.code === 0 ? head.stdout.trim() || undefined : undefined,
    detached: !branch,
    ahead,
    behind,
    files,
    staged: files.filter((file) => file.staged).length,
    unstaged: files.filter((file) => !file.staged).length,
    clean: files.length === 0
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

/** Stage everything in the work tree and commit it. */
export async function commitWorkingTree(
  root: string,
  message: string,
  includeUnstaged = false
): Promise<GitCommitResult> {
  const trimmed = message.trim()
  if (!root) return { ok: false, error: 'No project is open.' }
  if (!trimmed) return { ok: false, error: 'Write a message for the commit first.' }

  const status = await readStatus(root)
  if (!status.isRepo) return { ok: false, error: 'This folder is not a git repository.' }
  if (status.clean) return { ok: false, error: 'There is nothing to commit.' }

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

  const stagedFiles = await git(root, ['diff', '--cached', '--name-only'])
  const count = stagedFiles.code === 0 ? stagedFiles.stdout.split('\n').filter(Boolean).length : 0

  const committed = await git(root, ['commit', '-m', trimmed], COMMIT_TIMEOUT_MS)
  if (committed.code !== 0) {
    const detail = cleanError(committed.stderr) || cleanError(committed.stdout)
    return { ok: false, error: detail || 'git commit failed.' }
  }

  const head = await git(root, ['rev-parse', '--short', 'HEAD'])
  return {
    ok: true,
    hash: head.code === 0 ? head.stdout.trim() || undefined : undefined,
    files: count || status.files.length
  }
}

/** Move one file into the index. Deleted and new files go in as well. */
export async function stageFile(root: string, filePath: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  if (!filePath) return { ok: false, error: 'No file was given.' }
  const result = await git(root, ['add', '-A', '--', filePath], COMMIT_TIMEOUT_MS)
  if (result.code !== 0) {
    return { ok: false, error: cleanError(result.stderr) || 'git add failed.' }
  }
  return { ok: true }
}

/** Move one file out of the index, keeping its working-tree changes. */
export async function unstageFile(root: string, filePath: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  if (!filePath) return { ok: false, error: 'No file was given.' }
  // `restore --staged` needs a HEAD; a repository without a commit has to
  // fall back to removing the entry from the index instead.
  let result = await git(root, ['restore', '--staged', '--', filePath], COMMIT_TIMEOUT_MS)
  if (result.code !== 0) {
    result = await git(root, ['reset', '-q', 'HEAD', '--', filePath], COMMIT_TIMEOUT_MS)
  }
  if (result.code !== 0) {
    result = await git(root, ['rm', '--cached', '-q', '--', filePath], COMMIT_TIMEOUT_MS)
  }
  if (result.code !== 0) {
    return { ok: false, error: cleanError(result.stderr) || 'git restore failed.' }
  }
  return { ok: true }
}

export async function stageAll(root: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  const result = await git(root, ['add', '-A'], COMMIT_TIMEOUT_MS)
  if (result.code !== 0) return { ok: false, error: cleanError(result.stderr) || 'git add failed.' }
  return { ok: true }
}

export async function unstageAll(root: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  let result = await git(root, ['reset', '-q'], COMMIT_TIMEOUT_MS)
  if (result.code !== 0) {
    result = await git(root, ['rm', '-r', '--cached', '-q', '.'], COMMIT_TIMEOUT_MS)
  }
  if (result.code !== 0) {
    return { ok: false, error: cleanError(result.stderr) || 'git reset failed.' }
  }
  return { ok: true }
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
  if (relation.startsWith('..') || path.isAbsolute(relation)) return null
  return target
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0)
}

function capText(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= MAX_DIFF_BYTES) return { text, truncated: false }
  return { text: text.slice(0, MAX_DIFF_BYTES), truncated: true }
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

  const status = await git(root, ['status', '--porcelain=v1', '-z', '--', filePath])
  const entry = parsePorcelain(status.stdout)[0]
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
  try {
    const buffer = await readFile(target)
    if (looksBinary(buffer)) {
      binary = true
    } else {
      const capped = capText(buffer.toString('utf8'))
      newText = capped.text
      newTruncated = capped.truncated
    }
  } catch {
    /* a deleted or unreadable file only has the old side */
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
function untrackedPatch(relative: string, content: string, truncated: boolean): string {
  const clean = relative.replace(/\\/g, '/')
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const body = lines.map((line) => `+${line}`).join('\n')
  const marker = truncated ? '\n\\ No newline at end of file' : ''
  return `diff --git a/${clean} b/${clean}\nnew file mode 100644\n--- /dev/null\n+++ b/${clean}\n@@ -0,0 +1,${lines.length} @@\n${body}${marker}\n`
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
  const diff = await git(root, args, COMMIT_TIMEOUT_MS)
  let text = diff.code === 0 ? diff.stdout : ''
  let truncated = false
  if (text.length > MAX_PATCH_BYTES) {
    text = text.slice(0, MAX_PATCH_BYTES)
    truncated = true
  }

  const status = await readStatus(root)
  const untracked = status.files.filter(
    (file) => file.untracked && (!filePath || file.path === filePath)
  )
  for (const file of untracked) {
    const target = insideWorkTree(root, file.path)
    if (!target) continue
    const clean = file.path.replace(/\\/g, '/')
    try {
      const buffer = await readFile(target)
      if (looksBinary(buffer)) {
        text += `diff --git a/${clean} b/${clean}\nnew file mode 100644\nBinary files /dev/null and b/${clean} differ\n`
        continue
      }
      const capped = capText(buffer.toString('utf8'))
      text += untrackedPatch(file.path, capped.text, capped.truncated)
      truncated = truncated || capped.truncated
    } catch {
      /* a file that vanished has nothing to add */
    }
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_PATCH_BYTES) {
    text = text.slice(0, MAX_PATCH_BYTES)
    truncated = true
  }
  return { text, truncated }
}

/** Hashes arrive from a dialog; keep whatever runs in git to hex. */
function isHash(value: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(value)
}

/** Parse `git show --name-status` (rename-aware) by the new path. */
function parseNameStatus(raw: string): Map<string, { status: string; oldPath?: string }> {
  const map = new Map<string, { status: string; oldPath?: string }>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = parts[0]?.trim() ?? ''
    if (!code) continue
    if (code.startsWith('R') || code.startsWith('C')) {
      const oldPath = parts[1]
      const newPath = parts[2]
      if (!newPath) continue
      map.set(newPath, { status: code[0] ?? 'M', oldPath })
      continue
    }
    const target = parts[1]
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
    const [addedRaw = '', removedRaw = '', third = ''] = field.split('\t')
    let path = third
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

  const meta = await git(root, ['show', '-s', '--format=%H%x1f%s%x1f%an%x1f%at%x1f%b', hash])
  if (meta.code !== 0 || !meta.stdout.trim()) return null
  const parts = meta.stdout.split('\u001f')
  const fullHash = parts[0]?.trim() ?? hash
  const subject = parts[1] ?? ''
  const author = parts[2] ?? ''
  const seconds = Number(parts[3]) || 0
  const body = parts.slice(4).join('\u001f').trim()

  const [numstat, nameStatus, shown] = await Promise.all([
    git(root, ['show', '--numstat', '--format=', '-M', '-z', hash], COMMIT_TIMEOUT_MS),
    git(root, ['show', '--name-status', '--format=', '-M', hash], COMMIT_TIMEOUT_MS),
    git(root, ['show', '--no-color', '--format=', '-M', hash], COMMIT_TIMEOUT_MS)
  ])

  const statuses = parseNameStatus(nameStatus.stdout)
  const files = parseNumstatZ(numstat.stdout).map((file) => {
    const known = statuses.get(file.path)
    return {
      ...file,
      oldPath: known?.oldPath ?? file.oldPath,
      status: known?.status ?? file.status
    }
  })

  let patch = shown.code === 0 ? shown.stdout : ''
  let truncated = false
  if (patch.length > MAX_PATCH_BYTES) {
    patch = patch.slice(0, MAX_PATCH_BYTES)
    truncated = true
  }

  return {
    hash: fullHash,
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
export async function readCommitFileDiff(
  root: string,
  hash: string,
  filePath: string
): Promise<GitCommitFileDiff | null> {
  if (!root || !isHash(hash) || !filePath) return null
  const posix = filePath.replace(/\\/g, '/')

  // A pathspec would make git call the rename an addition (the old path is not
  // in the pathspec), so the whole commit's name-status is read instead.
  const nameStatus = await git(root, ['show', '--name-status', '--format=', '-M', hash])
  const entry = parseNameStatus(nameStatus.stdout).get(filePath)
  const oldPath = (entry?.oldPath ?? filePath).replace(/\\/g, '/')

  const [newSide, parent] = await Promise.all([
    git(root, ['show', `${hash}:${posix}`]),
    git(root, ['rev-parse', '--verify', `${hash}^`])
  ])
  let oldRaw = ''
  if (parent.code === 0) {
    const oldSide = await git(root, ['show', `${hash}^:${oldPath}`])
    if (oldSide.code === 0) oldRaw = oldSide.stdout
  }
  const newRaw = newSide.code === 0 ? newSide.stdout : ''

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

/**
 * Discard the working-tree changes of one tracked file.
 *
 * Restoring from HEAD also unstages the file, which is what "revert" means
 * here. A file that was never committed is left alone — deleting it is the
 * user's decision, not a diff button's.
 */
export async function revertFile(root: string, filePath: string): Promise<GitCommitResult> {
  if (!root) return { ok: false, error: 'No project is open.' }
  const status = await readStatus(root)
  if (!status.isRepo) return { ok: false, error: 'This folder is not a git repository.' }
  const file = status.files.find((entry) => entry.path === filePath)
  if (!file) return { ok: false, error: 'That file has no uncommitted changes.' }
  if (file.untracked) {
    return { ok: false, error: 'A new file is not reverted; delete it if you do not want it.' }
  }
  const head = await git(root, ['rev-parse', '--verify', 'HEAD'])
  if (head.code !== 0) return { ok: false, error: 'The repository has no commit to go back to.' }

  const result = await git(root, ['checkout', 'HEAD', '--', filePath], COMMIT_TIMEOUT_MS)
  if (result.code !== 0) {
    return { ok: false, error: cleanError(result.stderr) || 'git checkout failed.' }
  }
  return { ok: true }
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

/** Parse `git diff --numstat` into per-path added/removed counts. */
async function lineCounts(root: string, args: string[]): Promise<Map<string, { added: number; removed: number }>> {
  const result = await git(root, args)
  const counts = new Map<string, { added: number; removed: number }>()
  if (result.code !== 0) return counts
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue
    const [addedRaw, removedRaw, ...rest] = line.split('\t')
    const filePath = rest.join('\t')
    if (!filePath) continue
    // A rename is written as "old => new"; the status list already says it
    // was renamed, so the line counts are left to the files it replaced.
    if (filePath.includes('=>')) continue
    const added = Number(addedRaw)
    const removed = Number(removedRaw)
    counts.set(filePath, {
      added: Number.isFinite(added) ? added : 0,
      removed: Number.isFinite(removed) ? removed : 0
    })
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
        const absolute = path.join(root, file.path)
        const content = await readFile(absolute, { encoding: 'utf8', flag: 'r' })
        const limited = content.length > MAX_UNTRACKED_BYTES ? content.slice(0, MAX_UNTRACKED_BYTES) : content
        const lines = limited.split('\n')
        file.added = Math.max(0, lines.length - (limited.endsWith('\n') ? 1 : 0))
        file.removed = 0
      } catch {
        /* a binary or a file that vanished is simply shown without a count */
      }
    })
  )
}

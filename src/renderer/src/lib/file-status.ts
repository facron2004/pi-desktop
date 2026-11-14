import type { GitFileStatus, GitStatus } from '@shared/types'
import { normalisePathKey, relativePath, resolveAgainst } from './path'

/**
 * The change a file wears in the project tree.
 *
 * It is deliberately a *kind*, not git's raw two-letter code: the tree shows
 * one glyph per file, so two codes that read the same to a reader (`M ` and
 * ` M`) must not produce two different marks.
 */
export type FileChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted'

/** Which mark wins when a folder holds several changed files. */
const KIND_PRIORITY: Record<FileChangeKind, number> = {
  conflicted: 5,
  deleted: 4,
  renamed: 3,
  modified: 2,
  added: 1
}

export interface FileChangeEntry {
  /** The absolute path with its real casing, for display. */
  path: string
  kind: FileChangeKind
}

export interface FileChangeIndex {
  /** Lower-case absolute file path → the file's change and its real path. */
  files: Map<string, FileChangeEntry>
  /** Lower-case absolute folder path → the strongest change below it. */
  folders: Map<string, FileChangeKind>
}

const EMPTY_INDEX: FileChangeIndex = { files: new Map(), folders: new Map() }

/**
 * The single mark one porcelain entry deserves.
 *
 * An untracked file is "added": it is new to the repository even though git
 * spells it `??`. A conflict outranks everything because it needs a person.
 */
export function changeKind(file: GitFileStatus): FileChangeKind | undefined {
  if (file.untracked) return 'added'
  const index = file.index ?? ' '
  const worktree = file.worktree ?? ' '
  const codes = `${index}${worktree}`
  if (index === 'U' || worktree === 'U' || codes === 'AA' || codes === 'DD') return 'conflicted'
  if (codes.includes('R') || codes.includes('C')) return 'renamed'
  if (codes.includes('A')) return 'added'
  if (codes.includes('D')) return 'deleted'
  if (codes.includes('M') || codes.includes('T')) return 'modified'
  return undefined
}

/** True when a path is still absolute, i.e. the relative helper could not relate it. */
function looksAbsolute(value: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(value)
}

/**
 * Project the repository status onto the tree's own paths.
 *
 * `git status` reports paths relative to the work-tree root, which is not
 * always the workspace folder: a project can be a subdirectory of a larger
 * repository. Resolving through `git.root` keeps the marks on the right rows,
 * and every ancestor folder gets the strongest change it contains so a folded
 * branch still says it holds work.
 */
export function fileChangeIndex(git: GitStatus | undefined, root: string): FileChangeIndex {
  if (!git?.isRepo || !git.files?.length || !root) return EMPTY_INDEX
  const workTree = git.root || root
  const files = new Map<string, FileChangeEntry>()
  const folders = new Map<string, FileChangeKind>()
  const floor = normalisePathKey(root)

  for (const entry of git.files) {
    const kind = changeKind(entry)
    if (!kind) continue
    const absolute = resolveAgainst(workTree, entry.path)
    const relative = relativePath(root, absolute).replace(/\\/g, '/')
    // A file outside the open folder (the workspace is a subdirectory of the
    // repository) is not a row of this tree.
    if (!relative || looksAbsolute(relative)) continue

    // The tree's own rows are addressed by the absolute paths `fs:list`
    // returns, so the index is keyed the same way.
    files.set(normalisePathKey(absolute), { path: absolute, kind })

    const segments = absolute.replace(/\\/g, '/').split('/')
    segments.pop()
    let current = segments.join('/')
    while (current && normalisePathKey(current).length >= floor.length) {
      const key = normalisePathKey(current)
      const previous = folders.get(key)
      if (!previous || KIND_PRIORITY[kind] > KIND_PRIORITY[previous]) folders.set(key, kind)
      if (key === floor) break
      segments.pop()
      current = segments.join('/')
    }
  }
  return { files, folders }
}

/** The change a row should show, or undefined when the row is clean. */
export function changeFor(
  index: FileChangeIndex,
  path: string,
  kind: 'file' | 'directory'
): FileChangeKind | undefined {
  const key = normalisePathKey(path)
  return kind === 'file' ? index.files.get(key)?.kind : index.folders.get(key)
}

/* ------------------------------------------------------------------ *
 * The changed-files index
 *
 * Codex lists *only* the files that changed, grouped by the folders they
 * live in. That tree is derived from the status alone — no directory walk —
 * so it stays instant however large the project is.
 * ------------------------------------------------------------------ */

export interface ChangedFileNode {
  kind: 'file'
  name: string
  /** Absolute path, the same identity the tree rows use. */
  path: string
  change: FileChangeKind
}

export interface ChangedFolderNode {
  kind: 'folder'
  name: string
  path: string
  change: FileChangeKind
  children: ChangedNode[]
}

export type ChangedNode = ChangedFileNode | ChangedFolderNode

interface MutableFolder {
  name: string
  path: string
  change: FileChangeKind
  folders: Map<string, MutableFolder>
  files: ChangedFileNode[]
}

function folderFor(parent: MutableFolder, name: string, path: string): MutableFolder {
  const key = normalisePathKey(name)
  const existing = parent.folders.get(key)
  if (existing) return existing
  const created: MutableFolder = { name, path, change: 'modified', folders: new Map(), files: [] }
  parent.folders.set(key, created)
  return created
}

function strongest(left: FileChangeKind, right: FileChangeKind): FileChangeKind {
  return KIND_PRIORITY[right] > KIND_PRIORITY[left] ? right : left
}

/** Sort folders before files, then by name, the way a file browser reads. */
function finishFolder(folder: MutableFolder): ChangedNode[] {
  const folders = [...folder.folders.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((child): ChangedFolderNode => ({
      kind: 'folder',
      name: child.name,
      path: child.path,
      change: child.change,
      children: finishFolder(child)
    }))
  const files = folder.files.sort((left, right) => left.name.localeCompare(right.name))
  return [...folders, ...files]
}

/**
 * The changed files as a folder tree.
 *
 * `filter` is a plain case-insensitive substring over the file's relative
 * path, so typing `ipc` keeps `src/main/ipc.ts` and drops the folders that no
 * longer hold a match.
 */
export function changedFileTree(
  index: FileChangeIndex,
  root: string,
  filter = ''
): ChangedNode[] {
  if (!root || index.files.size === 0) return []
  const needle = filter.trim().toLowerCase()
  const rootKey = normalisePathKey(root)
  const base: MutableFolder = { name: '', path: root, change: 'modified', folders: new Map(), files: [] }

  for (const [key, entry] of index.files) {
    if (!key.startsWith(`${rootKey}/`)) continue
    const absolute = entry.path
    const relative = absolute.slice(root.replace(/[\\/]+$/, '').length + 1)
    if (needle && !relative.toLowerCase().includes(needle)) continue
    const segments = relative.split('/')
    const name = segments.pop() ?? relative
    let parent = base
    let path = root.replace(/[\\/]+$/, '')
    for (const segment of segments) {
      path = `${path}/${segment}`
      parent = folderFor(parent, segment, path)
      parent.change = strongest(parent.change, entry.kind)
    }
    parent.files.push({ kind: 'file', name, path: absolute, change: entry.kind })
  }
  return finishFolder(base)
}

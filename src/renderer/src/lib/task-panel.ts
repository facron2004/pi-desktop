import type { GitStatus } from '@shared/types'

/**
 * The task rail reads four things: the Git state of the folder, the background
 * tasks a run started, the plan the agent is working through and the files it
 * produced.
 *
 * Everything here is a projection: the rail keeps no state of its own, so a
 * conversation switch shows the state of whatever is on screen and nothing has
 * to keep two copies of it in step.
 */

/** One file the agent produced, addressed relative to the workspace root. */
export interface DeliverableFile {
  /** Path relative to the workspace root, with `/` separators. */
  path: string
  /** The path the file is opened with — absolute when the agent reported one. */
  target?: string
}

/** One row of the deliverables list. */
export interface Deliverable {
  /** The file name, which is what the row shows. */
  name: string
  /** The path relative to the workspace root, for the tooltip and the click. */
  path: string
  /** The folder — only when another produced file shares this name. */
  dir: string
  /** The path the file is opened with. */
  target?: string
}

/**
 * The produced files as one flat list, in the order the run touched them.
 *
 * The section answers "what did this run make", which is a list of files, not a
 * directory tree. A tree made every folder a row, hung a file one indent per
 * level, and turned an absolute path into a chain of `C:` → `Users` → `Facron`
 * rows — so the path is not shown at all: the name is the row, and the tooltip
 * and the click still carry the whole path. Only a name two files share has to
 * say which one it is, and then the folder earns its place.
 */
export function listDeliverables(files: readonly DeliverableFile[]): Deliverable[] {
  const rows = files.reduce<Deliverable[]>((list, file) => {
    const segments = file.path.split('/').filter(Boolean)
    if (!segments.length) return list
    const name = segments[segments.length - 1]
    // The same file can be written twice; the list shows it once.
    if (list.some((row) => row.path === file.path)) return list
    list.push({
      name,
      dir: segments.length > 1 ? segments.slice(0, -1).join('/') : '',
      path: file.path,
      target: file.target
    })
    return list
  }, [])

  const times = new Map<string, number>()
  for (const row of rows) times.set(row.name, (times.get(row.name) ?? 0) + 1)
  return rows.map((row) => (times.get(row.name) === 1 ? { ...row, dir: '' } : row))
}

/** How much the working tree changed, as the environment row shows it. */
export interface DiffSummary {
  /** Files with changes in the working tree. */
  files: number
  /** Lines added, when git reported them. */
  added: number
  /** Lines removed, when git reported them. */
  removed: number
  /** False when git reported no line counts, so only the file count is known. */
  hasLineStats: boolean
}

/**
 * The line counts of the working tree.
 *
 * Git only counts lines for tracked files, so a tree of new files has a file
 * count and no numbers — the row then says how many files changed instead of
 * claiming zero lines.
 */
export function summariseDiff(git: GitStatus | null | undefined): DiffSummary | null {
  if (!git?.isRepo) return null

  let added = 0
  let removed = 0
  let hasLineStats = false

  for (const file of git.files) {
    if (typeof file.added === 'number' || typeof file.removed === 'number') {
      hasLineStats = true
      added += file.added ?? 0
      removed += file.removed ?? 0
    }
  }

  return { files: git.files.length, added, removed, hasLineStats }
}

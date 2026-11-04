import type { GitStatus } from '@shared/types'

/**
 * The task rail reads four things: the Git state of the folder, the background
 * tasks a run started, the plan the agent is working through and the files it
 * produced.
 *
 * Everything here is a projection. The rail keeps no state of its own beyond
 * which folders of the deliverables tree are open, so a conversation switch
 * shows the state of whatever is on screen and nothing has to keep two copies
 * of it in step.
 */

/** One file the agent produced, addressed relative to the workspace root. */
export interface DeliverableFile {
  /** Path relative to the workspace root, with `/` separators. */
  path: string
  /** The path the file is opened with — absolute when the agent reported one. */
  target?: string
}

export interface DeliverableFolder {
  kind: 'folder'
  name: string
  /** The folder path relative to the workspace root. */
  path: string
  children: DeliverableNode[]
}

export interface DeliverableFileNode {
  kind: 'file'
  name: string
  /** The file path relative to the workspace root. */
  path: string
  /** The folders the file sits in, `/`-joined and empty at the project root. */
  dir: string
  /** The path the file is opened with — absolute when the agent reported one. */
  target?: string
}

export type DeliverableNode = DeliverableFolder | DeliverableFileNode

/** Folders come before files, and both are read in the order of their names. */
function compare(a: DeliverableNode, b: DeliverableNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  return a.name.localeCompare(b.name)
}

function sortTree(nodes: DeliverableNode[]): DeliverableNode[] {
  nodes.sort(compare)
  for (const node of nodes) if (node.kind === 'folder') sortTree(node.children)
  return nodes
}

/**
 * The produced files as a folder tree.
 *
 * A run that wrote ten files into one folder reads as one line instead of ten,
 * which is how the same list is shown elsewhere.
 */
export function buildDeliverableTree(files: readonly DeliverableFile[]): DeliverableNode[] {
  const root: DeliverableFolder = { kind: 'folder', name: '', path: '', children: [] }

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    if (!segments.length) continue

    let folder = root
    for (const segment of segments.slice(0, -1)) {
      const path = folder.path ? `${folder.path}/${segment}` : segment
      const existing = folder.children.find(
        (node): node is DeliverableFolder => node.kind === 'folder' && node.name === segment
      )
      if (existing) {
        folder = existing
        continue
      }
      const child: DeliverableFolder = { kind: 'folder', name: segment, path, children: [] }
      folder.children.push(child)
      folder = child
    }

    const name = segments[segments.length - 1]
    // The same file can be written twice; the tree lists it once.
    if (folder.children.some((node) => node.kind === 'file' && node.name === name)) continue
    folder.children.push({
      kind: 'file',
      name,
      dir: folder.path,
      path: folder.path ? `${folder.path}/${name}` : name,
      target: file.target
    })
  }

  // Unfold first, then sort: a file that came out of a folder belongs with the
  // other files, not in the block of folder rows the sort puts first.
  return sortTree(unwrapSingleFileFolders(root.children))
}

/**
 * A folder that holds one file is not a group: it is that file's path.
 *
 * Folding it into a line of its own saves nothing — the run still reads one
 * line per file — and the lone child sitting one indent step right of the files
 * beside it reads as a row that failed to line up. The file takes the folder's
 * place in the list and carries its folders as a hint on the row instead.
 *
 * A folder with two files or with a subfolder is a real group and stays.
 */
function unwrapSingleFileFolders(nodes: DeliverableNode[]): DeliverableNode[] {
  return nodes.map((node) => {
    if (node.kind === 'file') return node
    const children = unwrapSingleFileFolders(node.children)
    const [only] = children
    return children.length === 1 && only.kind === 'file' ? only : { ...node, children }
  })
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

/**
 * The session as Pi stores it: a tree of entries.
 *
 * This module turns the `get_tree` payload into rows a dialog can draw — what
 * each entry is, which ones are on the branch that is open, and where a new
 * branch could start. It is a projection: nothing here is stored.
 */

export type TreeRole = 'user' | 'assistant' | 'bash' | 'tool' | 'summary' | 'meta'

export interface SessionEntry {
  type: string
  id?: string
  parentId?: string | null
  timestamp?: string
  name?: string
  modelId?: string
  provider?: string
  thinkingLevel?: string
  command?: string
  summary?: string
  label?: string
  message?: {
    role?: string
    content?: unknown
    command?: string
    output?: string
    toolName?: string
    summary?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface SessionTreeNode {
  entry: SessionEntry
  children: SessionTreeNode[]
  label?: string
  labelTimestamp?: string
}

export interface SessionTree {
  roots: SessionTreeNode[]
  leafId: string | null
}

/** One line of the dialog. */
export interface TreeRow {
  id: string
  depth: number
  role: TreeRole
  title: string
  detail?: string
  /** The whole prompt, for a row that can start a branch. */
  prompt?: string
  active: boolean
  leaf: boolean
  hasChildren: boolean
  childrenOpen: boolean
  /** True when this entry is the point where the tree splits. */
  branch: boolean
  label?: string
}

export interface TreeStats {
  entries: number
  branches: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function asEntry(value: unknown): SessionEntry | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  return value as SessionEntry
}

function asNode(value: unknown): SessionTreeNode | null {
  if (!isRecord(value)) return null
  const entry = asEntry(value.entry)
  if (!entry) return null
  const children = Array.isArray(value.children)
    ? value.children
        .map(asNode)
        .filter((child): child is SessionTreeNode => child !== null)
    : []
  return {
    entry,
    children,
    label: typeof value.label === 'string' ? value.label : undefined,
    labelTimestamp: typeof value.labelTimestamp === 'string' ? value.labelTimestamp : undefined
  }
}

/** Turn the `get_tree` response into the shape the dialog uses. */
export function normalizeTree(raw: unknown): SessionTree {
  const data = isRecord(raw) ? raw : {}
  const roots = Array.isArray(data.tree)
    ? data.tree.map(asNode).filter((node): node is SessionTreeNode => node !== null)
    : []
  return { roots, leafId: typeof data.leafId === 'string' ? data.leafId : null }
}

/** Every entry id on the path from the open leaf back to the root. */
export function pathToLeaf(tree: SessionTree): Set<string> {
  const parents = new Map<string, string | null>()
  const walk = (nodes: SessionTreeNode[], parent: string | null) => {
    for (const node of nodes) {
      const id = node.entry.id
      if (id) parents.set(id, parent)
      walk(node.children, id ?? parent)
    }
  }
  walk(tree.roots, null)

  const active = new Set<string>()
  let cursor = tree.leafId
  while (cursor && !active.has(cursor)) {
    active.add(cursor)
    cursor = parents.get(cursor) ?? null
  }
  return active
}

/** Count the entries and the places where more than one branch continues. */
export function treeStats(tree: SessionTree): TreeStats {
  let entries = 0
  let branches = 0
  const walk = (nodes: SessionTreeNode[]) => {
    for (const node of nodes) {
      entries += 1
      if (node.children.length > 1) branches += 1
      walk(node.children)
    }
  }
  walk(tree.roots)
  return { entries, branches }
}

/** Ids of every node that has children, so the tree can start fully open. */
export function branchIds(tree: SessionTree): Set<string> {
  const ids = new Set<string>()
  const walk = (nodes: SessionTreeNode[]) => {
    for (const node of nodes) {
      if (node.children.length > 0 && node.entry.id) ids.add(node.entry.id)
      walk(node.children)
    }
  }
  walk(tree.roots)
  return ids
}

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function shorten(text: string, limit: number): string {
  const clean = collapse(text)
  if (clean.length <= limit) return clean
  return `${clean.slice(0, limit - 1).trimEnd()}…`
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return collapse(content)
  if (!Array.isArray(content)) return ''
  return collapse(
    content
      .map((block) => {
        if (!isRecord(block)) return ''
        return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
      })
      .filter(Boolean)
      .join(' ')
  )
}

interface Description {
  role: TreeRole
  title: string
  detail?: string
  prompt?: string
}

/** What a row says, or `null` for an entry that is not worth a row. */
export function describeEntry(entry: SessionEntry): Description | null {
  if (entry.type === 'message' && entry.message) {
    const message = entry.message
    if (message.role === 'user') {
      const text = textOf(message.content)
      return { role: 'user', title: text ? shorten(text, 150) : 'Prompt', prompt: text }
    }
    if (message.role === 'assistant') {
      const text = textOf(message.content)
      return { role: 'assistant', title: text ? shorten(text, 150) : 'Reasoning' }
    }
    if (message.role === 'toolResult') {
      return {
        role: 'tool',
        title: typeof message.toolName === 'string' ? message.toolName : 'Tool result'
      }
    }
    if (message.role === 'bashExecution') {
      const command = typeof message.command === 'string' ? message.command : ''
      return { role: 'bash', title: command ? shorten(command, 120) : 'Bash' }
    }
    if (message.role === 'compactionSummary') {
      return { role: 'summary', title: 'Context compacted' }
    }
    if (message.role === 'branchSummary') {
      return { role: 'summary', title: 'Branch summary' }
    }
    return null
  }

  if (entry.type === 'session_info') {
    return { role: 'meta', title: entry.name ? `Named “${shorten(entry.name, 80)}”` : 'Session info' }
  }
  if (entry.type === 'model_change') {
    return { role: 'meta', title: `Model: ${shorten(String(entry.modelId ?? 'unknown'), 60)}` }
  }
  if (entry.type === 'thinking_level_change') {
    return { role: 'meta', title: `Reasoning: ${String(entry.thinkingLevel ?? 'unknown')}` }
  }
  if (entry.type === 'label') {
    return { role: 'meta', title: entry.label ? `Label: ${shorten(entry.label, 80)}` : 'Label' }
  }
  if (entry.type === 'compaction') {
    return { role: 'summary', title: 'Compaction' }
  }
  return null
}

/**
 * Flatten the tree into rows, in the order the tree is read.
 *
 * Metadata entries get no row of their own, but their children keep the depth
 * they would have had, so a model switch between two prompts does not leave a
 * visual hole.
 */
export function flattenTree(tree: SessionTree, expanded: ReadonlySet<string>): TreeRow[] {
  const active = pathToLeaf(tree)
  const rows: TreeRow[] = []

  const walk = (nodes: SessionTreeNode[], depth: number) => {
    for (const node of nodes) {
      const id = node.entry.id ?? ''
      const description = describeEntry(node.entry)
      const childrenOpen = expanded.has(id)
      if (description) {
        rows.push({
          id,
          depth,
          role: description.role,
          title: description.title,
          detail: description.detail,
          prompt: description.prompt,
          active: active.has(id),
          leaf: tree.leafId !== null && tree.leafId === id,
          hasChildren: node.children.length > 0,
          childrenOpen,
          branch: node.children.length > 1,
          label: node.label
        })
      }
      if (description && node.children.length > 0 && !childrenOpen) continue
      walk(node.children, description ? depth + 1 : depth)
    }
  }

  walk(tree.roots, 0)

  // The leaf itself can be a bookkeeping entry (a model or reasoning switch)
  // that has no row of its own; the last row on the active path is then the
  // tip the reader can see.
  if (tree.leafId && !rows.some((row) => row.leaf)) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (!rows[index].active) continue
      rows[index] = { ...rows[index], leaf: true }
      break
    }
  }
  return rows
}

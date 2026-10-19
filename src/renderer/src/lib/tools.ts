import { relativePath } from './path'

export type ToolTone = 'read' | 'edit' | 'exec' | 'write' | 'search' | 'generic'

export interface ToolDescriptor {
  label: string
  /** The name of the tool when several of them run in a row. */
  plural: string
  tone: ToolTone
  /** One-line summary shown next to the tool name. */
  summary(args: Record<string, unknown>, root?: string): string
}

function str(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function shortenPath(value: string, max = 68): string {
  if (value.length <= max) return value
  return `…${value.slice(value.length - max + 1)}`
}

/**
 * A value as it should appear in a one-line summary.
 *
 * Tool arguments carry whole files, so anything long is cut off: a summary
 * is a label, not a copy of the payload.
 */
function brief(value: unknown, max = 60): string {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (!text) return ''
  const single = text.replace(/\s+/g, ' ').trim()
  if (single.length <= max) return single
  return `${single.slice(0, max - 1)}…`
}

/**
 * A path as it should be shown: relative to the project when it is inside
 * it, because the full path is mostly noise.
 */
function displayPath(value: string, root?: string): string {
  if (!value) return ''
  if (root) {
    const relative = relativePath(root, value)
    if (relative !== value) return shortenPath(relative)
  }
  return shortenPath(value)
}

const DESCRIPTORS: Record<string, ToolDescriptor> = {
  read: {
    label: 'Read',
    plural: 'reads',
    tone: 'read',
    summary: (args, root) => displayPath(str(args.path), root)
  },
  write: {
    label: 'Write',
    plural: 'writes',
    tone: 'write',
    summary: (args, root) => displayPath(str(args.path), root)
  },
  edit: {
    label: 'Edit',
    plural: 'edits',
    tone: 'edit',
    summary: (args, root) => {
      const edits = Array.isArray(args.edits) ? args.edits : []
      const path = displayPath(str(args.path), root)
      if (edits.length > 1) return `${path} · ${edits.length} edits`
      return path
    }
  },
  bash: {
    label: 'Bash',
    plural: 'bash commands',
    tone: 'exec',
    summary: (args) => brief(str(args.command).split('\n')[0])
  },
  powershell: {
    label: 'PowerShell',
    plural: 'PowerShell commands',
    tone: 'exec',
    summary: (args) => brief(str(args.command).split('\n')[0])
  },
  grep: {
    label: 'Grep',
    plural: 'searches',
    tone: 'search',
    summary: (args) => {
      const pattern = brief(str(args.pattern))
      const path = str(args.path)
      return path ? `${pattern} in ${shortenPath(path)}` : pattern
    }
  },
  find: {
    label: 'Find',
    plural: 'searches',
    tone: 'search',
    summary: (args) => {
      const pattern = brief(str(args.pattern))
      const path = str(args.path)
      return path ? `${pattern} in ${shortenPath(path)}` : pattern
    }
  },
  ls: {
    label: 'List',
    plural: 'listings',
    tone: 'read',
    summary: (args, root) => displayPath(str(args.path) || '.', root)
  }
}

const GENERIC: ToolDescriptor = {
  label: 'Tool',
  plural: 'tool calls',
  tone: 'generic',
  summary: (args) => {
    const keys = Object.keys(args ?? {})
    return keys.length ? keys.join(', ') : ''
  }
}

export function describeTool(name: string): ToolDescriptor {
  return DESCRIPTORS[name] ?? { ...GENERIC, label: name }
}

export interface EditPair {
  oldText: string
  newText: string
}

/** Extract the edit pairs of an `edit` tool call. */
export function editPairs(args: Record<string, unknown>): EditPair[] {
  const edits = Array.isArray(args?.edits) ? args.edits : []
  return edits
    .map((entry) => {
      const value = entry as { oldText?: unknown; newText?: unknown }
      return { oldText: str(value.oldText), newText: str(value.newText) }
    })
    .filter((pair) => pair.oldText !== '' || pair.newText !== '')
}

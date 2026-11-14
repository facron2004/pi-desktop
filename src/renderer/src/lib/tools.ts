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
 * The one line a shell command should occupy in the trace.
 *
 * Pi starts the command with `cd "<workspace>" &&`, then often chains the
 * real work with `&&` and trims the output (`2>&1 | tail`). Showing that
 * whole string made every row the same long line, and the reply had to sit
 * underneath the pile. The row names the first real command.
 */
export function commandSummary(command: string): string {
  const text = command
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*&&\s*)+/i, '')
  const parts = text
    .split(/\s*(?:&&|;)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
  const first = (parts[0] ?? text)
    .replace(/\s+\d*>&\d+/g, '')
    .replace(/\s*\|\s*(?:tail|head)\s+-?\d+\s*$/i, '')
    .trim()
  const extra = parts.length > 1 ? ` · +${parts.length - 1}` : ''
  return brief(`${first}${extra}`, 72)
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
    summary: (args) => commandSummary(str(args.command))
  },
  powershell: {
    label: 'PowerShell',
    plural: 'PowerShell commands',
    tone: 'exec',
    summary: (args) => commandSummary(str(args.command))
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
  },
  subagent: {
    label: 'Subagent',
    plural: 'subagent calls',
    tone: 'generic',
    summary: (args) => {
      const tasks = Array.isArray(args.tasks) ? args.tasks.length : 0
      return tasks ? `${tasks} parallel tasks` : brief(str(args.task))
    }
  },
  exit_plan_mode: {
    label: 'Plan',
    plural: 'plans',
    tone: 'generic',
    summary: (args) => brief(str(args.plan))
  },
  computer: {
    label: 'Computer',
    plural: 'computer actions',
    tone: 'generic',
    summary: (args) => {
      const action = str(args.action)
      if (action === 'type') return brief(str(args.text))
      if (action === 'key') return brief(str(args.key))
      const x = str(args.x)
      const y = str(args.y)
      return x && y ? `${action} ${x},${y}` : action
    }
  }
}

const GENERIC: ToolDescriptor = {
  label: 'Tool',
  plural: 'tool calls',
  tone: 'generic',
  summary: (args) => {
    // An unknown tool still names its subject: the usual field is better than
    // a bare list of argument names (`glob` reports a pattern, a shell an
    // option command, a file tool a path).
    const subject =
      str(args.pattern) || str(args.command) || str(args.path) || str(args.query) || str(args.url)
    if (subject) return brief(subject)
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

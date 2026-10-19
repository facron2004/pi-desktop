export type ToolTone = 'read' | 'edit' | 'exec' | 'write' | 'search' | 'generic'

export interface ToolDescriptor {
  label: string
  tone: ToolTone
  /** One-line summary shown next to the tool name. */
  summary(args: Record<string, unknown>): string
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

const DESCRIPTORS: Record<string, ToolDescriptor> = {
  read: {
    label: 'Read',
    tone: 'read',
    summary: (args) => shortenPath(str(args.path))
  },
  write: {
    label: 'Write',
    tone: 'write',
    summary: (args) => shortenPath(str(args.path))
  },
  edit: {
    label: 'Edit',
    tone: 'edit',
    summary: (args) => {
      const edits = Array.isArray(args.edits) ? args.edits : []
      const path = shortenPath(str(args.path))
      if (edits.length > 1) return `${path} · ${edits.length} edits`
      return path
    }
  },
  bash: {
    label: 'Bash',
    tone: 'exec',
    summary: (args) => str(args.command).split('\n')[0] ?? ''
  },
  powershell: {
    label: 'PowerShell',
    tone: 'exec',
    summary: (args) => str(args.command).split('\n')[0] ?? ''
  },
  grep: {
    label: 'Grep',
    tone: 'search',
    summary: (args) => {
      const pattern = str(args.pattern)
      const path = str(args.path)
      return path ? `${pattern} in ${shortenPath(path)}` : pattern
    }
  },
  find: {
    label: 'Find',
    tone: 'search',
    summary: (args) => {
      const pattern = str(args.pattern)
      const path = str(args.path)
      return path ? `${pattern} in ${shortenPath(path)}` : pattern
    }
  },
  ls: {
    label: 'List',
    tone: 'read',
    summary: (args) => shortenPath(str(args.path) || '.')
  }
}

const GENERIC: ToolDescriptor = {
  label: 'Tool',
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

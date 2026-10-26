import type { ToolItem } from './thread'

/**
 * Which renderer draws a tool call.
 *
 * A tool the registry does not know still gets a card: an unknown tool is a
 * normal outcome (an MCP server, a project extension), not a reason to drop
 * the call from the stream. The keys are the tool names Pi reports.
 */
export type ToolRendererKind =
  | 'file-read'
  | 'file-edit'
  | 'command'
  | 'search'
  | 'mcp'
  | 'todo'
  | 'generic'

const REGISTRY: Record<string, ToolRendererKind> = {
  read: 'file-read',
  edit: 'file-edit',
  write: 'file-edit',
  bash: 'command',
  powershell: 'command',
  grep: 'search',
  find: 'search',
  ls: 'search'
}

/** The renderer for a tool name, with a safe fallback for unknown ones. */
export function toolRendererOf(toolName: string): ToolRendererKind {
  const known = REGISTRY[toolName]
  if (known) return known
  // MCP tools arrive namespaced (`mcp__server__tool`), so the prefix is what
  // categorises them rather than the full name.
  if (toolName.startsWith('mcp__')) return 'mcp'
  if (toolName.startsWith('todo')) return 'todo'
  return 'generic'
}

/** How a card is summarised in one line, without any secret in it. */
export interface ToolSummary {
  /** The verb the card leads with, e.g. "Read". */
  label: string
  /** The object of the verb: a path, a command, a pattern. */
  detail: string
  /** The tone that decides the icon. */
  tone: ToolSummaryTone
}

export type ToolSummaryTone = 'read' | 'edit' | 'command' | 'search' | 'generic'

function str(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** One line of anything, for a summary that must not wrap. */
function oneLine(value: string, max = 72): string {
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`
}

const TONES: Record<string, ToolSummaryTone> = {
  read: 'read',
  edit: 'edit',
  write: 'edit',
  bash: 'command',
  powershell: 'command',
  grep: 'search',
  find: 'search',
  ls: 'search'
}

/**
 * The summary of a tool call, built from its arguments.
 *
 * Only the fields that identify *what* was touched are used. Credentials,
 * environment variables and request headers never reach the title: a card
 * that has to show them keeps them in the expandable body, and the body is
 * what the user opens on purpose.
 */
export function summarizeTool(tool: ToolItem): ToolSummary {
  const args = tool.args ?? {}
  const tone = TONES[tool.toolName] ?? 'generic'
  const kind = toolRendererOf(tool.toolName)

  let label = tool.toolName
  let detail = ''

  switch (kind) {
    case 'file-read':
      label = tool.toolName === 'read' ? 'Read' : 'List'
      detail = oneLine(str(args.path) || '.')
      break
    case 'file-edit':
      label = tool.toolName === 'write' ? 'Write' : 'Edit'
      detail = oneLine(str(args.path))
      break
    case 'command':
      label = tool.toolName === 'powershell' ? 'PowerShell' : 'Run'
      detail = oneLine(str(args.command))
      break
    case 'search':
      label = tool.toolName === 'grep' ? 'Grep' : tool.toolName === 'find' ? 'Find' : 'List'
      detail = oneLine(str(args.pattern) || str(args.path) || '.')
      break
    case 'mcp':
      // `mcp__server__tool` — the server is the part that identifies it.
      label = 'MCP'
      detail = oneLine(tool.toolName.replace(/^mcp__/, '').replace(/__/g, ' · '))
      break
    case 'todo':
      label = 'Todo'
      detail = oneLine(str(args.content) || str(args.todos))
      break
    default:
      label = tool.toolName
      detail = oneLine(Object.keys(args).join(', '))
      break
  }

  return { label, detail, tone }
}

/**
 * Whether a card can show a diff of what it changed.
 *
 * An `edit` carries both sides of every change in its arguments, which is
 * what makes a real diff possible without reading the file back. Nothing
 * else has enough information to draw one, and a diff that was invented
 * would be worse than none.
 */
export function diffableEdits(tool: ToolItem): { oldText: string; newText: string }[] {
  if (tool.toolName !== 'edit') return []
  const edits = Array.isArray(tool.args?.edits) ? tool.args.edits : []
  const pairs: { oldText: string; newText: string }[] = []
  for (const entry of edits) {
    if (!entry || typeof entry !== 'object') continue
    const value = entry as { oldText?: unknown; newText?: unknown }
    const oldText = str(value.oldText)
    const newText = str(value.newText)
    if (oldText || newText) pairs.push({ oldText, newText })
  }
  return pairs
}

/** The content a `write` created, when it did. */
export function writtenContent(tool: ToolItem): string {
  if (tool.toolName !== 'write') return ''
  return typeof tool.args?.content === 'string' ? tool.args.content : ''
}

/** The exit code a shell tool reported, if it reported one. */
export function exitCodeOf(tool: ToolItem): number | undefined {
  return tool.exitCode
}

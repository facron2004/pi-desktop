import { ASK_USER_TOOL_NAME } from '@shared/types'
import type { ToolItem } from './thread'
import { imageModelName, imageRatioLabel } from './image-options'

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
  | 'goal'
  | 'subagent'
  | 'plan'
  | 'question'
  | 'computer'
  | 'image'
  | 'generic'

const REGISTRY: Record<string, ToolRendererKind> = {
  read: 'file-read',
  edit: 'file-edit',
  write: 'file-edit',
  bash: 'command',
  powershell: 'command',
  grep: 'search',
  find: 'search',
  ls: 'search',
  subagent: 'subagent',
  swarm_spawn: 'subagent',
  swarm_task: 'subagent',
  swarm_message: 'subagent',
  swarm_collect: 'subagent',
  swarm_status: 'subagent',
  swarm_disband: 'subagent',
  desktop_goal_finish: 'goal',
  desktop_todo: 'todo',
  exit_plan_mode: 'plan',
  [ASK_USER_TOOL_NAME]: 'question',
  computer: 'computer',
  generate_image: 'image'
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

export type ToolSummaryTone = 'read' | 'edit' | 'command' | 'search' | 'subagent' | 'plan' | 'computer' | 'image' | 'generic'

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
  ls: 'search',
  subagent: 'subagent',
  swarm_spawn: 'subagent',
  swarm_task: 'subagent',
  swarm_message: 'subagent',
  swarm_collect: 'subagent',
  swarm_status: 'subagent',
  swarm_disband: 'subagent',
  desktop_goal_finish: 'plan',
  exit_plan_mode: 'plan',
  computer: 'computer',
  generate_image: 'image'
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
      // A command carries its arguments and paths in one string, so the 72
      // characters that suit a file path cut what is running off mid-argument.
      // The run-status line wraps this detail; tool cards still ellipsize it.
      label = tool.toolName === 'powershell' ? 'PowerShell' : 'Run'
      detail = oneLine(str(args.command), 240)
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
    case 'todo': {
      const items = Array.isArray(args.items)
        ? args.items
        : Array.isArray(args.todos)
          ? args.todos
          : []
      const steps = items.filter((item) => Boolean(item) && typeof item === 'object')
      label = 'Todo'
      // Counts only: the card's verb already says what the numbers are, and a
      // word here would have to be translated at render time, where this
      // projection is not recomputed when the language changes.
      detail = steps.length
        ? `${steps.filter((item) => (item as { status?: unknown }).status === 'completed').length}/${steps.length}`
        : oneLine(str(args.content) || str(args.todos))
      break
    }
    case 'goal': {
      // The outcome is the card's verb: "Complete" alone would read as a
      // nameless status on a tool that is not obviously Goal Mode's.
      const status = str(args.status)
      label = status === 'complete' ? 'Goal complete' : status === 'blocked' ? 'Goal blocked' : 'Goal'
      detail = oneLine(str(args.summary))
      break
    }
    case 'subagent': {
      if (tool.toolName.startsWith('swarm_')) {
        // One card per swarm action. The worker name is the object; a task call
        // adds the first line of its briefing so two dispatches read apart.
        const name = str(args.name)
        label = tool.toolName === 'swarm_spawn' ? 'Spawn worker'
          : tool.toolName === 'swarm_task' ? 'Assign worker'
            : tool.toolName === 'swarm_message' ? 'Message worker'
              : tool.toolName === 'swarm_collect' ? 'Collect workers'
                : tool.toolName === 'swarm_disband' ? 'Disband worker'
                  : 'Swarm'
        detail = oneLine([name, str(args.task) || str(args.message)].filter(Boolean).join(' · '))
        break
      }
      const tasks = Array.isArray(args.tasks) ? args.tasks : []
      label = 'Subagent'
      detail = tasks.length
        ? `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} in parallel`
        : oneLine(str(args.task))
      break
    }
    case 'plan':
      label = 'Plan'
      detail = oneLine(str(args.plan).split('\n')[0].replace(/^#+\s*/, ''))
      break
    case 'question':
      label = 'Question'
      detail = oneLine(str(args.question))
      break
    case 'computer': {
      label = 'Computer'
      const action = str(args.action)
      const x = str(args.x)
      const y = str(args.y)
      if (action === 'click' || action === 'move' || action === 'scroll') {
        detail = oneLine([action, x && y ? `${x},${y}` : '', str(args.direction), str(args.button)].filter(Boolean).join(' '))
      } else if (action === 'type') {
        detail = oneLine(str(args.text))
      } else if (action === 'key') {
        detail = oneLine(str(args.key))
      } else {
        detail = oneLine(action)
      }
      break
    }
    case 'image': {
      // The prompt lives in the card's fold. The header names the model and
      // size/count when the call carried them, so the reader can see what drew
      // the picture without unfolding the prompt.
      label = 'Generate image'
      const detailsModel =
        tool.details && typeof tool.details === 'object'
          ? str((tool.details as { model?: unknown }).model)
          : ''
      const model = detailsModel || str(args.model)
      const size = str(args.size)
      const quality = str(args.quality)
      const count =
        typeof args.n === 'number' && Number.isFinite(args.n) && args.n > 1
          ? `${Math.round(args.n)}×`
          : ''
      detail = oneLine(
        [
          model ? imageModelName(model) : '',
          size ? imageRatioLabel(size) : '',
          quality && quality !== 'auto' ? quality : '',
          count
        ]
          .filter(Boolean)
          .join(' · ')
      )
      break
    }
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

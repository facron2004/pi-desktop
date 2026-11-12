import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Named agent presets for the built-in subagent tool.
 *
 * An agent is a reusable delegation role: a short routing description, a system
 * prompt body, and optional model / thinking / tools / timeout defaults. The
 * model routes by the description, the way Claude Code and Gemini agents do,
 * and the body becomes part of the child's system prompt.
 *
 * Two locations, following the conventions the rest of Pi Desktop already
 * uses: `~/.pi/agent/agents/*.md` (user-owned, always read) and
 * `<workspace>/.pi/agents/*.md` (only read while project trust is on, the same
 * gate as `.pi/mcp.json`). A project entry with the same name replaces the
 * user entry, the way a project mcp.json replaces the user's server.
 */

export interface AgentPreset {
  /** Routing key: lowercase slug. The call's `agent` argument matches this. */
  name: string
  /** What the parent model reads to decide when to use this agent. */
  description: string
  /** Appended to the child's system prompt; may be empty. */
  prompt: string
  /** Catalog id in `provider/id` form; anything else is dropped later. */
  model?: string
  /** One of Pi's thinking levels. */
  thinking?: string
  /** Tool allowlist for the child. */
  tools?: string[]
  /** Wall-clock budget for the child; clamped again in the generated source. */
  timeoutMs?: number
}

const MAX_AGENT_FILES_PER_DIR = 20
const MAX_AGENTS_TOTAL = 32
const MAX_AGENT_FILE_BYTES = 64 * 1024
const MAX_AGENT_PROMPT_CHARS = 32 * 1024
const MAX_AGENT_DESCRIPTION_CHARS = 500
const MAX_AGENT_TOOLS = 32
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * Flat `key: value` frontmatter, not full YAML: the loader only accepts scalar
 * lines, so a nested or list-shaped value fails the file instead of being
 * misread. Unknown keys are ignored on purpose — they are inert metadata, and
 * a future version adding a key must not have old files rejected. That is a
 * different risk class from an unsupported outputSchema keyword, which is an
 * active constraint the caller relies on and therefore fails loudly.
 */
function parseAgentFile(text: string): AgentPreset | null {
  const source = text.replace(/^\uFEFF/, '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
  if (!match) return null
  const values = new Map<string, string>()
  for (const rawLine of match[1].split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    // Indented lines and list items mean a shape this loader does not support.
    if (/^\s/.test(rawLine) || /^-\s/.test(rawLine)) return null
    const index = rawLine.indexOf(':')
    if (index === -1) return null
    const key = rawLine.slice(0, index).trim()
    if (!key) return null
    values.set(key, rawLine.slice(index + 1).trim())
  }
  const name = (values.get('name') ?? '').trim().toLowerCase()
  if (!NAME_PATTERN.test(name)) return null
  const description = (values.get('description') ?? '').trim()
  if (!description) return null
  const preset: AgentPreset = {
    name,
    description: description.slice(0, MAX_AGENT_DESCRIPTION_CHARS),
    prompt: source.slice(match[0].length).trim().slice(0, MAX_AGENT_PROMPT_CHARS)
  }
  const model = (values.get('model') ?? '').trim()
  if (model) preset.model = model
  const thinking = (values.get('thinking') ?? '').trim()
  if (thinking) preset.thinking = thinking
  const tools = (values.get('tools') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, MAX_AGENT_TOOLS)
  if (tools.length > 0) preset.tools = tools
  const timeout = Number((values.get('timeoutMs') ?? '').trim())
  if (Number.isFinite(timeout) && timeout > 0) preset.timeoutMs = timeout
  return preset
}

/** True when `candidate` resolves inside `root` without a symlink escape. */
function resolvesInside(root: string, candidate: string): boolean {
  try {
    const relative = path.relative(realpathSync(root), realpathSync(candidate))
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  } catch {
    return false
  }
}

function readAgentDirectory(directory: string, workspaceRoot?: string): AgentPreset[] {
  if (!existsSync(directory)) return []
  // The project agents directory itself must live inside the workspace before
  // any file in it is even opened; a junction or symlink pointing elsewhere
  // would smuggle untrusted instructions into every delegation.
  if (workspaceRoot && !resolvesInside(workspaceRoot, directory)) return []
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return []
  }
  const byName = new Map<string, AgentPreset>()
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    if (byName.size >= MAX_AGENT_FILES_PER_DIR) break
    const file = path.join(directory, entry.name)
    try {
      if (statSync(file).size > MAX_AGENT_FILE_BYTES) continue
      if (workspaceRoot && !resolvesInside(directory, file)) continue
      const preset = parseAgentFile(readFileSync(file, 'utf8'))
      // First file in name order wins a duplicate, so the result is stable
      // across runs instead of depending on directory enumeration order.
      if (preset && !byName.has(preset.name)) byName.set(preset.name, preset)
    } catch {
      // An unreadable agent file is a skipped agent, not a broken project.
    }
  }
  return [...byName.values()]
}

/**
 * The presets a conversation in `workspacePath` may delegate to. The global
 * directory is user-owned and always read; the project directory only while
 * `trusted` carries the user's explicit project-safety choice.
 */
export function readAgentPresets(
  workspacePath: string | undefined,
  trusted: boolean,
  globalAgentsDir: string = path.join(os.homedir(), '.pi', 'agent', 'agents')
): AgentPreset[] {
  const global = readAgentDirectory(globalAgentsDir)
  const project = trusted && workspacePath
    ? readAgentDirectory(path.join(workspacePath, '.pi', 'agents'), workspacePath)
    : []
  // Project presets are the more specific context: they claim their names
  // first, so a cap cannot push a project role out in favour of a generic
  // global one. A project preset with the same name still replaces the user's.
  const byName = new Map(project.map((preset) => [preset.name, preset]))
  for (const preset of global) {
    if (!byName.has(preset.name)) byName.set(preset.name, preset)
  }
  return [...byName.values()].slice(0, MAX_AGENTS_TOTAL)
}

/**
 * Tools known to stay inside the local Pi session and Pi Desktop bookkeeping.
 * Unknown extension tools are external by default: their results may include
 * account data, pages or delegated work that should not enter future prompts.
 */
export const LOCAL_BUILTIN_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'bash',
  'powershell',
  'grep',
  'find',
  'ls'
] as const

export const EXTERNAL_TOOL_OVERRIDE_ENTRY = 'pi-desktop-external-tool-override'
export const EXTERNAL_CONTEXT_ENTRY = 'pi-desktop-external-context'
export const EXTERNAL_CONTEXT_CHECKED_ENTRY = 'pi-desktop-external-context-checked'
export const EXTERNAL_CONTEXT_UNKNOWN_ENTRY = 'pi-desktop-external-context-unknown'
/** Bump when classification rules change so cold readers can reject stale checks. */
export const EXTERNAL_CONTEXT_CLASSIFICATION_VERSION = 2

export const LOCAL_TOOL_NAMES = [
  ...LOCAL_BUILTIN_TOOL_NAMES,
  'desktop_goal_finish',
  'desktop_todo',
  'exit_plan_mode'
] as const

const LOCAL_TOOL_NAME_SET = new Set<string>(LOCAL_TOOL_NAMES)

export function isExternalToolName(name: unknown): boolean {
  return typeof name !== 'string' || !LOCAL_TOOL_NAME_SET.has(name)
}

/**
 * Tools whose result depends on something outside the local conversation.
 * A memory learned from those chats could leak an external account, a page or
 * a delegated task into a future prompt, so they are excluded by default.
 */
export function isExternalToolName(name: unknown): boolean {
  if (typeof name !== 'string' || !name) return false
  if (name.startsWith('mcp__')) return true
  return [
    'computer',
    'subagent',
    'tool_search',
    'codemode',
    'browser',
    'web_search',
    'web_fetch',
    'read_mcp_resource',
    'list_mcp_resources',
    'list_mcp_resource_templates'
  ].includes(name)
}

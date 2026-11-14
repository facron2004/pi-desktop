/**
 * Extension notices that are plumbing, not conversation.
 *
 * MCP and skill plugins announce their own startup state through
 * `ctx.ui.notify`: blocked project servers, tool-discovery summaries, loaded
 * or skipped skill bundles. Pi Desktop turns warnings into a toast above the
 * composer, so a project with untrusted servers produced a wall of text on
 * every cold start — text the reader cannot act on from there, and often
 * longer than the composer itself.
 *
 * These notices are not about the turn and must not occupy the one toast
 * slot. Actual MCP/skill tool failures still reach the transcript as tool
 * rows, and an error the reader triggers from a command still comes back
 * through that command's own UI.
 */
export function isMcpOrSkillChatter(message: string): boolean {
  const text = message.replace(/\s+/g, ' ').trim()
  if (!text) return true
  // The MCP adapter and Pi's built-in MCP extension prefix every status line
  // with `MCP:` (sometimes with a plug emoji). A user-typed `/mcp` command is
  // answered by its own command UI, so suppressing the notify path is safe.
  if (/^(?:🔌\s*)?MCP\b/i.test(text)) return true
  // Skill discovery has no single prefix: “Loaded 12 skills”, “skill bundles
  // skipped”, “Skills: …”. Treat any skill word in an extension notification
  // as startup chatter for the same reason.
  return /\bskills?\b|技能/i.test(text)
}

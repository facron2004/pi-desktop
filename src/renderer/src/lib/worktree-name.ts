/**
 * The next free branch for a session-start worktree.
 *
 * The current branch is the stem (`main` → `main-wt`, then `main-wt-2`), and
 * a branch that was itself created this way is stripped back first so a
 * worktree of a worktree does not stack `-wt-wt`.
 */
export function nextWorktreeBranch(current: string | undefined, taken: Iterable<string>): string {
  const used = new Set(taken)
  const stripped = (current ?? '')
    .trim()
    .replace(/-wt(?:-\d+)?$/, '')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/^[-./]+|[-./]+$/g, '')
  const base = (stripped || 'worktree').slice(0, 200)
  const stem = `${base}-wt`
  if (!used.has(stem)) return stem
  let n = 2
  while (used.has(`${stem}-${n}`)) n += 1
  return `${stem}-${n}`
}

/** A conversation has started once it has a user prompt or an assistant reply. */
export function conversationStarted(items: readonly { kind: string }[]): boolean {
  return items.some((item) => item.kind === 'user' || item.kind === 'assistant')
}

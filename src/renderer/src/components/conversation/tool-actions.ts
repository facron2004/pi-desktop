/**
 * Hands a command to the terminal drawer.
 *
 * The drawer is mounted by the app rather than by a card, so a card cannot
 * call the drawer's run path directly; the hand-off goes through the window
 * event the app listens for.
 */
export function runInTerminal(command: string): void {
  window.dispatchEvent(new CustomEvent('pi:terminal-run', { detail: { command } }))
}

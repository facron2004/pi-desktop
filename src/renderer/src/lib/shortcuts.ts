/** Show the modifier names users see on their keyboard. */
export function formatPlatformShortcut(shortcut: string, platform?: string): string {
  if (platform !== 'darwin') return shortcut
  return shortcut.replace(/\bCtrl\b/g, '⌘').replace(/\bAlt\b/g, '⌥')
}

/** Show the modifier names users see on their keyboard. */
export function formatPlatformShortcut(shortcut: string, platform?: string): string {
  if (platform !== 'darwin') return shortcut
  return shortcut.replace(/\bCtrl\b/g, '⌘').replace(/\bAlt\b/g, '⌥')
}

export interface ShortcutEntry {
  keys: string[]
  label: string
  group: string
  keySeparator?: 'or'
}

/**
 * The one shortcut table both the shortcuts dialog and the settings page
 * render. A chord added here shows up in both places, so they cannot drift.
 */
export const SHORTCUTS: ShortcutEntry[] = [
  { keys: ['Ctrl', ','], label: 'Open settings', group: 'Workspace' },
  { keys: ['Ctrl', 'N'], label: 'Start a new conversation', group: 'Workspace' },
  { keys: ['Ctrl', 'B'], label: 'Show or hide the sidebar', group: 'Workspace' },
  { keys: ['Ctrl', '`'], label: 'Open or close the terminal', group: 'Workspace' },
  { keys: ['Ctrl', 'K'], label: 'Focus the composer', group: 'Workspace' },
  { keys: ['Ctrl', 'F'], label: 'Search the conversation', group: 'Workspace' },
  { keys: ['Ctrl', '1…9'], label: 'Switch to another project', group: 'Workspace' },
  { keys: ['Ctrl', 'Shift', 'P'], label: 'Open the command palette', group: 'Workspace' },
  { keys: ['Ctrl', 'Shift', 'T'], label: 'Show the session tree', group: 'Workspace' },
  { keys: ['Ctrl', '/'], label: 'Show this shortcut list', group: 'Workspace' },
  { keys: ['Ctrl', 'P'], label: 'Use the next model', group: 'Model' },
  { keys: ['Ctrl', 'T'], label: 'Use the next reasoning effort', group: 'Model' },
  { keys: ['Enter'], label: 'Send the message', group: 'Composing' },
  { keys: ['Shift', 'Enter'], label: 'Insert a line break', group: 'Composing' },
  { keys: ['↑'], label: 'Recall the previous prompt', group: 'Composing' },
  { keys: ['↓'], label: 'Recall an older prompt', group: 'Composing' },
  { keys: ['/'], label: 'Open the command list', group: 'Composing' },
  { keys: ['Esc'], label: 'Stop the running turn', group: 'Composing' },
  { keys: ['↑', '↓'], label: 'Move through the command list', group: 'Command palette', keySeparator: 'or' },
  { keys: ['Tab'], label: 'Insert the highlighted command', group: 'Command palette' },
  { keys: ['Alt', '↑'], label: 'Jump to the previous turn', group: 'Reading' },
  { keys: ['Alt', '↓'], label: 'Jump to the next turn', group: 'Reading' },
  { keys: ['Enter'], label: 'Go to the next search hit', group: 'Search' },
  { keys: ['Shift', 'Enter'], label: 'Go to the previous search hit', group: 'Search' },
  { keys: ['Esc'], label: 'Close the search bar', group: 'Search' }
]

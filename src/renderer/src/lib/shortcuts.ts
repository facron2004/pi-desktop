/** Show the modifier names users see on their keyboard. */
export function formatPlatformShortcut(shortcut: string, platform?: string): string {
  if (platform !== 'darwin') return shortcut
  return shortcut.replace(/\bCtrl\b/g, '⌘').replace(/\bAlt\b/g, '⌥')
}

/**
 * The ids an app shortcut can be rebound by. Gestures of one widget — Enter to
 * send, Esc to close a search, the arrows of the palette — have no id: they
 * belong to the control they act on and are not a chord the user picks.
 */
export type ShortcutId =
  | 'open-settings'
  | 'new-chat'
  | 'toggle-sidebar'
  | 'toggle-terminal'
  | 'focus-composer'
  | 'search-conversation'
  | 'command-palette'
  | 'session-tree'
  | 'shortcut-list'
  | 'next-model'
  | 'next-thinking'
  | 'previous-turn'
  | 'next-turn'

/** A bound chord: the key names in canonical order (Ctrl, Shift, Alt, key). */
export type ShortcutBindings = Record<string, string[]>

export interface ShortcutEntry {
  /** Present when the row is a rebindable app chord. */
  id?: ShortcutId
  keys: string[]
  label: string
  group: string
  keySeparator?: 'or'
}

/**
 * The one shortcut table both the shortcuts dialog and the settings page
 * render. A chord added here shows up in both places, so they cannot drift.
 * `keys` is the built-in chord a row falls back to when no binding is saved.
 */
export const SHORTCUTS: ShortcutEntry[] = [
  { id: 'open-settings', keys: ['Ctrl', ','], label: 'Open settings', group: 'Workspace' },
  { id: 'new-chat', keys: ['Ctrl', 'N'], label: 'Start a new conversation', group: 'Workspace' },
  { id: 'toggle-sidebar', keys: ['Ctrl', 'B'], label: 'Show or hide the sidebar', group: 'Workspace' },
  { id: 'toggle-terminal', keys: ['Ctrl', '`'], label: 'Open or close the terminal', group: 'Workspace' },
  { id: 'focus-composer', keys: ['Ctrl', 'K'], label: 'Focus the composer', group: 'Workspace' },
  {
    id: 'search-conversation',
    keys: ['Ctrl', 'F'],
    label: 'Search the conversation',
    group: 'Workspace'
  },
  { keys: ['Ctrl', '1…9'], label: 'Switch to another project', group: 'Workspace' },
  {
    id: 'command-palette',
    keys: ['Ctrl', 'Shift', 'P'],
    label: 'Open the command palette',
    group: 'Workspace'
  },
  { id: 'session-tree', keys: ['Ctrl', 'Shift', 'T'], label: 'Show the session tree', group: 'Workspace' },
  { id: 'shortcut-list', keys: ['Ctrl', '/'], label: 'Show this shortcut list', group: 'Workspace' },
  { id: 'next-model', keys: ['Ctrl', 'P'], label: 'Use the next model', group: 'Model' },
  { id: 'next-thinking', keys: ['Ctrl', 'T'], label: 'Use the next reasoning effort', group: 'Model' },
  { keys: ['Enter'], label: 'Send the message', group: 'Composing' },
  { keys: ['Shift', 'Enter'], label: 'Insert a line break', group: 'Composing' },
  { keys: ['↑'], label: 'Recall the previous prompt', group: 'Composing' },
  { keys: ['↓'], label: 'Recall an older prompt', group: 'Composing' },
  { keys: ['/'], label: 'Open the command list', group: 'Composing' },
  { keys: ['Esc'], label: 'Stop the running turn', group: 'Composing' },
  {
    keys: ['↑', '↓'],
    label: 'Move through the command list',
    group: 'Command palette',
    keySeparator: 'or'
  },
  { keys: ['Tab'], label: 'Insert the highlighted command', group: 'Command palette' },
  { id: 'previous-turn', keys: ['Alt', '↑'], label: 'Jump to the previous turn', group: 'Reading' },
  { id: 'next-turn', keys: ['Alt', '↓'], label: 'Jump to the next turn', group: 'Reading' },
  { keys: ['Enter'], label: 'Go to the next search hit', group: 'Search' },
  { keys: ['Shift', 'Enter'], label: 'Go to the previous search hit', group: 'Search' },
  { keys: ['Esc'], label: 'Close the search bar', group: 'Search' }
]

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS'])

export function isModifierKey(key: string): boolean {
  return MODIFIERS.has(key)
}

/** The name a pressed key has in the table, or null when it cannot be bound. */
function keyName(event: KeyboardEvent): string | null {
  const key = event.key
  if (key.length === 1) {
    if (key === ' ') return 'Space'
    return key.toUpperCase()
  }
  if (key === 'ArrowUp') return '↑'
  if (key === 'ArrowDown') return '↓'
  if (key === 'ArrowLeft') return '←'
  if (key === 'ArrowRight') return '→'
  if (key === 'Escape') return 'Esc'
  if (key === 'Enter') return 'Enter'
  if (key === 'Tab') return 'Tab'
  if (key === 'Backspace') return 'Backspace'
  if (key === 'Delete') return 'Delete'
  if (/^F\d{1,2}$/.test(key)) return key
  return null
}

/**
 * The chord a key event stands for. Ctrl and Cmd are one modifier because the
 * app treats them as the same door on either platform.
 */
export function chordFromEvent(event: KeyboardEvent): string[] | null {
  const key = keyName(event)
  if (!key) return null
  const chord: string[] = []
  if (event.ctrlKey || event.metaKey) chord.push('Ctrl')
  if (event.shiftKey) chord.push('Shift')
  if (event.altKey) chord.push('Alt')
  chord.push(key)
  return chord
}

/** The keys a row shows: the user's binding, or the built-in chord. */
export function activeKeys(entry: ShortcutEntry, bindings?: ShortcutBindings): string[] {
  const custom = entry.id ? bindings?.[entry.id] : undefined
  return Array.isArray(custom) && custom.length > 0 ? custom : entry.keys
}

/** The keys currently bound to an id, from the table's own defaults. */
export function keysFor(id: ShortcutId, bindings?: ShortcutBindings): string[] {
  const entry = SHORTCUTS.find((item) => item.id === id)
  return entry ? activeKeys(entry, bindings) : []
}

export function matchesShortcut(event: KeyboardEvent, keys: string[]): boolean {
  const chord = chordFromEvent(event)
  if (!chord || chord.length !== keys.length) return false
  return chord.every((key, index) => key === keys[index])
}

/** The row already wearing this chord, so a binding cannot run two actions. */
export function conflictingShortcut(
  id: ShortcutId,
  chord: string[],
  bindings?: ShortcutBindings
): ShortcutEntry | undefined {
  return SHORTCUTS.find((entry) => {
    if (!entry.id || entry.id === id || entry.keySeparator === 'or') return false
    const keys = activeKeys(entry, bindings)
    return keys.length === chord.length && keys.every((key, index) => key === chord[index])
  })
}

/** Show the modifier names users see on their keyboard. */
export function formatPlatformShortcut(shortcut: string, platform?: string): string {
  if (platform !== 'darwin') return shortcut
  return shortcut.replace(/\bCtrl\b/g, '⌘').replace(/\bAlt\b/g, '⌥')
}

/** Render one chord as a single unified pill label (`Ctrl + Shift + P`). */
export function formatChord(keys: string[], platform?: string): string {
  return keys.map((key) => formatPlatformShortcut(key, platform)).join(' + ')
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

/** A bound chord: the key names in canonical order (`Ctrl`, `Shift`, `Alt`, key). */
export type ShortcutChord = string[]

/** One chord (`string[]`), multiple chords (`string[][]`), or `[]` when unbound. */
export type ShortcutBindingValue = ShortcutChord | ShortcutChord[]

export type ShortcutBindings = Record<string, ShortcutBindingValue>

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
  { id: 'previous-turn', keys: ['Alt', '↑'], label: 'Jump to the previous turn', group: 'Reading' },
  { id: 'next-turn', keys: ['Alt', '↓'], label: 'Jump to the next turn', group: 'Reading' },
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
  { keys: ['Enter'], label: 'Go to the next search hit', group: 'Search' },
  { keys: ['Shift', 'Enter'], label: 'Go to the previous search hit', group: 'Search' },
  { keys: ['Esc'], label: 'Close the search bar', group: 'Search' }
]

/** Reflect `sendShortcut` in the composing gestures shown to the user. */
export function entriesForDisplay(sendShortcut?: 'enter' | 'ctrlEnter'): ShortcutEntry[] {
  if (sendShortcut !== 'ctrlEnter') return SHORTCUTS
  return SHORTCUTS.map((entry) => {
    if (entry.group !== 'Composing') return entry
    if (entry.label === 'Send the message') return { ...entry, keys: ['Ctrl', 'Enter'] }
    if (entry.label === 'Insert a line break') return { ...entry, keys: ['Enter'] }
    return entry
  })
}

const MODIFIERS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'OS', 'AltGraph'])

export function isModifierKey(key: string): boolean {
  return MODIFIERS.has(key)
}

/** Held modifiers in canonical display order while recording a chord. */
export function heldModifiersFromEvent(event: KeyboardEvent): string[] {
  const modifiers: string[] = []
  if (event.ctrlKey || event.metaKey) modifiers.push('Ctrl')
  if (event.shiftKey) modifiers.push('Shift')
  if (event.altKey) modifiers.push('Alt')
  return modifiers
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
  if (key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown') return key
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
  return [...heldModifiersFromEvent(event), key]
}

export function sameChord(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/** All chords a row responds to: the user's bindings, `[]` when unbound, or the default. */
export function activeChords(entry: ShortcutEntry, bindings?: ShortcutBindings): ShortcutChord[] {
  if (!entry.id || !bindings || !Object.prototype.hasOwnProperty.call(bindings, entry.id)) {
    return [entry.keys]
  }
  const custom = bindings[entry.id]
  if (!Array.isArray(custom)) return [entry.keys]
  if (custom.length === 0) return []
  if (typeof custom[0] === 'string') {
    const chord = (custom as unknown[]).filter(
      (key): key is string => typeof key === 'string' && key.length > 0
    )
    return chord.length > 0 ? [chord] : []
  }
  const chords: ShortcutChord[] = []
  const seen = new Set<string>()
  for (const candidate of custom) {
    if (!Array.isArray(candidate)) continue
    const chord = candidate.filter(
      (key): key is string => typeof key === 'string' && key.length > 0
    )
    if (chord.length === 0) continue
    const signature = chord.join('+')
    if (seen.has(signature)) continue
    seen.add(signature)
    chords.push(chord)
  }
  return chords
}

/** The primary chord a row displays in menus and launcher hints, or `[]` when unbound. */
export function activeKeys(entry: ShortcutEntry, bindings?: ShortcutBindings): string[] {
  return activeChords(entry, bindings)[0] ?? []
}

/** All chords currently bound to an id, falling back to the table default. */
export function chordsFor(id: ShortcutId, bindings?: ShortcutBindings): ShortcutChord[] {
  const entry = SHORTCUTS.find((item) => item.id === id)
  return entry ? activeChords(entry, bindings) : []
}

/** The primary chord currently bound to an id, or `[]` when unbound. */
export function keysFor(id: ShortcutId, bindings?: ShortcutBindings): string[] {
  return chordsFor(id, bindings)[0] ?? []
}

export function matchesShortcut(event: KeyboardEvent, keys: string[]): boolean {
  if (keys.length === 0) return false
  const chord = chordFromEvent(event)
  if (!chord || chord.length !== keys.length) return false
  return chord.every((key, index) => key === keys[index])
}

/** Whether `event` matches any chord currently bound to `id`. */
export function matchesAnyShortcut(
  event: KeyboardEvent,
  id: ShortcutId,
  bindings?: ShortcutBindings
): boolean {
  return chordsFor(id, bindings).some((chord) => matchesShortcut(event, chord))
}

/** Whether an entry's active bindings differ from its built-in default. */
export function isCustomizedShortcut(entry: ShortcutEntry, bindings?: ShortcutBindings): boolean {
  if (!entry.id || !bindings || !Object.prototype.hasOwnProperty.call(bindings, entry.id)) {
    return false
  }
  const current = activeChords(entry, bindings)
  return !(current.length === 1 && sameChord(current[0], entry.keys))
}

export function hasAnyCustomShortcut(bindings?: ShortcutBindings): boolean {
  return SHORTCUTS.some((entry) => isCustomizedShortcut(entry, bindings))
}

/** Normalize a chord list for persistence; returns `undefined` when matching the default. */
export function serializeChords(
  entry: ShortcutEntry,
  chords: ShortcutChord[]
): ShortcutBindingValue | undefined {
  const deduped: ShortcutChord[] = []
  const seen = new Set<string>()
  for (const chord of chords) {
    if (chord.length === 0) continue
    const signature = chord.join('+')
    if (seen.has(signature)) continue
    seen.add(signature)
    deduped.push(chord)
  }
  if (deduped.length === 1 && sameChord(deduped[0], entry.keys)) return undefined
  if (deduped.length === 1) return deduped[0]
  return deduped
}

/** The row already wearing this chord, so a binding cannot run two actions. */
export function conflictingShortcut(
  id: ShortcutId,
  chord: string[],
  bindings?: ShortcutBindings
): ShortcutEntry | undefined {
  if (sameChord(chord, ['Ctrl', 'Enter'])) {
    return SHORTCUTS.find((entry) => entry.group === 'Composing' && entry.label === 'Send the message')
  }
  if (chord.length === 2 && chord[0] === 'Ctrl' && /^[1-9]$/.test(chord[1])) {
    return SHORTCUTS.find((entry) => !entry.id && entry.group === 'Workspace')
  }
  return SHORTCUTS.find((entry) => {
    if (!entry.id || entry.id === id || entry.keySeparator === 'or') return false
    return activeChords(entry, bindings).some((existing) => sameChord(existing, chord))
  })
}

/** Filter helper for the shortcut search box across labels, groups and chords. */
export function matchesShortcutSearch(
  entry: ShortcutEntry,
  query: string,
  bindings: ShortcutBindings | undefined,
  translate: (text: string) => string,
  platform?: string
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const compactNeedle = needle.replace(/[\s+]+/g, '')
  const haystack = [
    entry.label,
    translate(entry.label),
    entry.group,
    translate(entry.group)
  ]
  const chords = entry.id ? activeChords(entry, bindings) : [entry.keys]
  if (chords.length === 0) {
    haystack.push('Not set', translate('Not set'))
  } else if (entry.keySeparator === 'or') {
    haystack.push(
      entry.keys.map((key) => formatPlatformShortcut(key, platform)).join(' '),
      entry.keys.join(' ')
    )
  } else {
    for (const chord of chords) {
      haystack.push(
        formatChord(chord, platform),
        formatChord(chord),
        chord.join('+')
      )
    }
  }
  return haystack.some((candidate) => {
    const lower = candidate.toLowerCase()
    if (lower.includes(needle)) return true
    return compactNeedle.length > 0 && lower.replace(/[\s+]+/g, '').includes(compactNeedle)
  })
}

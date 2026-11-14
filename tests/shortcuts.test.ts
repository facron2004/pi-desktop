import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SHORTCUTS,
  activeChords,
  activeKeys,
  chordsFor,
  conflictingShortcut,
  chordFromEvent,
  entriesForDisplay,
  formatChord,
  hasAnyCustomShortcut,
  isCustomizedShortcut,
  keysFor,
  matchesAnyShortcut,
  matchesShortcutSearch,
  serializeChords
} from '../src/renderer/src/lib/shortcuts'
import { translate } from '../src/renderer/src/lib/i18n'

function fakeKeyEvent(init: {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  shiftKey?: boolean
  altKey?: boolean
}): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: Boolean(init.ctrlKey),
    metaKey: Boolean(init.metaKey),
    shiftKey: Boolean(init.shiftKey),
    altKey: Boolean(init.altKey)
  } as KeyboardEvent
}

test('multi-chord, legacy single-chord, and unbound shortcut bindings resolve cleanly', () => {
  const newChat = SHORTCUTS.find((entry) => entry.id === 'new-chat')!

  assert.deepEqual(activeChords(newChat, undefined), [['Ctrl', 'N']])
  assert.deepEqual(chordsFor('new-chat', { 'new-chat': ['Ctrl', 'Alt', 'N'] }), [
    ['Ctrl', 'Alt', 'N']
  ])
  assert.deepEqual(
    chordsFor('new-chat', {
      'new-chat': [
        ['Ctrl', 'N'],
        ['Ctrl', 'Shift', 'O'],
        ['Ctrl', 'Shift', 'L'],
        ['Ctrl', 'N']
      ]
    }),
    [
      ['Ctrl', 'N'],
      ['Ctrl', 'Shift', 'O'],
      ['Ctrl', 'Shift', 'L']
    ]
  )
  assert.deepEqual(chordsFor('new-chat', { 'new-chat': [] }), [])
  assert.deepEqual(keysFor('new-chat', { 'new-chat': [] }), [])
  assert.deepEqual(activeKeys(newChat, { 'new-chat': [['Ctrl', 'Shift', 'O'], ['Ctrl', 'N']] }), [
    'Ctrl',
    'Shift',
    'O'
  ])
})

test('matchesAnyShortcut matches every chord on an action and skips unbound actions', () => {
  const bindings = {
    'new-chat': [
      ['Ctrl', 'N'],
      ['Ctrl', 'Shift', 'O']
    ],
    'toggle-sidebar': []
  }

  assert.equal(
    matchesAnyShortcut(fakeKeyEvent({ key: 'n', ctrlKey: true }), 'new-chat', bindings),
    true
  )
  assert.equal(
    matchesAnyShortcut(
      fakeKeyEvent({ key: 'o', ctrlKey: true, shiftKey: true }),
      'new-chat',
      bindings
    ),
    true
  )
  assert.equal(
    matchesAnyShortcut(fakeKeyEvent({ key: 'b', ctrlKey: true }), 'toggle-sidebar', bindings),
    false
  )
})

test('conflictingShortcut respects multi-chords, unbound entries, and project switcher keys', () => {
  const bindings = {
    'new-chat': [
      ['Ctrl', 'N'],
      ['Ctrl', 'Shift', 'O']
    ],
    'focus-composer': []
  }

  assert.equal(conflictingShortcut('toggle-sidebar', ['Ctrl', 'Shift', 'O'], bindings)?.id, 'new-chat')
  assert.equal(conflictingShortcut('toggle-sidebar', ['Ctrl', 'K'], bindings), undefined)
  assert.equal(
    conflictingShortcut('toggle-sidebar', ['Ctrl', '1'], bindings)?.label,
    'Switch to another project'
  )
})

test('Ctrl or Meta Enter stays reserved for sending in both Composer modes', () => {
  for (const sendShortcut of ['enter', 'ctrlEnter'] as const) {
    const send = entriesForDisplay(sendShortcut).find((entry) => entry.label === 'Send the message')
    assert.ok(send)
    assert.equal(
      conflictingShortcut('toggle-sidebar', ['Ctrl', 'Enter'])?.label,
      send.label,
      `${sendShortcut} mode must reject an app binding on the send chord`
    )
  }

  assert.deepEqual(chordFromEvent(fakeKeyEvent({ key: 'Enter', ctrlKey: true })), ['Ctrl', 'Enter'])
  assert.deepEqual(chordFromEvent(fakeKeyEvent({ key: 'Enter', metaKey: true })), ['Ctrl', 'Enter'])
})

test('serializeChords and customization detection round-trip defaults and multi-chords', () => {
  const newChat = SHORTCUTS.find((entry) => entry.id === 'new-chat')!

  assert.equal(serializeChords(newChat, [['Ctrl', 'N']]), undefined)
  assert.deepEqual(serializeChords(newChat, [['Ctrl', 'Alt', 'N']]), ['Ctrl', 'Alt', 'N'])
  assert.deepEqual(
    serializeChords(newChat, [
      ['Ctrl', 'N'],
      ['Ctrl', 'Shift', 'O']
    ]),
    [
      ['Ctrl', 'N'],
      ['Ctrl', 'Shift', 'O']
    ]
  )
  assert.deepEqual(serializeChords(newChat, []), [])

  assert.equal(isCustomizedShortcut(newChat, { 'new-chat': [['Ctrl', 'N']] }), false)
  assert.equal(isCustomizedShortcut(newChat, { 'new-chat': [] }), true)
  assert.equal(
    hasAnyCustomShortcut({
      'new-chat': [
        ['Ctrl', 'N'],
        ['Ctrl', 'Shift', 'O']
      ]
    }),
    true
  )
  assert.equal(hasAnyCustomShortcut(undefined), false)
})

test('formatChord and search match English, localized labels, and compact chord queries', () => {
  assert.equal(formatChord(['Ctrl', 'Shift', 'P']), 'Ctrl + Shift + P')
  assert.equal(formatChord(['Ctrl', 'Shift', 'P'], 'darwin'), '⌘ + Shift + P')

  const focusComposer = SHORTCUTS.find((entry) => entry.id === 'focus-composer')!
  const zh = (text: string) => translate(text, 'zh-CN')

  assert.equal(matchesShortcutSearch(focusComposer, '聚焦', undefined, zh), true)
  assert.equal(matchesShortcutSearch(focusComposer, 'composer', undefined, zh), true)
  assert.equal(matchesShortcutSearch(focusComposer, 'ctrl k', undefined, zh), true)
  assert.equal(matchesShortcutSearch(focusComposer, 'ctrl+k', undefined, zh), true)
  assert.equal(matchesShortcutSearch(focusComposer, '未设置', { 'focus-composer': [] }, zh), true)
  assert.equal(matchesShortcutSearch(focusComposer, 'nonexistent', undefined, zh), false)
})

test('entriesForDisplay reflects sendShortcut mode in Composing', () => {
  const ctrlEnterEntries = entriesForDisplay('ctrlEnter')
  const send = ctrlEnterEntries.find((entry) => entry.label === 'Send the message')
  const newline = ctrlEnterEntries.find((entry) => entry.label === 'Insert a line break')

  assert.deepEqual(send?.keys, ['Ctrl', 'Enter'])
  assert.deepEqual(newline?.keys, ['Enter'])
})

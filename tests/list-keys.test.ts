import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { listSelectionAfter } from '../src/renderer/src/lib/list-keys'

/**
 * The composer's two lists only honoured Up/Down. A project's `@` list runs to
 * thousands of rows and the command list to dozens (21 app commands before any
 * skill or extension adds one), so reaching the last row meant holding the
 * arrow key — and the box's Home/End moved the caret instead of the highlight.
 */

test('up and down still wrap around the list', () => {
  assert.equal(listSelectionAfter('ArrowDown', 0, 3), 1)
  assert.equal(listSelectionAfter('ArrowDown', 2, 3), 0)
  assert.equal(listSelectionAfter('ArrowUp', 0, 3), 2)
  assert.equal(listSelectionAfter('ArrowUp', 2, 3), 1)
})

test('home and end jump to the ends from anywhere', () => {
  assert.equal(listSelectionAfter('Home', 7, 21), 0)
  assert.equal(listSelectionAfter('End', 0, 21), 20)
  assert.equal(listSelectionAfter('End', 20, 21), 20)
})

test('page keys move by the rows the list shows, and stop at the ends', () => {
  assert.equal(listSelectionAfter('PageDown', 0, 21, 8), 8)
  assert.equal(listSelectionAfter('PageDown', 16, 21, 8), 20)
  assert.equal(listSelectionAfter('PageUp', 20, 21, 8), 12)
  assert.equal(listSelectionAfter('PageUp', 3, 21, 8), 0)
  // A page of zero or a fraction still moves at least one row.
  assert.equal(listSelectionAfter('PageDown', 0, 21, 0), 1)
  assert.equal(listSelectionAfter('PageDown', 0, 21, 2.9), 2)
})

test('an index outside the list is brought inside before the move', () => {
  assert.equal(listSelectionAfter('ArrowDown', 99, 3), 0)
  assert.equal(listSelectionAfter('PageUp', 99, 3, 2), 0)
  assert.equal(listSelectionAfter('ArrowUp', -4, 3), 2)
})

test('a key that is not a list key is left to the textarea', () => {
  // Home/End/PageUp/PageDown with no list open are the draft's own keys; the
  // caller only reaches this function while a list is up.
  assert.equal(listSelectionAfter('Enter', 0, 3), undefined)
  assert.equal(listSelectionAfter('Escape', 0, 3), undefined)
  assert.equal(listSelectionAfter('a', 0, 3), undefined)
  assert.equal(listSelectionAfter('Home', 0, 0), undefined, 'an empty list has nowhere to move')
})

test('both lists read their page step from their own rows, and the composer wires the keys', () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')
  const composer = read('src/renderer/src/components/Composer.tsx')
  const palette = read('src/renderer/src/components/CommandPalette.tsx')
  const mention = read('src/renderer/src/components/FileMention.tsx')
  assert.match(palette, /className="palette__list" data-list-rows/, 'the command list does not mark its rows')
  assert.match(mention, /className="mention__list" ref=\{listRef\} data-list-rows/, 'the file list does not mark its rows')
  assert.match(composer, /listRows\(commandListId\)/, 'the command list key handling does not read the palette rows')
  assert.match(composer, /listRows\(mentionListId\)/, 'the file list key handling does not read its rows')
  assert.equal(
    [...composer.matchAll(/listSelectionAfter\(/g)].length,
    2,
    'both the command palette and the file list must move through the shared rule'
  )
})

/**
 * The box is the combobox: `role="combobox"`, `aria-controls` the open list and
 * `aria-activedescendant` names the highlighted row. The rows themselves are
 * therefore not Tab stops, and Shift+Tab walks back out of the box instead of
 * accepting whatever row it happened to point at.
 */
test('the rows are not Tab stops, and Shift+Tab leaves instead of accepting', () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')
  const composer = read('src/renderer/src/components/Composer.tsx')
  const palette = read('src/renderer/src/components/CommandPalette.tsx')
  const mention = read('src/renderer/src/components/FileMention.tsx')
  for (const [name, source] of [['command palette', palette], ['file list', mention]]) {
    assert.match(
      source,
      /role="option"[\s\S]{0,400}?tabIndex=\{-1\}/,
      `a ${name} row is a Tab stop of its own`
    )
  }
  assert.match(composer, /role="combobox"/, 'the input box is no longer the combobox')
  assert.equal(
    [...composer.matchAll(/event\.key === 'Tab' && event\.shiftKey/g)].length,
    2,
    'both lists must let Shift+Tab leave the box'
  )
  assert.equal(
    [...composer.matchAll(/event\.key === 'Tab' \|\| \(event\.key === 'Enter' && !event\.shiftKey\)\)/g)].length,
    2,
    'plain Tab must still accept the highlighted row in both lists'
  )
})

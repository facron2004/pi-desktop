import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { rowIndexAfterKey } from '../src/renderer/src/lib/row-nav'

/**
 * Row lists beyond the ones that already had arrows — the two changed-file
 * lists (Review page and the tool panel's File changes page) — walk with the
 * same rule, so a reader looking at twenty changed files can move through them
 * without twenty presses of Down. The rule is bounded: an arrow at the end
 * stops, because a list that also drives a preview must not jump back to the
 * top.
 */

test('the arrows move one row and stop at the ends', () => {
  assert.equal(rowIndexAfterKey('ArrowDown', 0, 3), 1)
  assert.equal(rowIndexAfterKey('ArrowDown', 2, 3), 2, 'the last row does not wrap')
  assert.equal(rowIndexAfterKey('ArrowUp', 0, 3), 0, 'the first row does not wrap')
  assert.equal(rowIndexAfterKey('ArrowUp', 2, 3), 1)
})

test('home and end jump to the ends', () => {
  assert.equal(rowIndexAfterKey('Home', 2, 5), 0)
  assert.equal(rowIndexAfterKey('End', 0, 5), 4)
  assert.equal(rowIndexAfterKey('End', 4, 5), 4)
})

test('keys the list does not own are left to the row', () => {
  for (const key of ['Enter', ' ', 'Tab', 'Escape', 'a', 'PageDown']) {
    assert.equal(rowIndexAfterKey(key, 1, 3), undefined, key)
  }
  assert.equal(rowIndexAfterKey('ArrowDown', 0, 0), undefined, 'an empty list has nowhere to move')
  assert.equal(rowIndexAfterKey('ArrowDown', -1, 3), undefined)
  assert.equal(rowIndexAfterKey('ArrowDown', 3, 3), undefined, 'a stale index is not a row')
})

test('both changed-file lists mark their rows and use the shared rule', () => {
  const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')
  const review = read('src/renderer/src/components/ReviewView.tsx')
  const inspector = read('src/renderer/src/components/InspectorPanel.tsx')
  const scheduled = read('src/renderer/src/components/ScheduledTasksDialog.tsx')
  for (const [name, source] of [['ReviewView', review], ['InspectorPanel', inspector]]) {
    assert.match(source, /data-change-file=/, `${name} rows carry no marker`)
    assert.match(
      source,
      /rowIndexAfterKey\(event\.key, rows\.indexOf\(target\), rows\.length\)/,
      `${name} does not walk its rows with the shared rule`
    )
    assert.match(source, /rows\[next\]\.focus\(\)/, `${name} does not move the focus`)
    assert.match(source, /rows\[next\]\.click\(\)/, `${name} does not show the file it moved to`)
  }
  // The scheduled list was the first bounded row column; it now shares the rule
  // instead of keeping its own copy of it.
  assert.match(scheduled, /rowIndexAfterKey\(event\.key, rows\.indexOf\(target\), rows\.length\)/)
  assert.doesNotMatch(scheduled, /event\.key === 'Home'\s*\?/, 'the scheduled list kept its own copy')
})

test('the commit history walks its rows without applying a message', () => {
  const source = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/CommitDialog.tsx'),
    'utf8'
  )
  assert.match(source, /data-commit-row=\{commit\.hash\}/, 'the history rows carry no marker')
  assert.match(
    source,
    /rowIndexAfterKey\(event\.key, rows\.indexOf\(target\), rows\.length\)/,
    'the history does not walk its rows with the shared rule'
  )
  assert.match(source, /rows\[next\]\.focus\(\)/, 'the history does not move the focus')
  // An arrow is a look, not a pick: Enter on the row is still the way to apply.
  assert.doesNotMatch(source, /rows\[next\]\.click\(\)/, 'an arrow applies the commit message')
})

test('the commit detail file list walks its rows without opening a diff', () => {
  const source = readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/CommitDetailDialog.tsx'),
    'utf8'
  )
  assert.match(
    source,
    /data-commit-detail-row=\{file\.path\}/,
    'the detail rows carry no marker'
  )
  assert.match(
    source,
    /rowIndexAfterKey\(event\.key, rows\.indexOf\(target\), rows\.length\)/,
    'the detail list does not walk its rows with the shared rule'
  )
  assert.match(source, /rows\[next\]\.focus\(\)/, 'the detail list does not move the focus')
  // Expanding a file reads it from git; an arrow must not trigger that read.
  assert.doesNotMatch(source, /rows\[next\]\.click\(\)/, 'an arrow expands the file diff')
})

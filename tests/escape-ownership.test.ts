import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Escape is the stop key while an agent runs.
 *
 * `Composer` listens on the window and stops the run on any Escape that nobody
 * has marked as handled (`event.defaultPrevented`). Everything else that closes
 * on Escape therefore has to `preventDefault()` — otherwise cancelling a rename
 * or dismissing a tip would end the run the reader is waiting on.
 *
 * These are source assertions because the rule is about how a handler treats
 * the event, not about a value a unit can compute; the real key press is driven
 * by `output/audit/check-escape-ownership.mjs`.
 */
const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), 'utf8')

test('the composer stops a run only on an escape nobody handled', () => {
  const composer = read('src/renderer/src/components/Composer.tsx')
  assert.match(
    composer,
    /if \(event\.defaultPrevented\) return/,
    'the composer no longer checks whether another control handled Escape'
  )
  assert.match(composer, /stopCurrent\(\)/, 'the composer no longer stops the run')
})

test('a project rename marks its Escape as handled', () => {
  const sidebar = read('src/renderer/src/components/Sidebar.tsx')
  // A tempered window: the handler must call preventDefault before it closes
  // the field. Without the temper this matches the old unprevented branch.
  const body = /e\.key === 'Escape'\) \{((?:(?!preventDefault)[\s\S]){0,240}?)setRenamingProjectId\(null\)/
  assert.doesNotMatch(sidebar, body, 'cancelling a project rename no longer marks Escape as handled')
})

test('the update tip and the hover card consume Escape', () => {
  const sidebar = read('src/renderer/src/components/Sidebar.tsx')
  assert.match(
    sidebar,
    /event\.key !== 'Escape'\) return[\s\S]{0,200}?event\.preventDefault\(\)[\s\S]{0,80}?clear\(\)/,
    'the update tip dismisses without marking Escape as handled'
  )
  const tip = read('src/renderer/src/components/SidebarTip.tsx')
  assert.match(
    tip,
    /event\.key !== 'Escape'\) return[\s\S]{0,200}?event\.preventDefault\(\)[\s\S]{0,80}?dismiss\(\)/,
    'the hover card dismisses without marking Escape as handled'
  )
})

test('the tab menu consumes Escape while it is open', () => {
  const panel = read('src/renderer/src/components/ToolPanel.tsx')
  assert.match(
    panel,
    /event\.key !== 'Escape'\) return[\s\S]{0,200}?event\.preventDefault\(\)[\s\S]{0,80}?close\(\)/,
    'the tab menu closes without marking Escape as handled'
  )
})

test('the side-chat selection bar consumes Escape only while it is up', () => {
  const bar = read('src/renderer/src/components/side-chat/ThreadSelectionBar.tsx')
  assert.match(
    bar,
    /if \(!targetRef\.current\) return[\s\S]{0,200}?event\.preventDefault\(\)/,
    'the selection bar swallows Escape when it has nothing to close'
  )
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
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

test('the in-thread hover card consumes Escape only while it is showing', () => {
  const tip = read('src/renderer/src/components/HoverTip.tsx')
  assert.match(
    tip,
    /if \(state\.visible\) event\.preventDefault\(\)/,
    'the hover card hides without marking Escape as handled while it is on screen'
  )
})

test('a branch rename marks its Escape as handled', () => {
  const menu = read('src/renderer/src/components/BranchMenu.tsx')
  assert.match(
    menu,
    /event\.key === 'Escape'\) \{[\s\S]{0,200}?event\.preventDefault\(\)[\s\S]{0,120}?event\.stopPropagation\(\)/,
    'cancelling a branch name stops the event but leaves it unmarked'
  )
})

/**
 * The net under the rule: any handler that reacts to Escape has to say so.
 *
 * This is a coarse check — a marking call within one screenful of the branch is
 * enough — but it catches the shape that caused the last three bugs, where a
 * new handler closes something and lets the key travel on to the stop handler.
 * Two files are exempt by nature: `TrayPopup` runs in its own window, and
 * `lib/shortcuts.ts` only turns a key into a label.
 */
test('every Escape handler marks the key', () => {
  const exempt = new Set(['TrayPopup.tsx', 'shortcuts.ts'])
  const misses: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(ts|tsx)$/.test(entry) || exempt.has(entry)) continue
      const source = readFileSync(full, 'utf8')
      for (const match of source.matchAll(/'Escape'/g)) {
        const at = match.index ?? 0
        const tail = source.slice(at, at + 1800)
        if (/preventDefault|stopPropagation|stopImmediatePropagation/.test(tail)) continue
        const line = source.slice(0, at).split('\n').length
        misses.push(`${path.relative(process.cwd(), full)}:${line}`)
      }
    }
  }
  walk(path.resolve(process.cwd(), 'src/renderer/src'))
  assert.deepEqual(
    misses,
    [],
    `these handlers react to Escape without marking the key: ${misses.join(', ')}`
  )
})

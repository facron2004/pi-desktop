import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/**
 * The 「对话」 head is one inline fold control.
 *
 * The caret used to sit at the right end of a full-width head, next to a
 * separate name, and hovering the caret painted a pill of its own. The reader
 * asked for the name and the arrow to be one compact trigger with no bubble:
 * both fold heads now put the label and the caret inside the button, and the
 * button never paints a surface.
 */
const root = path.resolve(process.cwd())
const sidebar = readFileSync(
  path.join(root, 'src/renderer/src/components/Sidebar.tsx'),
  'utf8'
)
const css = readFileSync(path.join(root, 'src/renderer/src/styles/global.css'), 'utf8')

test('both chats heads put the label and the caret inside one fold button', () => {
  const folds = [...sidebar.matchAll(/<button[\s\S]*?className="sidebar__section-fold"[\s\S]*?<\/button>/g)]
  assert.equal(folds.length, 2, 'expected the single list and the projectless list to fold')
  for (const [markup] of folds) {
    assert.match(markup, /className="sidebar__section-title"/, 'the label is not part of the trigger')
    assert.match(markup, /className="sidebar__section-caret"/, 'the caret is not part of the trigger')
  }
  assert.doesNotMatch(sidebar, /sidebar__section-toggle/, 'the old right-end caret button is still there')
})

test('the fold trigger paints no bubble, at rest or while pressed', () => {
  assert.doesNotMatch(css, /\.sidebar__section-toggle/, 'the old caret button styles are still there')
  const rule = (selector: RegExp) => selector.exec(css)?.[1] ?? ''
  const base = rule(/\.sidebar__section-head > \.sidebar__section-fold \{([\s\S]*?)\}/)
  assert.match(base, /background: transparent/, 'the fold trigger has a surface at rest')
  const pressed = rule(
    /\.sidebar__section-head > \.sidebar__section-fold:hover,\s*\.sidebar__section-head > \.sidebar__section-fold:active \{([\s\S]*?)\}/
  )
  assert.match(pressed, /background: transparent/, 'the fold trigger paints a bubble on hover or press')
})

/**
 * The branch menu's worktree button has been removed twice by "refinements"
 * that folded it into a checkbox inside the create-branch form. The renderer
 * has no DOM in this suite, so this guard reads the component source: the
 * visible button, its creation form and the worktree list/removal must stay.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const source = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/src/components/BranchMenu.tsx'),
  'utf8'
)

test('the branch menu keeps a visible worktree button', () => {
  assert.match(source, /data-worktree-button/, 'the worktree action needs a stable, visible button')
  assert.match(source, /t\('Add worktree…'\)/, 'the button must be labelled as a worktree action')
  assert.match(source, /t\('Create worktree'\)/, 'the button must open a worktree creation form')
  assert.match(source, /window\.pi\.git\.addWorktree/, 'creating a worktree must reach the git bridge')
})

test('the branch menu lists and can remove worktrees', () => {
  assert.match(source, /t\('Worktrees'\)/, 'existing worktrees must be listed')
  assert.match(
    source,
  /data\?\.worktrees && data\.worktrees\.length > 1 && filteredWorktrees\.length > 0/,
    'a search with one worktree match must keep that row visible'
  )
  assert.match(source, /window\.pi\.git\.removeWorktree/, 'a worktree row must be removable')
  assert.match(source, /await removeWorkspace\(\{ path: target\.path \}\)/, 'removing a worktree must remove its project registration')
  assert.match(source, /ConfirmDialog/, 'removal must ask for confirmation')
})

test('the worktree action is not a checkbox in the branch form', () => {
  assert.doesNotMatch(source, /useWorktree/, 'the visible button must not be replaced by a hidden toggle')
  assert.doesNotMatch(source, /branch-menu__worktree-toggle/, 'the checkbox style must not come back')
})

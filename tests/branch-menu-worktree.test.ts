/**
 * Adding a worktree is its own checkbox under the branch list. Checking it
 * only arms the next session; the folder is created when that session starts.
 * It must not go back to a name/path form, and it must not be folded into the
 * create-branch form, where it was hidden twice. The renderer has no DOM in
 * this suite, so the guard reads the source.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const source = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/src/components/BranchMenu.tsx'),
  'utf8'
)
const store = readFileSync(
  path.resolve(process.cwd(), 'src/renderer/src/store/useAppStore.ts'),
  'utf8'
)

test('checking the worktree box waits for the session to start', () => {
  assert.match(source, /data-worktree-button/, 'the worktree action needs a stable, visible control')
  assert.match(source, /role="menuitemcheckbox"/, 'the control is a checkbox, not a form opener')
  assert.match(source, /aria-checked=\{pendingWorktree\}/, 'clicking it has to check the box')
  assert.match(source, /setPendingWorktree\(!pendingWorktree\)/, 'the click only arms the checkbox')
  assert.match(source, /t\('Add worktree'\)/, 'the row must be labelled as adding a worktree')
  assert.doesNotMatch(source, /addWorktree/, 'the menu must not create the worktree on click')
  assert.doesNotMatch(source, /showWorktree/, 'the name and path form must not come back')
  assert.doesNotMatch(source, /t\('Branch for the worktree'\)/, 'the branch field must not come back')
  assert.match(
    store,
    /pendingWorktree && !conversationStarted\(state\.items\)/,
    'the worktree is created only when an empty conversation starts'
  )
  assert.match(
    store,
    /window\.pi\.git\.addWorktree\('', name, true, source\)/,
    'session start creates a worktree on a new branch in a sibling folder'
  )
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

test('the worktree checkbox is not folded into the branch form', () => {
  const formStart = source.indexOf('branch-menu__create-form')
  const actionsStart = source.indexOf('branch-menu__footer-actions')
  assert.ok(formStart >= 0 && actionsStart > formStart)
  const form = source.slice(formStart, actionsStart)
  assert.doesNotMatch(form, /addWorktree/, 'creating a branch must not be what creates the worktree')
  assert.doesNotMatch(source, /useWorktree/, 'the old hidden toggle must not come back')
  assert.doesNotMatch(source, /branch-menu__worktree-toggle/, 'the old toggle class must not come back')
})

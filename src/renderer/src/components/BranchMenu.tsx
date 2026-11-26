import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { Check, FileDiff, GitFork, Loader2, Plus, Search, Trash2, X } from 'lucide-react'
import type { GitBranches, GitWorktree } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { basename } from '../lib/path'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'
import { ConfirmDialog } from './ConfirmDialog'
import { BranchMark } from './BranchMark'
import '../styles/branch-menu.css'

/**
 * The branch chip and direct branch switcher menu.
 *
 * Structure:
 * - Top: Instant search box with clear button
 * - Middle: Branch list with changed files count badge on the SAME line as the branch
 * - Worktrees: the other checkouts of the repository, each one a switch target
 * - Bottom: "Create and checkout branch", and a worktree checkbox beside it.
 *   Checking the box only arms the next session. The worktree is created when
 *   that empty conversation sends its first prompt, not when the box is ticked.
 */
export const BranchMenu = memo(function BranchMenu({
  onOpenChanges,
  placement = 'top',
  align = 'left'
}: {
  onOpenChanges: () => void
  placement?: 'top' | 'bottom' | 'right'
  align?: 'left' | 'right'
}) {
  const gitChipRef = useRef<HTMLButtonElement>(null)
  const git = useAppStore((state) => state.git)
  const workspace = useAppStore((state) => state.workspace)
  const expectedRoot = workspace?.path ?? ''
  const refreshGit = useAppStore((state) => state.refreshGit)
  const switchProject = useAppStore((state) => state.switchProject)
  const removeWorkspace = useAppStore((state) => state.removeWorkspace)
  const showToast = useAppStore((state) => state.showToast)
  const pendingWorktree = useAppStore((state) => state.pendingWorktree)
  const setPendingWorktree = useAppStore((state) => state.setPendingWorktree)
  const t = useT()

  const [loaded, setLoaded] = useState<{ root: string; data: GitBranches }>()
  const data = loaded?.root === expectedRoot ? loaded.data : undefined
  const loadRequest = useRef(0)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [worktreeToRemove, setWorktreeToRemove] = useState<{ worktree: GitWorktree; root: string }>()

  const restoreFocus = () => requestAnimationFrame(() => gitChipRef.current?.focus())

  const load = useCallback(async () => {
    const request = ++loadRequest.current
    setLoading(true)
    setLoadError(false)
    try {
      const data = await window.pi.git.branches(expectedRoot)
      if (request === loadRequest.current) setLoaded({ root: expectedRoot, data })
    } catch {
      if (request === loadRequest.current) {
        setLoaded(undefined)
        setLoadError(true)
      }
    } finally {
      if (request === loadRequest.current) setLoading(false)
    }
  }, [expectedRoot])

  const filteredBranches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!data?.branches) return []
    if (!q) return data.branches
    return data.branches.filter((b) => b.name.toLowerCase().includes(q))
  }, [data?.branches, searchQuery])

  const filteredWorktrees = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!data?.worktrees) return []
    if (!q) return data.worktrees
    return data.worktrees.filter(
      (w) =>
        basename(w.path).toLowerCase().includes(q) ||
        (w.branch && w.branch.toLowerCase().includes(q))
    )
  }, [data?.worktrees, searchQuery])

  if (!git?.isRepo) return null

  const chooseBranch = async (name: string, close: () => void) => {
    if (busy) return
    if (name === data?.current) {
      close()
      return
    }
    setBusy(name)
    try {
      // A branch already checked out in another worktree cannot be switched to
      // here; go to that worktree instead, which is what its row means.
      const existingWorktree = data?.worktrees.find(
        (worktree) => worktree.branch === name && !worktree.current
      )
      if (existingWorktree) {
        await switchProject(existingWorktree.path, { allowWhileRunning: true })
        close()
        return
      }

      const result = await window.pi.git.switchBranch(name, expectedRoot)
      if (!result.ok) {
        showToast(result.error ?? t('Could not switch branch'), 'error')
        return
      }
      await refreshGit()
      await load()
      showToast(`${t('Switched to')} ${name}`)
      close()
    } finally {
      setBusy(undefined)
    }
  }

  const createNewBranch = async (close: () => void) => {
    const name = newBranch.trim()
    if (!name || busy) return
    setBusy('create')
    try {
      const result = await window.pi.git.createBranch(name, true, expectedRoot)
      if (!result.ok) {
        showToast(result.error ?? t('Could not create the branch'), 'error')
        return
      }
      await refreshGit()
      await load()
      setNewBranch('')
      setShowNew(false)
      showToast(`${t('Created and switched to')} ${name}`)
      close()
    } finally {
      setBusy(undefined)
    }
  }

  const openWorktree = async (target: string, close: () => void) => {
    if (busy) return
    if (workspace && target === workspace.path) {
      close()
      return
    }
    setBusy(target)
    try {
      await switchProject(target, { allowWhileRunning: true })
      close()
    } finally {
      setBusy(undefined)
    }
  }

  const removeWorktree = async () => {
    const pending = worktreeToRemove
    if (!pending || busy) return
    const { worktree: target, root } = pending
    setBusy('remove-worktree')
    try {
      const result = await window.pi.git.removeWorktree(target.path, root)
      if (!result.ok) {
        showToast(result.error ?? t('Could not remove the worktree'), 'error')
        void load()
        return
      }
      setWorktreeToRemove(undefined)
      restoreFocus()
      if (result.settings) {
        await removeWorkspace({ path: target.path }, result.settings)
        showToast(`${t('Worktree removed')}: ${basename(target.path)}`)
      } else {
        showToast(t('The worktree was removed, but its project settings could not be saved.'), 'warning')
      }
      await Promise.allSettled([refreshGit(), load()])
    } catch {
      showToast(t('Could not remove the worktree'), 'error')
    } finally {
      setBusy(undefined)
    }
  }

  return [
    <Popover
      key="branch-menu"
      placement={placement}
      align={align}
      className="branch-menu--docked"
      width={232}
      renderTrigger={({ open, toggle }) => (
        <button
          ref={gitChipRef}
          type="button"
          className="session-bar__item git-chip"
          data-active={open}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-label={t('Configure local environment')}
          onClick={(event) => {
            if (!open) {
              setSearchQuery('')
              setShowNew(false)
              setNewBranch('')
              void load()
            }
            toggle(event)
          }}
          title={git.branch ? `${t('Branch')}: ${git.branch}` : t('Configure local environment')}
        >
          <BranchMark size={13} className="git-chip__icon" />
          <span className="git-chip__branch">
            {git.branch ?? (git.head ? `#${git.head}` : t('Repository'))}
          </span>
        </button>
      )}
    >
      {(close) => (
        <div className="branch-menu" role="menu">
          {/* Top Search Bar */}
          <div className="branch-menu__search">
            <Search size={13} className="branch-menu__search-icon" />
            <input
              type="text"
              className="branch-menu__search-input"
              placeholder={t('Search branches')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery ? (
              <button
                type="button"
                className="branch-menu__search-clear"
                onClick={() => setSearchQuery('')}
                aria-label="Clear"
              >
                <X size={11} />
              </button>
            ) : null}
          </div>

          <div className="branch-menu__divider" />

          {git.detached ? (
            <p className="branch-menu__note">
              {t('HEAD is detached. Switch to a branch so new commits are kept.')}
            </p>
          ) : null}

          {loadError ? (
            <p className="branch-menu__note" role="status">
              {t('Could not load branches and worktrees.')}
            </p>
          ) : null}

          {/* Branch List */}
          <div className="branch-menu__list">
            {filteredBranches.map((branch) => {
              const isCurrent = Boolean(branch.current)
              const hasUncommitted = isCurrent && (git.files?.length ?? 0) > 0
              return (
                <button
                  key={branch.name}
                  className="branch-menu__row"
                  data-current={isCurrent || undefined}
                  disabled={Boolean(busy)}
                  onClick={() => void chooseBranch(branch.name, close)}
                  title={branch.subject ?? branch.name}
                >
                  <BranchMark size={13} className="branch-menu__icon" />
                  <span className="branch-menu__name">{branch.name}</span>

                  {/* Branch & changed files on the exact SAME line */}
                  {hasUncommitted ? (
                    <span
                      className="branch-menu__changes-badge"
                      role="button"
                      tabIndex={0}
                      title={`${git.files.length} ${t('uncommitted files')} · ${t('Review changes')}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        close()
                        onOpenChanges()
                      }}
                    >
                      <FileDiff size={11} />
                      <span>{git.files.length}</span>
                    </span>
                  ) : null}

                  {isCurrent ? <Check size={12} className="branch-menu__check" /> : null}
                </button>
              )
            })}

            {!loading && filteredBranches.length === 0 ? (
              <div className="branch-menu__empty">{t('No matching branches')}</div>
            ) : null}

            {loading && !data ? (
              <div className="branch-menu__note">
                <Loader2 size={11} className="spin" /> {t('Reading the branches…')}
              </div>
            ) : null}
          </div>

          {/* Other checkouts of this repository. With only the current one the
              section says nothing, so it waits for a second worktree. */}
          {data?.worktrees && data.worktrees.length > 1 && filteredWorktrees.length > 0 ? (
            <>
              <div className="branch-menu__divider" />
              <div className="branch-menu__section-title">{t('Worktrees')}</div>
              <div className="branch-menu__list">
                {filteredWorktrees.map((worktree) => {
                  const name = basename(worktree.path)
                  const branch = worktree.branch ?? t('detached')
                  const dirty = typeof worktree.dirty === 'number' && worktree.dirty > 0
                  const dirtyLabel = dirty ? `${worktree.dirty} ${t('Uncommitted files')}` : ''
                  return (
                    <div className="branch-menu__worktree" key={worktree.path}>
                      <button
                        type="button"
                        className="branch-menu__row"
                        data-current={worktree.current || undefined}
                        disabled={Boolean(busy)}
                        aria-label={`${name}, ${branch}${dirtyLabel ? `, ${dirtyLabel}` : ''}`}
                        title={dirtyLabel ? `${worktree.path} · ${dirtyLabel}` : worktree.path}
                        onClick={() => (worktree.current ? close() : void openWorktree(worktree.path, close))}
                      >
                        <GitFork size={12} className="branch-menu__icon" />
                        <span className="branch-menu__name">{name}</span>
                        <span className="branch-menu__meta">{branch}</span>
                        {dirty ? (
                          <span className="branch-menu__changes-badge" aria-hidden="true">
                            {worktree.dirty}
                          </span>
                        ) : null}
                        {worktree.current ? <Check size={12} className="branch-menu__check" /> : null}
                      </button>
                      {!worktree.current ? (
                        <button
                          type="button"
                          className="branch-menu__worktree-remove"
                          data-dirty={dirty || undefined}
                          aria-disabled={Boolean(busy) || dirty}
                          aria-label={`${t('Remove worktree')}: ${name}${
                            dirty ? `, ${t('Commit or discard changes before removing')}` : ''
                          }`}
                          title={
                            dirty
                              ? t('Commit or discard changes before removing')
                              : busy
                                ? t('Working…')
                                : `${t('Remove worktree')}: ${worktree.path}`
                          }
                          onClick={() => {
                            if (!busy && !dirty) setWorktreeToRemove({ worktree, root: expectedRoot })
                          }}
                        >
                          <Trash2 size={12} />
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            </>
          ) : null}

          <div className="branch-menu__divider" />

          {/* Bottom actions. The worktree row is a checkbox: checking it is the
              create, not a door into another form. */}
          <div className="branch-menu__footer">
            {showNew ? (
              <form
                className="branch-menu__create-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void createNewBranch(close)
                }}
              >
                <div className="branch-menu__create-row">
                  <input
                    type="text"
                    className="branch-menu__create-input"
                    autoFocus
                    placeholder={t('Branch name')}
                    value={newBranch}
                    spellCheck={false}
                    onChange={(event) => setNewBranch(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        // The field owns Escape while it is open: mark it, or
                        // another handler that closes on Escape would also act.
                        event.preventDefault()
                        event.stopPropagation()
                        setShowNew(false)
                        setNewBranch('')
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="branch-menu__create-btn branch-menu__create-btn--submit"
                    disabled={!newBranch.trim() || Boolean(busy)}
                    title={t('Create and checkout branch')}
                  >
                    {busy === 'create' ? <Loader2 size={11} className="spin" /> : <Check size={12} />}
                  </button>
                  <button
                    type="button"
                    className="branch-menu__create-btn branch-menu__create-btn--cancel"
                    onClick={() => {
                      setShowNew(false)
                      setNewBranch('')
                    }}
                    title={t('Cancel')}
                  >
                    <X size={12} />
                  </button>
                </div>
              </form>
            ) : (
              <div className="branch-menu__footer-actions">
                <button
                  className="branch-menu__action-btn branch-menu__action-btn--primary"
                  type="button"
                  onClick={() => setShowNew(true)}
                >
                  <Plus size={13} strokeWidth={1.8} />
                  <span>{t('Create and checkout branch')}</span>
                </button>
                <button
                  className="branch-menu__action-btn branch-menu__action-btn--primary"
                  type="button"
                  role="menuitemcheckbox"
                  data-worktree-button
                  aria-checked={pendingWorktree}
                  disabled={Boolean(busy)}
                  title={t('The worktree is created when the session starts')}
                  onClick={() => setPendingWorktree(!pendingWorktree)}
                >
                  <span
                    className="branch-menu__check-box"
                    data-checked={pendingWorktree || undefined}
                    aria-hidden="true"
                  >
                    {pendingWorktree ? <Check size={11} /> : null}
                  </span>
                  <span>{t('Add worktree')}</span>
                </button>
              </div>
            )}
          </div>

          {busy && busy !== 'create' ? (
            <div className="branch-menu__busy">
              <Loader2 size={11} className="spin" />
              <span>{t('Working…')}</span>
            </div>
          ) : null}
        </div>
      )}
    </Popover>,
    worktreeToRemove ? (
      <ConfirmDialog
        key="remove-worktree"
        title={`${t('Remove worktree')}: ${basename(worktreeToRemove.worktree.path)}`}
        body={t('The worktree folder will be removed from disk. Its branch will remain.')}
        confirmLabel={busy === 'remove-worktree' ? 'Working…' : 'Remove worktree'}
        tone="danger"
        onCancel={() => {
          if (!busy) {
            setWorktreeToRemove(undefined)
            restoreFocus()
          }
        }}
        onConfirm={() => void removeWorktree()}
      />
    ) : null
  ]
})

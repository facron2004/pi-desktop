import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  FileDiff,
  GitFork,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
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
 * - Bottom: "Create and checkout new branch" button & inline creation form
 */
export function BranchMenu({
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
  const refreshGit = useAppStore((state) => state.refreshGit)
  const pushGit = useAppStore((state) => state.pushGit)
  const pullGit = useAppStore((state) => state.pullGit)
  const switchProject = useAppStore((state) => state.switchProject)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()

  const [data, setData] = useState<GitBranches | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [searchQuery, setSearchQuery] = useState('')
  const [showNew, setShowNew] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [worktreeToRemove, setWorktreeToRemove] = useState<GitWorktree | undefined>()

  const restoreFocus = () => requestAnimationFrame(() => gitChipRef.current?.focus())

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      setData(await window.pi.git.branches())
    } catch {
      setData(undefined)
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

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
      const result = await window.pi.git.switchBranch(name)
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
      const result = await window.pi.git.createBranch(name, true)
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
    const target = worktreeToRemove
    if (!target || busy) return
    setBusy('remove-worktree')
    try {
      const result = await window.pi.git.removeWorktree(target.path)
      if (!result.ok) {
        showToast(result.error ?? t('Could not remove the worktree'), 'error')
        void load()
        return
      }
      setWorktreeToRemove(undefined)
      restoreFocus()
      showToast(`${t('Worktree removed')}: ${basename(target.path)}`)
      await Promise.allSettled([refreshGit(), load()])
    } catch {
      showToast(t('Could not remove the worktree'), 'error')
    } finally {
      setBusy(undefined)
    }
  }

  const runPush = async () => {
    if (busy) return
    setBusy('push')
    try {
      await pushGit()
      await load()
    } finally {
      setBusy(undefined)
    }
  }

  const runPull = async () => {
    if (busy) return
    setBusy('pull')
    try {
      await pullGit()
      await load()
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
          className="session-bar__item git-chip"
          data-active={open}
          aria-expanded={open}
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
              autoFocus
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
              {t('Could not load branches and worktrees. Select Refresh to try again.')}
            </p>
          ) : null}

          {/* Branch List */}
          <div className="branch-menu__list">
            {filteredBranches.map((branch) => {
              const isCurrent = Boolean(branch.current)
              const hasUncommitted = isCurrent && git.files.length > 0
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

          {/* Worktrees if present */}
          {filteredWorktrees.length > 1 ? (
            <>
              <div className="branch-menu__divider" />
              <div className="branch-menu__section-title">{t('Worktrees')}</div>
              <div className="branch-menu__list">
                {filteredWorktrees.map((worktree) => {
                  const name = basename(worktree.path)
                  const branch = worktree.branch ?? t('detached')
                  return (
                    <button
                      key={worktree.path}
                      className="branch-menu__row"
                      data-current={worktree.current || undefined}
                      disabled={Boolean(busy)}
                      onClick={() => void openWorktree(worktree.path, close)}
                    >
                      <GitFork size={12} className="branch-menu__icon" />
                      <span className="branch-menu__name">{name}</span>
                      <span className="branch-menu__meta">{branch}</span>
                      {worktree.current ? <Check size={12} className="branch-menu__check" /> : null}
                    </button>
                  )
                })}
              </div>
            </>
          ) : null}

          <div className="branch-menu__divider" />

          {/* Bottom Actions: Create and checkout new branch at bottom */}
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
              <div className="branch-menu__footer-row">
                <button
                  className="branch-menu__action-btn branch-menu__action-btn--primary"
                  type="button"
                  onClick={() => setShowNew(true)}
                >
                  <Plus size={13} strokeWidth={1.8} />
                  <span>{t('Create and checkout branch')}</span>
                </button>
                <div className="branch-menu__remote-actions">
                  <button
                    className="branch-menu__remote-btn"
                    disabled={Boolean(busy) || git.detached}
                    onClick={() => void runPull()}
                    title={t('Pull latest changes from remote')}
                  >
                    <ArrowDown size={11} />
                    {git.behind > 0 ? <span className="branch-menu__count-sub">{git.behind}</span> : null}
                  </button>
                  <button
                    className="branch-menu__remote-btn"
                    disabled={Boolean(busy) || git.detached}
                    onClick={() => void runPush()}
                    title={t('Push commits to remote')}
                  >
                    <ArrowUp size={11} />
                    {git.ahead > 0 ? <span className="branch-menu__count-sub">{git.ahead}</span> : null}
                  </button>
                  <button
                    className="branch-menu__remote-btn"
                    disabled={loading}
                    onClick={() => void load()}
                    title={t('Refresh')}
                  >
                    <RefreshCw size={11} className={loading ? 'spin' : undefined} />
                  </button>
                </div>
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
        title={`${t('Remove worktree')}: ${basename(worktreeToRemove.path)}`}
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
}

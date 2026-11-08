import { useCallback, useMemo, useRef, useState } from 'react'
import { Check, FileDiff, Loader2, Plus, Search, X } from 'lucide-react'
import type { GitBranches } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'
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
  const refreshGit = useAppStore((state) => state.refreshGit)
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
  const [useWorktree, setUseWorktree] = useState(false)

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

  if (!git?.isRepo) return null

  const chooseBranch = async (name: string, close: () => void) => {
    if (busy) return
    if (name === data?.current) {
      close()
      return
    }
    setBusy(name)
    try {
      const existingWorktree = data?.worktrees.find(
        (worktree) => worktree.branch === name && !worktree.current
      )
      if (existingWorktree) {
        await switchProject(existingWorktree.path, { allowWhileRunning: true })
        close()
        return
      }

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
      if (useWorktree) {
        const result = await window.pi.git.addWorktree('', name, true)
        if (!result.ok || !result.path) {
          showToast(result.error ?? t('Could not add the worktree'), 'error')
          return
        }
        setNewBranch('')
        setShowNew(false)
        setUseWorktree(false)
        showToast(`${t('Worktree created at')} ${result.path}`)
        await switchProject(result.path, { allowWhileRunning: true })
        close()
        return
      }

      const result = await window.pi.git.createBranch(name, true)
      if (!result.ok) {
        showToast(result.error ?? t('Could not create the branch'), 'error')
        return
      }
      await refreshGit()
      await load()
      setNewBranch('')
      setShowNew(false)
      setUseWorktree(false)
      showToast(`${t('Created and switched to')} ${name}`)
      close()
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
              setUseWorktree(false)
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
              {t('Could not load branches.')}
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
                        setUseWorktree(false)
                      }
                    }}
                  />
                  <button
                    type="submit"
                    className="branch-menu__create-btn branch-menu__create-btn--submit"
                    disabled={!newBranch.trim() || Boolean(busy)}
                    title={useWorktree ? t('Create branch in new worktree') : t('Create and checkout branch')}
                  >
                    {busy === 'create' ? <Loader2 size={11} className="spin" /> : <Check size={12} />}
                  </button>
                  <button
                    type="button"
                    className="branch-menu__create-btn branch-menu__create-btn--cancel"
                    onClick={() => {
                      setShowNew(false)
                      setNewBranch('')
                      setUseWorktree(false)
                    }}
                    title={t('Cancel')}
                  >
                    <X size={12} />
                  </button>
                </div>
                <label className="branch-menu__worktree-toggle">
                  <input
                    type="checkbox"
                    checked={useWorktree}
                    onChange={(event) => setUseWorktree(event.target.checked)}
                    disabled={Boolean(busy)}
                  />
                  <span>{t('Use a new worktree')}</span>
                </label>
              </form>
            ) : (
              <div className="branch-menu__footer-actions">
                <button
                  className="branch-menu__action-btn branch-menu__action-btn--primary"
                  type="button"
                  onClick={() => {
                    setUseWorktree(false)
                    setShowNew(true)
                  }}
                >
                  <Plus size={13} strokeWidth={1.8} />
                  <span>{t('Create and checkout branch')}</span>
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
    </Popover>
  ]
}

import { useCallback, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  FileDiff,
  GitBranch,
  GitFork,
  Loader2,
  Plus,
  RefreshCw,
  Trash2
} from 'lucide-react'
import type { GitBranches, GitWorktree } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { basename } from '../lib/path'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'
import { ConfirmDialog } from './ConfirmDialog'
import '../styles/branch-menu.css'

/**
 * The branch chip, and the menu behind it.
 *
 * Switching a branch or adding a worktree changes the files under the agent,
 * so the menu stays read-only until the user picks one of those two actions;
 * everything else (the dirty count, the review) is just a way in.
 */
export function BranchMenu({
  onOpenChanges,
  iconOnly = false
}: {
  onOpenChanges: () => void
  iconOnly?: boolean
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
  const [showNew, setShowNew] = useState(false)
  const [newBranch, setNewBranch] = useState('')
  const [showWorktree, setShowWorktree] = useState(false)
  const [worktreeBranch, setWorktreeBranch] = useState('')
  const [worktreePath, setWorktreePath] = useState('')
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
      // Asking for a worktree is asking for that folder, run and all.
      await switchProject(target, { allowWhileRunning: true })
      close()
    } finally {
      setBusy(undefined)
    }
  }

  const createWorktree = async (close: () => void) => {
    const branch = worktreeBranch.trim()
    if (!branch || busy) return
    setBusy('worktree')
    try {
      const result = await window.pi.git.addWorktree(worktreePath.trim(), branch, true)
      if (!result.ok) {
        showToast(result.error ?? t('Could not add the worktree'), 'error')
        return
      }
      setWorktreeBranch('')
      setWorktreePath('')
      setShowWorktree(false)
      showToast(`${t('Worktree created at')} ${result.path ?? ''}`)
      if (result.path) await switchProject(result.path, { allowWhileRunning: true })
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
      placement={iconOnly ? 'right' : 'bottom'}
      className={iconOnly ? 'branch-menu--rail' : undefined}
      width={340}
      renderTrigger={({ open, toggle }) => (
        <button
          ref={gitChipRef}
          className={iconOnly ? 'icon-btn git-chip git-chip--icon no-drag' : 'pill git-chip no-drag'}
          data-dirty={!git.clean}
          data-active={open}
          aria-label={iconOnly ? t('Branches') : undefined}
          aria-expanded={open}
          onClick={(event) => {
            toggle(event)
            if (!open) void load()
          }}
          title={
            git.clean
              ? `${git.branch ?? t('Repository')} — ${t('no uncommitted changes')}`
              : `${git.branch ?? t('Repository')} — ${git.files.length} ${t('uncommitted')}. ${t('Review and commit')}`
          }
        >
          <GitBranch size={iconOnly ? 16 : 13} />
          {iconOnly ? null : (
            <>
              <span className="git-chip__branch">
                {git.branch ?? (git.head ? `#${git.head}` : t('Repository'))}
              </span>
              {git.detached ? <span className="git-chip__tag">{t('detached')}</span> : null}
              {git.ahead > 0 ? <span className="git-chip__delta">↑{git.ahead}</span> : null}
              {git.behind > 0 ? <span className="git-chip__delta">↓{git.behind}</span> : null}
              {git.clean ? (
                <Check size={12} className="git-chip__clean" />
              ) : (
                <span className="git-chip__dirty">{git.files.length}</span>
              )}
              <ChevronDown size={11} className="pill__caret" />
            </>
          )}
        </button>
      )}
    >
      {(close) => (
        <div className="branch-menu">
          <div className="branch-menu__head">
            <span className="popover__label">{t('Branches')}</span>
            <button
              className="icon-btn"
              onClick={() => void load()}
              aria-label={t('Refresh')}
              title={t('Refresh')}
              disabled={loading}
            >
              <RefreshCw size={11} className={loading ? 'spin' : undefined} />
            </button>
          </div>

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

          <div className="branch-menu__list">
            {data?.branches.map((branch) => (
              <button
                key={branch.name}
                className="branch-menu__row"
                data-current={branch.current || undefined}
                disabled={Boolean(busy)}
                onClick={() => void chooseBranch(branch.name, close)}
                title={branch.subject ?? branch.name}
              >
                <GitBranch size={12} className="branch-menu__icon" />
                <span className="branch-menu__name">{branch.name}</span>
                {branch.current ? <Check size={12} className="branch-menu__check" /> : null}
              </button>
            ))}
            {!loading && data && data.branches.length === 0 ? (
              <p className="branch-menu__note">{t('This repository has no branches yet.')}</p>
            ) : null}
            {loading && !data ? (
              <p className="branch-menu__note">
                <Loader2 size={11} className="spin" /> {t('Reading the branches…')}
              </p>
            ) : null}
          </div>

          <div className="branch-menu__actions">
            <button
              className="ghost-btn"
              aria-expanded={showNew}
              onClick={() => setShowNew((value) => !value)}
            >
              <Plus size={11} />
              {t('New branch…')}
            </button>
            <button
              className="ghost-btn"
              disabled={Boolean(busy) || git.detached}
              onClick={() => void runPull()}
              title={t('Pull latest changes from remote')}
            >
              <ArrowDown size={11} />
              {t('Pull')}
              {git.behind > 0 ? ` (${git.behind})` : ''}
            </button>
            <button
              className="ghost-btn"
              disabled={Boolean(busy) || git.detached}
              onClick={() => void runPush()}
              title={t('Push commits to remote')}
            >
              <ArrowUp size={11} />
              {t('Push')}
              {git.ahead > 0 ? ` (${git.ahead})` : ''}
            </button>
            <button
              className="ghost-btn"
              onClick={() => {
                close()
                onOpenChanges()
              }}
            >
              <FileDiff size={11} />
              {t('Review changes')}
            </button>
          </div>

          {showNew ? (
            <form
              className="branch-menu__form"
              onSubmit={(event) => {
                event.preventDefault()
                void createNewBranch(close)
              }}
            >
              <label className="branch-menu__field">
                <span className="branch-menu__field-label">{t('Branch name')}</span>
                <input
                  autoFocus
                  value={newBranch}
                  spellCheck={false}
                  onChange={(event) => setNewBranch(event.target.value)}
                />
              </label>
              <button
                type="submit"
                className="btn btn--primary btn--sm"
                disabled={!newBranch.trim() || Boolean(busy)}
              >
                {t('Create and switch')}
              </button>
            </form>
          ) : null}

          <div className="branch-menu__section">
            <div className="popover__label">{t('Worktrees')}</div>
            {data?.worktrees.map((worktree) => {
              const name = basename(worktree.path)
              const branch = worktree.branch ?? t('detached')
              const dirty = typeof worktree.dirty === 'number' && worktree.dirty > 0
              const dirtyLabel = dirty ? `${worktree.dirty} ${t('Uncommitted files')}` : ''
              return (
                <div className="branch-menu__worktree" key={worktree.path}>
                  <button
                    className="branch-menu__row"
                    data-current={worktree.current || undefined}
                    disabled={Boolean(busy)}
                    aria-label={`${name}, ${branch}${dirtyLabel ? `, ${dirtyLabel}` : ''}`}
                    title={dirtyLabel ? `${worktree.path} · ${dirtyLabel}` : worktree.path}
                    onClick={() => void openWorktree(worktree.path, close)}
                  >
                    <GitFork size={12} className="branch-menu__icon" />
                    <span className="branch-menu__name">{name}</span>
                    <span className="branch-menu__meta">{branch}</span>
                    {dirty ? (
                      <span className="branch-menu__dirty" aria-hidden="true">
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
                        if (!busy && !dirty) setWorktreeToRemove(worktree)
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  ) : null}
                </div>
              )
            })}
            <button
              className="ghost-btn"
              aria-expanded={showWorktree}
              onClick={() => setShowWorktree((value) => !value)}
            >
              <Plus size={11} />
              {t('Add worktree…')}
            </button>
            {showWorktree ? (
              <form
                className="branch-menu__form branch-menu__form--column"
                onSubmit={(event) => {
                  event.preventDefault()
                  void createWorktree(close)
                }}
              >
                <label className="branch-menu__field">
                  <span className="branch-menu__field-label">{t('Branch for the worktree')}</span>
                  <input
                    autoFocus
                    value={worktreeBranch}
                    spellCheck={false}
                    onChange={(event) => setWorktreeBranch(event.target.value)}
                  />
                </label>
                <label className="branch-menu__field">
                  <span className="branch-menu__field-label">{t('Folder')}</span>
                  <input
                    value={worktreePath}
                    placeholder={t('Folder (empty for a sibling folder)')}
                    spellCheck={false}
                    onChange={(event) => setWorktreePath(event.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  className="btn btn--primary btn--sm"
                  disabled={!worktreeBranch.trim() || Boolean(busy)}
                >
                  {t('Create worktree')}
                </button>
              </form>
            ) : null}
          </div>

          {busy ? (
            <p className="branch-menu__busy">
              <Loader2 size={11} className="spin" />
              {t('Working…')}
            </p>
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

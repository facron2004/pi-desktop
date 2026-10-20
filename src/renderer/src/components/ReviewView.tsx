import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Copy,
  FileWarning,
  RefreshCw,
  RotateCcw,
  Search,
  SquareArrowOutUpRight,
  X
} from 'lucide-react'
import type { GitFileDiff, GitFileStatus } from '@shared/types'
import { buildDiff } from '../lib/diff-fold'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { DiffView } from './DiffView'
import '../styles/review.css'

type DiffState =
  | { status: 'loading' }
  | { status: 'ready'; diff: GitFileDiff }
  | { status: 'error' }

/**
 * The working tree as git sees it.
 *
 * The Changes tab is derived from the conversation; this one reads the disk,
 * so a change made in another editor shows up here too — and can be reverted
 * without asking the agent to do it.
 */
export function ReviewView({
  onOpenFile
}: {
  onOpenFile: (file: { path: string; line?: number }) => void
}) {
  const git = useAppStore((state) => state.git)
  const workspace = useAppStore((state) => state.workspace)
  const refreshGit = useAppStore((state) => state.refreshGit)
  const showToast = useAppStore((state) => state.showToast)
  const language = useAppStore((state) => state.settings.language)
  const diffSplit = useAppStore((state) => state.settings.diffSplit === true)
  const t = useT()

  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [revertTarget, setRevertTarget] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  // The panel is opened when the user wants to review, so it reads git then.
  useEffect(() => {
    void refreshGit()
  }, [refreshGit, workspace?.path])

  const files = git?.files ?? []

  const load = useCallback(async (path: string) => {
    setDiffs((previous) => ({ ...previous, [path]: { status: 'loading' } }))
    try {
      const diff = await window.pi.git.fileDiff(path)
      setDiffs((previous) => ({ ...previous, [path]: { status: 'ready', diff } }))
    } catch {
      setDiffs((previous) => ({ ...previous, [path]: { status: 'error' } }))
    }
  }, [])

  const toggle = useCallback(
    (path: string) => {
      setOpen((previous) => {
        const next = new Set(previous)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
          if (!diffs[path]) void load(path)
        }
        return next
      })
    },
    [diffs, load]
  )

  const refresh = useCallback(async () => {
    setRefreshing(true)
    const reopened = [...openRef.current]
    try {
      await refreshGit()
      setDiffs({})
      await Promise.all(reopened.map((path) => load(path)))
    } finally {
      setRefreshing(false)
    }
  }, [refreshGit, load])

  // A file that left the working tree (committed or reverted) cannot keep its
  // cached diff, or the list would show a change that no longer exists.
  const paths = useMemo(() => files.map((file) => file.path).join('\n'), [files])
  useEffect(() => {
    const current = new Set(paths ? paths.split('\n') : [])
    setDiffs((previous) => {
      let changed = false
      const next: Record<string, DiffState> = {}
      for (const [path, value] of Object.entries(previous)) {
        if (current.has(path)) next[path] = value
        else changed = true
      }
      return changed ? next : previous
    })
    setOpen((previous) => {
      const next = new Set([...previous].filter((path) => current.has(path)))
      return next.size === previous.size ? previous : next
    })
  }, [paths])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return files
    return files.filter((file) => file.path.toLowerCase().includes(needle))
  }, [files, filter])

  const totals = useMemo(
    () =>
      files.reduce(
        (acc, file) => ({
          added: acc.added + (file.added ?? 0),
          removed: acc.removed + (file.removed ?? 0)
        }),
        { added: 0, removed: 0 }
      ),
    [files]
  )

  const copyPaths = useCallback(async () => {
    if (!files.length) {
      showToast(t('There is nothing to copy yet'), 'warning')
      return
    }
    try {
      await navigator.clipboard.writeText(files.map((file) => file.path).join('\n'))
      showToast(`${files.length} ${t('paths were copied')}`)
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }, [files, showToast, t])

  const revert = useCallback(async () => {
    const target = revertTarget
    setRevertTarget(null)
    if (!target) return
    const result = await window.pi.git.revertFile(target)
    if (!result.ok) {
      showToast(result.error ?? t('The file could not be reverted'), 'error')
      return
    }
    setDiffs((previous) => {
      const next = { ...previous }
      delete next[target]
      return next
    })
    await refreshGit()
    showToast(t('The changes were reverted'))
  }, [revertTarget, refreshGit, showToast, t])

  const revertBody = revertTarget
    ? language === 'zh-CN'
      ? `丢弃“${revertTarget}”的全部未提交更改（恢复到 HEAD）？此操作无法在 Pi Desktop 中撤销。`
      : `Discard every uncommitted change in “${revertTarget}” (back to HEAD)? This cannot be undone from inside Pi Desktop.`
    : ''

  return (
    <div className="review">
      {git?.isRepo ? (
        <div className="review__bar">
          <div className="review__filter">
            <Search size={12} />
            <input
              value={filter}
              placeholder={t('Filter the working tree')}
              onChange={(event) => setFilter(event.target.value)}
            />
            {filter ? (
              <button className="icon-btn" onClick={() => setFilter('')} title={t('Clear the filter')}>
                <X size={11} />
              </button>
            ) : null}
          </div>

          <div className="review__actions">
            <span className="review__totals" title={t('Lines added and removed in the working tree')}>
              {totals.added ? <span data-kind="add">+{totals.added}</span> : null}
              {totals.removed ? <span data-kind="del">−{totals.removed}</span> : null}
            </span>
            <button
              className="icon-btn"
              onClick={() => void copyPaths()}
              title={t('Copy the paths of the changed files')}
            >
              <Copy size={12} />
            </button>
            <button
              className="icon-btn"
              onClick={() => void refresh()}
              title={t('Refresh the working tree')}
              disabled={refreshing}
            >
              <RefreshCw size={12} className={refreshing ? 'spin' : undefined} />
            </button>
          </div>
        </div>
      ) : null}

      {!git ? (
        <div className="review__state">
          <RefreshCw size={14} className="spin" />
          {t('Reading the working tree…')}
        </div>
      ) : !git.isRepo ? (
        <div className="review__empty">
          <p>{t('This folder is not a git repository.')}</p>
          <p className="review__empty-hint">
            {t('Open a project that git tracks to review its changes here.')}
          </p>
        </div>
      ) : git.clean ? (
        <div className="review__empty">
          <p>{t('The working tree is clean.')}</p>
          <p className="review__empty-hint">{t('Everything is committed.')}</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="review__empty">
          <p>
            {t('No changed file matches')} “{filter}”.
          </p>
        </div>
      ) : (
        <div className="review__list">
          {visible.map((file) => (
            <ReviewFile
              key={file.path}
              file={file}
              isOpen={open.has(file.path)}
              state={diffs[file.path]}
              split={diffSplit}
              onToggle={() => toggle(file.path)}
              onOpen={() => onOpenFile({ path: file.path })}
              onReveal={() => void window.pi.fs.reveal(file.path)}
              onRevert={() => setRevertTarget(file.path)}
            />
          ))}
        </div>
      )}

      {revertTarget ? (
        <ConfirmDialog
          title={t('Revert file')}
          body={revertBody}
          confirmLabel={t('Revert')}
          tone="danger"
          onCancel={() => setRevertTarget(null)}
          onConfirm={() => void revert()}
        />
      ) : null}
    </div>
  )
}

function ReviewFile({
  file,
  isOpen,
  state,
  split,
  onToggle,
  onOpen,
  onReveal,
  onRevert
}: {
  file: GitFileStatus
  isOpen: boolean
  state: DiffState | undefined
  split: boolean
  onToggle: () => void
  onOpen: () => void
  onReveal: () => void
  onRevert: () => void
}) {
  const t = useT()
  const status = statusOf(file)

  const blocks = useMemo(() => {
    if (!state || state.status !== 'ready' || state.diff.binary) return []
    return [buildDiff(state.diff.oldText, state.diff.newText)]
  }, [state])

  return (
    <section className="review__file" data-open={isOpen}>
      <div className="review__head">
        <button
          className="review__toggle"
          onClick={onToggle}
          aria-expanded={isOpen}
          title={isOpen ? t('Collapse this file') : t('Show the changes of this file')}
        >
          <ChevronRight size={12} className="review__chevron" />
          <span className="review__status" data-kind={status.kind}>
            {status.label}
          </span>
          <span className="review__path" title={file.path}>
            {file.path}
          </span>
          <span className="review__stats">
            {file.added ? <span data-kind="add">+{file.added}</span> : null}
            {file.removed ? <span data-kind="del">−{file.removed}</span> : null}
          </span>
        </button>

        <div className="review__file-actions">
          <button className="icon-btn" onClick={onOpen} title={t('Open the file')}>
            <SquareArrowOutUpRight size={12} />
          </button>
          <button className="icon-btn" onClick={onReveal} title={t('Reveal in the file manager')}>
            <FileWarning size={12} />
          </button>
          {file.untracked ? null : (
            <button
              className="icon-btn review__revert"
              onClick={onRevert}
              title={t('Revert this file')}
            >
              <RotateCcw size={12} />
            </button>
          )}
        </div>
      </div>

      {isOpen ? (
        <div className="review__body">
          {!state || state.status === 'loading' ? (
            <div className="review__state">
              <RefreshCw size={12} className="spin" />
              {t('Reading the changes…')}
            </div>
          ) : state.status === 'error' ? (
            <div className="review__state">{t('Could not read the changes of this file.')}</div>
          ) : state.diff.error ? (
            <div className="review__state">{state.diff.error}</div>
          ) : state.diff.binary ? (
            <div className="review__state">{t('Binary file changed.')}</div>
          ) : (
            <>
              {state.diff.truncated ? (
                <div className="review__note">{t('The file is too large to show in full.')}</div>
              ) : null}
              <DiffView diffs={blocks} mode={split ? 'split' : 'unified'} />
            </>
          )}
        </div>
      ) : null}
    </section>
  )
}

/** The single letter git shows in `status --short`, with its tone. */
function statusOf(file: GitFileStatus): {
  label: string
  kind: 'add' | 'del' | 'edit' | 'rename'
} {
  if (file.untracked) return { label: 'A', kind: 'add' }
  if (file.index === 'D' || file.worktree === 'D') return { label: 'D', kind: 'del' }
  if (file.index === 'R' || file.worktree === 'R') return { label: 'R', kind: 'rename' }
  if (file.index === 'A') return { label: 'A', kind: 'add' }
  return { label: 'M', kind: 'edit' }
}

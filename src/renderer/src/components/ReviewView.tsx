import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  ClipboardCopy,
  Copy,
  FileWarning,
  Minus,
  Plus,
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
  const stageFile = useAppStore((state) => state.stageFile)
  const unstageFile = useAppStore((state) => state.unstageFile)
  const stageAll = useAppStore((state) => state.stageAll)
  const unstageAll = useAppStore((state) => state.unstageAll)
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

  const stagedFiles = useMemo(() => visible.filter((file) => file.staged), [visible])
  const unstagedFiles = useMemo(() => visible.filter((file) => !file.staged), [visible])
  const [stageBusy, setStageBusy] = useState(false)

  const toggleStage = useCallback(
    async (file: GitFileStatus) => {
      const result = file.staged ? await unstageFile(file.path) : await stageFile(file.path)
      if (!result.ok) {
        showToast(result.error ?? t('The file could not be staged'), 'error')
      }
    },
    [stageFile, unstageFile, showToast, t]
  )

  const stageEverything = useCallback(async () => {
    setStageBusy(true)
    try {
      const result = await stageAll()
      if (!result.ok) showToast(result.error ?? t('The files could not be staged'), 'error')
    } finally {
      setStageBusy(false)
    }
  }, [stageAll, showToast, t])

  const unstageEverything = useCallback(async () => {
    setStageBusy(true)
    try {
      const result = await unstageAll()
      if (!result.ok) showToast(result.error ?? t('The files could not be unstaged'), 'error')
    } finally {
      setStageBusy(false)
    }
  }, [unstageAll, showToast, t])

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

  /** Copy a patch another tool can apply: the whole tree, or one file. */
  const copyPatch = useCallback(
    async (file?: string) => {
      try {
        const patch = await window.pi.git.patch(file)
        if (!patch.text.trim()) {
          showToast(t('There is no patch to copy yet'), 'warning')
          return
        }
        await navigator.clipboard.writeText(patch.text)
        showToast(
          patch.truncated
            ? t('The patch was copied, but it is too large to be complete')
            : t('The patch was copied')
        )
      } catch {
        showToast(t('The clipboard is not available'), 'error')
      }
    },
    [showToast, t]
  )

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
            {git && git.staged > 0 ? (
              <button
                className="ghost-btn review__bulk"
                onClick={() => void unstageEverything()}
                disabled={stageBusy}
                title={t('Unstage every file')}
              >
                <Minus size={11} />
                {t('Unstage all')}
              </button>
            ) : null}
            {git && git.unstaged > 0 ? (
              <button
                className="ghost-btn review__bulk"
                onClick={() => void stageEverything()}
                disabled={stageBusy}
                title={t('Stage every file')}
              >
                <Plus size={11} />
                {t('Stage all')}
              </button>
            ) : null}
            <button
              className="icon-btn"
              onClick={() => void copyPatch()}
              title={t('Copy the patch of the whole working tree')}
            >
              <ClipboardCopy size={12} />
            </button>
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
          {stagedFiles.length > 0 ? (
            <ReviewGroup
              label={t('Staged')}
              count={stagedFiles.length}
              files={stagedFiles}
              open={open}
              diffs={diffs}
              split={diffSplit}
              onToggle={(path) => toggle(path)}
              onOpen={onOpenFile}
              onToggleStage={(file) => void toggleStage(file)}
              onCopyPatch={(file) => void copyPatch(file.path)}
              onRevert={setRevertTarget}
            />
          ) : null}
          {unstagedFiles.length > 0 ? (
            <ReviewGroup
              label={stagedFiles.length > 0 ? t('Changes') : null}
              count={unstagedFiles.length}
              files={unstagedFiles}
              open={open}
              diffs={diffs}
              split={diffSplit}
              onToggle={(path) => toggle(path)}
              onOpen={onOpenFile}
              onToggleStage={(file) => void toggleStage(file)}
              onCopyPatch={(file) => void copyPatch(file.path)}
              onRevert={setRevertTarget}
            />
          ) : null}
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

function ReviewGroup({
  label,
  count,
  files,
  open,
  diffs,
  split,
  onToggle,
  onOpen,
  onToggleStage,
  onCopyPatch,
  onRevert
}: {
  label: string | null
  count: number
  files: GitFileStatus[]
  open: ReadonlySet<string>
  diffs: Record<string, DiffState>
  split: boolean
  onToggle: (path: string) => void
  onOpen: (file: { path: string; line?: number }) => void
  onToggleStage: (file: GitFileStatus) => void
  onCopyPatch: (file: GitFileStatus) => void
  onRevert: (path: string) => void
}) {
  const t = useT()
  return (
    <div className="review__group">
      {label ? (
        <div className="review__group-head">
          <span>{label}</span>
          <span className="review__group-count">{count}</span>
        </div>
      ) : null}
      {files.map((file) => (
        <ReviewFile
          key={file.path}
          file={file}
          isOpen={open.has(file.path)}
          state={diffs[file.path]}
          split={split}
          onToggle={() => onToggle(file.path)}
          onOpen={() => onOpen({ path: file.path })}
          onReveal={() => void window.pi.fs.reveal(file.path)}
          onToggleStage={() => onToggleStage(file)}
          onCopyPatch={() => onCopyPatch(file)}
          onRevert={() => onRevert(file.path)}
        />
      ))}
      {label ? null : <span className="sr-only">{t('Changes')}</span>}
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
  onToggleStage,
  onCopyPatch,
  onRevert
}: {
  file: GitFileStatus
  isOpen: boolean
  state: DiffState | undefined
  split: boolean
  onToggle: () => void
  onOpen: () => void
  onReveal: () => void
  onToggleStage: () => void
  onCopyPatch: () => void
  onRevert: () => void
}) {
  const t = useT()
  const status = statusOf(file)

  const blocks = useMemo(() => {
    if (!state || state.status !== 'ready' || state.diff.binary) return []
    return [buildDiff(state.diff.oldText, state.diff.newText)]
  }, [state])

  return (
    <section className="review__file" data-open={isOpen} data-staged={file.staged || undefined}>
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
          <span
            className="review__path"
            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
          >
            {file.oldPath ? (
              <>
                <span className="review__old-path">{file.oldPath}</span>
                <span className="review__arrow" aria-hidden="true">
                  →
                </span>
              </>
            ) : null}
            {file.path}
          </span>
          <span className="review__stats">
            {file.added ? <span data-kind="add">+{file.added}</span> : null}
            {file.removed ? <span data-kind="del">−{file.removed}</span> : null}
          </span>
        </button>

        <div className="review__file-actions">
          <button
            className="icon-btn review__stage"
            onClick={onToggleStage}
            title={file.staged ? t('Unstage this file') : t('Stage this file')}
          >
            {file.staged ? <Minus size={12} /> : <Plus size={12} />}
          </button>
          <button
            className="icon-btn"
            onClick={onCopyPatch}
            title={t('Copy this patch')}
          >
            <ClipboardCopy size={12} />
          </button>
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

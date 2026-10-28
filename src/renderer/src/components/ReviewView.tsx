import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardCopy,
  Columns2,
  Copy,
  Ellipsis,
  FileWarning,
  GitCommit,
  MessageSquarePlus,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Rows3,
  Search,
  SquareArrowOutUpRight,
  X
} from 'lucide-react'
import type { GitFileDiff, GitFileStatus } from '@shared/types'
import { buildWorkingTreeDiff, CONTEXT_LINES, type DiffBlock, type DiffRow } from '../lib/diff-fold'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { DiffView } from './DiffView'
import { Popover } from './Popover'
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
  onOpenFile,
  onCommit,
  scopeControl,
  active
}: {
  onOpenFile: (file: { path: string; line?: number }) => void
  onCommit: () => void
  scopeControl: ReactNode
  active: boolean
}) {
  const git = useAppStore((state) => state.git)
  const workspace = useAppStore((state) => state.workspace)
  const refreshGit = useAppStore((state) => state.refreshGit)
  const stageFile = useAppStore((state) => state.stageFile)
  const unstageFile = useAppStore((state) => state.unstageFile)
  const stageAll = useAppStore((state) => state.stageAll)
  const unstageAll = useAppStore((state) => state.unstageAll)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const showToast = useAppStore((state) => state.showToast)
  const language = useAppStore((state) => state.settings.language)
  const diffSplit = useAppStore((state) => state.settings.diffSplit === true)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const t = useT()

  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [revertTarget, setRevertTarget] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open

  // The panel is opened when the user wants to review, so it reads git then.
  useEffect(() => {
    if (active) void refreshGit()
  }, [active, refreshGit, workspace?.path])

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

  // Reverting a hunk rewrites the work tree, so this file's cached diff is
  // stale: drop it, re-read the status and read the file again.
  const reloadAfterHunk = useCallback(
    async (path: string) => {
      setDiffs((previous) => {
        const next = { ...previous }
        delete next[path]
        return next
      })
      await refreshGit()
      await load(path)
    },
    [refreshGit, load]
  )

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
    return files.filter(
      (file) =>
        file.path.toLowerCase().includes(needle) ||
        file.oldPath?.toLowerCase().includes(needle)
    )
  }, [files, filter])

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
  const visibleTotals = useMemo(
    () =>
      visible.reduce(
        (acc, file) => ({
          added: acc.added + (file.added ?? 0),
          removed: acc.removed + (file.removed ?? 0)
        }),
        { added: 0, removed: 0 }
      ),
    [visible]
  )
  const allVisibleOpen = visible.length > 0 && visible.every((file) => open.has(file.path))
  const toggleAllFiles = () => {
    setOpen((previous) => {
      const next = new Set(previous)
      for (const file of visible) {
        if (allVisibleOpen) next.delete(file.path)
        else next.add(file.path)
      }
      return next
    })
    if (!allVisibleOpen) {
      for (const file of visible) if (!diffs[file.path]) void load(file.path)
    }
  }

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
        <>
          <div className="review__bar">
            {scopeControl}
            <span className="review__totals" title={t('Lines added and removed in the working tree')}>
              {totals.added ? <span data-kind="add">+{totals.added}</span> : null}
              {totals.removed ? <span data-kind="del">−{totals.removed}</span> : null}
            </span>
            <div className="review__actions">
              <button
                className="icon-btn"
                onClick={() => {
                  if (filterOpen) setFilter('')
                  setFilterOpen((value) => !value)
                }}
                aria-label={t('Filter the working tree')}
                title={t('Filter the working tree')}
                aria-pressed={filterOpen}
                data-active={filterOpen}
              >
                <Search size={14} />
              </button>
              <button
                className="icon-btn"
                onClick={toggleAllFiles}
                disabled={visible.length === 0}
                aria-label={allVisibleOpen ? t('Collapse all files') : t('Expand all files')}
                title={allVisibleOpen ? t('Collapse all files') : t('Expand all files')}
              >
                {allVisibleOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
              </button>
              <button
                className="icon-btn"
                onClick={() => void updateSettings({ diffSplit: !diffSplit })}
                aria-label={diffSplit ? t('Unified diff') : t('Side-by-side diff')}
                title={diffSplit ? t('Unified diff') : t('Side-by-side diff')}
              >
                {diffSplit ? <Rows3 size={14} /> : <Columns2 size={14} />}
              </button>
              <Popover
                align="right"
                width={220}
                renderTrigger={({ open: menuOpen, toggle: toggleMenu }) => (
                  <button
                    className="icon-btn"
                    type="button"
                    aria-label={t('More actions')}
                    title={t('More actions')}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={toggleMenu}
                  >
                    <Ellipsis size={15} />
                  </button>
                )}
              >
                {(close) => (
                  <div role="menu" aria-label={t('More actions')}>
                    <button className="popover__item" role="menuitem" disabled={git.clean} onClick={() => { close(); onCommit() }}>
                      <GitCommit size={13} /> {t('Commit')}
                    </button>
                    <button className="popover__item" role="menuitem" disabled={stageBusy || git.staged === 0} onClick={() => { close(); void unstageEverything() }}>
                      <Minus size={13} /> {t('Unstage all')}
                    </button>
                    <button className="popover__item" role="menuitem" disabled={stageBusy || !files.some((file) => file.untracked || (file.worktree !== ' ' && file.worktree !== '?'))} onClick={() => { close(); void stageEverything() }}>
                      <Plus size={13} /> {t('Stage all')}
                    </button>
                    <button className="popover__item" role="menuitem" disabled={git.clean} onClick={() => { close(); insertIntoComposer(t('Review the uncommitted git changes in this repository, point out any bugs or edge cases, and suggest improvements.')) }}>
                      <MessageSquarePlus size={13} /> {t('Ask Pi to review uncommitted changes')}
                    </button>
                    <button className="popover__item" role="menuitem" onClick={() => { close(); void copyPatch() }}>
                      <ClipboardCopy size={13} /> {t('Copy the patch of the whole working tree')}
                    </button>
                    <button className="popover__item" role="menuitem" onClick={() => { close(); void copyPaths() }}>
                      <Copy size={13} /> {t('Copy paths')}
                    </button>
                    <button className="popover__item" role="menuitem" disabled={refreshing} onClick={() => { close(); void refresh() }}>
                      <RefreshCw size={13} /> {t('Refresh the working tree')}
                    </button>
                  </div>
                )}
              </Popover>
            </div>
          </div>
          {filterOpen ? (
            <div className="review__filter-row">
              <div className="review__filter">
                <Search size={12} />
                <input
                  autoFocus
                  value={filter}
                  placeholder={t('Filter files')}
                  aria-label={t('Filter the working tree')}
                  onChange={(event) => setFilter(event.target.value)}
                />
                {filter ? (
                  <button className="icon-btn" onClick={() => setFilter('')} title={t('Clear the filter')} aria-label={t('Clear the filter')}>
                    <X size={11} />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          <div className="review__summary">
            <span>{visible.length} {visible.length === 1 ? t('file') : t('files')}</span>
            <span className="review__totals">
              {visibleTotals.added ? <span data-kind="add">+{visibleTotals.added}</span> : null}
              {visibleTotals.removed ? <span data-kind="del">−{visibleTotals.removed}</span> : null}
            </span>
          </div>
        </>
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
              onToggleStage={() => void toggleStage(file)}
              onCopyPatch={() => void copyPatch(file.path)}
              onRevert={() => setRevertTarget(file.path)}
              onHunkReverted={() => void reloadAfterHunk(file.path)}
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

/** A fold row standing for context the hunk split left out. */
function hiddenGap(hidden: DiffRow[], key: string): DiffRow {
  const first = hidden[0]
  return {
    kind: 'gap',
    oldLine: first?.oldLine ?? null,
    newLine: first?.newLine ?? null,
    text: '',
    hidden,
    key
  }
}

/**
 * Cut a file diff into one block per hunk, the way git groups changes.
 *
 * "Copy this hunk" and "Revert this hunk" belong to one change region, so a
 * run of unchanged lines longer than the context on both sides starts a new
 * block. The lines the split leaves out become a fold on the following block:
 * they stay expandable, and while the fold is closed they stay out of the
 * copied or reverted patch.
 */
function splitHunks(rows: DiffRow[], context = CONTEXT_LINES): DiffBlock[] {
  const changes: number[] = []
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index].kind === 'add' || rows[index].kind === 'del') changes.push(index)
  }
  if (changes.length === 0) return []

  const groups: { start: number; end: number }[] = []
  for (const index of changes) {
    const last = groups[groups.length - 1]
    // Two changes share a hunk while their context on both sides still touches.
    if (!last || index - last.end - 1 > context * 2) {
      groups.push({
        start: Math.max(index - context, 0),
        end: Math.min(index + context, rows.length - 1)
      })
    } else {
      last.end = Math.min(index + context, rows.length - 1)
    }
  }

  const blocks: DiffBlock[] = []
  let cursor = 0
  for (let group = 0; group < groups.length; group += 1) {
    const { start, end } = groups[group]
    const blockRows: DiffRow[] = []
    if (start > cursor) blockRows.push(hiddenGap(rows.slice(cursor, start), `hunk:${group}:before`))
    blockRows.push(...rows.slice(start, end + 1))
    if (group === groups.length - 1 && end < rows.length - 1) {
      blockRows.push(hiddenGap(rows.slice(end + 1), `hunk:${group}:after`))
    }
    blocks.push({ rows: blockRows })
    cursor = end + 1
  }
  return blocks
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
  onRevert,
  onHunkReverted
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
  onHunkReverted: () => void
}) {
  const t = useT()
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const status = statusOf(file)

  const blocks = useMemo(() => {
    if (!state || state.status !== 'ready' || state.diff.binary) return []
    return splitHunks(buildWorkingTreeDiff(state.diff.oldText, state.diff.newText, file.added, file.removed).rows)
  }, [state, file.added, file.removed])

  return (
    <section className="review__file" data-open={isOpen} data-staged={file.staged || undefined}>
      <div className="review__head">
        <button
          className="review__toggle"
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-label={`${isOpen ? t('Collapse this file') : t('Show the changes of this file')}: ${file.path} (${status.label}${file.staged ? `, ${t('Staged')}` : ''})`}
          title={isOpen ? t('Collapse this file') : t('Show the changes of this file')}
        >
          <ChevronRight size={12} className="review__chevron" />
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
            <span className="review__new-path">{file.path}</span>
          </span>
          <span className="review__stats">
            {file.added ? <span data-kind="add">+{file.added}</span> : null}
            {file.removed ? <span data-kind="del">−{file.removed}</span> : null}
          </span>
          {file.staged ? <span className="review__staged">{t('Staged')}</span> : null}
        </button>

        <div className="review__file-actions">
          <Popover
            align="right"
            width={220}
            renderTrigger={({ open: menuOpen, toggle: toggleMenu }) => (
              <button
                className="icon-btn"
                type="button"
                title={t('More actions')}
                aria-label={`${t('More actions')}: ${file.path}`}
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                onClick={toggleMenu}
              >
                <Ellipsis size={14} />
              </button>
            )}
          >
            {(close) => (
              <div role="menu" aria-label={`${t('More actions')}: ${file.path}`}>
                <button className="popover__item" role="menuitem" onClick={() => { close(); onToggleStage() }}>
                  {file.staged ? <Minus size={13} /> : <Plus size={13} />}
                  {file.staged ? t('Unstage this file') : t('Stage this file')}
                </button>
                <button className="popover__item" role="menuitem" onClick={() => { close(); insertIntoComposer(t('Review the uncommitted changes in @{file} and check for potential issues.').replace('{file}', file.path.replace(/\\/g, '/'))) }}>
                  <MessageSquarePlus size={13} /> {t('Ask Pi to review this file')}
                </button>
                <button className="popover__item" role="menuitem" onClick={() => { close(); onCopyPatch() }}>
                  <ClipboardCopy size={13} /> {t('Copy this patch')}
                </button>
                <button className="popover__item" role="menuitem" onClick={() => { close(); onOpen() }}>
                  <SquareArrowOutUpRight size={13} /> {t('Open the file')}
                </button>
                <button className="popover__item" role="menuitem" onClick={() => { close(); onReveal() }}>
                  <FileWarning size={13} /> {t('Reveal in the file manager')}
                </button>
                {file.untracked ? null : (
                  <button className="popover__item" role="menuitem" onClick={() => { close(); onRevert() }}>
                    <RotateCcw size={13} /> {t('Revert this file')}
                  </button>
                )}
              </div>
            )}
          </Popover>
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
              <DiffView
                diffs={blocks}
                mode={split ? 'split' : 'unified'}
                patchPath={file.path}
                revertPath={file.untracked ? undefined : file.path}
                onReverted={onHunkReverted}
              />
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

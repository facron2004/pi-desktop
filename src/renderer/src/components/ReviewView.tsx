import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
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
import type { GitFileDiff, GitFileStatus, GitStatus } from '@shared/types'
import { buildWorkingTreeDiff, CONTEXT_LINES, type DiffBlock, type DiffRow } from '../lib/diff-fold'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { DiffView } from './DiffView'
import { FileIcon } from './FileIcon'
import { Popover } from './Popover'
import '../styles/review.css'

/**
 * A cached per-file diff, tagged with what it was read from.
 *
 * `signature` is the file's status as git reported it (see `signatureOf`).
 * `snapshot` is the whole `git` reading the diff was read under: an edit can
 * rewrite the text of an already-changed line without moving its counts, so the
 * counts alone are not enough to call a diff fresh. The reading is compared by
 * identity — the store builds a new `GitStatus` on every read.
 */
type DiffState = ReadRequest &
  (
    | { status: 'loading' }
    | { status: 'ready'; diff: GitFileDiff }
    | { status: 'error' }
  )

/** What a per-file diff read was asked for: the file's state, and the tree. */
interface ReadRequest {
  /** The file's status as git reported it when this read started. */
  signature: string
  /** The `git` reading this read started under; a newer one makes it stale. */
  snapshot: GitStatus | undefined
}

/** One array for the "not read yet" case, so its identity does not churn. */
const NO_FILES: GitFileStatus[] = []

/**
 * Everything about a changed file that a cached diff depends on.
 *
 * The diff is HEAD against the working tree, so it is stale when the status
 * codes move (a file becomes staged, deleted or untracked), when the line
 * counts move (the edit landed), or when a rename picks up a different source.
 * A file that left the tree has no signature at all, which is what drops its
 * entry.
 */
function signatureOf(file: GitFileStatus): string {
  return [
    file.path,
    file.oldPath ?? '',
    file.index,
    file.worktree,
    file.added ?? '',
    file.removed ?? ''
  ].join('\u0000')
}

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
  // The changed file whose diff is in the main pane. MCode's review panel is a
  // split view: the file tree stays on the right while the diff changes in
  // place, rather than folding every file open in a single column.
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [revertTarget, setRevertTarget] = useState<string | null>(null)
  const [expandAll, setExpandAll] = useState<boolean | undefined>(undefined)
  // The read that is running or was last asked for, per path. The object is its
  // own token: a read that finishes after a newer one started must not paint,
  // or the pane would show the older of the two diffs.
  const readsInFlight = useRef<Record<string, ReadRequest>>({})

  // The panel is opened when the user wants to review, so it reads git then.
  useEffect(() => {
    if (active) void refreshGit()
  }, [active, refreshGit, workspace?.path])

  const files = git?.files ?? NO_FILES

  // What a cached diff was read from, per path. The status codes, the rename
  // source and the line counts all move when the file changes on disk, so the
  // tuple tells a fresh read from a stale one without reading every file.
  const signatures = useMemo(() => {
    const next: Record<string, string> = {}
    for (const file of files) next[file.path] = signatureOf(file)
    return next
  }, [files])

  const load = useCallback(async (path: string, request: ReadRequest) => {
    const mine = request
    readsInFlight.current[path] = mine
    setDiffs((previous) => {
      const entry = previous[path]
      // The diff on screen stays there while the newer one is read. The store
      // reads the tree after every edit, and a spinner for each of those reads
      // would flash the pane instead of letting the edit land in place.
      if (entry?.status === 'ready' && entry.signature === request.signature) return previous
      return { ...previous, [path]: { status: 'loading', ...request } }
    })
    try {
      const diff = await window.pi.git.fileDiff(path)
      if (readsInFlight.current[path] !== mine) return
      delete readsInFlight.current[path]
      setDiffs((previous) => ({ ...previous, [path]: { status: 'ready', ...request, diff } }))
    } catch {
      if (readsInFlight.current[path] !== mine) return
      delete readsInFlight.current[path]
      setDiffs((previous) => {
        // A diff that was read before and is still current is worth more than
        // an error notice: the tree was read again, not the file broken.
        const entry = previous[path]
        if (entry?.status === 'ready' && entry.signature === request.signature) {
          return { ...previous, [path]: { status: 'ready', ...request, diff: entry.diff } }
        }
        return { ...previous, [path]: { status: 'error', ...request } }
      })
    }
  }, [])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      // The new `git` reading is what invalidates the cached diffs, and the
      // selected-file effect reads that file again under it. Nothing is read
      // here directly: one read of the selected file per tree reading.
      await refreshGit()
    } finally {
      setRefreshing(false)
    }
  }, [refreshGit])

  // Reverting a hunk rewrites the work tree, so every cached diff is stale.
  // The new `git` reading invalidates them, and the selected-file effect reads
  // this file again from disk under it.
  const reloadAfterHunk = useCallback(async () => {
    await refreshGit()
  }, [refreshGit])

  // A cached diff belongs to the state of the file it was read from. When the
  // signature moves, the entry goes: the edit landed and its counts changed, a
  // file was staged or deleted, or a rename picked up a different source. A
  // path that left the working tree — committed or reverted — has no signature
  // at all and goes the same way, instead of keeping a change that no longer
  // exists. The snapshot is not checked here: it is what makes the selected
  // file be read again below, and dropping the entry first would flash the
  // spinner on every read the store pushes during a run.
  useEffect(() => {
    setDiffs((previous) => {
      let changed = false
      const next: Record<string, DiffState> = {}
      for (const [path, entry] of Object.entries(previous)) {
        if (signatures[path] === entry.signature) next[path] = entry
        else changed = true
      }
      return changed ? next : previous
    })
  }, [signatures])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return files
    return files.filter(
      (file) =>
        file.path.toLowerCase().includes(needle) ||
        file.oldPath?.toLowerCase().includes(needle)
    )
  }, [files, filter])

  const selectedFile =
    visible.find((file) => file.path === selectedPath) ?? visible[0] ?? null
  const selectedDiff = selectedFile ? diffs[selectedFile.path] : undefined

  // Selecting a row is the only way its diff is read; keeping this effect at
  // the top means the first file is loaded as soon as the tree is available.
  // The read is keyed by the file's signature and the git reading it happens
  // under, so a file whose status or counts moved — or whose tree was read
  // again — is read once more, and a file that did not move is not read at all.
  // Only the selected file is read: a run that touches twenty files must not
  // turn one git update into twenty diff reads. The store pushes `git`; nothing
  // here asks git for anything, so a read cannot feed the refresh behind it.
  useEffect(() => {
    if (!active || !selectedFile) return
    const signature = signatures[selectedFile.path]
    if (!signature) return
    const entry = diffs[selectedFile.path]
    if (entry && entry.signature === signature && entry.snapshot === git) return
    const running = readsInFlight.current[selectedFile.path]
    if (running && running.signature === signature && running.snapshot === git) return
    void load(selectedFile.path, { signature, snapshot: git })
  }, [active, selectedFile, signatures, diffs, git, load])

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
    // The file went back to HEAD, so its entry has no signature any more and
    // the new reading drops it.
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
                onClick={() => setExpandAll((value) => value === true ? false : true)}
                disabled={visible.length === 0}
                aria-label={expandAll === true ? t('Fold the unchanged lines') : t('Show the unchanged lines')}
                title={expandAll === true ? t('Fold the unchanged lines') : t('Show the unchanged lines')}
              >
                {expandAll === true ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
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
      ) : (
        <div className="change-workspace">
          <div className="change-workspace__main">
            {selectedFile ? (
              <ReviewFileDetail
                file={selectedFile}
                state={selectedDiff}
                split={diffSplit}
                expandAll={expandAll}
                onOpen={() => onOpenFile({ path: selectedFile.path })}
                onReveal={() => void window.pi.fs.reveal(selectedFile.path)}
                onToggleStage={() => void toggleStage(selectedFile)}
                onCopyPatch={() => void copyPatch(selectedFile.path)}
                onRevert={() => setRevertTarget(selectedFile.path)}
                onHunkReverted={() => void reloadAfterHunk()}
              />
            ) : (
              <div className="review__empty">
                <p>{t('No changed file matches')} “{filter}”.</p>
              </div>
            )}
          </div>
          <aside className="change-workspace__files" aria-label={t('Changed files')}>
            <div className="change-files__head">
              <span>{visible.length} {visible.length === 1 ? t('file') : t('files')}</span>
              <span className="review__totals">
                {visibleTotals.added ? <span data-kind="add">+{visibleTotals.added}</span> : null}
                {visibleTotals.removed ? <span data-kind="del">−{visibleTotals.removed}</span> : null}
              </span>
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
            <div className="change-files__list">
              {visible.map((file) => {
                const status = statusOf(file)
                const name = file.path.split(/[\\/]/).pop() ?? file.path
                return (
                  <button
                    key={file.path}
                    type="button"
                    className="change-file"
                    data-active={selectedFile?.path === file.path || undefined}
                    data-staged={file.staged || undefined}
                    title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                    onClick={() => setSelectedPath(file.path)}
                  >
                    <span className="review-file__status" data-kind={status.kind}>{status.label}</span>
                    <FileIcon name={name} />
                    <span className="change-file__body">
                      <span className="change-file__name">{name}</span>
                    </span>
                    <span className="change-file__stats">
                      {file.added ? <span data-kind="add">+{file.added}</span> : null}
                      {file.removed ? <span data-kind="del">−{file.removed}</span> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          </aside>
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

function ReviewFileDetail({
  file,
  state,
  split,
  expandAll,
  onOpen,
  onReveal,
  onToggleStage,
  onCopyPatch,
  onRevert,
  onHunkReverted
}: {
  file: GitFileStatus
  state: DiffState | undefined
  split: boolean
  expandAll: boolean | undefined
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
  const name = file.path.split(/[\\/]/).pop() ?? file.path

  const blocks = useMemo(() => {
    if (!state || state.status !== 'ready' || state.diff.binary) return []
    return splitHunks(buildWorkingTreeDiff(state.diff.oldText, state.diff.newText, file.added, file.removed).rows)
  }, [state, file.added, file.removed])

  return (
    <div className="change-preview" data-staged={file.staged || undefined}>
      <div className="change-preview__bar">
        <span className="review-file__status" data-kind={status.kind}>{status.label}</span>
        <span className="change-preview__name" title={file.path}>{name}</span>
        <code className="change-preview__path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
          {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
        </code>
        {file.staged ? <span className="review__staged">{t('Staged')}</span> : null}
        <span className="change-preview__stats">
          {file.added ? <span data-kind="add">+{file.added}</span> : null}
          {file.removed ? <span data-kind="del">−{file.removed}</span> : null}
        </span>
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

      <div className="change-preview__body">
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
              expandAll={expandAll}
            />
          </>
        )}
      </div>
    </div>
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

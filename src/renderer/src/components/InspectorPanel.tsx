import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  ExternalLink,
  FileDiff,
  FilePlus,
  Files,
  GitCommit,
  GitCompare,
  MessageSquare,
  Pencil,
  Rows3,
  Search,
  X
} from 'lucide-react'
import { collectChanges } from '../lib/changes'
import { formatChanges } from '../lib/diff-text'
import { relativePath, resolveAgainst } from '../lib/path'
import { useAppStore } from '../store/useAppStore'
import { diffStats } from '../lib/diff-fold'
import { DiffView } from './DiffView'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { CommitDialog } from './CommitDialog'
import { ReviewView } from './ReviewView'
import { useT } from '../lib/i18n'

type Tab = 'changes' | 'files' | 'review'

const MIN_WIDTH = 300
const MAX_WIDTH = 920

export function InspectorPanel({
  onClose,
  initialTab = 'changes',
  file,
  onOpenFile,
  onResize,
  onResizeEnd
}: {
  onClose: () => void
  initialTab?: Tab
  /** The file to show, when the panel was asked for a specific one. */
  file: { path: string; line?: number } | null
  onOpenFile: (file: { path: string; line?: number } | null) => void
  onResize?: (width: number) => void
  onResizeEnd?: (width: number) => void
}) {
  const items = useAppStore((state) => state.items)
  const workspace = useAppStore((state) => state.workspace)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const showToast = useAppStore((state) => state.showToast)
  const git = useAppStore((state) => state.git)
  const commitRequest = useAppStore((state) => state.commitRequest)
  const refreshGit = useAppStore((state) => state.refreshGit)
  const t = useT()
  const diffSplit = settings.diffSplit === true
  const changes = useMemo(() => collectChanges(items), [items])
  const [commitOpen, setCommitOpen] = useState(false)

  // The panel is the place the review happens, so it asks git for a fresh
  // working tree every time it is opened.
  useEffect(() => {
    void refreshGit()
  }, [refreshGit])

  // The app's own `/commit` command and the launcher ask for this dialog
  // through the store instead of reaching into the component tree.
  useEffect(() => {
    if (commitRequest > 0) setCommitOpen(true)
  }, [commitRequest])

  // The lines that were added and removed over all the files, for the head of
  // the panel. The same numbers are shown per file.
  const stats = useMemo(
    () =>
      changes.map((change) => {
        const total = change.diffs.reduce(
          (acc, block) => {
            const one = diffStats(block)
            return { added: acc.added + one.added, removed: acc.removed + one.removed }
          },
          { added: 0, removed: 0 }
        )
        return { path: change.path, ...total }
      }),
    [changes]
  )
  const totals = useMemo(
    () =>
      stats.reduce(
        (acc, one) => ({ added: acc.added + one.added, removed: acc.removed + one.removed }),
        { added: 0, removed: 0 }
      ),
    [stats]
  )

  const [tab, setTab] = useState<Tab>(initialTab)
  // The files the agent touched, narrowed down by a search on the path.
  const [fileFilter, setFileFilter] = useState('')
  // `undefined` means the reader decides, one run at a time.
  const [expandAll, setExpandAll] = useState<boolean | undefined>(undefined)

  // The paths of the changed files, relative to the project, so the list
  // means the same thing to the user and to the agent.
  const relativePaths = useMemo(
    () => changes.map((change) => relativePath(workspace?.path ?? '', change.path)),
    [changes, workspace?.path]
  )

  // The changed files that survive the search, with their line counts.
  const entries = useMemo(() => {
    const needle = fileFilter.trim().toLowerCase()
    return changes
      .map((change, index) => ({ change, stat: stats[index], path: relativePaths[index] }))
      .filter((entry) => !needle || entry.path.toLowerCase().includes(needle))
  }, [changes, stats, relativePaths, fileFilter])

  const copyPaths = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(relativePaths.join('\n'))
      showToast(
        relativePaths.length === 1
          ? t('The path was copied')
          : `${relativePaths.length} ${t('paths were copied')}`
      )
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }, [relativePaths, showToast, t])

  /**
   * Take every change out of the app.
   *
   * The diff of a review or the body of a commit is written somewhere else,
   * and picking it out of the panel line by line is a waste of a minute.
   */
  const copyDiff = useCallback(async () => {
    const text = formatChanges(changes, relativePaths)
    if (!text.trim()) {
      showToast(t('There is no diff to copy yet'), 'warning')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      showToast(t('The diff was copied'))
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }, [changes, relativePaths, showToast, t])

  /**
   * Hand the list of changed files to the agent.
   *
   * The prompt is put in the composer rather than sent, so the user can say
   * something else about the changes before it goes out.
   */
  const askAboutChanges = useCallback(() => {
    const list = changes
      .map((change, index) => {
        const one = stats[index]
        const size =
          change.kind === 'write' && !one.added && !one.removed
            ? 'new file'
            : `${one.added ? `+${one.added}` : ''} ${one.removed ? `−${one.removed}` : ''}`.trim()
        return `- ${relativePaths[index]}${size ? ` (${size})` : ''}`
      })
      .join('\n')
    insertIntoComposer(
      settings.language === 'zh-CN'
        ? `请检查你刚才对这些文件所做的修改，并说明修改内容和原因：\n${list}`
        : `Review the changes you just made to these files and tell me what you changed and why:\n${list}`,
      'append'
    )
    showToast(t('The file list is in the composer'))
  }, [changes, stats, relativePaths, insertIntoComposer, showToast, settings.language, t])

  // The open file lives in the app shell, so a diff in the thread can send
  // the reader to a line of a file.
  const openFile = file
  const setOpenFile = onOpenFile

  useEffect(() => {
    setTab(initialTab)
  }, [initialTab])

  // Development aid: open a file straight away so screenshots can show the
  // viewer. Set by the main process via PI_DESKTOP_OPEN_FILE. A relative
  // path is taken from the project root.
  useEffect(() => {
    const dev = (window as unknown as { __piDesktopDev?: { openFile?: string } }).__piDesktopDev
    if (!dev?.openFile) return
    setTab('files')
    const root = useAppStore.getState().workspace?.path
    setOpenFile({ path: root ? resolveAgainst(root, dev.openFile) : dev.openFile })
  }, [setOpenFile])

  // Drag the left edge to make the panel wider or narrower.
  const widthRef = useRef(0)
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!onResize) return
      event.preventDefault()
      const handle = event.currentTarget
      const panel = handle.parentElement
      const startX = event.clientX
      const startWidth = panel?.getBoundingClientRect().width ?? 420
      widthRef.current = startWidth

      const move = (moveEvent: PointerEvent) => {
        const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth - (moveEvent.clientX - startX)))
        widthRef.current = width
        onResize(width)
      }
      const up = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        document.body.classList.remove('is-resizing')
        onResizeEnd?.(widthRef.current)
      }

      handle.setPointerCapture(event.pointerId)
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
      document.body.classList.add('is-resizing')
    },
    [onResize, onResizeEnd]
  )

  return (
    <aside className="drawer" aria-label={t('Project inspector')}>
      <div
        className="drawer__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('Resize the panel')}
        onPointerDown={startResize}
      />
      <header className="drawer__head">
        <div className="drawer__tabs">
          <button
            className="drawer__tab"
            data-active={tab === 'changes' && !openFile}
            onClick={() => {
              setTab('changes')
              setOpenFile(null)
            }}
          >
            <FileDiff size={13} />
            {t('Changes')}
            {changes.length > 0 ? <span className="drawer__count">{changes.length}</span> : null}
          </button>
          <button
            className="drawer__tab"
            data-active={tab === 'review' && !openFile}
            onClick={() => {
              setTab('review')
              setOpenFile(null)
            }}
            title={t('Review the uncommitted changes of the project')}
          >
            <GitCompare size={13} />
            {t('Review')}
            {git?.isRepo && git.files.length > 0 ? (
              <span className="drawer__count">{git.files.length}</span>
            ) : null}
          </button>
          <button
            className="drawer__tab"
            data-active={tab === 'files' && !openFile}
            onClick={() => {
              setTab('files')
              setOpenFile(null)
            }}
          >
            <Files size={13} />
            {t('Files')}
          </button>
        </div>
        <span style={{ flex: 1 }} />
        {tab === 'changes' && changes.length > 0 && (totals.added || totals.removed) ? (
          <span className="drawer__stats" title={t('Lines added and removed over all files')}>
            {totals.added ? <span data-kind="add">+{totals.added}</span> : null}
            {totals.removed ? <span data-kind="del">−{totals.removed}</span> : null}
          </span>
        ) : null}
        {tab !== 'files' && git?.isRepo ? (
          <button
            className="ghost-btn drawer__commit"
            onClick={() => setCommitOpen(true)}
            disabled={git.clean}
            title={
              git.clean
                ? t('There is nothing to commit')
                : t('Review the working tree and commit it')
            }
          >
            <GitCommit size={12} />
            <span>{git.clean ? t('Committed') : t('Commit')}</span>
            {git.clean ? null : <span className="drawer__count">{git.files.length}</span>}
          </button>
        ) : null}
        {tab !== 'files' && (tab === 'review' || changes.length > 0) ? (
          <div className="segmented segmented--tight" title={t('Diff layout')}>
            <button
              data-active={!diffSplit}
              onClick={() => void updateSettings({ diffSplit: false })}
              title={t('Unified diff')}
            >
              <Rows3 size={12} />
            </button>
            <button
              data-active={diffSplit}
              onClick={() => void updateSettings({ diffSplit: true })}
              title={t('Side-by-side diff')}
            >
              <Columns2 size={12} />
            </button>
          </div>
        ) : null}
        <button className="icon-btn" onClick={onClose} title={t('Close')}>
          <X size={15} />
        </button>
      </header>

      {/* The panes stay mounted, so the file tree keeps the folders the user
          opened while a file is on screen. */}
      <div className="drawer__stack">
        <div className="drawer__pane" data-active={!openFile && tab === 'files'}>
          <FileTree root={workspace?.path ?? ''} onOpen={(path) => setOpenFile({ path })} />
        </div>

        <div className="drawer__pane" data-active={!openFile && tab === 'review'}>
          <ReviewView onOpenFile={setOpenFile} />
        </div>

        <div className="drawer__pane" data-active={!openFile && tab === 'changes'}>
          {changes.length === 0 ? (
            <div className="drawer__empty">
              {git?.isRepo && git.files.length > 0
                ? t('This conversation has not changed any files.')
                : t('No files have been changed yet.')}
              <br />
              {git?.isRepo && git.files.length > 0
                ? t('The working tree has changes from outside this conversation.')
                : t('Edits and new files show up here as Pi works.')}
              {git?.isRepo && git.files.length > 0 ? (
                <div className="drawer__empty-action">
                  <button className="btn" onClick={() => setCommitOpen(true)}>
                    <GitCommit size={12} />
                    {git.files.length} {git.files.length === 1 ? t('file to commit') : t('files to commit')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="drawer__body">
              <div className="drawer__bar">
                {changes.length >= 3 ? (
                  <div className="drawer__filter">
                    <Search size={12} />
                    <input
                      value={fileFilter}
                      placeholder={t('Filter the changed files')}
                      onChange={(event) => setFileFilter(event.target.value)}
                    />
                    {fileFilter ? (
                      <button
                        className="icon-btn"
                        onClick={() => setFileFilter('')}
                        title={t('Clear the filter')}
                      >
                        <X size={11} />
                      </button>
                    ) : null}
                  </div>
                ) : null}

                <div className="drawer__actions">
                  <button
                    className="ghost-btn"
                    onClick={() => void copyDiff()}
                    title={t('Copy the diff of every changed file')}
                  >
                    <FileDiff size={12} />
                    {t('Copy the diff')}
                  </button>
                  <button
                    className="ghost-btn"
                    onClick={() => void copyPaths()}
                    title={t('Copy the paths of the changed files')}
                  >
                    <Copy size={12} />
                    {t('Copy paths')}
                  </button>
                  <button
                    className="ghost-btn"
                    onClick={askAboutChanges}
                    title={t('Put the list of changed files in the composer')}
                  >
                    <MessageSquare size={12} />
                    {t('Ask Pi')}
                  </button>
                  <span style={{ flex: 1 }} />
                  <button
                    className="icon-btn"
                    onClick={() => setExpandAll((value) => value !== true)}
                    title={expandAll === true ? t('Fold the unchanged lines') : t('Show the unchanged lines')}
                  >
                    {expandAll === true ? (
                      <ChevronsDownUp size={13} />
                    ) : (
                      <ChevronsUpDown size={13} />
                    )}
                  </button>
                </div>
              </div>

              {entries.length === 0 ? (
                <div className="drawer__empty">{t('No changed file matches')} “{fileFilter}”.</div>
              ) : null}

              {entries.map(({ change, stat: one, path }) => {
                return (
                  <section className="change" key={change.path}>
                    <header className="change__head">
                      <span className="change__icon" data-kind={change.kind}>
                        {change.kind === 'edit' ? <Pencil size={12} /> : <FilePlus size={12} />}
                      </span>
                      <button
                        className="change__path"
                        title={`${t('Open')} ${change.path}`}
                        onClick={() => setOpenFile({ path: change.path })}
                      >
                        {path}
                      </button>
                      {one.added || one.removed ? (
                        <span className="change__stats">
                          {one.added ? <span data-kind="add">+{one.added}</span> : null}
                          {one.removed ? <span data-kind="del">−{one.removed}</span> : null}
                        </span>
                      ) : null}
                      {change.edits > 1 ? (
                        <span className="change__badge">{change.edits} {t('edits')}</span>
                      ) : null}
                      <button
                        className="change__reveal"
                        title={t('Reveal in the file manager')}
                        onClick={() => void window.pi.fs.reveal(change.path)}
                      >
                        <ExternalLink size={12} />
                      </button>
                    </header>

                    {change.diffs.length > 0 ? (
                      <DiffView
                        diffs={change.diffs}
                        mode={diffSplit ? 'split' : 'unified'}
                        onOpenLine={(line) => setOpenFile({ path: change.path, line })}
                        expandAll={expandAll}
                        onExpandAllChange={setExpandAll}
                      />
                    ) : null}

                    {!change.diffs.length && change.content ? (
                      <pre className="tool__pre">{change.content}</pre>
                    ) : null}

                    {!change.diffs.length && !change.content ? (
                      <pre className="tool__pre">{t('Written to disk.')}</pre>
                    ) : null}
                  </section>
                )
              })}
            </div>
          )}
        </div>

        <div className="drawer__pane" data-active={Boolean(openFile)}>
          {openFile ? (
            <div className="drawer__body drawer__body--flush">
              <div className="viewer__back">
                <button className="ghost-btn" onClick={() => setOpenFile(null)}>
                  <ArrowLeft size={12} />
                  {t('Back')}
                </button>
              </div>
              <FileViewer file={openFile.path} root={workspace?.path} line={openFile.line} />
            </div>
          ) : null}
        </div>
      </div>

      {commitOpen ? <CommitDialog onClose={() => setCommitOpen(false)} /> : null}
    </aside>
  )
}

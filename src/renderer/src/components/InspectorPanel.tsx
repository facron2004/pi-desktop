import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  Copy,
  Ellipsis,
  ExternalLink,
  FileDiff,
  Files,
  GitCommit,
  GitCompare,
  Globe,
  Images,
  MessageSquare,
  Rows3,
  Search,
  SquareArrowOutUpRight,
  X
} from 'lucide-react'
import { collectChanges, countChangedFiles, type FileChange } from '../lib/changes'
import { formatChanges } from '../lib/diff-text'
import { relativePath, resolveAgainst } from '../lib/path'
import type { ThreadItem } from '../lib/thread'
import { useAppStore } from '../store/useAppStore'
import { diffStats } from '../lib/diff-fold'
import { DiffView } from './DiffView'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'
import { CommitDialog } from './CommitDialog'
import { CommitDetailDialog } from './CommitDetailDialog'
import { ReviewView } from './ReviewView'
import { DiffScope } from './DiffScope'
import { Popover } from './Popover'
import { TextSearch } from './TextSearch'
import { BrowserView } from './BrowserView'
import { ImageViewer } from './ImageViewer'
import { useT } from '../lib/i18n'
import { useDialogFocus } from '../hooks/useDialogFocus'
import '../styles/browser-and-images.css'

type Tab = 'changes' | 'files' | 'review' | 'browser' | 'images'

const MIN_WIDTH = 300
const MAX_WIDTH = 920
const EMPTY_ITEMS: ThreadItem[] = []
const EMPTY_CHANGES: FileChange[] = []

export function InspectorPanel({
  onClose,
  overlay,
  initialTab = 'changes',
  onTabChange,
  file,
  onOpenFile,
  onResize,
  onResizeEnd,
  embedded = false
}: {
  onClose: () => void
  overlay: boolean
  initialTab?: Tab
  onTabChange?: (tab: Tab) => void
  /** The file to show, when the panel was asked for a specific one. */
  file: { path: string; line?: number } | null
  onOpenFile: (file: { path: string; line?: number } | null) => void
  onResize?: (width: number) => void
  onResizeEnd?: (width: number) => void
  /**
   * Draw inside the side panel: the panel owns the header and the width, so
   * the tabs, the close button and the resize edge are not drawn here.
   */
  embedded?: boolean
}) {
  const panelRef = useRef<HTMLElement>(null)
  useDialogFocus(panelRef, onClose, overlay)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [changeScope, setChangeScope] = useState<'auto' | 'local' | 'conversation'>('auto')
  const changeTab = (next: Tab) => {
    setTab(next)
    onTabChange?.(next)
    onOpenFile(null)
  }
  const showingChanges = tab === 'changes' && file === null
  const items = useAppStore((state) => (showingChanges ? state.items : EMPTY_ITEMS))
  const changedFileCount = useAppStore((state) => countChangedFiles(state.items))
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
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
  const changes = useMemo(
    () => (showingChanges ? collectChanges(items) : EMPTY_CHANGES),
    [items, showingChanges]
  )
  const showingGitFallback =
    tab === 'changes' && Boolean(git?.isRepo) &&
    (changeScope === 'local' || (changeScope === 'auto' && changes.length === 0))
  const effectiveChangesCount =
    changedFileCount > 0 ? changedFileCount : git?.isRepo ? git.files.length : 0
  const [commitOpen, setCommitOpen] = useState(false)
  const [commitHash, setCommitHash] = useState<string | null>(null)

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

  // The files the agent touched, narrowed down by a search on the path.
  const [fileFilter, setFileFilter] = useState('')
  const [fileFilterOpen, setFileFilterOpen] = useState(false)
  const fileFilterRef = useRef<HTMLInputElement>(null)
  // `undefined` means the reader decides, one run at a time.
  const [expandAll, setExpandAll] = useState<boolean | undefined>(undefined)
  const [openChanges, setOpenChanges] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    setOpenChanges(new Set())
    setChangeScope('auto')
  }, [activeSessionFile, workspace?.path])
  // The Files tab browses the tree or searches inside the files. The tree stays
  // mounted while the search is on, so its open folders survive a look.
  const [filesMode, setFilesMode] = useState<'tree' | 'text'>('tree')

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
  const visibleTotals = useMemo(
    () => entries.reduce((acc, entry) => ({ added: acc.added + entry.stat.added, removed: acc.removed + entry.stat.removed }), { added: 0, removed: 0 }),
    [entries]
  )
  const allVisibleOpen = entries.length > 0 && entries.every((entry) => openChanges.has(entry.change.path))
  const toggleAllChanges = () => {
    setOpenChanges((previous) => {
      const next = new Set(previous)
      for (const entry of entries) {
        if (allVisibleOpen) next.delete(entry.change.path)
        else next.add(entry.change.path)
      }
      return next
    })
  }
  const scopeControl = git?.isRepo ? (
    <DiffScope
      value={showingGitFallback || tab === 'review' ? 'local' : 'conversation'}
      onChange={(scope) => {
        setChangeScope(scope)
        if (tab === 'review') changeTab('changes')
      }}
    />
  ) : <span className="review__scope">{t('Conversation changes')}</span>

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
    <>
      <aside
        ref={panelRef}
        className={embedded ? 'drawer drawer--embedded' : 'drawer'}
        role={overlay ? 'dialog' : undefined}
        aria-modal={overlay ? true : undefined}
        tabIndex={overlay ? -1 : undefined}
        aria-label={t('Project inspector')}
      >
        {embedded ? null : (
          <div
            className="drawer__resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label={t('Resize the panel')}
            onPointerDown={startResize}
          />
        )}
        {embedded ? null : (
          <header className="drawer__head">
          <div className="drawer__tabs">
            <button
              className="drawer__tab"
              data-active={tab === 'changes'}
              aria-pressed={tab === 'changes'}
              aria-label={t('Changes')}
              title={t('Changes')}
              onClick={() => changeTab('changes')}
            >
              <FileDiff size={13} />
              <span className="drawer__tab-label">{t('Changes')}</span>
              {effectiveChangesCount > 0 ? (
                <span className="drawer__count">{effectiveChangesCount}</span>
              ) : null}
            </button>
            <button
              className="drawer__tab"
              data-active={tab === 'files'}
              aria-pressed={tab === 'files'}
              aria-label={t('Files')}
              onClick={() => changeTab('files')}
              title={t('Files')}
            >
              <Files size={14} />
              <span className="drawer__tab-label">{t('Files')}</span>
            </button>
            <button
              className="drawer__tab"
              data-active={tab === 'review'}
              aria-pressed={tab === 'review'}
              aria-label={t('Review')}
              title={t('Review the uncommitted changes of the project')}
              onClick={() => changeTab('review')}
            >
              <GitCompare size={14} />
              <span className="drawer__tab-label">{t('Review')}</span>
              {git?.isRepo && git.files.length > 0 ? (
                <span className="drawer__count">{git.files.length}</span>
              ) : null}
            </button>
            <button
              className="drawer__tab"
              data-active={tab === 'browser'}
              aria-pressed={tab === 'browser'}
              aria-label={t('Browser')}
              title={t('Browse a page without leaving the app')}
              onClick={() => changeTab('browser')}
            >
              <Globe size={14} />
              <span className="drawer__tab-label">{t('Browser')}</span>
            </button>
            <button
              className="drawer__tab"
              data-active={tab === 'images'}
              aria-pressed={tab === 'images'}
              aria-label={t('Images')}
              title={t('Pictures in this project')}
              onClick={() => changeTab('images')}
            >
              <Images size={14} />
              <span className="drawer__tab-label">{t('Images')}</span>
            </button>
          </div>
          <button className="icon-btn" onClick={onClose} title={t('Close')} aria-label={t('Close')}>
            <X size={16} />
          </button>
          </header>
        )}
        {/* The panes stay mounted, so the file tree keeps the folders the user
            opened while a file is on screen. */}
        <div className="drawer__stack">
          <div className="drawer__pane" data-active={!openFile && tab === 'files'}>
            <div className="file-mode">
              <div className="segmented">
                <button
                  data-active={filesMode === 'tree'}
                  aria-pressed={filesMode === 'tree'}
                  onClick={() => setFilesMode('tree')}
                  title={t('Browse the project files')}
                >
                  {t('Files')}
                </button>
                <button
                  data-active={filesMode === 'text'}
                  aria-pressed={filesMode === 'text'}
                  onClick={() => setFilesMode('text')}
                  title={t('Search inside the project files')}
                >
                  {t('Text')}
                </button>
              </div>
            </div>
            <div className="file-mode__body" hidden={filesMode !== 'tree'}>
              <FileTree root={workspace?.path ?? ''} onOpen={(path) => setOpenFile({ path })} />
            </div>
            {filesMode === 'text' ? (
              <TextSearch
                root={workspace?.path ?? ''}
                onOpenFile={setOpenFile}
                onClose={() => setFilesMode('tree')}
              />
            ) : null}
          </div>

          <div
            className="drawer__pane"
            data-active={!openFile && (tab === 'review' || showingGitFallback)}
          >
            <ReviewView
              key={workspace?.path}
              onOpenFile={setOpenFile}
              onCommit={() => setCommitOpen(true)}
              scopeControl={scopeControl}
              active={!openFile && (tab === 'review' || showingGitFallback)}
            />
          </div>

          <div
            className="drawer__pane"
            data-active={!openFile && tab === 'changes' && !showingGitFallback}
          >
              <div className="drawer__body drawer__body--changes">
                <div className="review__bar">
                  {scopeControl}
                  <span className="review__totals" title={t('Lines added and removed over all files')}>
                    {totals.added ? <span data-kind="add">+{totals.added}</span> : null}
                    {totals.removed ? <span data-kind="del">−{totals.removed}</span> : null}
                  </span>
                  <div className="review__actions">
                    <button className="icon-btn" onClick={() => { if (fileFilterOpen) setFileFilter(''); setFileFilterOpen((value) => !value) }} title={t('Filter the changed files')} aria-label={t('Filter the changed files')} aria-pressed={fileFilterOpen} data-active={fileFilterOpen}>
                      <Search size={14} />
                    </button>
                    <button className="icon-btn" onClick={toggleAllChanges} disabled={entries.length === 0} title={allVisibleOpen ? t('Collapse all files') : t('Expand all files')} aria-label={allVisibleOpen ? t('Collapse all files') : t('Expand all files')}>
                      {allVisibleOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                    </button>
                    <button className="icon-btn" onClick={() => void updateSettings({ diffSplit: !diffSplit })} title={diffSplit ? t('Unified diff') : t('Side-by-side diff')} aria-label={diffSplit ? t('Unified diff') : t('Side-by-side diff')}>
                      {diffSplit ? <Rows3 size={14} /> : <Columns2 size={14} />}
                    </button>
                    <Popover
                      align="right"
                      width={220}
                      renderTrigger={({ open, toggle }) => (
                        <button className="icon-btn" type="button" aria-label={t('More actions')} title={t('More actions')} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
                          <Ellipsis size={15} />
                        </button>
                      )}
                    >
                      {(close) => (
                        <div role="menu" aria-label={t('More actions')}>
                          <button className="popover__item" role="menuitem" disabled={changes.length === 0} onClick={() => { close(); void copyDiff() }}>
                            <FileDiff size={13} /> {t('Copy the diff')}
                          </button>
                          <button className="popover__item" role="menuitem" disabled={changes.length === 0} onClick={() => { close(); void copyPaths() }}>
                            <Copy size={13} /> {t('Copy paths')}
                          </button>
                          <button className="popover__item" role="menuitem" disabled={changes.length === 0} onClick={() => { close(); askAboutChanges() }}>
                            <MessageSquare size={13} /> {t('Ask Pi')}
                          </button>
                          <button className="popover__item" role="menuitem" onClick={() => { close(); setExpandAll((value) => value !== true) }}>
                            {expandAll === true ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
                            {expandAll === true ? t('Fold the unchanged lines') : t('Show the unchanged lines')}
                          </button>
                          {git?.isRepo ? (
                            <button className="popover__item" role="menuitem" disabled={git.clean} onClick={() => { close(); setCommitOpen(true) }}>
                              <GitCommit size={13} /> {t('Commit')}
                            </button>
                          ) : null}
                        </div>
                      )}
                    </Popover>
                  </div>
                </div>
                {fileFilterOpen ? (
                  <div className="review__filter-row">
                    <div className="review__filter">
                      <Search size={12} />
                      <input
                        ref={fileFilterRef}
                        autoFocus
                        value={fileFilter}
                        aria-label={t('Filter the changed files')}
                        placeholder={t('Filter the changed files')}
                        onChange={(event) => setFileFilter(event.target.value)}
                      />
                      {fileFilter ? (
                        <button className="icon-btn" onClick={() => { setFileFilter(''); fileFilterRef.current?.focus() }} title={t('Clear the filter')} aria-label={t('Clear the filter')}>
                          <X size={11} />
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                <div className="review__summary">
                  <span>{entries.length} {entries.length === 1 ? t('file') : t('files')}</span>
                  <span className="review__totals">
                    {visibleTotals.added ? <span data-kind="add">+{visibleTotals.added}</span> : null}
                    {visibleTotals.removed ? <span data-kind="del">−{visibleTotals.removed}</span> : null}
                  </span>
                </div>

                {changes.length === 0 ? (
                  <div className="drawer__empty">
                    {git?.isRepo && git.files.length > 0
                      ? t('This conversation has not changed any files.')
                      : t('No files have been changed yet.')}
                    <br />
                    {git?.isRepo && git.files.length > 0
                      ? t('The working tree has changes from outside this conversation.')
                      : t('Edits and new files show up here as Pi works.')}
                  </div>
                ) : entries.length === 0 ? (
                  <div className="drawer__empty">{t('No changed file matches')} “{fileFilter}”.</div>
                ) : null}

                {entries.map(({ change, stat: one, path }) => {
                  const isOpen = openChanges.has(change.path)
                  return (
                    <section className="change" key={change.path} data-open={isOpen}>
                      <header className="change__head">
                        <button
                          className="change__toggle"
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? t('Collapse this file') : t('Show the changes of this file')}: ${path}`}
                          title={isOpen ? t('Collapse this file') : t('Show the changes of this file')}
                          onClick={() => {
                            setOpenChanges((previous) => {
                              const next = new Set(previous)
                              if (next.has(change.path)) next.delete(change.path)
                              else next.add(change.path)
                              return next
                            })
                          }}
                        >
                          <ChevronRight size={12} />
                          <span className="change__path" title={change.path}>{path}</span>
                          {one.added || one.removed ? (
                            <span className="change__stats">
                              {one.added ? <span data-kind="add">+{one.added}</span> : null}
                              {one.removed ? <span data-kind="del">−{one.removed}</span> : null}
                            </span>
                          ) : null}
                          {change.edits > 1 ? (
                            <span className="change__badge">{change.edits} {t('edits')}</span>
                          ) : null}
                        </button>
                        <div className="change__file-actions">
                          <button className="icon-btn" title={t('Open the file')} aria-label={`${t('Open the file')}: ${change.path}`} onClick={() => setOpenFile({ path: change.path })}>
                            <SquareArrowOutUpRight size={12} />
                          </button>
                          <button className="icon-btn" title={t('Reveal in the file manager')} aria-label={`${t('Reveal in the file manager')}: ${change.path}`} onClick={() => void window.pi.fs.reveal(change.path)}>
                            <ExternalLink size={12} />
                          </button>
                        </div>
                      </header>

                      {isOpen ? (
                        <div className="change__body">
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
                        </div>
                      ) : null}
                    </section>
                  )
                })}
              </div>
          </div>

          <div className="drawer__pane" data-active={!openFile && tab === 'browser'}>
            <BrowserView />
          </div>

          <div className="drawer__pane" data-active={!openFile && tab === 'images'}>
            <ImageViewer />
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
      </aside>

      {commitOpen ? (
        <CommitDialog
          onClose={() => setCommitOpen(false)}
          onOpenCommit={(hash) => setCommitHash(hash)}
        />
      ) : null}
      {commitHash ? (
        <CommitDetailDialog hash={commitHash} onClose={() => setCommitHash(null)} />
      ) : null}
    </>
  )
}

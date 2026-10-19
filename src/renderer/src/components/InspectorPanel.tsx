import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Columns2, ExternalLink, FileDiff, FilePlus, Files, Pencil, Rows3, X } from 'lucide-react'
import { collectChanges } from '../lib/changes'
import { relativePath, resolveAgainst } from '../lib/path'
import { useAppStore } from '../store/useAppStore'
import { diffStats } from '../lib/diff-fold'
import { DiffView } from './DiffView'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'

type Tab = 'changes' | 'files'

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
  const diffSplit = settings.diffSplit === true
  const changes = useMemo(() => collectChanges(items), [items])

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
    <aside className="drawer" aria-label="Project inspector">
      <div
        className="drawer__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the panel"
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
            Changes
            {changes.length > 0 ? <span className="drawer__count">{changes.length}</span> : null}
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
            Files
          </button>
        </div>
        <span style={{ flex: 1 }} />
        {changes.length > 0 && (totals.added || totals.removed) ? (
          <span className="drawer__stats" title="Lines added and removed over all files">
            {totals.added ? <span data-kind="add">+{totals.added}</span> : null}
            {totals.removed ? <span data-kind="del">−{totals.removed}</span> : null}
          </span>
        ) : null}
        {tab === 'changes' && changes.length > 0 ? (
          <div className="segmented segmented--tight" title="Diff layout">
            <button
              data-active={!diffSplit}
              onClick={() => void updateSettings({ diffSplit: false })}
              title="Unified diff"
            >
              <Rows3 size={12} />
            </button>
            <button
              data-active={diffSplit}
              onClick={() => void updateSettings({ diffSplit: true })}
              title="Side-by-side diff"
            >
              <Columns2 size={12} />
            </button>
          </div>
        ) : null}
        <button className="icon-btn" onClick={onClose} title="Close">
          <X size={15} />
        </button>
      </header>

      {/* The panes stay mounted, so the file tree keeps the folders the user
          opened while a file is on screen. */}
      <div className="drawer__stack">
        <div className="drawer__pane" data-active={!openFile && tab === 'files'}>
          <FileTree root={workspace?.path ?? ''} onOpen={(path) => setOpenFile({ path })} />
        </div>

        <div className="drawer__pane" data-active={!openFile && tab !== 'files'}>
          {changes.length === 0 ? (
            <div className="drawer__empty">
              No files have been changed yet.
              <br />
              Edits and new files show up here as Pi works.
            </div>
          ) : (
            <div className="drawer__body">
              {changes.map((change, index) => {
                const one = stats[index]
                return (
                  <section className="change" key={change.path}>
                    <header className="change__head">
                      <span className="change__icon" data-kind={change.kind}>
                        {change.kind === 'edit' ? <Pencil size={12} /> : <FilePlus size={12} />}
                      </span>
                      <button
                        className="change__path"
                        title={`Open ${change.path}`}
                        onClick={() => setOpenFile({ path: change.path })}
                      >
                        {relativePath(workspace?.path ?? '', change.path)}
                      </button>
                      {one.added || one.removed ? (
                        <span className="change__stats">
                          {one.added ? <span data-kind="add">+{one.added}</span> : null}
                          {one.removed ? <span data-kind="del">−{one.removed}</span> : null}
                        </span>
                      ) : null}
                      {change.edits > 1 ? (
                        <span className="change__badge">{change.edits} edits</span>
                      ) : null}
                      <button
                        className="change__reveal"
                        title="Reveal in the file manager"
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
                      />
                    ) : null}

                    {!change.diffs.length && change.content ? (
                      <pre className="tool__pre">{change.content}</pre>
                    ) : null}

                    {!change.diffs.length && !change.content ? (
                      <pre className="tool__pre">Written to disk.</pre>
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
                  Back
                </button>
              </div>
              <FileViewer file={openFile.path} root={workspace?.path} line={openFile.line} />
            </div>
          ) : null}
        </div>
      </div>
    </aside>
  )
}

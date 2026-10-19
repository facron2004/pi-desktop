import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, FileDiff, FilePlus, Files, Pencil, X } from 'lucide-react'
import { collectChanges, shortPath } from '../lib/changes'
import { useAppStore } from '../store/useAppStore'
import { DiffView } from './DiffView'
import { FileTree } from './FileTree'
import { FileViewer } from './FileViewer'

type Tab = 'changes' | 'files'

export function InspectorPanel({
  onClose,
  initialTab = 'changes'
}: {
  onClose: () => void
  initialTab?: Tab
}) {
  const items = useAppStore((state) => state.items)
  const workspace = useAppStore((state) => state.workspace)
  const changes = useMemo(() => collectChanges(items), [items])

  const [tab, setTab] = useState<Tab>(initialTab)
  const [openFile, setOpenFile] = useState<string | null>(null)

  useEffect(() => {
    setTab(initialTab)
    setOpenFile(null)
  }, [initialTab])

  // Development aid: open a file straight away so screenshots can show the
  // viewer. Set by the main process via PI_DESKTOP_OPEN_FILE.
  useEffect(() => {
    const dev = (window as unknown as { __piDesktopDev?: { openFile?: string } }).__piDesktopDev
    if (!dev?.openFile) return
    setTab('files')
    setOpenFile(dev.openFile)
  }, [])

  return (
    <aside className="drawer" aria-label="Project inspector">
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
        <button className="icon-btn" onClick={onClose} title="Close">
          <X size={15} />
        </button>
      </header>

      {openFile ? (
        <div className="drawer__body drawer__body--flush">
          <div className="viewer__back">
            <button className="ghost-btn" onClick={() => setOpenFile(null)}>
              <ArrowLeft size={12} />
              Back
            </button>
          </div>
          <FileViewer file={openFile} root={workspace?.path} />
        </div>
      ) : tab === 'files' ? (
        <div className="drawer__body drawer__body--flush">
          <FileTree root={workspace?.path ?? ''} onOpen={setOpenFile} />
        </div>
      ) : changes.length === 0 ? (
        <div className="drawer__empty">
          No files have been changed yet.
          <br />
          Edits and new files show up here as Pi works.
        </div>
      ) : (
        <div className="drawer__body">
          {changes.map((change) => (
            <section className="change" key={change.path}>
              <header className="change__head">
                <span className="change__icon" data-kind={change.kind}>
                  {change.kind === 'edit' ? <Pencil size={12} /> : <FilePlus size={12} />}
                </span>
                <span className="change__path" title={change.path}>
                  {shortPath(change.path)}
                </span>
                {change.edits > 1 ? (
                  <span className="change__badge">{change.edits} edits</span>
                ) : null}
              </header>

              {change.diffs.length > 0 ? (
                <DiffView diffs={change.diffs} />
              ) : null}

              {!change.diffs.length && change.content ? (
                <pre className="tool__pre">{change.content}</pre>
              ) : null}

              {!change.diffs.length && !change.content ? (
                <pre className="tool__pre">Written to disk.</pre>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </aside>
  )
}

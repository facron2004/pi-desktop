import { useMemo } from 'react'
import { FilePlus, Pencil, X } from 'lucide-react'
import { collectChanges, shortPath } from '../lib/changes'
import { useAppStore } from '../store/useAppStore'
import { DiffView } from './DiffView'

export function ChangesPanel({ onClose }: { onClose: () => void }) {
  const items = useAppStore((state) => state.items)
  const changes = useMemo(() => collectChanges(items), [items])

  return (
    <aside className="drawer" aria-label="Changed files">
      <header className="drawer__head">
        <span className="drawer__title">Changes</span>
        <span className="drawer__count">{changes.length}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">
          <X size={15} />
        </button>
      </header>

      {changes.length === 0 ? (
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

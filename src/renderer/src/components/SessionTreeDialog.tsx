import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, Copy, GitFork, RefreshCw, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import {
  branchIds,
  flattenTree,
  normalizeTree,
  treeStats,
  type SessionTree,
  type TreeRow
} from '../lib/session-tree'
import '../styles/session-tree.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; tree: SessionTree }
  | { status: 'error' }

/**
 * The conversation as Pi keeps it: a tree.
 *
 * A branch starts before a user message, so the tree is also the list of places
 * a new branch can start from; the row of a prompt carries the fork action.
 */
export function SessionTreeDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const forkFrom = useAppStore((state) => state.forkFrom)
  const showToast = useAppStore((state) => state.showToast)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)

  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Every branch starts open; the reader can fold the parts they do not need.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [forking, setForking] = useState<string | null>(null)
  const leafRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const raw = await window.pi.runtime.request<unknown>('get_tree')
      const tree = normalizeTree(raw)
      setState({ status: 'ready', tree })
      setExpanded(branchIds(tree))
    } catch {
      setState({ status: 'error' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo(
    () => (state.status === 'ready' ? flattenTree(state.tree, expanded) : []),
    [state, expanded]
  )
  const stats = useMemo(
    () => (state.status === 'ready' ? treeStats(state.tree) : { entries: 0, branches: 0 }),
    [state]
  )

  // The open leaf is what the reader came to see, so it is brought into view.
  useEffect(() => {
    if (state.status !== 'ready') return
    const frame = requestAnimationFrame(() =>
      leafRef.current?.scrollIntoView({ block: 'center' })
    )
    return () => cancelAnimationFrame(frame)
  }, [state])

  const toggle = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const fork = async (row: TreeRow) => {
    if (forking) return
    setForking(row.id)
    try {
      await forkFrom(row.id)
      onClose()
    } finally {
      setForking(null)
    }
  }

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(t('The prompt was copied'))
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }

  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal session-tree"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-tree-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="session-tree-title" className="modal__title">
            {t('Session tree')}
          </h2>
          {state.status === 'ready' ? (
            <span className="session-tree__stats">
              {stats.branches}{' '}
              {stats.branches === 1 ? t('branch') : t('branches')} · {stats.entries}{' '}
              {stats.entries === 1 ? t('entry') : t('entries')}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <button
            className="icon-btn"
            onClick={() => void load()}
            title={t('Refresh the session tree')}
          >
            <RefreshCw size={13} className={state.status === 'loading' ? 'spin' : undefined} />
          </button>
          <button className="icon-btn" onClick={onClose} title={t('Close')}>
            <X size={15} />
          </button>
        </div>

        <div className="session-tree__body">
          {state.status === 'loading' ? (
            <div className="session-tree__state">
              <RefreshCw size={13} className="spin" />
              {t('Reading the session tree…')}
            </div>
          ) : state.status === 'error' ? (
            <div className="session-tree__state" data-tone="error">
              <AlertTriangle size={13} />
              {t('The session tree could not be read.')}
            </div>
          ) : rows.length === 0 ? (
            <div className="session-tree__state">{t('This conversation has no messages yet.')}</div>
          ) : (
            rows.map((row) => (
              <div
                key={`${row.id}-${row.depth}`}
                ref={row.leaf ? leafRef : undefined}
                className="session-tree__row"
                data-role={row.role}
                data-active={row.active || undefined}
                data-leaf={row.leaf || undefined}
                data-branch={row.branch || undefined}
                style={{ paddingLeft: 10 + row.depth * 16 }}
              >
                <button
                  className="session-tree__chevron"
                  data-open={row.childrenOpen || undefined}
                  disabled={!row.hasChildren}
                  aria-label={
                    row.hasChildren
                      ? row.childrenOpen
                        ? t('Collapse this branch')
                        : t('Expand this branch')
                      : undefined
                  }
                  onClick={() => {
                    if (row.hasChildren) toggle(row.id)
                  }}
                >
                  {row.hasChildren ? (
                    <ChevronRight size={12} />
                  ) : (
                    <span className="session-tree__dot" />
                  )}
                </button>
                <span className="session-tree__title" title={row.prompt ?? row.title}>
                  {row.title}
                </span>
                {row.label ? <span className="session-tree__label">{row.label}</span> : null}
                {row.leaf ? (
                  <span className="session-tree__current">{t('current')}</span>
                ) : null}
                {row.prompt ? (
                  <span className="session-tree__actions">
                    <button
                      className="icon-btn"
                      title={t('Fork from this prompt')}
                      aria-label={t('Fork from this prompt')}
                      disabled={forking === row.id}
                      onClick={() => void fork(row)}
                    >
                      <GitFork size={12} />
                    </button>
                    <button
                      className="icon-btn"
                      title={t('Copy the prompt')}
                      aria-label={t('Copy the prompt')}
                      onClick={() => void copy(row.prompt ?? '')}
                    >
                      <Copy size={12} />
                    </button>
                  </span>
                ) : null}
              </div>
            ))
          )}
        </div>

        <div className="modal__foot session-tree__foot">
          <span>
            {t(
              'Forking starts a new conversation before the prompt you pick; the current one is left as it is.'
            )}
          </span>
          <button className="btn btn--primary" onClick={onClose}>
            {t('Close')}
          </button>
        </div>
      </div>
    </div>
  )
}

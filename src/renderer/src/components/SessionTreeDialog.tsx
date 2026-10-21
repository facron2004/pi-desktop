import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  GitFork,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import {
  branchIds,
  branchTips,
  filterTree,
  normalizeTree,
  pathToEntry,
  treeStats,
  type SessionTree,
  type TreeRow,
  type TreeView
} from '../lib/session-tree'
import '../styles/session-tree.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; tree: SessionTree }
  | { status: 'error' }

const EMPTY_VIEW: TreeView = { rows: [], matched: true }

/** The folds of one conversation are remembered by its session file. */
function collapseKey(file: string): string {
  return `pi-desktop.session-tree.collapsed:${file}`
}

function readCollapsed(file: string | undefined): Set<string> {
  if (!file) return new Set()
  try {
    const raw = window.localStorage.getItem(collapseKey(file))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((id): id is string => typeof id === 'string'))
  } catch {
    // Storage that cannot be read is the same as no memory at all.
    return new Set()
  }
}

function writeCollapsed(file: string | undefined, collapsed: Iterable<string>): void {
  if (!file) return
  try {
    window.localStorage.setItem(collapseKey(file), JSON.stringify([...collapsed]))
  } catch {
    // A full or disabled storage must not break the dialog.
  }
}

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

  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  // Every branch starts open; the reader can fold the parts they do not need.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [forking, setForking] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [flash, setFlash] = useState<{ id: string; seq: number } | null>(null)
  const leafRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const flashSeq = useRef(0)
  const tipCursor = useRef(-1)

  const load = useCallback(async () => {
    setState({ status: 'loading' })
    try {
      const raw = await window.pi.runtime.request<unknown>('get_tree')
      const tree = normalizeTree(raw)
      setState({ status: 'ready', tree })
      // The folds the reader left last time come back by node id; a
      // conversation that was never folded (or a brand new one) starts open.
      const collapsed = readCollapsed(activeSessionFile)
      setExpanded(new Set([...branchIds(tree)].filter((id) => !collapsed.has(id))))
      tipCursor.current = -1
    } catch {
      setState({ status: 'error' })
    }
  }, [activeSessionFile])

  useEffect(() => {
    void load()
  }, [load])

  const view = useMemo(
    () => (state.status === 'ready' ? filterTree(state.tree, expanded, query) : EMPTY_VIEW),
    [state, expanded, query]
  )
  const rows = view.rows
  const stats = useMemo(
    () => (state.status === 'ready' ? treeStats(state.tree) : { entries: 0, forkPoints: 0 }),
    [state]
  )
  const branches = useMemo(
    () => (state.status === 'ready' ? branchIds(state.tree) : new Set<string>()),
    [state]
  )
  const tips = useMemo(
    () => (state.status === 'ready' ? branchTips(state.tree) : []),
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

  // The folds survive closing the dialog and coming back to the same
  // conversation. Only a branch can be folded, so only branches are stored.
  useEffect(() => {
    if (state.status !== 'ready') return
    writeCollapsed(activeSessionFile, [...branches].filter((id) => !expanded.has(id)))
  }, [expanded, branches, state.status, activeSessionFile])

  // A tip that was jumped to glows for a moment, so the eye finds it after
  // the scroll has moved it into the middle of the list.
  useEffect(() => {
    if (!flash) return
    rowRefs.current.get(flash.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = window.setTimeout(() => setFlash(null), 1400)
    return () => window.clearTimeout(timer)
  }, [flash])

  // The dialog closes on Escape through a capture listener on the document.
  // While the filter has text the first Escape belongs to the filter, so it is
  // taken here, before that listener runs; the next one still closes the tree.
  useEffect(() => {
    if (!query) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return
      if (document.activeElement !== filterRef.current) return
      event.preventDefault()
      event.stopImmediatePropagation()
      setQuery('')
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [query])

  const toggle = (id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  // Walk the tips of the tree in the order they read. A tip behind a fold is
  // opened first; a filter steps aside because it may hide the tip entirely.
  const jumpTip = (direction: 1 | -1) => {
    if (state.status !== 'ready' || tips.length === 0) return
    const tree = state.tree
    if (query) setQuery('')
    const current = tipCursor.current
    const next =
      current < 0
        ? direction > 0
          ? 0
          : tips.length - 1
        : (current + direction + tips.length) % tips.length
    tipCursor.current = next
    const id = tips[next]
    setExpanded((previous) => {
      const path = pathToEntry(tree, id)
      if (path.every((entry) => previous.has(entry))) return previous
      return new Set([...previous, ...path])
    })
    setFlash({ id, seq: ++flashSeq.current })
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
              {stats.forkPoints}{' '}
              {stats.forkPoints === 1 ? t('fork point') : t('fork points')} · {stats.entries}{' '}
              {stats.entries === 1 ? t('entry') : t('entries')}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          {state.status === 'ready' ? (
            <>
              <div className="session-tree__filter">
                <Search size={12} />
                <input
                  ref={filterRef}
                  value={query}
                  placeholder={t('Filter the session tree')}
                  aria-label={t('Filter the session tree')}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    className="icon-btn"
                    onClick={() => {
                      setQuery('')
                      filterRef.current?.focus()
                    }}
                    title={t('Clear the filter')}
                    aria-label={t('Clear the filter')}
                  >
                    <X size={11} />
                  </button>
                ) : null}
              </div>
              <div className="session-tree__nav">
                <button
                  className="icon-btn"
                  onClick={() => jumpTip(-1)}
                  disabled={tips.length === 0}
                  title={t('Previous branch tip')}
                  aria-label={t('Previous branch tip')}
                >
                  <ChevronUp size={14} />
                </button>
                <button
                  className="icon-btn"
                  onClick={() => jumpTip(1)}
                  disabled={tips.length === 0}
                  title={t('Next branch tip')}
                  aria-label={t('Next branch tip')}
                >
                  <ChevronDown size={14} />
                </button>
              </div>
            </>
          ) : null}
          <button
            className="icon-btn"
            onClick={() => void load()}
            title={t('Refresh the session tree')}
            aria-label={t('Refresh the session tree')}
          >
            <RefreshCw size={13} className={state.status === 'loading' ? 'spin' : undefined} />
          </button>
          <button className="icon-btn" onClick={onClose} title={t('Close')} aria-label={t('Close')}>
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
          ) : !view.matched ? (
            <div className="session-tree__state">{t('No entries match')}</div>
          ) : rows.length === 0 ? (
            <div className="session-tree__state">{t('This conversation has no messages yet.')}</div>
          ) : (
            rows.map((row) => (
              <div
                key={`${row.id}-${row.depth}`}
                ref={(element) => {
                  if (element) rowRefs.current.set(row.id, element)
                  else rowRefs.current.delete(row.id)
                  if (row.leaf) leafRef.current = element
                }}
                className="session-tree__row"
                data-role={row.role}
                data-active={row.active || undefined}
                data-leaf={row.leaf || undefined}
                data-branch={row.branch || undefined}
                data-flash={flash?.id === row.id || undefined}
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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { treeNavAction, type TreeNavKey } from '../lib/session-tree-nav'
import '../styles/session-tree.css'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; tree: SessionTree }
  | { status: 'error' }

const EMPTY_VIEW: TreeView = { rows: [], matched: true }
const TREE_DIALOG_PAGE = 250

interface SessionTreeRowProps {
  row: TreeRow
  isFlashing: boolean
  isForking: boolean
  t: (text: string) => string
  onToggle: (id: string) => void
  onFork: (row: TreeRow) => void
  onCopy: (text: string) => void
  onRowRef: (id: string, leaf: boolean, element: HTMLDivElement | null) => void
}

const SessionTreeRow = memo(function SessionTreeRow({
  row,
  isFlashing,
  isForking,
  t,
  onToggle,
  onFork,
  onCopy,
  onRowRef
}: SessionTreeRowProps) {
  return (
    <div
      ref={(element) => onRowRef(row.id, row.leaf, element)}
      className="session-tree__row"
      tabIndex={-1}
      data-tree-row-id={row.id}
      data-role={row.role}
      data-active={row.active || undefined}
      data-leaf={row.leaf || undefined}
      data-branch={row.branch || undefined}
      data-flash={isFlashing || undefined}
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
          if (row.hasChildren) onToggle(row.id)
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
            disabled={isForking}
            onClick={() => onFork(row)}
          >
            <GitFork size={12} />
          </button>
          <button
            className="icon-btn"
            title={t('Copy the prompt')}
            aria-label={t('Copy the prompt')}
            onClick={() => onCopy(row.prompt ?? '')}
          >
            <Copy size={12} />
          </button>
        </span>
      ) : null}
    </div>
  )
})

/** The folds of one conversation are remembered by its session file. */
const COLLAPSE_PREFIX = 'pi-desktop.session-tree.collapsed:'
const MAX_COLLAPSED_SESSIONS = 50

function collapseKey(file: string): string {
  return `${COLLAPSE_PREFIX}${file}`
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

function pruneCollapsedStorage(protectKey: string): void {
  if (window.localStorage.length <= MAX_COLLAPSED_SESSIONS + 20) return
  const keys: string[] = []
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const candidate = window.localStorage.key(index)
    if (candidate && candidate.startsWith(COLLAPSE_PREFIX) && candidate !== protectKey) {
      keys.push(candidate)
    }
  }
  const excess = keys.length + 1 - MAX_COLLAPSED_SESSIONS
  for (let index = 0; index < excess; index += 1) {
    window.localStorage.removeItem(keys[index])
  }
}

function writeCollapsed(file: string | undefined, collapsed: Iterable<string>): void {
  if (!file) return
  const key = collapseKey(file)
  const list = [...collapsed]
  try {
    if (list.length === 0) {
      window.localStorage.removeItem(key)
      return
    }
    window.localStorage.setItem(key, JSON.stringify(list))
    pruneCollapsedStorage(key)
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
  const [rowLimit, setRowLimit] = useState(TREE_DIALOG_PAGE)
  const leafRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const flashSeq = useRef(0)
  const tipCursor = useRef(-1)
  const loadSequence = useRef(0)

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current
    setState({ status: 'loading' })
    setRowLimit(TREE_DIALOG_PAGE)
    try {
      const key = await useAppStore.getState().ensureRuntime(activeSessionFile, 'session-tree')
      if (sequence !== loadSequence.current) return
      const raw = await window.pi.runtime.request<unknown>(
        'get_tree',
        undefined,
        undefined,
        { sourceAction: 'session-tree', uiSessionId: key },
        key
      )
      if (sequence !== loadSequence.current) return
      const tree = normalizeTree(raw)
      setState({ status: 'ready', tree })
      // The folds the reader left last time come back by node id; a
      // conversation that was never folded (or a brand new one) starts open.
      const collapsed = readCollapsed(activeSessionFile)
      setExpanded(new Set([...branchIds(tree)].filter((id) => !collapsed.has(id))))
      tipCursor.current = -1
    } catch {
      if (sequence === loadSequence.current) setState({ status: 'error' })
    }
  }, [activeSessionFile])

  useEffect(() => {
    void load()
    return () => { loadSequence.current += 1 }
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

  const revealedStateRef = useRef<typeof state | null>(null)

  useEffect(() => {
    setRowLimit(TREE_DIALOG_PAGE)
  }, [query])

  // Ensure the open leaf stays inside the rendered slice once per loaded tree,
  // without yanking scroll back on subsequent collapse/filter/Show-more/tip-jump.
  useEffect(() => {
    if (state.status !== 'ready') {
      revealedStateRef.current = null
      return
    }
    if (flash) {
      revealedStateRef.current = state
      return
    }
    if (revealedStateRef.current === state) return
    const leafIndex = rows.findIndex((row) => row.leaf)
    if (leafIndex >= rowLimit) {
      setRowLimit(leafIndex + 80)
      return
    }
    revealedStateRef.current = state
    const frame = requestAnimationFrame(() =>
      leafRef.current?.scrollIntoView({ block: 'center' })
    )
    return () => cancelAnimationFrame(frame)
  }, [state, rows, rowLimit, flash])

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
    const targetIndex = rows.findIndex((row) => row.id === flash.id)
    if (targetIndex >= rowLimit) {
      setRowLimit(targetIndex + 80)
      return
    }
    const frame = requestAnimationFrame(() => {
      rowRefs.current.get(flash.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    const timer = window.setTimeout(() => setFlash(null), 1400)
    return () => {
      cancelAnimationFrame(frame)
      window.clearTimeout(timer)
    }
  }, [flash, rows, rowLimit])

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

  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

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

  const fork = useCallback(async (row: TreeRow) => {
    if (forking) return
    setForking(row.id)
    try {
      // A refused fork (a run is active, another fork is in flight) must not
      // close the tree: the reader would lose their place for nothing.
      const forked = await forkFrom(row.id)
      if (forked) onClose()
    } finally {
      setForking(null)
    }
  }, [forking, forkFrom, onClose])

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(t('The prompt was copied'))
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }, [showToast, t])

  const handleRowRef = useCallback((id: string, leaf: boolean, element: HTMLDivElement | null) => {
    if (element) rowRefs.current.set(id, element)
    else rowRefs.current.delete(id)
    if (leaf) leafRef.current = element
  }, [])

  const visibleRows = useMemo(
    () => (rows.length > rowLimit ? rows.slice(0, rowLimit) : rows),
    [rows, rowLimit]
  )

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
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return
          const keys: TreeNavKey[] = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
          if (!keys.includes(event.key as TreeNavKey)) return
          const target = event.target
          if (!(target instanceof HTMLElement) || !target.matches('[data-tree-row-id]')) return
          const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-tree-row-id]')]
          const index = elements.indexOf(target)
          if (index < 0) return
          event.preventDefault()
          const action = treeNavAction(visibleRows, index, event.key as TreeNavKey)
          if (!action) return
          if (action.kind === 'focus') elements[action.index]?.focus()
          else if (action.kind === 'toggle') toggle(action.id)
          else filterRef.current?.focus()
        }}
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
                  onKeyDown={(event) => {
                    if (event.key !== 'ArrowDown' || event.altKey || event.ctrlKey || event.metaKey) return
                    const first = dialogRef.current?.querySelector<HTMLElement>('[data-tree-row-id]')
                    if (!first) return
                    event.preventDefault()
                    first.focus()
                  }}
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
            <>
              {visibleRows.map((row) => (
                <SessionTreeRow
                  key={`${row.id}-${row.depth}`}
                  row={row}
                  isFlashing={flash?.id === row.id}
                  isForking={forking === row.id}
                  t={t}
                  onToggle={toggle}
                  onFork={fork}
                  onCopy={copy}
                  onRowRef={handleRowRef}
                />
              ))}
              {rows.length > visibleRows.length ? (
                <button
                  type="button"
                  className="btn btn--sm session-tree__more"
                  onClick={() => setRowLimit((current) => current + TREE_DIALOG_PAGE)}
                >
                  {t('Show more')} ({rows.length - visibleRows.length})
                </button>
              ) : null}
            </>
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

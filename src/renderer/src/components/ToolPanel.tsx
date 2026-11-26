import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'
import {
  Bot,
  FileDiff,
  Files,
  GitCompare,
  Globe,
  Images,
  List,
  Maximize2,
  MessagesSquare,
  Minimize2,
  Network,
  Plus,
  SquareTerminal,
  X
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { formatPlatformShortcut, keysFor } from '../lib/shortcuts'
import { useT } from '../lib/i18n'
import { tabIndexAfterClose } from '../lib/tab-focus'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { ErrorBoundary } from './ErrorBoundary'
import { Popover } from './Popover'

/**
 * What the side panel can show, as a page each.
 *
 * The pages follow MCode's workspace panel: the header is a strip of
 * fixed-width page tabs, and `+` creates a new "start from here" tab.
 */
export type ToolPanelView = 'side-chat' | 'files' | 'changes' | 'review' | 'subagents' | 'swarm' | 'terminal' | 'browser' | 'images' | 'start'

interface ToolTab {
  id: string
  view: Exclude<ToolPanelView, 'start'> | null
}

const TABS: {
  view: Exclude<ToolPanelView, 'start'>
  label: string
  description: string
  icon: typeof Files
  shortcut?: string
}[] = [
  {
    view: 'side-chat',
    label: 'Side chat',
    description: 'Ask, break down tasks, or review changes alongside this conversation',
    icon: MessagesSquare,
    shortcut: 'Ctrl+Shift+L'
  },
  { view: 'files', label: 'Files', description: 'Browse the project files', icon: Files },
  { view: 'browser', label: 'Browser', description: 'Browse a page without leaving the app', icon: Globe },
  { view: 'terminal', label: 'Terminal', description: 'Run commands in a real shell', icon: SquareTerminal, shortcut: 'Ctrl+`' },
  { view: 'changes', label: 'File changes', description: 'Review the files this conversation changed', icon: FileDiff },
  {
    view: 'review',
    label: 'Review',
    description: 'Review the uncommitted changes of the project',
    icon: GitCompare
  },
  { view: 'subagents', label: 'Subagents', description: 'Subagent tasks and their status', icon: Bot },
  { view: 'swarm', label: 'Swarm', description: 'The worker team of this conversation', icon: Network },
  { view: 'images', label: 'Images', description: 'Pictures in this project', icon: Images }
]

const TAB_BY_VIEW = new Map(TABS.map((entry) => [entry.view, entry]))
const TOOL_PANEL_TABPANEL_ID = 'tool-panel-tabpanel'
const MIN_PANEL_WIDTH = 360
const MAX_PANEL_WIDTH = 760
const toolTabDomId = (id: string) => `tool-panel-tab-${id}`

interface TabContextMenu {
  tab: ToolTab
  x: number
  y: number
}

export const ToolPanel = memo(function ToolPanel({
  view,
  onViewChange,
  onViewClosed,
  children,
  className,
  concealed = false,
  overlay,
  onClose,
  width,
  onResize,
  onResizeEnd,
  actions,
  onMaximizedChange
}: {
  view: ToolPanelView
  onViewChange: (view: ToolPanelView) => void
  /** A page tab was closed, so its live content (browser, terminal) can go. */
  onViewClosed?: (view: Exclude<ToolPanelView, 'start'>) => void
  /** The active page's content. The start page is drawn by the panel itself. */
  children?: ReactNode
  className?: string
  /** Folded away, but still mounted so its tabs and pages survive. */
  concealed?: boolean
  overlay: boolean
  onClose: () => void
  width: number
  onResize?: (width: number) => void
  onResizeEnd?: (width: number) => void
  /** Page-specific controls that sit in the strip's right corner. */
  actions?: ReactNode
  /** Whether the panel currently covers the conversation. */
  onMaximizedChange?: (maximized: boolean) => void
}) {
  const t = useT()
  const panelRef = useRef<HTMLElement>(null)
  // The overlay keeps the focus trap but not Escape: a find box inside the
  // panel owns that key. The panel's own handler below closes it otherwise.
  useDialogFocus(panelRef, onClose, { enabled: overlay && !concealed, closeOnEscape: false })

  // The strip holds the pages the reader opened in this panel visit. App still
  // owns the active view, while each new-tab page gets its own tab identity.
  const newTabSequence = useRef(0)
  const [tabs, setTabs] = useState<ToolTab[]>(() => [
    view === 'start' ? { id: 'new-tab-0', view: null } : { id: view, view }
  ])
  const [active, setActive] = useState<string | null>(() =>
    view === 'start' ? 'new-tab-0' : view
  )
  const [dragTab, setDragTab] = useState<string | null>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [maximized, setMaximized] = useState(false)
  // A maximized panel covers the conversation; report it so the shell can
  // make the covered content inert. Closing the panel releases it too.
  useEffect(() => {
    onMaximizedChange?.(maximized && !concealed)
  }, [maximized, concealed, onMaximizedChange])
  useEffect(
    () => () => {
      onMaximizedChange?.(false)
    },
    [onMaximizedChange]
  )
  const [menu, setMenu] = useState<TabContextMenu | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // The sync has to be total. Returning early for the start page left the
    // previously active tab selected while App passed the start page's content
    // (none), so folding the panel on "File changes" and reopening it from the
    // corner toggle produced an empty drawer.
    if (view === 'start') {
      // A blank page that is already in front is the start page: `+` adds one
      // and selects it, and re-selecting the *first* blank tab here made the
      // press look like it did nothing once a blank tab existed.
      if (tabs.find((tab) => tab.id === active)?.view === null) return
      const startTab = tabs.find((tab) => tab.view === null)
      if (startTab) {
        setActive((current) => (current === startTab.id ? current : startTab.id))
        return
      }
      const id = `new-tab-${(newTabSequence.current += 1)}`
      setTabs((current) => [...current, { id, view: null }])
      setActive(id)
      return
    }
    const existing = tabs.find((tab) => tab.view === view)
    if (existing) {
      setActive(existing.id)
      return
    }
    setTabs((current) => [...current, { id: view, view }])
    setActive(view)
  }, [tabs, view, active])

  // Fixed widths are the point: a tab must not grow because its file name is
  // long. Once the strip cannot hold them all, it scrolls and the all-tabs
  // control appears, the same escape hatch MCode has.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const update = () => setOverflowing(element.scrollWidth > element.clientWidth + 1)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [tabs])

  useEffect(() => {
    const activeElement = scrollRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    activeElement?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement
      if (!target.closest('.tool-tab-menu')) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      // The menu is the topmost thing while it is open, so it consumes Escape;
      // otherwise the composer's window handler would stop the running agent.
      event.preventDefault()
      close()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  // A maximized panel covers the conversation, so it has to answer to the
  // keyboard as well: Escape leaves the maximized state and gives the reading
  // surface back. Anything that owns Escape (a dialog, a menu, the lightbox)
  // keeps it — the panel only steps in when nothing else is open.
  useEffect(() => {
    if (!maximized || concealed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('.modal-layer, .popover, .tool-tab-menu, .lightbox-layer')) return
      // Leaving the maximized state consumes the key: the composer stops a run
      // on any Escape that nobody marked, and both listeners sit on the window.
      event.preventDefault()
      setMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized, concealed])

  // The overlay panel used to close from the dialog hook's capture listener,
  // which ran before a find box inside it could see Escape. It handles the key
  // itself now, and leaves it alone while an editable control is focused.
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    if (!overlay || maximized || concealed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
      ) return
      if (document.querySelector('.modal-layer, .popover, .tool-tab-menu, .lightbox-layer')) return
      // Closing the drawer consumes the key too; without this the composer's
      // stop handler would also fire on the same press.
      event.preventDefault()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay, maximized, concealed])

  const openView = useCallback(
    (next: Exclude<ToolPanelView, 'start'>) => {
      const activeTab = tabs.find((tab) => tab.id === active)
      const existing = tabs.find((tab) => tab.view === next)
      if (existing) {
        if (activeTab?.view === null && activeTab.id !== existing.id) {
          setTabs((current) => current.filter((tab) => tab.id !== activeTab.id))
        }
        setActive(existing.id)
      } else if (activeTab?.view === null) {
        setTabs((current) =>
          current.map((tab) => (tab.id === activeTab.id ? { ...tab, view: next } : tab))
        )
        setActive(activeTab.id)
      } else {
        setTabs((current) => [...current, { id: next, view: next }])
        setActive(next)
      }
      onViewChange(next)
    },
    [active, onViewChange, tabs]
  )

  const selectTab = (next: ToolTab) => {
    setActive(next.id)
    onViewChange(next.view ?? 'start')
  }

  const createNewTab = () => {
    const tab: ToolTab = { id: `new-tab-${++newTabSequence.current}`, view: null }
    setTabs((current) => [...current, tab])
    setActive(tab.id)
    onViewChange('start')
  }

  const release = (closed: readonly ToolTab[]) => {
    for (const tab of closed) {
      if (tab.view) onViewClosed?.(tab.view)
    }
  }

  const closeTab = (next: ToolTab) => {
    const index = tabs.findIndex((tab) => tab.id === next.id)
    const remaining = tabs.filter((tab) => tab.id !== next.id)
    setTabs(remaining)
    setMenu(null)
    release([next])
    if (remaining.length === 0) {
      const blankTab: ToolTab = { id: `new-tab-${++newTabSequence.current}`, view: null }
      setTabs([blankTab])
      setActive(blankTab.id)
      onViewChange('start')
      onClose()
      return
    }
    // The close button that held the keyboard is being removed. The tab that
    // takes its place keeps it — whether the page being closed was the one on
    // screen or another one in the strip.
    const fallback = remaining[tabIndexAfterClose(index, remaining.length)] ?? remaining[remaining.length - 1]
    if (active !== next.id) {
      if (fallback) focusTab(fallback)
      return
    }
    if (fallback) {
      setActive(fallback.id)
      onViewChange(fallback.view ?? 'start')
      focusTab(fallback)
    } else {
      setActive(null)
      onViewChange('start')
    }
  }

  const closeOthers = (keep: ToolTab) => {
    release(tabs.filter((tab) => tab.id !== keep.id))
    setTabs([keep])
    setActive(keep.id)
    onViewChange(keep.view ?? 'start')
    setMenu(null)
  }

  const closeToRight = (keep: ToolTab) => {
    const index = tabs.findIndex((tab) => tab.id === keep.id)
    if (index < 0) return
    release(tabs.slice(index + 1))
    setTabs(tabs.slice(0, index + 1))
    setActive(keep.id)
    onViewChange(keep.view ?? 'start')
    setMenu(null)
  }

  const closeAll = () => {
    release(tabs)
    const blankTab: ToolTab = { id: `new-tab-${++newTabSequence.current}`, view: null }
    setTabs([blankTab])
    setActive(blankTab.id)
    setMenu(null)
    onViewChange('start')
    onClose()
  }

  const reorder = (source: ToolTab, target: ToolTab) => {
    const from = tabs.findIndex((tab) => tab.id === source.id)
    const to = tabs.findIndex((tab) => tab.id === target.id)
    if (from < 0 || to < 0 || from === to) return
    const next = [...tabs]
    next.splice(to, 0, next.splice(from, 1)[0])
    setTabs(next)
  }

  const openContextMenuAt = (tab: ToolTab, x: number, y: number) => {
    setMenu({
      tab,
      x: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - 224 - 8)),
      y: Math.min(Math.max(8, y), Math.max(8, window.innerHeight - 220 - 8))
    })
  }

  const openContextMenu = (event: React.MouseEvent, tab: ToolTab) => {
    event.preventDefault()
    openContextMenuAt(tab, event.clientX, event.clientY)
  }

  const focusTab = (tab: ToolTab) => {
    requestAnimationFrame(() => document.getElementById(toolTabDomId(tab.id))?.focus())
  }

  const selectAndFocusTab = (tab: ToolTab) => {
    selectTab(tab)
    focusTab(tab)
  }

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, tab: ToolTab) => {
    if (event.nativeEvent.isComposing) return
    if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      openContextMenuAt(tab, rect.left, rect.bottom + 4)
      return
    }
    const index = tabs.findIndex((entry) => entry.id === tab.id)
    let nextIndex: number | undefined
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = tabs.length - 1
    if (nextIndex === undefined) return
    event.preventDefault()
    const next = tabs[nextIndex]
    if (next) selectAndFocusTab(next)
  }

  const widthRef = useRef(width)
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!onResize) return
      event.preventDefault()
      const handle = event.currentTarget
      const panel = handle.parentElement
      const startX = event.clientX
      const startWidth = panel?.getBoundingClientRect().width ?? width
      widthRef.current = startWidth

      const move = (moveEvent: PointerEvent) => {
        // Dragging left handle: moving left increases width
        const nextWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startWidth - (moveEvent.clientX - startX)))
        widthRef.current = nextWidth
        onResize(nextWidth)
      }
      let finished = false
      const finish = () => {
        if (finished) return
        finished = true
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', finish)
        handle.removeEventListener('pointercancel', finish)
        handle.removeEventListener('lostpointercapture', finish)
        document.body.classList.remove('is-resizing')
        onResizeEnd?.(widthRef.current)
      }

      handle.setPointerCapture(event.pointerId)
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', finish)
      handle.addEventListener('pointercancel', finish)
      handle.addEventListener('lostpointercapture', finish)
      document.body.classList.add('is-resizing')
    },
    [onResize, onResizeEnd, width]
  )

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onResize || event.nativeEvent.isComposing) return
    const step = event.shiftKey ? 48 : 16
    let next: number | undefined
    // The divider is on the panel's left edge: moving it left makes the panel wider.
    if (event.key === 'ArrowLeft') next = width + step
    else if (event.key === 'ArrowRight') next = width - step
    else if (event.key === 'Home') next = MIN_PANEL_WIDTH
    else if (event.key === 'End') next = MAX_PANEL_WIDTH
    if (next === undefined) return
    event.preventDefault()
    const clamped = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.round(next)))
    onResize(clamped)
    onResizeEnd?.(clamped)
  }

  const activeTab = tabs.find((tab) => tab.id === active) ?? null

  return (
    <aside
      ref={panelRef}
      className={`tool-panel${maximized ? ' tool-panel--maximized' : ''}${className ? ` ${className}` : ''}`}
      style={{ width }}
      hidden={concealed}
      inert={concealed || undefined}
      role={overlay && !concealed ? 'dialog' : undefined}
      aria-modal={overlay && !concealed ? true : undefined}
      tabIndex={overlay ? -1 : undefined}
      aria-label={t('Tools')}
    >
      {onResize ? (
        <div
          className="tool-panel__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('Resize the panel')}
          aria-valuemin={MIN_PANEL_WIDTH}
          aria-valuemax={MAX_PANEL_WIDTH}
          aria-valuenow={Math.round(width)}
          tabIndex={0}
          onKeyDown={handleResizeKeyDown}
          onPointerDown={startResize}
        />
      ) : null}
      {/* The strip keeps its right corner empty: the shell pins the panel's one
          toggle there, so it does not travel with the panel's animation. */}
      <div className="tool-panel__tabs">
        <div
          ref={scrollRef}
          className="tool-panel__tab-scroll"
          role="tablist"
          aria-label={t('Tools')}
        >
          {tabs.map((tab) => {
            const meta = tab.view ? TAB_BY_VIEW.get(tab.view) : null
            const Icon = meta?.icon ?? Plus
            return (
              <div
                className="tool-panel__tab-shell"
                key={tab.id}
                data-active={tab.id === active || undefined}
                draggable
                onDragStart={() => setDragTab(tab.id)}
                onDragEnd={() => setDragTab(null)}
                onDragOver={(event) => {
                  if (dragTab && dragTab !== tab.id) event.preventDefault()
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  if (dragTab) {
                    const source = tabs.find((entry) => entry.id === dragTab)
                    if (source) reorder(source, tab)
                  }
                  setDragTab(null)
                }}
                onContextMenu={(event) => openContextMenu(event, tab)}
              >
                <button
                  type="button"
                  id={toolTabDomId(tab.id)}
                  role="tab"
                  aria-selected={tab.id === active}
                  aria-controls={TOOL_PANEL_TABPANEL_ID}
                  tabIndex={tab.id === active ? 0 : -1}
                  className="tool-panel__tab"
                  data-active={tab.id === active || undefined}
                  title={t(meta?.description ?? 'New tab')}
                  onClick={() => selectTab(tab)}
                  onKeyDown={(event) => handleTabKeyDown(event, tab)}
                >
                  <Icon size={18} strokeWidth={1.7} />
                  <span className="tool-panel__tab-label">{t(meta?.label ?? 'New tab')}</span>
                </button>
                <button
                  type="button"
                  className="tool-panel__tab-close"
                  aria-label={t('Close tab')}
                  title={t('Close tab')}
                  onClick={(event) => {
                    event.stopPropagation()
                    closeTab(tab)
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            )
          })}
          <button
            type="button"
            className="tool-panel__new-tab"
            aria-label={t('New tab')}
            title={t('New tab')}
            onClick={createNewTab}
          >
            <Plus size={16} strokeWidth={1.7} />
          </button>
        </div>
        {overflowing ? (
          <Popover
            align="right"
            width={208}
            className="tool-tabs-popover"
            renderTrigger={({ open, toggle }) => (
              <button
                type="button"
                className="tool-panel__all-tabs"
                aria-label={t('All open pages')}
                title={t('All open pages')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              >
                <List size={16} strokeWidth={1.7} />
              </button>
            )}
          >
            {(close) => (
              <div className="tool-tabs-menu" role="menu" aria-label={t('All open pages')}>
                <div className="tool-tabs-menu__heading">{t('All open pages')}</div>
                {tabs.map((tab) => {
                  const meta = tab.view ? TAB_BY_VIEW.get(tab.view) : null
                  const Icon = meta?.icon ?? Plus
                  return (
                    <div
                      key={tab.id}
                      className="tool-tabs-menu__row"
                      data-selected={tab.id === active || undefined}
                      role="menuitemradio"
                      aria-checked={tab.id === active}
                      tabIndex={0}
                      onClick={() => {
                        close()
                        selectTab(tab)
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        close()
                        selectTab(tab)
                      }}
                    >
                      <Icon size={18} strokeWidth={1.6} />
                      <span className="tool-tabs-menu__label">{t(meta?.label ?? 'New tab')}</span>
                      <button
                        type="button"
                        className="tool-tabs-menu__close"
                        aria-label={`${t('Close tab')}: ${t(meta?.label ?? 'New tab')}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          closeTab(tab)
                          close()
                        }}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </Popover>
        ) : null}
        <button
          type="button"
          className="tool-panel__action"
          aria-label={maximized ? t('Restore the panel') : t('Maximize the panel')}
          title={maximized ? t('Restore the panel') : t('Maximize the panel')}
          aria-pressed={maximized}
          onClick={() => setMaximized((value) => !value)}
        >
          {maximized ? <Minimize2 size={16} strokeWidth={1.7} /> : <Maximize2 size={16} strokeWidth={1.7} />}
        </button>
        {actions}
      </div>

      <div
        className="tool-panel__body"
        id={TOOL_PANEL_TABPANEL_ID}
        role="tabpanel"
        aria-labelledby={activeTab ? toolTabDomId(activeTab.id) : undefined}
        data-view={activeTab?.view ?? 'start'}
      >
        <ErrorBoundary scope="tool panel">
          {activeTab?.view == null ? (
            <>
              <ToolStart onOpen={openView} />
              {children}
            </>
          ) : children}
        </ErrorBoundary>
      </div>

      {menu
        ? createPortal(
            <div
              className="tool-tab-menu"
              role="menu"
              aria-label={t('Tab actions')}
              style={{ left: menu.x, top: menu.y }}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  setMenu(null)
                  if (activeTab) focusTab(activeTab)
                  return
                }
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
                const items = Array.from(
                  event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')
                )
                if (items.length === 0) return
                event.preventDefault()
                const index = items.indexOf(document.activeElement as HTMLElement)
                const direction = event.key === 'ArrowDown' ? 1 : -1
                items[(index + direction + items.length) % items.length]?.focus()
              }}
            >
              <button
                type="button"
                role="menuitem"
                autoFocus
                className="tool-tab-menu__item"
                onClick={() => closeTab(menu.tab)}
              >
                <X size={15} />
                {t('Close tab')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="tool-tab-menu__item"
                disabled={tabs.length <= 1}
                onClick={() => closeOthers(menu.tab)}
              >
                {t('Close other tabs')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="tool-tab-menu__item"
                disabled={tabs.findIndex((tab) => tab.id === menu.tab.id) === tabs.length - 1}
                onClick={() => closeToRight(menu.tab)}
              >
                {t('Close tabs to the right')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="tool-tab-menu__item"
                onClick={closeAll}
              >
                {t('Close all tabs')}
              </button>
            </div>,
            document.body
          )
        : null}
    </aside>
  )
})

/** The panel's home page: the tools start from here, as cards. */
function ToolStart({ onOpen }: { onOpen: (view: Exclude<ToolPanelView, 'start'>) => void }) {
  const t = useT()
  const platform = useAppStore((state) => state.info?.platform)
  const shortcutBindings = useAppStore((state) => state.settings.shortcutBindings)
  // Live shortcut cards wear the chords the user actually recorded.
  const shortcutOf = (entry: (typeof TABS)[number]) =>
    entry.view === 'terminal'
      ? keysFor('toggle-terminal', shortcutBindings).join('+')
      : entry.view === 'side-chat'
        ? keysFor('toggle-side-chat', shortcutBindings).join('+')
        : entry.shortcut
  return (
    <div className="tool-start">
      <div className="tool-start__panel">
        <div className="tool-start__caption">{t('Start from here')}</div>
        <div className="tool-start__list">
          {TABS.map((entry) => {
            const Icon = entry.icon
            const shortcut = shortcutOf(entry)
            return (
              <button
                key={entry.view}
                type="button"
                className="tool-menu__card"
                data-tool={entry.view}
                title={t(entry.description)}
                onClick={() => onOpen(entry.view)}
              >
                <span className="tool-menu__card-icon">
                  <Icon size={18} strokeWidth={1.6} />
                </span>
                <span className="tool-menu__card-label">{t(entry.label)}</span>
                {shortcut ? (
                  <span className="tool-menu__shortcut">
                    {formatPlatformShortcut(shortcut, platform)}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

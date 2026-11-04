import {
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
  Globe,
  Images,
  List,
  Maximize2,
  Minimize2,
  Plus,
  SquareTerminal,
  X
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { formatPlatformShortcut } from '../lib/shortcuts'
import { useT } from '../lib/i18n'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { ErrorBoundary } from './ErrorBoundary'
import { Popover } from './Popover'

/**
 * What the side panel can show, as a page each.
 *
 * The pages follow MCode's workspace panel: the header is a strip of
 * fixed-width page tabs, and `+` creates a new "start from here" tab.
 */
export type ToolPanelView = 'files' | 'changes' | 'subagents' | 'terminal' | 'browser' | 'images' | 'start'

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
  { view: 'files', label: 'Files', description: 'Browse the project files', icon: Files },
  { view: 'browser', label: 'Browser', description: 'Browse a page without leaving the app', icon: Globe },
  { view: 'terminal', label: 'Terminal', description: 'Run commands in a real shell', icon: SquareTerminal, shortcut: 'Ctrl+`' },
  { view: 'changes', label: 'File changes', description: 'Review the files this conversation changed', icon: FileDiff },
  { view: 'subagents', label: 'Subagents', description: 'Subagent tasks and their status', icon: Bot },
  { view: 'images', label: 'Images', description: 'Pictures in this project', icon: Images }
]

const TAB_BY_VIEW = new Map(TABS.map((entry) => [entry.view, entry]))

interface TabContextMenu {
  tab: ToolTab
  x: number
  y: number
}

export function ToolPanel({
  view,
  onViewChange,
  children,
  className,
  overlay,
  onClose,
  width,
  onResize,
  onResizeEnd
}: {
  view: ToolPanelView
  onViewChange: (view: ToolPanelView) => void
  /** The active page's content. The start page is drawn by the panel itself. */
  children?: ReactNode
  className?: string
  overlay: boolean
  onClose: () => void
  width: number
  onResize?: (width: number) => void
  onResizeEnd?: (width: number) => void
}) {
  const t = useT()
  const panelRef = useRef<HTMLElement>(null)
  useDialogFocus(panelRef, onClose, overlay)

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
  const [menu, setMenu] = useState<TabContextMenu | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (view === 'start') return
    const existing = tabs.find((tab) => tab.view === view)
    if (existing) {
      setActive(existing.id)
      return
    }
    setTabs((current) => [...current, { id: view, view }])
    setActive(view)
  }, [tabs, view])

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
      if (event.key === 'Escape') close()
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
    if (!maximized) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('.modal-layer, .popover, .tool-tab-menu, .lightbox-layer')) return
      setMaximized(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maximized])

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

  const closeTab = (next: ToolTab) => {
    const index = tabs.findIndex((tab) => tab.id === next.id)
    const remaining = tabs.filter((tab) => tab.id !== next.id)
    setTabs(remaining)
    setMenu(null)
    if (remaining.length === 0) {
      setActive(null)
      onViewChange('start')
      onClose()
      return
    }
    if (active !== next.id) return
    const fallback = remaining[Math.min(index, remaining.length - 1)] ?? remaining[remaining.length - 1]
    if (fallback) {
      setActive(fallback.id)
      onViewChange(fallback.view ?? 'start')
    } else {
      setActive(null)
      onViewChange('start')
    }
  }

  const closeOthers = (keep: ToolTab) => {
    setTabs([keep])
    setActive(keep.id)
    onViewChange(keep.view ?? 'start')
    setMenu(null)
  }

  const closeToRight = (keep: ToolTab) => {
    const index = tabs.findIndex((tab) => tab.id === keep.id)
    if (index < 0) return
    setTabs(tabs.slice(0, index + 1))
    setActive(keep.id)
    onViewChange(keep.view ?? 'start')
    setMenu(null)
  }

  const closeAll = () => {
    setTabs([])
    setActive(null)
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

  const openContextMenu = (event: React.MouseEvent, tab: ToolTab) => {
    event.preventDefault()
    setMenu({
      tab,
      x: Math.min(Math.max(8, event.clientX), Math.max(8, window.innerWidth - 224 - 8)),
      y: Math.min(Math.max(8, event.clientY), Math.max(8, window.innerHeight - 220 - 8))
    })
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
        const nextWidth = Math.max(360, Math.min(760, startWidth - (moveEvent.clientX - startX)))
        widthRef.current = nextWidth
        onResize(nextWidth)
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
    [onResize, onResizeEnd, width]
  )
  const activeTab = tabs.find((tab) => tab.id === active) ?? null

  return (
    <aside
      ref={panelRef}
      className={`tool-panel${maximized ? ' tool-panel--maximized' : ''}${className ? ` ${className}` : ''}`}
      style={{ width }}
      role={overlay ? 'dialog' : undefined}
      aria-modal={overlay ? true : undefined}
      tabIndex={overlay ? -1 : undefined}
      aria-label={t('Tools')}
    >
      {onResize ? (
        <div
          className="tool-panel__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('Resize the panel')}
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
                  role="tab"
                  aria-selected={tab.id === active}
                  className="tool-panel__tab"
                  data-active={tab.id === active || undefined}
                  title={t(meta?.description ?? 'New tab')}
                  onClick={() => selectTab(tab)}
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
            <Plus size={18} />
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
                <List size={18} />
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
          {maximized ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
        </button>
      </div>

      <div className="tool-panel__body" data-view={activeTab?.view ?? 'start'}>
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
            >
              <button
                type="button"
                role="menuitem"
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
}

/** The panel's home page: the tools start from here, as cards. */
function ToolStart({ onOpen }: { onOpen: (view: Exclude<ToolPanelView, 'start'>) => void }) {
  const t = useT()
  const platform = useAppStore((state) => state.info?.platform)
  return (
    <div className="tool-start">
      <div className="tool-start__panel">
        <div className="tool-start__caption">{t('Start from here')}</div>
        <div className="tool-start__list">
          {TABS.map((entry) => {
            const Icon = entry.icon
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
                {entry.shortcut ? (
                  <span className="tool-menu__shortcut">
                    {formatPlatformShortcut(entry.shortcut, platform)}
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

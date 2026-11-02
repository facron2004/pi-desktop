import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bot,
  Compass,
  FileDiff,
  Files,
  Globe,
  Images,
  Plus,
  SquareTerminal,
  X
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { countChangedFiles } from '../lib/changes'
import { formatPlatformShortcut } from '../lib/shortcuts'
import { useT } from '../lib/i18n'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { ErrorBoundary } from './ErrorBoundary'

/**
 * What the side panel can show, as a page each.
 *
 * Pages are opened from the guide (the panel's home page), not from a fixed
 * function strip: the top row is a browser-like tab strip, so opening Files
 * does not make Files the permanent meaning of a tab. The guide is the
 * navigation surface and always remains reachable through the plus control.
 */
export type ToolPanelView = 'files' | 'changes' | 'subagents' | 'terminal' | 'browser' | 'images'

type ToolTab = ToolPanelView | 'guide'

const TABS: {
  view: ToolPanelView
  label: string
  description: string
  icon: typeof Files
  shortcut?: string
}[] = [
  { view: 'files', label: 'Files', description: 'Browse the project files', icon: Files },
  { view: 'changes', label: 'File changes', description: 'Review the files this conversation changed', icon: FileDiff },
  { view: 'subagents', label: 'Subagents', description: 'Subagent tasks and their status', icon: Bot },
  { view: 'terminal', label: 'Terminal', description: 'Run commands in a real shell', icon: SquareTerminal, shortcut: 'Ctrl+`' },
  { view: 'browser', label: 'Browser', description: 'Browse a page without leaving the app', icon: Globe },
  { view: 'images', label: 'Images', description: 'Pictures in this project', icon: Images }
]

const GUIDE_META = { label: 'Tools', icon: Compass }
const TAB_BY_VIEW = new Map(TABS.map((entry) => [entry.view, entry]))

function metaOf(tab: ToolTab) {
  if (tab === 'guide') return GUIDE_META
  return TAB_BY_VIEW.get(tab) ?? GUIDE_META
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
  /** The active page's content. The guide is drawn by the panel itself. */
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
  const items = useAppStore((state) => state.items)
  const git = useAppStore((state) => state.git)

  const changeCount = useMemo(() => {
    const fromThread = countChangedFiles(items)
    return fromThread > 0 ? fromThread : git?.isRepo ? git.files.length : 0
  }, [items, git])

  // The strip holds the pages the reader opened in this panel visit. App still
  // owns the active view, so the guide and every tab share one navigation
  // state rather than maintaining a second copy in the panel.
  const [tabs, setTabs] = useState<ToolTab[]>(['guide', view])
  const [active, setActive] = useState<ToolTab>(view)
  useEffect(() => {
    setTabs((current) => (current.includes(view) ? current : [...current, view]))
    setActive(view)
  }, [view])

  const openView = useCallback((next: ToolPanelView) => {
    setTabs((current) => (current.includes(next) ? current : [...current, next]))
    setActive(next)
    onViewChange(next)
  }, [onViewChange])

  const openGuide = useCallback(() => {
    setTabs((current) => (current.includes('guide') ? current : [...current, 'guide']))
    setActive('guide')
  }, [])

  const selectTab = (next: ToolTab) => {
    setActive(next)
    if (next !== 'guide') onViewChange(next)
  }

  const closeTab = (next: ToolTab) => {
    const remaining = tabs.filter((tab) => tab !== next)
    if (remaining.length === 0) {
      setTabs(['guide'])
      setActive('guide')
      return
    }
    setTabs(remaining)
    if (active === next) {
      const fallback = remaining[remaining.length - 1]
      setActive(fallback)
      if (fallback !== 'guide') onViewChange(fallback)
    }
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
        const nextWidth = Math.max(300, Math.min(800, startWidth - (moveEvent.clientX - startX)))
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

  return (
    <aside
      ref={panelRef}
      className={`tool-panel${className ? ` ${className}` : ''}`}
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
      <div className="tool-panel__tabs" role="tablist" aria-label={t('Tools')}>
        {tabs.map((tab) => {
          const meta = metaOf(tab)
          const Icon = meta.icon
          const activeTab = tab === active
          const title = tab === 'guide' ? GUIDE_META.label : TAB_BY_VIEW.get(tab)?.description ?? GUIDE_META.label
          return (
            <div className="tool-panel__tab-shell" key={tab} data-active={activeTab || undefined}>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab}
                className="tool-panel__tab"
                data-active={activeTab || undefined}
                title={t(title)}
                onClick={() => selectTab(tab)}
              >
                <Icon size={15} strokeWidth={1.7} />
                <span className="tool-panel__tab-label">{t(meta.label)}</span>
                {tab === 'changes' && changeCount > 0 ? (
                  <span className="tool-panel__count">{changeCount}</span>
                ) : null}
              </button>
              {tab === 'guide' ? null : (
                <button
                  type="button"
                  className="tool-panel__tab-close"
                  aria-label={t('Close tab')}
                  title={t('Close tab')}
                  onClick={() => closeTab(tab)}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          )
        })}
        <button
          type="button"
          className="tool-panel__new-tab"
          aria-label={t('Open a tool')}
          title={t('Open a tool')}
          onClick={openGuide}
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="tool-panel__body" data-view={active}>
        <ErrorBoundary scope="tool panel">
          {active === 'guide' ? <ToolGuide onOpen={openView} /> : children}
        </ErrorBoundary>
      </div>
    </aside>
  )
}

/** The panel's home page: tool entries are links, not permanent tabs. */
function ToolGuide({ onOpen }: { onOpen: (view: ToolPanelView) => void }) {
  const t = useT()
  const platform = useAppStore((state) => state.info?.platform)
  return (
    <div className="tool-menu">
      <div className="tool-menu__list">
        <div className="tool-menu__heading">{t('Open a tool')}</div>
        {TABS.map((entry) => {
          const Icon = entry.icon
          return (
            <button
              key={entry.view}
              type="button"
              className="tool-menu__card"
              title={entry.shortcut}
              onClick={() => onOpen(entry.view)}
            >
              <span className="tool-menu__card-icon">
                <Icon size={16} strokeWidth={1.7} />
              </span>
              <span className="tool-menu__card-copy">
                <span className="tool-menu__card-label">{t(entry.label)}</span>
                <span className="tool-menu__card-description">{t(entry.description)}</span>
              </span>
              {entry.shortcut ? (
                <span className="tool-menu__shortcut">{formatPlatformShortcut(entry.shortcut, platform)}</span>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}

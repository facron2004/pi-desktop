import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import {
  ChevronLeft,
  FileDiff,
  Files,
  Globe,
  Images,
  LayoutGrid,
  PanelRight,
  SquareTerminal
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { collectChanges } from '../lib/changes'
import { formatPlatformShortcut } from '../lib/shortcuts'
import { useT } from '../lib/i18n'
import { useDialogFocus } from '../hooks/useDialogFocus'

/**
 * What the side panel can show: a menu first, then the thing that was picked.
 *
 * The panel opens on a menu rather than on a tab — a tab bar says "these are
 * five views of one thing", which is not true here; the pieces are unrelated
 * tools, and a menu is what a list of tools looks like. Picking one replaces
 * the menu with that tool and leaves one way back, so the panel is never a
 * puzzle about where the menu went.
 */
export type ToolPanelView =
  | 'start'
  | 'files'
  | 'changes'
  | 'terminal'
  | 'browser'
  | 'images'
  | 'tasks'

const MENU: {
  view: ToolPanelView
  label: string
  icon: typeof Files
  shortcut?: string
}[] = [
  { view: 'files', label: 'Files', icon: Files },
  { view: 'changes', label: 'File changes', icon: FileDiff },
  { view: 'terminal', label: 'New terminal', icon: SquareTerminal, shortcut: 'Ctrl+`' },
  { view: 'browser', label: 'Browser', icon: Globe },
  { view: 'images', label: 'Images', icon: Images },
  { view: 'tasks', label: 'Tasks', icon: LayoutGrid }
]

const MENU_TITLES: Record<ToolPanelView, string> = {
  start: 'Start',
  files: 'Files',
  changes: 'File changes',
  terminal: 'Terminal',
  browser: 'Browser',
  images: 'Images',
  tasks: 'Tasks'
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
  /** The tool itself, or null when this component draws the menu. */
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
  const platform = useAppStore((state) => state.info?.platform)
  const items = useAppStore((state) => state.items)
  const git = useAppStore((state) => state.git)

  const showingMenu = view === 'start'

  const changeCount = useMemo(() => {
    const fromThread = collectChanges(items).length
    return fromThread > 0 ? fromThread : git?.isRepo ? git.files.length : 0
  }, [items, git])

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
      <header className="tool-panel__head">
        {showingMenu ? (
          <div className="tool-panel__title">
            <span className="tool-panel__title-icon" aria-hidden="true">
              <LayoutGrid size={15} />
            </span>
            <span>{t(MENU_TITLES[view])}</span>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="icon-btn tool-panel__back"
              aria-label={t('Back')}
              title={t('Back')}
              onClick={() => onViewChange('start')}
            >
              <ChevronLeft size={15} />
            </button>
            <div className="tool-panel__title">
              <span>{t(MENU_TITLES[view])}</span>
              {view === 'changes' && changeCount > 0 ? (
                <span className="tool-panel__count">{changeCount}</span>
              ) : null}
            </div>
          </>
        )}
        <div className="tool-panel__head-actions">
          <button
            className="icon-btn"
            aria-label={t('Hide tools panel')}
            title={t('Hide tools panel')}
            onClick={onClose}
          >
            <PanelRight size={16} strokeWidth={1.7} />
          </button>
        </div>
      </header>

      <div className="tool-panel__body" data-view={view}>
        {showingMenu ? (
          <div className="tool-menu">
            <div className="tool-menu__list">
              <div className="tool-menu__heading">{t('Start here')}</div>
              {MENU.map((entry) => {
                const Icon = entry.icon
                return (
                  <button
                    key={entry.view}
                    type="button"
                    className="tool-menu__card"
                    onClick={() => onViewChange(entry.view)}
                  >
                    <span className="tool-menu__card-icon">
                      <Icon size={17} />
                    </span>
                    <span className="tool-menu__card-label">{t(entry.label)}</span>
                    {entry.view === 'changes' && changeCount > 0 ? (
                      <span className="tool-menu__count">{changeCount}</span>
                    ) : null}
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
        ) : (
          children
        )}
      </div>
    </aside>
  )
}

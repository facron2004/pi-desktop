import { PanelLeft } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { formatPlatformShortcut, keysFor, type ShortcutId } from '../lib/shortcuts'
import { Popover } from './Popover'
import { checkForAppUpdates } from '../lib/app-update'

type MenuItem =
  | { separator: true }
  | {
      label: string
      onSelect: () => void
      /** The chord the action answers to, already formatted for this platform. */
      shortcut?: string
      disabled?: boolean
      /** Destructive items read in the danger colour. */
      danger?: boolean
    }

interface MenuGroupProps {
  label: string
  items: MenuItem[]
  width?: number
}

/**
 * One top-level menu. Items are separated by the same hairline the other
 * popovers use; a chord sits on the right edge so the list reads like a
 * desktop menu rather than a list of buttons.
 */
function MenuGroup({ label, items, width = 260 }: MenuGroupProps) {
  return (
    <Popover
      width={width}
      className="app-menu__popover"
      renderTrigger={({ open, toggle }) => (
        <button
          className="app-menu__trigger no-drag"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={toggle}
        >
          {label}
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={label}>
          {items.map((item, index) =>
            'separator' in item ? (
              <div className="popover__divider" role="separator" key={`separator-${index}`} />
            ) : (
              <button
                className={`popover__item${item.danger ? ' popover__item--danger' : ''}`}
                type="button"
                role="menuitem"
                key={item.label}
                disabled={item.disabled}
                onClick={() => {
                  close()
                  item.onSelect()
                }}
              >
                <span className="popover__item-text">{item.label}</span>
                {item.shortcut ? <span className="app-menu__chord">{item.shortcut}</span> : null}
              </button>
            )
          )}
        </div>
      )}
    </Popover>
  )
}

export function AppMenuBar({
  sidebarOpen,
  taskRailOpen,
  hasItems,
  canCompact,
  onToggleSidebar,
  onToggleTaskPanel,
  onNewChat,
  onNewProject,
  onExportConversation,
  onOpenChanges,
  onOpenFiles,
  onOpenBrowser,
  onOpenSubagents,
  onToggleTerminal,
  onOpenSessionTree,
  onSearchConversation,
  onCompact,
  onOpenSettings,
  onOpenShortcuts,
  onOpenLauncher,
  onOpenAbout
}: {
  sidebarOpen: boolean
  taskRailOpen: boolean
  hasItems: boolean
  canCompact: boolean
  onToggleSidebar: () => void
  onToggleTaskPanel: () => void
  onNewChat: () => void
  onNewProject: () => void
  onExportConversation: () => void
  onOpenChanges: () => void
  onOpenFiles: () => void
  onOpenBrowser: () => void
  onOpenSubagents: () => void
  onToggleTerminal: () => void
  onOpenSessionTree: () => void
  onSearchConversation: () => void
  onCompact: () => void
  onOpenSettings: () => void
  onOpenShortcuts: () => void
  onOpenLauncher: () => void
  onOpenAbout: () => void
}) {
  const t = useT()
  const shortcutBindings = useAppStore((state) => state.settings.shortcutBindings)
  const platform = useAppStore((state) => state.info?.platform)

  /** A menu chord, using the reader's own bindings and platform glyphs. */
  const chord = (id: ShortcutId) =>
    formatPlatformShortcut(keysFor(id, shortcutBindings).join('+'), platform)
  /** A browser-native chord (undo, copy…), still with the platform's modifier. */
  const nativeChord = (value: string) => formatPlatformShortcut(value, platform)

  const editAction = (command: string) => () => {
    document.execCommand(command)
  }

  const docsUrl = 'https://github.com/facron2004/pi-desktop#readme'
  const issuesUrl = 'https://github.com/facron2004/pi-desktop/issues'

  return (
    <header className="app-menu drag-region">
      <div className="app-menu__navigation no-drag">
        <button
          className="app-menu__button"
          type="button"
          aria-label={t('Toggle sidebar')}
          title={t('Toggle sidebar')}
          aria-expanded={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <PanelLeft size={17} />
        </button>
      </div>

      <nav className="app-menu__groups no-drag" aria-label={t('Application menus')}>
        <MenuGroup
          label={t('File')}
          items={[
            { label: t('New chat'), onSelect: onNewChat, shortcut: chord('new-chat') },
            { label: `${t('New project')}…`, onSelect: onNewProject },
            { label: `${t('Open project folder')}…`, onSelect: onNewProject },
            { separator: true },
            {
              label: `${t('Export conversation')}…`,
              onSelect: onExportConversation,
              disabled: !hasItems
            }
          ]}
        />
        <MenuGroup
          label={t('Edit')}
          items={[
            { label: t('Undo'), onSelect: editAction('undo'), shortcut: nativeChord('Ctrl+Z') },
            {
              label: t('Redo'),
              onSelect: editAction('redo'),
              shortcut: nativeChord(platform === 'darwin' ? 'Ctrl+Shift+Z' : 'Ctrl+Y')
            },
            { separator: true },
            { label: t('Cut'), onSelect: editAction('cut'), shortcut: nativeChord('Ctrl+X') },
            { label: t('Copy'), onSelect: editAction('copy'), shortcut: nativeChord('Ctrl+C') },
            { label: t('Paste'), onSelect: editAction('paste'), shortcut: nativeChord('Ctrl+V') },
            { label: t('Delete'), onSelect: editAction('delete'), shortcut: 'Del' },
            { separator: true },
            { label: t('Select all'), onSelect: editAction('selectAll'), shortcut: nativeChord('Ctrl+A') },
            { separator: true },
            {
              label: `${t('Settings')}…`,
              onSelect: onOpenSettings,
              shortcut: chord('open-settings')
            }
          ]}
        />
        <MenuGroup
          label={t('View')}
          width={280}
          items={[
            {
              label: sidebarOpen ? t('Hide sidebar') : t('Show sidebar'),
              onSelect: onToggleSidebar,
              shortcut: chord('toggle-sidebar')
            },
            {
              label: taskRailOpen ? t('Hide task panel') : t('Show task panel'),
              onSelect: () => onToggleTaskPanel()
            },
            { separator: true },
            { label: t('Review changes'), onSelect: onOpenChanges },
            { label: t('Project files'), onSelect: onOpenFiles },
            { label: t('Browser'), onSelect: onOpenBrowser },
            { label: t('Subagents'), onSelect: onOpenSubagents },
            {
              label: t('Terminal'),
              onSelect: onToggleTerminal,
              shortcut: chord('toggle-terminal')
            },
            { separator: true },
            {
              label: t('Session tree'),
              onSelect: onOpenSessionTree,
              shortcut: chord('session-tree'),
              disabled: !hasItems
            },
            {
              label: t('Search conversation'),
              onSelect: onSearchConversation,
              shortcut: chord('search-conversation'),
              disabled: !hasItems
            },
            { separator: true },
            { label: t('Compact'), onSelect: onCompact, disabled: !canCompact }
          ]}
        />
        <MenuGroup
          label={t('Help')}
          items={[
            {
              label: t('Documentation'),
              onSelect: () => void window.pi.shell.openExternal(docsUrl)
            },
            {
              label: t('Keyboard shortcuts'),
              onSelect: onOpenShortcuts,
              shortcut: chord('shortcut-list')
            },
            {
              label: t('Command palette'),
              onSelect: onOpenLauncher,
              shortcut: chord('command-palette')
            },
            { separator: true },
            { label: `${t('Check for updates')}…`, onSelect: () => void checkForAppUpdates().catch(() => {}) },
            {
              label: t('Report an issue'),
              onSelect: () => void window.pi.shell.openExternal(issuesUrl)
            },
            { label: t('About Pi Desktop'), onSelect: onOpenAbout }
          ]}
        />
      </nav>
    </header>
  )
}

import { PanelLeft } from 'lucide-react'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'

type MenuAction = {
  label: string
  onSelect: () => void
  disabled?: boolean
}

function MenuGroup({ label, actions }: { label: string; actions: MenuAction[] }) {
  return (
    <Popover
      width={220}
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
          {actions.map((action) => (
            <button
              className="popover__item"
              type="button"
              role="menuitem"
              key={action.label}
              disabled={action.disabled}
              onClick={() => {
                close()
                action.onSelect()
              }}
            >
              <span className="popover__item-text">{action.label}</span>
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}

export function AppMenuBar({
  sidebarOpen,
  onToggleSidebar,
  onNewChat,
  onOpenProject,
  onOpenChanges,
  onOpenFiles,
  onCompact,
  canCompact,
  onToggleTerminal,
  onOpenSettings,
  onOpenShortcuts,
  onOpenLauncher
}: {
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onNewChat: () => void
  onOpenProject: () => void
  onOpenChanges: () => void
  onOpenFiles: () => void
  onCompact: () => void
  canCompact: boolean
  onToggleTerminal: () => void
  onOpenSettings: () => void
  onOpenShortcuts: () => void
  onOpenLauncher: () => void
}) {
  const t = useT()
  const editAction = (command: string) => () => {
    document.execCommand(command)
  }

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
          actions={[
            { label: t('New chat'), onSelect: onNewChat },
            { label: t('Open project folder'), onSelect: onOpenProject }
          ]}
        />
        <MenuGroup
          label={t('Edit')}
          actions={[
            { label: t('Undo'), onSelect: editAction('undo') },
            { label: t('Redo'), onSelect: editAction('redo') },
            { label: t('Cut'), onSelect: editAction('cut') },
            { label: t('Copy'), onSelect: editAction('copy') },
            { label: t('Paste'), onSelect: editAction('paste') },
            { label: t('Select all'), onSelect: editAction('selectAll') }
          ]}
        />
        <MenuGroup
          label={t('View')}
          actions={[
            { label: t('Toggle sidebar'), onSelect: onToggleSidebar },
            { label: t('Changes'), onSelect: onOpenChanges },
            { label: t('Files'), onSelect: onOpenFiles },
            { label: t('Compact'), onSelect: onCompact, disabled: !canCompact },
            { label: t('Terminal'), onSelect: onToggleTerminal },
            { label: t('Settings'), onSelect: onOpenSettings }
          ]}
        />
        <MenuGroup
          label={t('Help')}
          actions={[
            { label: t('Keyboard shortcuts'), onSelect: onOpenShortcuts },
            { label: t('Open the launcher'), onSelect: onOpenLauncher }
          ]}
        />
      </nav>
    </header>
  )
}

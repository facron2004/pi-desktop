import {
  FolderOpen,
  Clock3,
  Square,
  SquareTerminal,
  Settings,
  GitBranch,
  House,
  Files,
  LayoutGrid,
  Puzzle,
  type LucideIcon
} from 'lucide-react'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'

type AppRailProps = {
  newChatActive: boolean
  filesOpen: boolean
  terminalOpen: boolean
  settingsOpen: boolean
  mcpOpen: boolean
  launcherOpen: boolean
  onNewChat: () => void
  onSearchConversations: () => void
  onOpenFiles: () => void
  onOpenProject: () => void
  onOpenChanges: () => void
  onOpenTerminal: () => void
  onOpenMcp: () => void
  onOpenSettings: () => void
  onOpenLauncher: () => void
}

type RailActionProps = {
  icon?: LucideIcon
  label: string
  onClick: () => void
  active?: boolean
}

function RailAction({ icon: Icon, label, onClick, active = false }: RailActionProps) {
  return (
    <button
      className="app-rail__button"
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-active={active}
      onClick={onClick}
    >
      {Icon ? (
        <Icon
          size={Icon === House ? 18 : 16}
          fill={Icon === House && active ? 'currentColor' : 'none'}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : null}
    </button>
  )
}

export function AppRail({
  newChatActive,
  filesOpen,
  terminalOpen,
  settingsOpen,
  mcpOpen,
  launcherOpen,
  onNewChat,
  onSearchConversations,
  onOpenFiles,
  onOpenProject,
  onOpenChanges,
  onOpenTerminal,
  onOpenMcp,
  onOpenSettings,
  onOpenLauncher
}: AppRailProps) {
  const t = useT()
  const isStreaming = useAppStore((state) => state.isStreaming)
  const aborting = useAppStore((state) => state.run.phase === 'aborting')
  const stop = useAppStore((state) => state.stop)

  return (
    <nav className="app-rail" aria-label={t('Application menu')}>
      <div className="app-rail__group">
        <RailAction icon={House} label={t('New chat')} onClick={onNewChat} active={newChatActive} />
        <RailAction
          icon={Files}
          label={t('Browse the project files')}
          onClick={onOpenFiles}
          active={filesOpen}
        />
        <RailAction icon={Clock3} label={t('Filter conversations')} onClick={onSearchConversations} />
        <RailAction icon={FolderOpen} label={t('Open project folder')} onClick={onOpenProject} />
        <RailAction
          icon={SquareTerminal}
          label={t('Open or close the terminal')}
          onClick={onOpenTerminal}
          active={terminalOpen}
        />

        {/* Stopping a run belongs with the app's own controls, not in the
            message being written: the column is always there, so the run can
            be stopped whether or not the composer has a draft in it. */}
        {isStreaming ? (
          <button
            type="button"
            className="app-rail__stop"
            data-aborting={aborting || undefined}
            aria-label={aborting ? t('Stopping…') : t('Stop the current run (Esc)')}
            title={aborting ? t('Stopping…') : t('Stop the current run (Esc)')}
            onClick={() => void stop()}
          >
            <Square size={12} fill="currentColor" strokeWidth={0} />
          </button>
        ) : null}
      </div>

      <div className="app-rail__divider" />

      <div className="app-rail__group app-rail__group--bottom">
        {/* The branch itself is in the line under the composer; the rail only
            offers the way into the review, in both cases. */}
        <RailAction
          icon={GitBranch}
          label={t('Review the files Pi changed')}
          onClick={onOpenChanges}
        />
        <RailAction icon={LayoutGrid} label={t('Open the launcher')} onClick={onOpenLauncher} active={launcherOpen} />
        <RailAction icon={Puzzle} label={t('MCP servers')} onClick={onOpenMcp} active={mcpOpen} />
        <RailAction icon={Settings} label={t('Settings')} onClick={onOpenSettings} active={settingsOpen} />
      </div>
    </nav>
  )
}

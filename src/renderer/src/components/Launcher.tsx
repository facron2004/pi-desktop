import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Copy,
  CopyPlus,
  Cpu,
  FileDiff,
  FileDown,
  Files,
  FolderOpen,
  GitBranch,
  GitCommit,
  GitFork,
  Keyboard,
  MessageSquarePlus,
  Minimize2,
  Moon,
  PanelLeft,
  Pin,
  Search,
  Server,
  Settings,
  Sparkles,
  SquarePen,
  SquareTerminal,
  Sun,
  Type
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { collectProjects, sortProjects } from '../lib/projects'
import { COMMAND_SOURCE } from '../lib/command-source'
import { transcriptOf } from '../lib/thread'
import { useT } from '../lib/i18n'

/** One thing the user can do from the launcher. */
export interface LauncherAction {
  id: string
  title: string
  /** The reason for the action, or the keys that trigger it. */
  hint?: string
  group: string
  icon: LucideIcon
  run: () => void | Promise<void>
}

/** The text sizes the settings offer, from the smallest to the largest. */
const FONT_STEPS = [0.92, 1, 1.1, 1.22]

/** The parts of the app shell the launcher drives. */
export interface LauncherShell {
  sidebarOpen: boolean
  toggleSidebar: () => void
  openSettings: () => void
  openShortcuts: () => void
}

/**
 * Collect everything the launcher can do.
 *
 * The app's own commands live in the store already, so they are run from
 * there; the rest needs the shell, which only the app knows.
 */
export function useLauncherActions(shell: LauncherShell): LauncherAction[] {
  const runAppCommand = useAppStore((state) => state.runAppCommand)
  const switchProject = useAppStore((state) => state.switchProject)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const cycleModel = useAppStore((state) => state.cycleModel)
  const cycleThinkingLevel = useAppStore((state) => state.cycleThinkingLevel)
  const togglePin = useAppStore((state) => state.togglePin)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const workspaces = useAppStore((state) => state.settings.workspaces)
  const sessions = useAppStore((state) => state.sessions)
  const workspace = useAppStore((state) => state.workspace)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const pinned = useAppStore((state) => state.settings.pinnedSessions ?? [])
  const models = useAppStore((state) => state.models)
  const thinkingLevels = useAppStore((state) => state.thinkingLevels)
  const fontScale = useAppStore((state) => state.settings.fontScale ?? 1)
  const showToast = useAppStore((state) => state.showToast)

  // The theme that is on screen, which is what the reader sees — the setting
  // itself may still be "follow the system".
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  const fontIndex = FONT_STEPS.findIndex((step) => Math.abs(step - fontScale) < 0.01)
  const biggerFont = FONT_STEPS[(fontIndex + 1 + FONT_STEPS.length) % FONT_STEPS.length]
  const smallerFont = FONT_STEPS[(fontIndex - 1 + FONT_STEPS.length) % FONT_STEPS.length]

  const actions: LauncherAction[] = [
    {
      id: 'new',
      title: 'Start a new conversation',
      hint: 'Ctrl+N',
      group: 'Conversation',
      icon: MessageSquarePlus,
      run: () => runAppCommand('new')
    },
    {
      id: 'rename',
      title: 'Rename this conversation',
      group: 'Conversation',
      icon: SquarePen,
      run: () => {
        window.dispatchEvent(new CustomEvent('pi:rename-session'))
      }
    },
    {
      id: 'duplicate',
      title: 'Duplicate this conversation',
      group: 'Conversation',
      icon: CopyPlus,
      run: () => runAppCommand('duplicate')
    },
    {
      id: 'branch',
      title: 'Branch from the last prompt',
      group: 'Conversation',
      icon: GitBranch,
      run: () => runAppCommand('branch')
    },
    {
      id: 'tree',
      title: 'Show the session tree',
      hint: 'Ctrl+Shift+T',
      group: 'Conversation',
      icon: GitFork,
      run: () => runAppCommand('tree')
    },
    {
      id: 'copy',
      title: 'Copy the last answer',
      group: 'Conversation',
      icon: Copy,
      run: () => runAppCommand('copy')
    },
    {
      id: 'copy-conversation',
      title: 'Copy the whole conversation',
      group: 'Conversation',
      icon: Copy,
      run: async () => {
        const transcript = transcriptOf(useAppStore.getState().items)
        if (!transcript) {
          showToast('There is nothing to copy yet', 'warning')
          return
        }
        try {
          await navigator.clipboard.writeText(transcript)
          showToast('The conversation was copied')
        } catch {
          showToast('The clipboard is not available', 'error')
        }
      }
    },
    {
      id: 'export',
      title: 'Export this conversation as HTML',
      group: 'Conversation',
      icon: FileDown,
      run: () => runAppCommand('export')
    },
    {
      id: 'compact',
      title: 'Summarise the conversation to free up the context',
      group: 'Conversation',
      icon: Minimize2,
      run: () => runAppCommand('compact')
    },
    {
      id: 'pin',
      title:
        activeSessionFile && pinned.includes(activeSessionFile)
          ? 'Unpin this conversation'
          : 'Pin this conversation to the top',
      group: 'Conversation',
      icon: Pin,
      run: () => {
        if (activeSessionFile) void togglePin(activeSessionFile)
      }
    },
    {
      id: 'model-next',
      title: 'Use the next model',
      hint: models.length > 1 ? 'Ctrl+P' : undefined,
      group: 'Model',
      icon: Cpu,
      run: () => cycleModel(1)
    },
    {
      id: 'model-previous',
      title: 'Use the previous model',
      group: 'Model',
      icon: Cpu,
      run: () => cycleModel(-1)
    },
    {
      id: 'thinking-next',
      title: 'Use the next reasoning effort',
      hint: thinkingLevels.length > 1 ? 'Ctrl+T' : undefined,
      group: 'Model',
      icon: Sparkles,
      run: () => cycleThinkingLevel(1)
    },
    {
      id: 'thinking-previous',
      title: 'Use the previous reasoning effort',
      group: 'Model',
      icon: Sparkles,
      run: () => cycleThinkingLevel(-1)
    },
    {
      id: 'open-project',
      title: 'Open another project…',
      group: 'Project',
      icon: FolderOpen,
      run: () => pickWorkspace()
    },
    {
      id: 'sidebar',
      title: shell.sidebarOpen ? 'Hide the sidebar' : 'Show the sidebar',
      hint: 'Ctrl+B',
      group: 'View',
      icon: PanelLeft,
      run: () => shell.toggleSidebar()
    },
    {
      id: 'changes',
      title: 'Review the files Pi changed',
      group: 'View',
      icon: FileDiff,
      run: () => runAppCommand('changes')
    },
    {
      id: 'files',
      title: 'Browse the project files',
      group: 'View',
      icon: Files,
      run: () => runAppCommand('files')
    },
    {
      id: 'terminal',
      title: 'Toggle the terminal',
      hint: 'Ctrl+`',
      group: 'View',
      icon: SquareTerminal,
      run: () => runAppCommand('terminal')
    },
    {
      id: 'commit',
      title: 'Review and commit the working tree',
      group: 'Project',
      icon: GitCommit,
      run: () => runAppCommand('commit')
    },
    {
      id: 'mcp',
      title: 'MCP servers',
      group: 'Project',
      icon: Server,
      run: () => runAppCommand('mcp')
    },
    {
      id: 'shortcuts',
      title: 'Keyboard shortcuts',
      hint: 'Ctrl+/',
      group: 'View',
      icon: Keyboard,
      run: () => shell.openShortcuts()
    },
    {
      id: 'theme',
      title: theme === 'light' ? 'Use the dark theme' : 'Use the light theme',
      group: 'View',
      icon: theme === 'light' ? Moon : Sun,
      run: () => updateSettings({ theme: theme === 'light' ? 'dark' : 'light' })
    },
    {
      id: 'font-bigger',
      title: 'Make the text larger',
      group: 'View',
      icon: Type,
      run: () => updateSettings({ fontScale: biggerFont })
    },
    {
      id: 'font-smaller',
      title: 'Make the text smaller',
      group: 'View',
      icon: Type,
      run: () => updateSettings({ fontScale: smallerFont })
    },
    {
      id: 'settings',
      title: 'Settings',
      group: 'View',
      icon: Settings,
      run: () => shell.openSettings()
    }
  ]

  // The projects come last, so the actions are what the user sees first.
  const projects = sortProjects(collectProjects(workspaces, sessions), workspace?.path)
  for (const project of projects) {
    actions.push({
      id: `project:${project.path}`,
      title: project.name,
      hint: project.path,
      group: 'Projects',
      icon: FolderOpen,
      run: () => switchProject(project.path)
    })
  }

  return actions
}

/**
 * Score an action against the query.
 *
 * Every word of the query has to appear somewhere; a word in the title
 * counts for more than one in the description.
 */
function scoreAction(action: LauncherAction, tokens: string[]): number | null {
  const title = action.title.toLowerCase()
  const haystack = `${title} ${(action.hint ?? '').toLowerCase()} ${action.group.toLowerCase()}`
  let score = 0
  for (const token of tokens) {
    if (!haystack.includes(token)) return null
    const at = title.indexOf(token)
    score += at === -1 ? 1 : 12 - Math.min(at, 11)
  }
  return score
}

export function Launcher({
  actions,
  onClose
}: {
  actions: LauncherAction[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const commands = useAppStore((state) => state.commands)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const t = useT()

  /**
   * Pi's own commands join the search as soon as there is something to
   * search for.
   *
   * There are dozens of them — skills, prompt templates, extension commands
   * — and without a query they would bury the actions of the app.
   */
  const piCommands = useMemo(
    () => commands.filter((command) => command.source !== 'app'),
    [commands]
  )

  const visible = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const list: LauncherAction[] = [...actions]
    if (tokens.length) {
      for (const command of piCommands) {
        list.push({
          id: `pi:${command.source}:${command.name}`,
          title: `/${command.name}`,
          hint: command.description,
          group: 'Pi',
          icon: COMMAND_SOURCE[command.source].Icon,
          // A command of Pi is text that goes to the agent, so it is typed
          // into the composer rather than run right away.
          run: () => insertIntoComposer(`/${command.name} `)
        })
      }
    }
    const scored = list
      .map((action) => ({
        action,
        score: tokens.length
          ? scoreAction(
              {
                ...action,
                title: `${action.title} ${t(action.title)}`,
                group: `${action.group} ${t(action.group)}`
              },
              tokens
            )
          : 0
      }))
      .filter((entry): entry is { action: LauncherAction; score: number } => entry.score !== null)
      .sort((a, b) => b.score - a.score)
    return scored.map((entry, position) => ({ ...entry, position }))
  }, [actions, piCommands, query, insertIntoComposer, t])

  const groups = useMemo(() => {
    const map = new Map<string, typeof visible>()
    for (const entry of visible) {
      const list = map.get(entry.action.group)
      if (list) list.push(entry)
      else map.set(entry.action.group, [entry])
    }
    return Array.from(map, ([name, items]) => ({ name, items }))
  }, [visible])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // A new query means a new list, so the highlight goes back to the top.
  useEffect(() => {
    setIndex(0)
  }, [query])

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [index, visible])

  const run = (entry: { action: LauncherAction }) => {
    // The panel goes away first, so the action can change the app freely.
    onClose()
    void entry.action.run()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setIndex((value) => (visible.length ? (value + 1) % visible.length : 0))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setIndex((value) =>
        visible.length ? (value - 1 + visible.length) % visible.length : 0
      )
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setIndex(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      setIndex(Math.max(0, visible.length - 1))
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const entry = visible[index]
      if (entry) run(entry)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  return (
    <div className="modal-layer" data-align="top" onMouseDown={onClose}>
      <div className="launcher" onMouseDown={(event) => event.stopPropagation()}>
        <div className="launcher__search">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('Search for an action, a command or a project')}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        <div className="launcher__list" ref={listRef}>
          {visible.length === 0 ? (
            <div className="palette__empty">
              {t('Nothing matches')} “{query}”.
              <br />
              {t('Try new, model, files, a skill or the name of a project.')}
            </div>
          ) : (
            groups.map((group) => (
              <div className="launcher__group" key={group.name}>
                <div className="launcher__group-title">{t(group.name)}</div>
                {group.items.map((entry) => {
                  const Icon = entry.action.icon
                  return (
                    <button
                      key={entry.action.id}
                      className="launcher__item"
                      data-active={entry.position === index}
                      data-kind={entry.action.group === 'Pi' ? 'command' : undefined}
                      onMouseEnter={() => setIndex(entry.position)}
                      onClick={() => run(entry)}
                    >
                      <span className="palette__icon">
                        <Icon size={12} />
                      </span>
                      <span className="launcher__name">{t(entry.action.title)}</span>
                      <span className="launcher__hint">{entry.action.hint}</span>
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        <div className="palette__foot">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <span>{t('to move')}</span>
          <kbd>↵</kbd>
          <span>{t('to run')}</span>
          <kbd>esc</kbd>
          <span>{t('to dismiss')}</span>
        </div>
      </div>
    </div>
  )
}

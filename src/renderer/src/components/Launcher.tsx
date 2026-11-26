import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Copy,
  CopyPlus,
  Cpu,
  FileDiff,
  FileDown,
  FileText,
  Files,
  FolderOpen,
  GitBranch,
  GitCommit,
  GitFork,
  Keyboard,
  ListChecks,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  MessagesSquare,
  Minimize2,
  Moon,
  Network,
  PanelLeft,
  Pin,
  RefreshCw,
  Search,
  Server,
  Settings,
  Sparkles,
  SquarePen,
  SquareTerminal,
  Store,
  Sun,
  Target,
  Type,
  WandSparkles,
  Wrench
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { selectableModels } from '@shared/provider-models'
import { FONT_SCALE_PRESETS, nearestFontStepIndex } from '@shared/font-scale'
import { isSideSessionKey } from '@shared/types'
import { draftKeyOf, useAppStore } from '../store/useAppStore'
import { collectProjects, sortProjects } from '../lib/projects'
import { liveConversationRows } from '../lib/live-sessions'
import { basename, samePath } from '../lib/path'
import { sessionIndicator, type SessionIndicator } from '../lib/session-indicator'
import { formatPlatformShortcut, keysFor, type ShortcutId } from '../lib/shortcuts'
import { COMMAND_SOURCE } from '../lib/command-source'
import { transcriptOf } from '../lib/thread'
import { useT } from '../lib/i18n'
import { useDialogFocus } from '../hooks/useDialogFocus'

/** One thing the user can do from the launcher. */
export interface LauncherAction {
  id: string
  title: string
  /** Preserve literal user-owned titles (conversations, projects) instead of running through i18n. */
  literal?: boolean
  /** Optional attention state shown on the row icon. */
  indicator?: SessionIndicator
  /** The reason for the action, or the keys that trigger it. */
  hint?: string
  group: string
  icon: LucideIcon
  run: () => void | Promise<void>
}

/** MCode's text sizes (UI base 12 / 14 / 15 / 16) live in the shared
 *  font-scale module so this launcher and Settings cannot drift. */

const MESSAGE_ACTION_IDS = new Set([
  'rename',
  'duplicate',
  'tree',
  'copy-conversation',
  'export',
  'compact',
  'pin'
])

/**
 * The pins a conversation without any reads as.
 *
 * It is a module constant, not a literal in the selector: `pinnedSessions` is
 * absent until the first pin, and `?? []` would hand Zustand a fresh array on
 * every store update — the launcher would then re-render for every streamed
 * token even though nothing it shows changed.
 */
const NO_PINS: readonly string[] = []

/** The parts of the app shell the launcher drives. */
export interface LauncherShell {
  sidebarOpen: boolean
  toggleSidebar: () => void
  openSettings: () => void
  openShortcuts: () => void
  openMarketplace: () => void
}

/**
 * Collect everything the launcher can do.
 *
 * The app's own commands live in the store already, so they are run from
 * there; the rest needs the shell, which only the app knows.
 */
export function useLauncherActions(shell: LauncherShell): LauncherAction[] {
  const runAppCommand = useAppStore((state) => state.runAppCommand)
  const selectSession = useAppStore((state) => state.selectSession)
  const switchProject = useAppStore((state) => state.switchProject)
  const openProjectDialog = useAppStore((state) => state.openProjectDialog)
  const cycleModel = useAppStore((state) => state.cycleModel)
  const cycleThinkingLevel = useAppStore((state) => state.cycleThinkingLevel)
  const setAgentMode = useAppStore((state) => state.setAgentMode)
  const agentMode = useAppStore((state) => state.agentMode)
  const togglePin = useAppStore((state) => state.togglePin)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const workspaces = useAppStore((state) => state.settings.workspaces)
  const hiddenProjects = useAppStore((state) => state.settings.hiddenProjects)
  const projectOrder = useAppStore((state) => state.settings.projectOrder)
  const archivedSessions = useAppStore((state) => state.settings.archivedSessions)
  const sessions = useAppStore((state) => state.sessions)
  // The palette is built from the same live rows the sidebar lists, but it must
  // not re-render once per streamed frame: `threads` gets a new identity on every
  // painted delta. The metadata counter is what the sidebar subscribes to for
  // exactly this reason, so the snapshot below changes only when a conversation's
  // own mark (streaming / notice / waiting dialog / first prompt) does.
  const threadsMetaVersion = useAppStore((state) => state.threadsMetaVersion)
  const threads = useMemo(() => useAppStore.getState().threads, [threadsMetaVersion])
  const sessionNotices = useAppStore((state) => state.sessionNotices)
  const workspace = useAppStore((state) => state.workspace)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const activeKey = useAppStore((state) => draftKeyOf(state))
  const t = useT()
  const hasMessages = useAppStore((state) => state.items.length > 0)
  const hasForkTarget = useAppStore((state) => state.forkTargets.length > 0)
  const hasAssistantAnswer = useAppStore((state) =>
    state.items.some(
      (item) =>
        item.kind === 'assistant' &&
        item.blocks.some((block) => block.type === 'text' && Boolean(block.text.trim()))
    )
  )
  const pinned = useAppStore((state) => state.settings.pinnedSessions ?? NO_PINS)
  const threadModels = useAppStore((state) => state.models)
  const catalogModels = useAppStore((state) => state.catalogModels)
  const disabledModelSpecs = useAppStore((state) => state.disabledModelSpecs)
  const models = useMemo(
    () => selectableModels(threadModels, catalogModels, disabledModelSpecs),
    [threadModels, catalogModels, disabledModelSpecs]
  )
  const thinkingLevels = useAppStore((state) => state.thinkingLevels)
  const fontScale = useAppStore((state) => state.settings.fontScale ?? 1)
  const shortcutBindings = useAppStore((state) => state.settings.shortcutBindings)
  const showToast = useAppStore((state) => state.showToast)
  // The hint follows the binding the user recorded, so the palette never
  // advertises a key the app no longer listens for.
  const chordOf = (id: ShortcutId) => keysFor(id, shortcutBindings).join('+')

  // The theme that is on screen, which is what the reader sees — the setting
  // itself may still be "follow the system".
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  // Snap legacy or odd stored values to a preset first; findIndex alone
  // returned -1 for an old 0.92 and inverted the two font actions.
  const fontIndex = nearestFontStepIndex(fontScale)
  const biggerFont = FONT_SCALE_PRESETS[(fontIndex + 1) % FONT_SCALE_PRESETS.length]
  const smallerFont =
    FONT_SCALE_PRESETS[(fontIndex - 1 + FONT_SCALE_PRESETS.length) % FONT_SCALE_PRESETS.length]

  const actions: LauncherAction[] = [
    {
      id: 'new',
      title: 'Start a new conversation',
      hint: chordOf('new-chat'),
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
      hint: chordOf('session-tree'),
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
      id: 'export-markdown',
      title: 'Export this conversation as Markdown',
      group: 'Conversation',
      icon: FileText,
      run: () => runAppCommand('export-md')
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
      hint: models.length > 1 ? chordOf('next-model') : undefined,
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
      hint: thinkingLevels.length > 1 ? chordOf('next-thinking') : undefined,
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
      id: 'mode-plan',
      title: agentMode === 'plan' ? 'Leave Plan Mode' : 'Use Plan Mode',
      group: 'Mode',
      icon: ListChecks,
      run: () => setAgentMode(agentMode === 'plan' ? 'default' : 'plan')
    },
    {
      id: 'mode-goal',
      title: agentMode === 'goal' ? 'Leave Goal Mode' : 'Use Goal Mode',
      group: 'Mode',
      icon: Target,
      run: () => setAgentMode(agentMode === 'goal' ? 'default' : 'goal')
    },
    {
      id: 'mode-swarm',
      title: agentMode === 'swarm' ? 'Leave Swarm Mode' : 'Use Swarm Mode',
      group: 'Mode',
      icon: Network,
      run: () => setAgentMode(agentMode === 'swarm' ? 'default' : 'swarm')
    },
    {
      id: 'mode-plugin',
      title: agentMode === 'plugin' ? 'Leave Plugin Mode' : 'Use Plugin Mode',
      group: 'Mode',
      icon: Wrench,
      run: () => setAgentMode(agentMode === 'plugin' ? 'default' : 'plugin')
    },
    {
      id: 'mode-image',
      title: 'Image generation',
      group: 'Mode',
      icon: WandSparkles,
      run: () => runAppCommand('image')
    },
    {
      id: 'open-project',
      title: 'Open another project…',
      group: 'Project',
      icon: FolderOpen,
      run: () => openProjectDialog({ mode: 'create' })
    },
    {
      id: 'sidebar',
      title: shell.sidebarOpen ? 'Hide the sidebar' : 'Show the sidebar',
      hint: chordOf('toggle-sidebar'),
      group: 'View',
      icon: PanelLeft,
      run: () => shell.toggleSidebar()
    },
    {
      id: 'side-chat',
      title: 'Toggle side chat',
      hint: chordOf('toggle-side-chat'),
      group: 'View',
      icon: MessagesSquare,
      run: () => runAppCommand('side')
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
      hint: chordOf('toggle-terminal'),
      group: 'View',
      icon: SquareTerminal,
      run: () => runAppCommand('terminal')
    },
    {
      id: 'restart-runtime',
      title: 'Restart the Pi runtime',
      group: 'Project',
      icon: RefreshCw,
      run: () => {
        if (workspace) void useAppStore.getState().openWorkspace(workspace, undefined, 'runtime-restart')
      }
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
      hint: chordOf('shortcut-list'),
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
      id: 'marketplace',
      title: 'Plugin and skill marketplace',
      group: 'View',
      icon: Store,
      run: () => shell.openMarketplace()
    },
    {
      id: 'settings',
      title: 'Settings',
      group: 'View',
      icon: Settings,
      hint: chordOf('open-settings'),
      run: () => shell.openSettings()
    }
  ]

  // Active & attention conversations (blocked on input, running, failed, unread)
  // sit right at the top of the launcher so concurrent background work is one
  // Ctrl/Cmd+Shift+P + Enter away; recent idle conversations appear below View.
  const attentionRank: Record<SessionIndicator, number> = {
    'needs-input': 4,
    running: 3,
    error: 2,
    unread: 1,
    idle: 0
  }
  const archived = new Set(archivedSessions ?? [])
  const sideParentByKey = useAppStore.getState().sideParentByKey
  const liveRows = liveConversationRows(sessions, threads, workspace?.path)
  const seenSessions = new Set<string>()
  const sessionEntries: Array<{
    session: (typeof liveRows)[number]
    indicator: SessionIndicator
    rank: number
  }> = []
  for (const row of [
    ...liveRows,
    ...sessions.map((session) => ({ ...session, onDisk: true }))
  ]) {
    if (
      !row.file ||
      row.file === activeKey ||
      seenSessions.has(row.file) ||
      isSideSessionKey(row.file) ||
      row.file in sideParentByKey
    ) continue
    seenSessions.add(row.file)
    const thread = threads[row.file]
    const indicator = sessionIndicator({
      isStreaming: Boolean(thread?.isStreaming),
      notice: thread?.notice ?? sessionNotices[row.file],
      needsInput: Boolean(thread?.uiRequest || thread?.uiRequests?.length)
    })
    if (archived.has(row.file) && indicator === 'idle') continue
    sessionEntries.push({
      session: row,
      indicator,
      rank: attentionRank[indicator]
    })
  }
  sessionEntries.sort(
    (a, b) => b.rank - a.rank || b.session.updatedAt - a.session.updatedAt
  )

  const toSessionAction = (
    entry: (typeof sessionEntries)[number],
    group: string
  ): LauncherAction => {
    const { session, indicator } = entry
    const folder = session.cwd ? basename(session.cwd) : t('Chats without a project')
    const statusText =
      indicator === 'needs-input'
        ? t('Needs input')
        : indicator === 'running'
          ? t('Running')
          : indicator === 'error'
            ? t('The last run failed')
            : indicator === 'unread'
              ? t('Unread')
              : ''
    const icon: LucideIcon =
      indicator === 'needs-input' || indicator === 'error'
        ? AlertCircle
        : indicator === 'running'
          ? Loader2
          : MessageSquare
    return {
      id: `session:${session.file}`,
      title: session.name || session.preview || t('Untitled session'),
      literal: true,
      indicator: indicator !== 'idle' ? indicator : undefined,
      hint: statusText ? `${statusText} · ${folder}` : folder,
      group,
      icon,
      run: () => selectSession(session, 'launcher-session')
    }
  }

  const attentionActions = sessionEntries
    .filter((entry) => entry.rank > 0)
    .map((entry) => toSessionAction(entry, 'Active conversations'))
  const recentSessionActions = sessionEntries
    .filter((entry) => entry.rank === 0)
    .slice(0, 5)
    .map((entry) => toSessionAction(entry, 'Recent conversations'))

  actions.push(...recentSessionActions)

  // The projects come last, so the actions are what the user sees first.
  const projects = sortProjects(
    collectProjects(workspaces, sessions, hiddenProjects, projectOrder),
    workspace?.path
  ).filter((project) => !workspace || !samePath(project.path, workspace.path))
  for (const project of projects) {
    actions.push({
      id: `project:${project.path}`,
      title: project.name,
      literal: true,
      hint: project.path,
      group: 'Projects',
      icon: FolderOpen,
      run: async () => { await switchProject(project.path, { allowWhileRunning: true }) }
    })
  }

  // Keep the palette focused on actions the open session can currently perform.
  const filtered = actions.filter((action) => {
    if (action.id === 'branch') return hasMessages && hasForkTarget
    if (action.id === 'copy') return hasAssistantAnswer
    if (action.id === 'restart-runtime') return Boolean(workspace)
    if (action.id === 'model-next' || action.id === 'model-previous') return models.length > 1
    if (action.id === 'thinking-next' || action.id === 'thinking-previous') {
      return thinkingLevels.length > 1
    }
    return !MESSAGE_ACTION_IDS.has(action.id) || hasMessages
  })
  return attentionActions.length > 0 ? [...attentionActions, ...filtered] : filtered
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

export function LauncherDialog({
  shell,
  onClose
}: {
  shell: LauncherShell
  onClose: () => void
}) {
  const actions = useLauncherActions(shell)
  return <Launcher actions={actions} onClose={onClose} />
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
  const dialogRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const commands = useAppStore((state) => state.commands)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const platform = useAppStore((state) => state.info?.platform)
  const t = useT()

  useDialogFocus(dialogRef, onClose)

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
    // A composing IME uses Enter to commit the candidate and the arrow keys to
    // pick one; acting on them would run commands while the reader is typing.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
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
      <div
        ref={dialogRef}
        className="launcher"
        role="dialog"
        aria-modal="true"
        aria-label={t('Command palette')}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="launcher__search">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder={t('Search for an action, a command or a project')}
            aria-label={t('Search for an action, a command or a project')}
            aria-describedby="launcher-keyboard-help"
            aria-autocomplete="list"
            aria-expanded={true}
            aria-controls="launcher-results"
            aria-activedescendant={
              visible[index] ? `launcher-option-${visible[index].position}` : undefined
            }
            role="combobox"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        <div className="launcher__list" ref={listRef}>
          <div id="launcher-results" role="listbox" aria-label={t('Search results')}>
            {visible.length > 0
              ? groups.map((group) => (
                <div
                  className="launcher__group"
                  key={group.name}
                  role="group"
                  aria-label={t(group.name)}
                >
                  <div className="launcher__group-title" aria-hidden="true">
                    {t(group.name)}
                  </div>
                  {group.items.map((entry) => {
                    const Icon = entry.action.icon
                    const hasDescription =
                      entry.action.group === 'Pi' ||
                      entry.action.group === 'Projects' ||
                      entry.action.group === 'Active conversations' ||
                      entry.action.group === 'Recent conversations'
                    return (
                      <button
                        key={entry.action.id}
                        id={`launcher-option-${entry.position}`}
                        className="launcher__item"
                        data-active={entry.position === index}
                        data-kind={entry.action.group === 'Pi' ? 'command' : undefined}
                        data-indicator={entry.action.indicator}
                        data-has-hint={Boolean(entry.action.hint)}
                        data-hint-kind={hasDescription ? 'description' : 'shortcut'}
                        role="option"
                        aria-selected={entry.position === index}
                        tabIndex={-1}
                        onMouseEnter={() => setIndex(entry.position)}
                        onClick={() => run(entry)}
                      >
                        <span className="palette__icon">
                          <Icon
                            size={12}
                            className={entry.action.indicator === 'running' ? 'spin' : undefined}
                          />
                        </span>
                        <span className="launcher__name">
                          {entry.action.literal ? entry.action.title : t(entry.action.title)}
                        </span>
                        <span className="launcher__hint">
                          {entry.action.hint
                            ? hasDescription
                              ? entry.action.hint
                              : formatPlatformShortcut(entry.action.hint, platform)
                            : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
                ))
              : null}
          </div>
          {visible.length === 0 ? (
            <div className="palette__empty" role="status" aria-live="polite">
              {t('Nothing matches')} “{query}”.
              <br />
              {t('Try new, model, files, a skill or the name of a project.')}
            </div>
          ) : null}
        </div>

        <div className="palette__foot" id="launcher-keyboard-help">
          <kbd>↑</kbd>
          <span>{t('or')}</span>
          <kbd>↓</kbd>
          <span>{t('to move')}</span>
          <kbd>↵</kbd>
          <span>{t('to run')}</span>
          <kbd>Esc</kbd>
          <span>{t('to dismiss')}</span>
        </div>
      </div>
    </div>
  )
}

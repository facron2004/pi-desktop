import { useEffect, useMemo, useState } from 'react'
import {
  ArrowUpRight,
  FolderOpen,
  GitBranch,
  Keyboard,
  Lightbulb,
  MessageSquare,
  Terminal,
  Wand2
} from 'lucide-react'
import { formatRelativeTime } from '../lib/format'
import { formatPlatformShortcut } from '../lib/shortcuts'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'

const STARTERS = [
  {
    icon: Wand2,
    title: 'Review this codebase',
    body: 'Give me a tour of the project: structure, key modules, and how to run it.'
  },
  {
    icon: GitBranch,
    title: 'Plan a change',
    body: 'Read the repository and propose an implementation plan for the feature I describe.'
  },
  {
    icon: Lightbulb,
    title: 'Suggest an improvement',
    body: 'Find one small change that would make this project easier to use, and explain why.'
  }
]

/** How many past conversations the empty state offers to resume. */
const RECENT_LIMIT = 4

/**
 * The kind of project the folder holds, so the empty state can offer
 * something that fits it.
 */
type ProjectKind = 'node' | 'python' | 'rust' | 'go' | 'unknown'

/**
 * Read the package manifest before offering a test-suite starter.
 *
 * The read is cheap and keeps the empty state from suggesting `npm test`
 * when the project has no test script.
 */
async function detectKind(root: string): Promise<ProjectKind> {
  const has = async (name: string) => Boolean(await window.pi.fs.read(`${root}/${name}`))
  const packageJson = await window.pi.fs.read(`${root}/package.json`)
  if (packageJson) {
    try {
      const manifest = JSON.parse(packageJson.content) as { scripts?: Record<string, unknown> }
      const testScript = manifest.scripts?.test
      if (
        typeof testScript === 'string' &&
        testScript.trim() &&
        !/no test specified/i.test(testScript)
      ) {
        return 'node'
      }
    } catch {
      // A malformed manifest cannot confirm that an npm test command exists.
    }
  }
  if (await has('pyproject.toml') || (await has('requirements.txt'))) return 'python'
  if (await has('Cargo.toml')) return 'rust'
  if (await has('go.mod')) return 'go'
  return 'unknown'
}

/** The starter that fits the project, and the one it pushes down. */
function startersFor(kind: ProjectKind): typeof STARTERS {
  if (kind === 'unknown') return STARTERS
  return [
    {
      icon: Terminal,
      title: 'Run the tests',
      body: 'Run the test suite of this project and tell me what fails.'
    },
    STARTERS[0],
    STARTERS[1]
  ]
}

export function Welcome({ onPick }: { onPick: () => void }) {
  const workspace = useAppStore((state) => state.workspace)
  const status = useAppStore((state) => state.status.phase)
  const error = useAppStore((state) => state.error)
  const send = useAppStore((state) => state.send)
  const sessions = useAppStore((state) => state.sessions)
  const settings = useAppStore((state) => state.settings)
  const activeSessionFile = useAppStore((state) => state.activeSessionFile)
  const selectSession = useAppStore((state) => state.selectSession)
  const platform = useAppStore((state) => state.info?.platform)
  const t = useT()

  // The conversations of this project, most recent first. Resuming one from
  // here saves a trip through the sidebar. A pinned conversation comes
  // first, because the user marked it as worth returning to.
  const recent = useMemo(() => {
    if (!workspace) return []
    const pinned = new Set(settings.pinnedSessions ?? [])
    return sessions
      .filter((session) => session.cwd === workspace.path && session.file !== activeSessionFile)
      .sort((a, b) => {
        const left = pinned.has(a.file) ? 1 : 0
        const right = pinned.has(b.file) ? 1 : 0
        if (left !== right) return right - left
        return b.updatedAt - a.updatedAt
      })
      .slice(0, RECENT_LIMIT)
  }, [sessions, workspace, activeSessionFile, settings.pinnedSessions])

  // The starters that fit the project the user opened.
  const [kind, setKind] = useState<ProjectKind>('unknown')
  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    void detectKind(workspace.path).then((found) => {
      if (!cancelled) setKind(found)
    })
    return () => {
      cancelled = true
    }
  }, [workspace])
  const starters = useMemo(() => startersFor(kind), [kind])

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <h1 className="welcome__title">
          {workspace ? `${t('Let’s build')} ${workspace.name}` : t('Start a new project')}
        </h1>
        <p className="welcome__subtitle">
          {workspace
            ? t('Choose a task to get started, or describe what you want to build.')
            : t('Choose a project folder and start a task with Pi.')}
        </p>

        {workspace ? (
          <div className="welcome__cards">
            {starters.map((starter) => (
              <button
                className="welcome__card"
                key={starter.title}
                onClick={() => void send(t(starter.body), [])}
              >
                <div className="welcome__card-top">
                  <span className="welcome__card-icon" aria-hidden="true">
                    <starter.icon size={16} />
                  </span>
                  <ArrowUpRight className="welcome__card-arrow" size={15} aria-hidden="true" />
                </div>
                <div className="welcome__card-title">
                  {t(starter.title)}
                </div>
                <div className="welcome__card-body">{t(starter.body)}</div>
              </button>
            ))}
          </div>
        ) : (
          <button className="btn btn--primary" style={{ marginTop: 20 }} onClick={onPick}>
            <FolderOpen size={14} />
            {t('Open project folder')}
          </button>
        )}

        {error ? (
          <div className="welcome__error">
            <strong>{t('Pi could not start.')}</strong>
            <br />
            {error}
          </div>
        ) : null}

        {recent.length > 0 ? (
          <div className="welcome__recent">
            <div className="welcome__recent-head">
              <span>{t('Recent conversations')}</span>
            </div>
            <div className="welcome__recent-list">
              {recent.map((session) => (
                <button
                  className="welcome__recent-item"
                  key={session.file}
                  onClick={() => void selectSession(session)}
                  title={session.name || session.preview || session.file}
                >
                  <MessageSquare size={13} />
                  <span className="welcome__recent-title">
                    {session.name || session.preview || t('Untitled session')}
                  </span>
                  <span className="welcome__recent-meta">
                    {formatRelativeTime(session.updatedAt, settings.language)}
                    {session.messageCount
                      ? ` · ${session.messageCount} ${session.messageCount === 1 ? t('msg') : t('msgs')}`
                      : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {status === 'starting' ? (
          <div className="welcome__pending">
            <span className="spinner" />
            <span>{t('Starting the Pi runtime…')}</span>
          </div>
        ) : null}

        <div className="welcome__hints">
          <span>
            <kbd>/</kbd> {t('commands')}
          </span>
          <span>
            <kbd>{formatPlatformShortcut('Ctrl', platform)}</kbd>
            <kbd>Shift</kbd>
            <kbd>P</kbd> {t('everything')}
          </span>
          <span>
            <kbd>{formatPlatformShortcut('Ctrl', platform)}</kbd>
            <kbd>K</kbd> {t('focus composer')}
          </span>
          <button
            className="ghost-btn"
            onClick={() => window.dispatchEvent(new CustomEvent('pi:show-shortcuts'))}
          >
            <Keyboard size={12} />
            {t('All shortcuts')}
          </button>
        </div>
      </div>
    </div>
  )
}

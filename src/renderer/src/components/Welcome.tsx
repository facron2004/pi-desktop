import { FolderOpen, GitBranch, Terminal, Wand2 } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'

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
    icon: Terminal,
    title: 'Fix a failing test',
    body: 'Run the test suite, find what breaks, and fix the root cause.'
  }
]

export function Welcome({ onPick }: { onPick: () => void }) {
  const workspace = useAppStore((state) => state.workspace)
  const status = useAppStore((state) => state.status.phase)
  const error = useAppStore((state) => state.error)
  const send = useAppStore((state) => state.send)

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <div className="welcome__logo">π</div>
        <h1 className="welcome__title">
          {workspace ? `Working in ${workspace.name}` : 'Pi Desktop'}
        </h1>
        <p className="welcome__subtitle">
          {workspace
            ? 'Describe a task and Pi will explore the project, run commands and edit files. Everything it does is shown inline below.'
            : 'Choose a project folder to give Pi a working directory. Pi runs there with your own permissions.'}
        </p>

        {workspace ? (
          <div className="welcome__cards">
            {STARTERS.map((starter) => (
              <button
                className="welcome__card"
                key={starter.title}
                onClick={() => void send(starter.body, [])}
              >
                <div className="welcome__card-title">
                  <starter.icon size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
                  {starter.title}
                </div>
                <div className="welcome__card-body">{starter.body}</div>
              </button>
            ))}
          </div>
        ) : (
          <button className="btn btn--primary" style={{ marginTop: 20 }} onClick={onPick}>
            <FolderOpen size={14} />
            Open project folder
          </button>
        )}

        {error ? (
          <div className="welcome__error">
            <strong>Pi could not start.</strong>
            <br />
            {error}
          </div>
        ) : null}

        {status === 'starting' ? (
          <div className="welcome__error" style={{ borderColor: 'var(--border)', background: 'transparent', color: 'var(--text-muted)' }}>
            Starting the Pi runtime…
          </div>
        ) : null}
      </div>
    </div>
  )
}

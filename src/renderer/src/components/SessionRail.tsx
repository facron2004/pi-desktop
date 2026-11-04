import type { Turn } from '../lib/turns'
import type { UserItem } from '../lib/thread'
import { useT } from '../lib/i18n'
import '../styles/session-rail.css'

interface SessionRailProps {
  turns: (Turn & { user: UserItem })[]
  activeTurnId: string | null
  onSelect: (turnId: string) => void
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function SessionRail({ turns, activeTurnId, onSelect }: SessionRailProps) {
  const t = useT()
  const railHeight = Math.min(96, turns.length * 12 + (turns.length - 1) * 2 + 8)

  return (
    <aside
      className="session-rail"
      aria-label={t('Turns')}
      style={{ height: `min(${railHeight}px, 50%)` }}
    >
      <div className="session-rail__track">
        {turns.map((turn, index) => {
          const prompt = oneLine(turn.user.text) || t('Untitled session')
          const response = oneLine(
            turn.assistants
              .flatMap((assistant) =>
                assistant.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
              )
              .join(' ')
          )
          const active = turn.id === activeTurnId
          const tooltipId = `session-turn-${index}`

          return (
            <button
              key={turn.id}
              type="button"
              className="session-rail__marker"
              data-active={active || undefined}
              aria-label={`${index + 1}: ${prompt}`}
              aria-current={active ? 'location' : undefined}
              aria-describedby={tooltipId}
              onClick={() => onSelect(turn.id)}
            >
              <span
                className="session-rail__tick"
                style={{ animationDelay: `${(index % 8) * 75}ms` }}
                aria-hidden="true"
              />
              <span className="session-rail__popup" id={tooltipId} role="tooltip">
                <span className="session-rail__prompt">{prompt}</span>
                {response ? (
                  <span className="session-rail__response">{response}</span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}

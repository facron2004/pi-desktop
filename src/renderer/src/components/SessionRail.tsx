import { memo } from 'react'
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

interface MarkerProps {
  turn: Turn & { user: UserItem }
  index: number
  active: boolean
  onSelect: (turnId: string) => void
}

/**
 * One tick on the rail.
 *
 * A streamed delta rebuilds only the live turn object; every finished turn is
 * the same reference, so its marker (and the full-text tooltip it computes)
 * stays untouched while another answer is being written.
 */
const SessionRailMarker = memo(function SessionRailMarker({
  turn,
  index,
  active,
  onSelect
}: MarkerProps) {
  const t = useT()
  const prompt = oneLine(turn.user.text) || t('Untitled session')
  const response = oneLine(
    turn.assistants
      .flatMap((assistant) =>
        assistant.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
      )
      .join(' ')
  )
  const tooltipId = `session-turn-${index}`

  return (
    <button
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
        {response ? <span className="session-rail__response">{response}</span> : null}
      </span>
    </button>
  )
})

function sameTurns(left: SessionRailProps['turns'], right: SessionRailProps['turns']): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export const SessionRail = memo(
  function SessionRail({ turns, activeTurnId, onSelect }: SessionRailProps) {
    const t = useT()
    const railHeight = Math.min(96, turns.length * 12 + (turns.length - 1) * 2 + 8)

    return (
      <aside
        className="session-rail"
        aria-label={t('Turns')}
        style={{ height: `min(${railHeight}px, 50%)` }}
      >
        <div className="session-rail__track">
          {turns.map((turn, index) => (
            <SessionRailMarker
              key={turn.id}
              turn={turn}
              index={index}
              active={turn.id === activeTurnId}
              onSelect={onSelect}
            />
          ))}
        </div>
      </aside>
    )
  },
  (previous, next) =>
    previous.activeTurnId === next.activeTurnId &&
    previous.onSelect === next.onSelect &&
    sameTurns(previous.turns, next.turns)
)

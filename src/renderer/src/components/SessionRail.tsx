import { memo, useMemo } from 'react'
import type { Turn } from '../lib/turns'
import type { UserItem } from '../lib/thread'
import { useT } from '../lib/i18n'
import '../styles/session-rail.css'

const MAX_SESSION_RAIL_PREVIEW_CHARS = 240
const MAX_SESSION_RAIL_PREVIEW_BLOCKS = 128

interface SessionRailProps {
  turns: (Turn & { user: UserItem })[]
  activeTurn: Turn & { user: UserItem }
  activeTurnId: string | null
  onSelect: (turnId: string) => void
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function oneLinePreview(text: string, truncated = false): string {
  const normalized = oneLine(text.slice(0, MAX_SESSION_RAIL_PREVIEW_CHARS + 1))
  if (!normalized) return ''
  if (truncated || normalized.length > MAX_SESSION_RAIL_PREVIEW_CHARS) {
    return `${normalized.slice(0, MAX_SESSION_RAIL_PREVIEW_CHARS).trimEnd()}…`
  }
  return normalized
}

const responsePreviewCache = new WeakMap<Turn, string>()

function responsePreview(turn: Turn): string {
  const cached = responsePreviewCache.get(turn)
  if (cached !== undefined) return cached
  let text = ''
  let inspectedBlocks = 0
  let truncated = false

  for (const assistant of turn.assistants) {
    for (const block of assistant.blocks) {
      inspectedBlocks += 1
      if (inspectedBlocks > MAX_SESSION_RAIL_PREVIEW_BLOCKS) {
        truncated = true
        break
      }
      if (block.type !== 'text' || !block.text) continue

      const separator = text ? ' ' : ''
      const available = MAX_SESSION_RAIL_PREVIEW_CHARS + 1 - text.length - separator.length
      if (available <= 0) {
        truncated = true
        break
      }
      const part = block.text.slice(0, available)
      text += separator + part
      if (part.length < block.text.length) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }

  const preview = oneLinePreview(text, truncated)
  responsePreviewCache.set(turn, preview)
  return preview
}

interface MarkerProps {
  turn: Turn & { user: UserItem }
  index: number
  active: boolean
  /** The rail is one keyboard stop: only the reader's current tick takes it. */
  tabStop: boolean
  onSelect: (turnId: string) => void
}

/**
 * One tick on the rail.
 *
 * A streamed delta rebuilds only the live turn object; every finished turn is
 * the same reference, so its marker stays untouched while another answer is
 * being written. Tooltip text is bounded to keep a long live answer cheap.
 */
const SessionRailMarker = memo(function SessionRailMarker({
  turn,
  index,
  active,
  tabStop,
  onSelect
}: MarkerProps) {
  const t = useT()
  const prompt = useMemo(
    () => oneLinePreview(
      turn.user.text,
      turn.user.text.length > MAX_SESSION_RAIL_PREVIEW_CHARS
    ) || t('Untitled session'),
    [turn.user, t]
  )
  const response = responsePreview(turn)
  const tooltipId = `session-turn-${index}`

  return (
    <button
      type="button"
      className="session-rail__marker"
      data-rail-marker
      tabIndex={tabStop ? 0 : -1}
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

type SessionRailHistoryProps = Pick<SessionRailProps, 'turns' | 'activeTurnId' | 'onSelect'> & {
  /** Index of the tick that owns the rail's single Tab stop. */
  stopIndex: number
}

const SessionRailHistory = memo(function SessionRailHistory({
  turns,
  activeTurnId,
  onSelect,
  stopIndex
}: SessionRailHistoryProps) {
  return <>
    {turns.slice(0, -1).map((turn, index) => (
      <SessionRailMarker
        key={turn.id}
        turn={turn}
        index={index}
        active={turn.id === activeTurnId}
        tabStop={index === stopIndex}
        onSelect={onSelect}
      />
    ))}
  </>
}, (previous, next) =>
  previous.turns === next.turns &&
  previous.activeTurnId === next.activeTurnId &&
  previous.stopIndex === next.stopIndex &&
  previous.onSelect === next.onSelect
)

export const SessionRail = memo(
  function SessionRail({ turns, activeTurn, activeTurnId, onSelect }: SessionRailProps) {
    const t = useT()
    const railHeight = Math.min(96, turns.length * 12 + (turns.length - 1) * 2 + 8)
    // One Tab stop for the whole rail: the reader's current turn, or the first
    // tick when nothing is marked. Arrows move it with the keyboard.
    const stopIndex = Math.max(0, turns.findIndex((turn) => turn.id === activeTurnId))

    return (
      <aside
        className="session-rail"
        aria-label={t('Turns')}
        style={{ height: `min(${railHeight}px, 50%)` }}
        onKeyDown={(event) => {
          // The rail is one vertical keyboard column: the arrows walk its
          // turn ticks, Home/End jump to the ends. Each tick is a button, so
          // Enter still jumps to that turn.
          if (event.altKey || event.ctrlKey || event.metaKey) return
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          const target = event.target
          if (!(target instanceof HTMLElement) || !target.matches('[data-rail-marker]')) return
          const markers = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-rail-marker]')]
          const index = markers.indexOf(target)
          if (index < 0) return
          event.preventDefault()
          const move = (next: HTMLElement | undefined) => {
            if (!next || next === target) return
            target.tabIndex = -1
            next.tabIndex = 0
            next.focus()
          }
          if (event.key === 'Home') {
            move(markers[0])
          } else if (event.key === 'End') {
            move(markers[markers.length - 1])
          } else if (event.key === 'ArrowDown') {
            if (index < markers.length - 1) move(markers[index + 1])
          } else if (index > 0) {
            move(markers[index - 1])
          }
        }}
      >
        <div className="session-rail__track">
          <SessionRailHistory
            turns={turns}
            activeTurnId={activeTurnId}
            onSelect={onSelect}
            stopIndex={stopIndex}
          />
          <SessionRailMarker
            turn={activeTurn}
            index={turns.length - 1}
            active={activeTurn.id === activeTurnId}
            tabStop={stopIndex === turns.length - 1}
            onSelect={onSelect}
          />
        </div>
      </aside>
    )
  },
  (previous, next) =>
    previous.turns === next.turns &&
    previous.activeTurnId === next.activeTurnId &&
    previous.onSelect === next.onSelect &&
    (previous.activeTurn === next.activeTurn ||
      (previous.activeTurn.id === next.activeTurn.id &&
        previous.activeTurn.user === next.activeTurn.user &&
        responsePreview(previous.activeTurn) === responsePreview(next.activeTurn)))
)

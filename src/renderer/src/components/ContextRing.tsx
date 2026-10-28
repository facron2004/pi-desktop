import { useAppStore } from '../store/useAppStore'
import { formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'
import { ContextPanel } from './ContextPanel'

/**
 * How full the context window is, as a ring.
 *
 * The arc is the whole reading: how much of the window the conversation takes.
 * One colour, the foreground of the control, so the length is what is seen —
 * there is no amber or red state to decode. The percentage is in the label and
 * the numbers are in the panel behind it.
 */
export function ContextRing() {
  const showContextUsage = useAppStore((state) => state.settings.showContextUsage !== false)
  const context = useAppStore((state) => state.stats?.contextUsage)
  const t = useT()

  if (!showContextUsage) return null

  const tokens = context?.tokens ?? 0
  const window = context?.contextWindow ?? 0
  const percent = context?.percent ?? (window > 0 ? (tokens / window) * 100 : 0)
  const clamped = Math.max(0, Math.min(100, percent))
  const known = Boolean(context?.contextWindow)

  const title = known
    ? `${t('Context window')}: ${formatTokens(tokens)} / ${formatTokens(window)} (${Math.round(
        percent
      )}%)`
    : t('Waiting for Pi statistics')

  return (
    <Popover
      placement="top"
      align="right"
      width={290}
      className="context-popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className="context-ring"
          data-empty={known ? undefined : 'true'}
          data-active={open}
          aria-expanded={open}
          aria-label={t('Session details')}
          title={title}
          onClick={toggle}
        >
          <span
            className="context-ring__svg"
            role="img"
            aria-label={`${Math.round(percent)}%`}
          >
            <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
              <circle className="context-ring__track" cx="10" cy="10" r="7.6" />
              <circle
                className="context-ring__value"
                cx="10"
                cy="10"
                r="7.6"
                // Circumference of r=7.6 is ~47.75; the dash offset is what
                // paints the arc, and the rotation starts it at twelve.
                strokeDasharray="47.75"
                strokeDashoffset={47.75 * (1 - clamped / 100)}
              />
            </svg>
          </span>
        </button>
      )}
    >
      {(close) => <ContextPanel close={close} />}
    </Popover>
  )
}

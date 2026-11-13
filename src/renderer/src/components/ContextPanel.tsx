import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { resolveSavedModel } from '@shared/provider-models'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { contextReading } from '../lib/context-reading'

/**
 * The session panel behind the context ring.
 *
 * Every reading goes through `lib/context-reading.ts`: Pi's own
 * `get_session_stats` when a process answers, the transcript's newest usage
 * and the model's window otherwise. It asks once when the panel opens, so a
 * reopened conversation — or one whose first read raced the Pi boot — does not
 * sit on "Waiting for Pi statistics" forever, and it marks the reading source
 * in a tooltip: an estimate must never be presented as Pi's own number.
 */
function formatContextTokens(value: number | null): string {
  if (value === null || Number.isNaN(value)) return '—'
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

function formatBreakdownTokens(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value >= 1_000_000) return `~${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1_000) return `~${Number((value / 1_000).toFixed(1))}K`
  return `~${value}`
}

export function ContextPanel() {
  const stats = useAppStore((state) => state.stats)
  const contextBreakdown = useAppStore((state) => state.contextBreakdown)
  const items = useAppStore((state) => state.items)
  const piState = useAppStore((state) => state.piState)
  const models = useAppStore((state) => state.models)
  const catalogModels = useAppStore((state) => state.catalogModels)
  const savedModel = useAppStore((state) => state.settings.model)
  const savedProvider = useAppStore((state) => state.settings.provider)
  const readSessionStats = useAppStore((state) => state.readSessionStats)
  const t = useT()

  const [reading, setReading] = useState(false)
  // One read at a time, and one on open: StrictMode replays the mount effect,
  // and a re-render must not turn into another `get_session_stats`.
  const inFlight = useRef(false)
  const asked = useRef(false)

  // A conversation with no process has no `piState.model`, so the saved model
  // supplies the window. The live model list wins when Pi has published one;
  // the catalog is what a cold chat has.
  const fallbackModel = useMemo(
    () => resolveSavedModel(savedModel, savedProvider, models.length ? models : catalogModels),
    [savedModel, savedProvider, models, catalogModels]
  )

  const current = useMemo(
    () => contextReading({ stats, items, model: piState?.model, fallbackModel }),
    [stats, items, piState?.model, fallbackModel]
  )

  const refreshReading = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    setReading(true)
    try {
      // Never starts a process; `undefined` simply leaves the transcript
      // reading in place.
      await readSessionStats()
    } finally {
      inFlight.current = false
      setReading(false)
    }
  }, [readSessionStats])

  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void refreshReading()
  }, [refreshReading])

  const clamped = current.percent === null ? 0 : Math.max(0, Math.min(100, current.percent))

  return (
    <div className="ctx">
      <div className="ctx__overview">
        <div className="ctx__head">
          <div className="ctx__headline" role="group" aria-label={t('Context window')}>
            <span className="ctx__title">
              {t('Context used')} <strong className="ctx__percent">
                {current.percent === null ? '—' : `${Math.round(current.percent)}%`}
              </strong>
            </span>
            <span
              className="ctx__total"
              title={t(current.source === 'pi' ? 'From the live session' : 'Estimated from the transcript')}
            >
              {current.tokens === null ? '—' : `~${formatContextTokens(current.tokens)}`}
              {' / '}{formatContextTokens(current.contextWindow)}
            </span>
          </div>
        </div>
        <span className="ctx__bar" aria-hidden="true">
          <span className="ctx__fill" style={{ width: `${clamped}%` }} />
        </span>
        <div
          className="ctx__breakdown"
          role="group"
          aria-label={t('Context breakdown')}
          title={t(contextBreakdown?.source === 'request'
            ? 'Estimated from the provider request; category values are approximate.'
            : 'Estimated from the saved session; category values are approximate.')}
        >
          <div className="ctx__breakdown-row">
            <span className="ctx__swatch" data-kind="system" aria-hidden="true" />
            <span>{t('System prompt')}</span>
            <span className="ctx__breakdown-value">{formatBreakdownTokens(contextBreakdown?.systemPrompt)}</span>
          </div>
          <div className="ctx__breakdown-row">
            <span className="ctx__swatch" data-kind="tools" aria-hidden="true" />
            <span>{t('Tool definitions')}</span>
            <span className="ctx__breakdown-value">{formatBreakdownTokens(contextBreakdown?.toolDefinitions)}</span>
          </div>
          <div className="ctx__breakdown-row">
            <span className="ctx__swatch" data-kind="messages" aria-hidden="true" />
            <span>{t('Conversation messages')}</span>
            <span className="ctx__breakdown-value">
              {formatBreakdownTokens(contextBreakdown?.conversationMessages)}
            </span>
          </div>
        </div>
        {reading ? (
          <p className="ctx__hint" role="status">{t('Reading Pi statistics…')}</p>
        ) : current.tokens === null ? (
          <p className="ctx__hint" role="status">
            {t('Pi has not reported statistics for this conversation yet.')}
          </p>
        ) : null}
      </div>
    </div>
  )
}

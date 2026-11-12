import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, Minimize2, RefreshCw } from 'lucide-react'
import { resolveSavedModel } from '@shared/provider-models'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { contextReading } from '../lib/context-reading'
import { formatCost, formatTokens } from '../lib/format'
import { Switch } from './Switch'

/**
 * The session panel behind the context ring.
 *
 * Every reading goes through `lib/context-reading.ts`: Pi's own
 * `get_session_stats` when a process answers, the transcript's newest usage
 * and the model's window otherwise. The panel used to read only the `stats`
 * that `refreshState` had left behind, so a reopened conversation — or one
 * whose first read raced the Pi boot — sat on "Waiting for Pi statistics"
 * forever with no way to ask again. So it asks on open, offers a refresh, and
 * marks the reading source in a tooltip: an estimate must never be
 * presented as Pi's own number.
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

export function ContextPanel({ close }: { close: () => void }) {
  const stats = useAppStore((state) => state.stats)
  const contextBreakdown = useAppStore((state) => state.contextBreakdown)
  const items = useAppStore((state) => state.items)
  const piState = useAppStore((state) => state.piState)
  const models = useAppStore((state) => state.models)
  const catalogModels = useAppStore((state) => state.catalogModels)
  const savedModel = useAppStore((state) => state.settings.model)
  const savedProvider = useAppStore((state) => state.settings.provider)
  const readSessionStats = useAppStore((state) => state.readSessionStats)
  const compact = useAppStore((state) => state.compact)
  const t = useT()
  const setAutoCompaction = useAppStore((state) => state.setAutoCompaction)
  const setAutoRetry = useAppStore((state) => state.setAutoRetry)
  const setSteeringMode = useAppStore((state) => state.setSteeringMode)
  const setFollowUpMode = useAppStore((state) => state.setFollowUpMode)
  const ready = useAppStore((state) => state.status.phase === 'ready')

  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)
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

  const runCompact = async () => {
    setBusy(true)
    try {
      // A failure leaves the panel open so the reader can retry with the
      // same instructions; the thread banner explains what Pi answered.
      if (await compact(instructions)) {
        setInstructions('')
        close()
      }
    } finally {
      setBusy(false)
    }
  }

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
          <button
            type="button"
            className="icon-btn ctx__refresh"
            aria-label={t('Refresh the reading')}
            title={t('Refresh the reading')}
            disabled={reading}
            onClick={() => void refreshReading()}
          >
            <RefreshCw size={12} className={reading ? 'spin' : undefined} aria-hidden="true" />
          </button>
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

      <details className="ctx__details ctx__more">
        <summary className="ctx__fold">
          {t('More details and controls')}
          <ChevronRight size={12} className="ctx__caret" aria-hidden="true" />
        </summary>
        <div className="ctx__more-body">
          <div className="ctx__summary">
            <div className="ctx__row ctx__row--strong">
              <span>{t('Total tokens')}</span>
              <span>{formatTokens(current.tokensTotal)}</span>
            </div>
            <div className="ctx__row ctx__row--strong">
              <span>{t('Cost')}</span>
              <span>{formatCost(current.cost)}</span>
            </div>
          </div>

          <div className="ctx__compact">
            <div className="popover__label ctx__section">{t('Compact')}</div>
            <input
              className="ctx__input"
              value={instructions}
              placeholder={t('Instructions for the summary (optional)')}
              aria-label={t('Instructions for the summary (optional)')}
              onChange={(event) => setInstructions(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter' && !busy) void runCompact()
              }}
            />
            <button
              className="btn btn--sm ctx__action"
              onClick={() => void runCompact()}
              disabled={!ready || busy}
            >
              <Minimize2 size={13} />
              {busy ? t('Compacting…') : t('Compact now')}
            </button>
          </div>

          <details className="ctx__details">
            <summary className="ctx__fold">
              {t('Usage details')}
              <ChevronRight size={12} className="ctx__caret" aria-hidden="true" />
            </summary>
            <div className="ctx__body ctx__usage">
              <div className="ctx__rows">
                <div className="ctx__row">
                  <span>{t('Input')}</span>
                  <span>{formatTokens(current.input)}</span>
                </div>
                <div className="ctx__row">
                  <span>{t('Output')}</span>
                  <span>{formatTokens(current.output)}</span>
                </div>
                <div className="ctx__row">
                  <span>{t('Cache read')}</span>
                  <span>{formatTokens(current.cacheRead)}</span>
                </div>
                <div className="ctx__row">
                  <span>{t('Cache write')}</span>
                  <span>{formatTokens(current.cacheWrite)}</span>
                </div>
              </div>

              <div className="popover__label ctx__section">{t('Messages')}</div>
              <div className="ctx__rows">
                <div className="ctx__row">
                  <span>{t('Prompts')}</span>
                  <span>{stats?.userMessages ?? '—'}</span>
                </div>
                <div className="ctx__row">
                  <span>{t('Replies')}</span>
                  <span>{stats?.assistantMessages ?? '—'}</span>
                </div>
                <div className="ctx__row">
                  <span>{t('Tool calls')}</span>
                  <span>{stats?.toolCalls ?? '—'}</span>
                </div>
              </div>
        </div>
      </details>

      <details className="ctx__details">
        <summary className="ctx__fold">
          {t('Run settings')}
          <ChevronRight size={12} className="ctx__caret" aria-hidden="true" />
        </summary>
        <div className="ctx__body ctx__settings">
          <div className="popover__label ctx__section">{t('Queued messages')}</div>
          <div className="ctx__rows">
            <div className="ctx__row">
              <span>{t('Steering')}</span>
              <div className="segmented segmented--tight">
                <button
                  data-active={piState?.steeringMode !== 'all'}
                  aria-pressed={piState?.steeringMode !== 'all'}
                  onClick={() => void setSteeringMode('one-at-a-time')}
                  title={t('Deliver one steering message per turn')}
                >
                  {t('One by one')}
                </button>
                <button
                  data-active={piState?.steeringMode === 'all'}
                  aria-pressed={piState?.steeringMode === 'all'}
                  onClick={() => void setSteeringMode('all')}
                  title={t('Deliver every steering message at once')}
                >
                  {t('All at once')}
                </button>
              </div>
            </div>
            <div className="ctx__row">
              <span>{t('Follow-up')}</span>
              <div className="segmented segmented--tight">
                <button
                  data-active={piState?.followUpMode !== 'all'}
                  aria-pressed={piState?.followUpMode !== 'all'}
                  onClick={() => void setFollowUpMode('one-at-a-time')}
                  title={t('Deliver one follow-up message per run')}
                >
                  {t('One by one')}
                </button>
                <button
                  data-active={piState?.followUpMode === 'all'}
                  aria-pressed={piState?.followUpMode === 'all'}
                  onClick={() => void setFollowUpMode('all')}
                  title={t('Deliver every follow-up message at once')}
                >
                  {t('All at once')}
                </button>
              </div>
            </div>
          </div>

          <div className="ctx__toggle">
            <span>
              {t('Compact automatically')}
              <span className="ctx__hint">{t('when the context window fills up')}</span>
            </span>
            <Switch
              checked={piState?.autoCompactionEnabled !== false}
              onChange={(value) => void setAutoCompaction(value)}
              label={t('Compact automatically')}
            />
          </div>

          <div className="ctx__toggle">
            <span>
              {t('Retry automatically')}
              <span className="ctx__hint">{t('on transient provider errors')}</span>
            </span>
            <Switch
              checked={piState?.autoRetryEnabled !== false}
              onChange={(value) => void setAutoRetry(value)}
              label={t('Retry automatically')}
            />
          </div>
        </div>
      </details>
        </div>
      </details>
    </div>
  )
}

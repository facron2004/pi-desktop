import { useState } from 'react'
import { Minimize2 } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { formatCost, formatTokens } from '../lib/format'
import { Switch } from './Switch'

/**
 * The session panel behind the context meter in the top bar.
 *
 * Everything here comes from Pi's own `get_session_stats`, so the numbers are
 * the ones the agent sees rather than a second copy of them.
 */
export function ContextPanel({ close }: { close: () => void }) {
  const stats = useAppStore((state) => state.stats)
  const piState = useAppStore((state) => state.piState)
  const compact = useAppStore((state) => state.compact)
  const t = useT()
  const setAutoCompaction = useAppStore((state) => state.setAutoCompaction)
  const setSteeringMode = useAppStore((state) => state.setSteeringMode)
  const setFollowUpMode = useAppStore((state) => state.setFollowUpMode)
  const ready = useAppStore((state) => state.status.phase === 'ready')

  const [instructions, setInstructions] = useState('')
  const [busy, setBusy] = useState(false)

  const context = stats?.contextUsage
  const tokens = stats?.tokens
  const percent = context?.percent ?? 0
  const level = percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low'

  const runCompact = async () => {
    setBusy(true)
    try {
      await compact(instructions)
      setInstructions('')
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ctx">
      <div className="popover__label">{t('Context window')}</div>
      <div className="ctx__headline">
        <span className="ctx__big">{formatTokens(context?.tokens ?? 0)}</span>
        <span className="ctx__muted"> {t('of')} {formatTokens(context?.contextWindow)}</span>
        {context?.percent !== null && context?.percent !== undefined ? (
          <span className="ctx__muted">· {Math.round(context.percent)}%</span>
        ) : null}
      </div>
      <span className="ctx__bar">
        <span
          className="ctx__fill"
          data-level={level}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </span>

      <div className="popover__label ctx__section">{t('Tokens')}</div>
      <div className="ctx__rows">
        <div className="ctx__row">
          <span>{t('Input')}</span>
          <span>{formatTokens(tokens?.input)}</span>
        </div>
        <div className="ctx__row">
          <span>{t('Output')}</span>
          <span>{formatTokens(tokens?.output)}</span>
        </div>
        <div className="ctx__row">
          <span>{t('Cache read')}</span>
          <span>{formatTokens(tokens?.cacheRead)}</span>
        </div>
        <div className="ctx__row">
          <span>{t('Cache write')}</span>
          <span>{formatTokens(tokens?.cacheWrite)}</span>
        </div>
        <div className="ctx__row ctx__row--strong">
          <span>{t('Total')}</span>
          <span>{formatTokens(tokens?.total)}</span>
        </div>
        <div className="ctx__row ctx__row--strong">
          <span>{t('Cost')}</span>
          <span>{formatCost(stats?.cost)}</span>
        </div>
      </div>

      <div className="popover__label ctx__section">{t('Messages')}</div>
      <div className="ctx__rows">
        <div className="ctx__row">
          <span>{t('Prompts')}</span>
          <span>{stats?.userMessages ?? 0}</span>
        </div>
        <div className="ctx__row">
          <span>{t('Replies')}</span>
          <span>{stats?.assistantMessages ?? 0}</span>
        </div>
        <div className="ctx__row">
          <span>{t('Tool calls')}</span>
          <span>{stats?.toolCalls ?? 0}</span>
        </div>
      </div>

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

      <div className="popover__label ctx__section">{t('Compact')}</div>
      <input
        className="ctx__input"
        value={instructions}
        placeholder={t('Instructions for the summary (optional)')}
        aria-label={t('Instructions for the summary (optional)')}
        onChange={(event) => setInstructions(event.target.value)}
        onKeyDown={(event) => {
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
    </div>
  )
}

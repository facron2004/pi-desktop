import { useState } from 'react'
import { Minimize2 } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
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
  const setAutoCompaction = useAppStore((state) => state.setAutoCompaction)
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
      <div className="popover__label">Context window</div>
      <div className="ctx__headline">
        <span className="ctx__big">{formatTokens(context?.tokens ?? 0)}</span>
        <span className="ctx__muted"> of {formatTokens(context?.contextWindow)}</span>
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

      <div className="popover__label ctx__section">Tokens</div>
      <div className="ctx__rows">
        <div className="ctx__row">
          <span>Input</span>
          <span>{formatTokens(tokens?.input)}</span>
        </div>
        <div className="ctx__row">
          <span>Output</span>
          <span>{formatTokens(tokens?.output)}</span>
        </div>
        <div className="ctx__row">
          <span>Cache read</span>
          <span>{formatTokens(tokens?.cacheRead)}</span>
        </div>
        <div className="ctx__row">
          <span>Cache write</span>
          <span>{formatTokens(tokens?.cacheWrite)}</span>
        </div>
        <div className="ctx__row ctx__row--strong">
          <span>Total</span>
          <span>{formatTokens(tokens?.total)}</span>
        </div>
        <div className="ctx__row ctx__row--strong">
          <span>Cost</span>
          <span>{formatCost(stats?.cost)}</span>
        </div>
      </div>

      <div className="popover__label ctx__section">Messages</div>
      <div className="ctx__rows">
        <div className="ctx__row">
          <span>Prompts</span>
          <span>{stats?.userMessages ?? 0}</span>
        </div>
        <div className="ctx__row">
          <span>Replies</span>
          <span>{stats?.assistantMessages ?? 0}</span>
        </div>
        <div className="ctx__row">
          <span>Tool calls</span>
          <span>{stats?.toolCalls ?? 0}</span>
        </div>
      </div>

      <div className="popover__label ctx__section">Compact</div>
      <input
        className="ctx__input"
        value={instructions}
        placeholder="Instructions for the summary (optional)"
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
        {busy ? 'Compacting…' : 'Compact now'}
      </button>

      <div className="ctx__toggle">
        <span>
          Compact automatically
          <span className="ctx__hint">when the context window fills up</span>
        </span>
        <Switch
          checked={piState?.autoCompactionEnabled !== false}
          onChange={(value) => void setAutoCompaction(value)}
          label="Compact automatically"
        />
      </div>
    </div>
  )
}

import { useMemo } from 'react'
import { ChevronDown, Cpu, FileDiff, Gauge, Minimize2, Sparkles } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { collectChanges } from '../lib/changes'
import { formatTokens } from '../lib/format'
import { Popover } from './Popover'

export function TopBar({ onOpenChanges }: { onOpenChanges: () => void }) {
  const models = useAppStore((state) => state.models)
  const piState = useAppStore((state) => state.piState)
  const thinkingLevels = useAppStore((state) => state.thinkingLevels)
  const stats = useAppStore((state) => state.stats)
  const items = useAppStore((state) => state.items)
  const setModel = useAppStore((state) => state.setModel)
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel)
  const compact = useAppStore((state) => state.compact)
  const ready = useAppStore((state) => state.status.phase === 'ready')

  const changes = useMemo(() => collectChanges(items), [items])

  const currentModel = piState?.model
  const currentLevel = piState?.thinkingLevel
  const context = stats?.contextUsage
  const percent = context?.percent ?? 0
  const level = percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low'

  const providers = Array.from(new Set(models.map((model) => model.provider)))

  return (
    <div className="topbar">
      <Popover
        width={290}
        renderTrigger={({ open }) => (
          <button className="pill" data-active={open} disabled={!ready}>
            <Cpu size={13} />
            <span>{currentModel?.name ?? currentModel?.id ?? 'Select model'}</span>
            <ChevronDown size={12} className="pill__caret" />
          </button>
        )}
      >
        {(close) => (
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            <div className="popover__label">Models</div>
            {models.length === 0 ? (
              <div className="popover__item" style={{ color: 'var(--text-faint)' }}>
                No models available
              </div>
            ) : null}
            {providers.map((provider) => (
              <div key={provider}>
                <div className="popover__label" style={{ paddingTop: 10 }}>
                  {provider}
                </div>
                {models
                  .filter((model) => model.provider === provider)
                  .map((model) => (
                    <button
                      key={`${model.provider}/${model.id}`}
                      className="popover__item"
                      data-selected={currentModel?.id === model.id}
                      onClick={() => {
                        void setModel(model)
                        close()
                      }}
                    >
                      <span className="popover__item-text">{model.name || model.id}</span>
                      {model.reasoning ? (
                        <span className="popover__item-sub">
                          {formatTokens(model.contextWindow)} ctx
                        </span>
                      ) : null}
                    </button>
                  ))}
              </div>
            ))}
          </div>
        )}
      </Popover>

      <Popover
        width={190}
        renderTrigger={({ open }) => (
          <button className="pill" data-active={open} disabled={!ready || !thinkingLevels.length}>
            <Sparkles size={13} />
            <span>{currentLevel ? `Thinking: ${currentLevel}` : 'Thinking'}</span>
            <ChevronDown size={12} className="pill__caret" />
          </button>
        )}
      >
        {(close) => (
          <div>
            <div className="popover__label">Reasoning effort</div>
            {thinkingLevels.map((levelName) => (
              <button
                key={levelName}
                className="popover__item"
                data-selected={currentLevel === levelName}
                onClick={() => {
                  void setThinkingLevel(levelName)
                  close()
                }}
              >
                <span className="popover__item-text" style={{ textTransform: 'capitalize' }}>
                  {levelName}
                </span>
              </button>
            ))}
          </div>
        )}
      </Popover>

      {context ? (
        <div className="context-meter" title="Context window usage">
          <Gauge size={13} />
          <span>
            {formatTokens(context.tokens ?? 0)} / {formatTokens(context.contextWindow)}
          </span>
          <span className="context-meter__bar">
            <span
              className="context-meter__fill"
              data-level={level}
              style={{ width: `${Math.min(100, percent)}%` }}
            />
          </span>
        </div>
      ) : null}

      <div style={{ flex: 1 }} />

      {changes.length > 0 ? (
        <button className="pill" onClick={onOpenChanges} title="Review the files Pi changed">
          <FileDiff size={13} />
          <span>
            {changes.length} changed {changes.length === 1 ? 'file' : 'files'}
          </span>
        </button>
      ) : null}

      <button className="btn btn--ghost btn--sm" onClick={() => void compact()} disabled={!ready}>
        <Minimize2 size={13} />
        Compact
      </button>
    </div>
  )
}

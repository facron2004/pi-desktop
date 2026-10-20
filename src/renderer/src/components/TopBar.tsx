import { useMemo, useState } from 'react'
import { ChevronDown, Cpu, FileDiff, Files, Gauge, Minimize2, Search, Sparkles } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { collectChanges } from '../lib/changes'
import { formatTokens } from '../lib/format'
import { Popover } from './Popover'
import { ContextPanel } from './ContextPanel'
import { useT } from '../lib/i18n'

export function ModelControls() {
  const models = useAppStore((state) => state.models)
  const piState = useAppStore((state) => state.piState)
  const thinkingLevels = useAppStore((state) => state.thinkingLevels)
  const stats = useAppStore((state) => state.stats)
  const setModel = useAppStore((state) => state.setModel)
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel)
  const ready = useAppStore((state) => state.status.phase === 'ready')
  const [modelQuery, setModelQuery] = useState('')
  const t = useT()

  const currentModel = piState?.model
  const currentLevel = piState?.thinkingLevel
  const context = stats?.contextUsage
  const percent = context?.percent ?? 0
  const level = percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low'

  const needle = modelQuery.trim().toLowerCase()
  const visibleModels = useMemo(
    () =>
      needle
        ? models.filter(
            (model) =>
              model.name.toLowerCase().includes(needle) ||
              model.id.toLowerCase().includes(needle) ||
              model.provider.toLowerCase().includes(needle)
          )
        : models,
    [models, needle]
  )
  const providers = Array.from(new Set(visibleModels.map((model) => model.provider)))

  return (
    <div className="topbar__group model-controls">
      <Popover
        width={290}
        renderTrigger={({ open, toggle }) => (
          <button className="pill" data-active={open} onClick={toggle} disabled={!ready}>
            <Cpu size={13} />
            <span>{currentModel?.name ?? currentModel?.id ?? t('Select model')}</span>
            <ChevronDown size={12} className="pill__caret" />
          </button>
        )}
      >
        {(close) => (
          <div style={{ maxHeight: 380, overflowY: 'auto' }}>
            {models.length > 6 ? (
              <div className="palette__search">
                <Search size={12} />
                <input
                  value={modelQuery}
                  placeholder={t('Filter models')}
                  autoFocus
                  onChange={(event) => setModelQuery(event.target.value)}
                />
              </div>
            ) : null}

            <div className="popover__label">{t('Models')}</div>
            {visibleModels.length === 0 ? (
              <div className="popover__item" style={{ color: 'var(--text-faint)' }}>
                {t('No model matches')} “{modelQuery}”
              </div>
            ) : null}
            {providers.map((provider) => (
              <div key={provider}>
                <div className="popover__label" style={{ paddingTop: 10 }}>
                  {provider}
                </div>
                {visibleModels
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
        renderTrigger={({ open, toggle }) => (
          <button
            className="pill"
            data-active={open}
            onClick={toggle}
            disabled={!ready || !thinkingLevels.length}
          >
            <Sparkles size={13} />
            <span>{currentLevel ? `${t('Thinking')}: ${currentLevel}` : t('Thinking')}</span>
            <ChevronDown size={12} className="pill__caret" />
          </button>
        )}
      >
        {(close) => (
          <div>
            <div className="popover__label">{t('Reasoning effort')}</div>
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
        <Popover
          width={290}
          renderTrigger={({ open, toggle }) => (
            <button className="context-meter" data-active={open} onClick={toggle} title={t('Session details')}>
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
            </button>
          )}
        >
          {(close) => <ContextPanel close={close} />}
        </Popover>
      ) : null}
    </div>
  )
}

export function TopBar({
  onOpenChanges,
  onOpenFiles
}: {
  onOpenChanges: () => void
  onOpenFiles: () => void
}) {
  const items = useAppStore((state) => state.items)
  const compact = useAppStore((state) => state.compact)
  const ready = useAppStore((state) => state.status.phase === 'ready')
  const language = useAppStore((state) => state.settings.language)
  const changes = useMemo(() => collectChanges(items), [items])
  const t = useT()

  return (
    <div className="topbar">
      <div className="topbar__group topbar__group--end">
        {changes.length > 0 ? (
          <button className="pill" onClick={onOpenChanges} title={t('Review the files Pi changed')}>
            <FileDiff size={13} />
            <span>
              {language === 'zh-CN'
                ? `${changes.length} 个文件已修改`
                : `${changes.length} changed ${changes.length === 1 ? 'file' : 'files'}`}
            </span>
          </button>
        ) : null}

        <button className="pill" onClick={onOpenFiles} title={t('Browse the project files')}>
          <Files size={13} />
          <span>{t('Files')}</span>
        </button>

        <button
          className="pill"
          onClick={() => void compact()}
          disabled={!ready}
          title={t('Summarise the conversation to free up the context window')}
        >
          <Minimize2 size={13} />
          <span>{t('Compact')}</span>
        </button>
      </div>
    </div>
  )
}

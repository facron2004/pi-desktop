import { useMemo, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import {
  Check,
  ChevronDown,
  Cpu,
  Search,
  Sparkles
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { Popover } from './Popover'
import { ContextRing } from './ContextRing'
import { useT } from '../lib/i18n'
import '../styles/model-picker.css'

/** The picker prints context windows short; `0` means Pi did not report one. */
function formatContextWindow(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return null
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`
  return String(value)
}

/** A price without the cents a whole dollar does not need. */
function formatPrice(value: number): string {
  return `$${Math.round(value * 100) / 100}`
}

/**
 * Pi reports prices per million tokens. Custom endpoints often report no cost
 * at all, so a missing `cost` is a normal answer rather than a broken row.
 */
function modelPrice(
  model: ModelInfo,
  t: (key: string) => string
): { text: string; title: string } | null {
  const cost = model.cost
  if (!cost) return null

  const read = (key: string): number | undefined => {
    const value = cost[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  const input = read('input')
  const output = read('output')
  if (input === undefined && output === undefined) return null
  // A provider that reports zero for everything has no published price; a
  // "$0 / $0" row is noise rather than information.
  if ((input ?? 0) <= 0 && (output ?? 0) <= 0) return null

  const cacheRead = read('cacheRead')
  const cacheWrite = read('cacheWrite')
  const text =
    input !== undefined && output !== undefined
      ? `${formatPrice(input)} / ${formatPrice(output)}`
      : input !== undefined
        ? `${formatPrice(input)} ${t('in')}`
        : output !== undefined
          ? `${formatPrice(output)} ${t('out')}`
          : null
  if (text === null) return null
  const parts = [
    input !== undefined ? `${t('Input')} ${formatPrice(input)}` : null,
    output !== undefined ? `${t('Output')} ${formatPrice(output)}` : null,
    cacheRead !== undefined ? `${t('Cache read')} ${formatPrice(cacheRead)}` : null,
    cacheWrite !== undefined ? `${t('Cache write')} ${formatPrice(cacheWrite)}` : null
  ].filter((part): part is string => part !== null)

  return { text, title: `${parts.join(' · ')} ${t('per 1M tokens')}` }
}

/** One line per level, so the effort names do not have to be memorised. */
const REASONING_HINTS: Record<string, string> = {
  off: 'No reasoning',
  minimal: 'Fastest, shortest reasoning',
  low: 'Fast, light reasoning',
  medium: 'Balanced speed and depth',
  high: 'Thorough reasoning',
  xhigh: 'Deepest reasoning',
  max: 'Maximum reasoning effort'
}

function reasoningHint(level: string): string {
  return REASONING_HINTS[level.toLowerCase()] ?? 'Pi decides the effort'
}

function levelLabel(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1)
}

function acceptsImages(model: ModelInfo): boolean {
  // The type says string[], but a custom endpoint can leave it out at runtime.
  return Array.isArray(model.input) && model.input.includes('image')
}

export function ModelControls() {
  const models = useAppStore((state) => state.models)
  const currentModel = useAppStore((state) => state.piState?.model)
  const currentLevel = useAppStore((state) => state.piState?.thinkingLevel)
  const thinkingLevels = useAppStore((state) => state.thinkingLevels)
  const setModel = useAppStore((state) => state.setModel)
  const setThinkingLevel = useAppStore((state) => state.setThinkingLevel)
  const ready = useAppStore((state) => state.status.phase === 'ready')
  const [modelQuery, setModelQuery] = useState('')
  const t = useT()

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
  const modelGroups = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>()
    for (const model of visibleModels) {
      const group = groups.get(model.provider)
      if (group) group.push(model)
      else groups.set(model.provider, [model])
    }
    return [...groups]
  }, [visibleModels])
  const currentContext = currentModel ? formatContextWindow(currentModel.contextWindow) : null
  const currentPrice = currentModel ? modelPrice(currentModel, t) : null
  const triggerTitle = currentModel
    ? [
        currentModel.name || currentModel.id,
        currentContext ? `${currentContext} ${t('ctx')}` : null,
        currentPrice?.title ?? null
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
    : undefined

  return (
    <div className="topbar__group model-controls">
      <Popover
        placement="top"
        align="right"
        width={340}
        className="model-picker"
        renderTrigger={({ open, toggle }) => (
          <button
            className="pill model-picker__trigger"
            data-active={open}
            aria-expanded={open}
            onClick={toggle}
            disabled={!ready}
            title={triggerTitle}
          >
            <Cpu size={13} />
            <span className="model-picker__trigger-name">
              {currentModel?.name ?? currentModel?.id ?? t('Select model')}
            </span>
            <ChevronDown size={12} className="pill__caret" />
          </button>
        )}
      >
        {(close) => (
          <div className="model-picker__list">
            {models.length > 6 ? (
              <div className="palette__search">
                <Search size={12} />
                <input
                  value={modelQuery}
                  placeholder={t('Filter models')}
                  aria-label={t('Filter models')}
                  autoFocus
                  onChange={(event) => setModelQuery(event.target.value)}
                />
              </div>
            ) : null}

            {visibleModels.length === 0 ? (
              <div className="model-picker__empty">
                {t('No model matches')} “{modelQuery}”
              </div>
            ) : null}
            {modelGroups.map(([provider, group]) => (
              <div className="model-picker__group" key={provider} role="group" aria-label={provider}>
                <div className="popover__label model-picker__group-label" title={provider}>
                  {provider}
                </div>
                {group.map((model) => {
                  const modelContext = formatContextWindow(model.contextWindow)
                  const price = modelPrice(model, t)
                  const images = acceptsImages(model)
                  const selected = currentModel?.id === model.id && currentModel.provider === model.provider
                  const rowTitle = [
                    model.name || model.id,
                    model.provider,
                    modelContext ? `${modelContext} ${t('ctx')}` : null,
                    price?.title ?? null,
                    model.reasoning ? t('Reasoning') : null,
                    images ? t('Image input') : null
                  ]
                    .filter((part): part is string => Boolean(part))
                    .join(' · ')

                  return (
                    <button
                      key={`${model.provider}/${model.id}`}
                      className="popover__item model-picker__row"
                      data-selected={selected}
                      aria-pressed={selected}
                      title={rowTitle}
                      onClick={() => {
                        void setModel(model)
                        close()
                      }}
                    >
                      <span className="model-picker__row-body">
                        <span className="model-picker__row-name">{model.name || model.id}</span>
                        {modelContext || price || model.reasoning || images ? (
                          <span className="model-picker__row-meta">
                            {modelContext ? (
                              <span className="model-picker__meta-item">
                                {modelContext} {t('ctx')}
                              </span>
                            ) : null}
                            {price ? (
                              <span className="model-picker__price" title={price.title}>
                                {price.text}
                              </span>
                            ) : null}
                            {model.reasoning ? (
                              <span className="model-picker__badge" data-kind="reasoning">
                                {t('Reasoning')}
                              </span>
                            ) : null}
                            {images ? (
                              <span className="model-picker__badge" data-kind="image">
                                {t('Images')}
                              </span>
                            ) : null}
                          </span>
                        ) : null}
                      </span>
                      {selected ? <Check size={13} className="model-picker__check" /> : null}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        )}
      </Popover>

      <Popover
        placement="top"
        align="right"
        width={240}
        className="reasoning-picker"
        renderTrigger={({ open, toggle }) => (
          <button
            className="pill model-picker__effort-trigger"
            data-active={open}
            aria-expanded={open}
            onClick={toggle}
            disabled={!ready || !thinkingLevels.length}
          >
            <Sparkles size={13} />
            <span>{currentLevel ? t(levelLabel(currentLevel)) : t('Thinking')}</span>
            <ChevronDown size={12} className="pill__caret" />
          </button>
        )}
      >
        {(close) => (
          <div className="model-picker__effort">
            <div className="popover__label">{t('Reasoning effort')}</div>
            <div className="model-picker__effort-list" role="group" aria-label={t('Reasoning effort')}>
              {thinkingLevels.map((level) => {
                const selected = currentLevel === level
                const label = t(levelLabel(level))
                const hint = t(reasoningHint(level))
                return (
                  <button
                    key={level}
                    type="button"
                    className="popover__item model-picker__reasoning-row"
                    data-selected={selected}
                    aria-pressed={selected}
                    disabled={!ready}
                    title={`${label} · ${hint}`}
                    onClick={() => {
                      if (level !== currentLevel) void setThinkingLevel(level)
                      close()
                    }}
                  >
                    <span className="model-picker__reasoning-body">
                      <span className="model-picker__reasoning-level">{label}</span>
                      <span className="model-picker__reasoning-hint">{hint}</span>
                    </span>
                    {selected ? <Check size={13} className="model-picker__check" aria-hidden="true" /> : null}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </Popover>

      <ContextRing />
    </div>
  )
}

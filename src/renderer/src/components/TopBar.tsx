import { useCallback, useMemo, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import { Check, ChevronDown, ChevronLeft, Search, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { EffortSlider } from './EffortSlider'
import { Popover } from './Popover'
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

function acceptsImages(model: ModelInfo): boolean {
  // The type says string[], but a custom endpoint can leave it out at runtime.
  return Array.isArray(model.input) && model.input.includes('image')
}

/** The model and its reasoning effort share one composer control. */
export function ModelPicker() {
  const models = useAppStore((state) => state.models)
  const currentModel = useAppStore((state) => state.piState?.model)
  const currentLevel = useAppStore((state) => state.piState?.thinkingLevel)
  const thinkingLevels = useAppStore((state) => state.thinkingLevels)
  const setModel = useAppStore((state) => state.setModel)
  const ready = useAppStore((state) => state.status.phase === 'ready')
  const [modelQuery, setModelQuery] = useState('')
  const [showModels, setShowModels] = useState(false)
  const [modelUpdating, setModelUpdating] = useState(false)
  const [effortUpdating, setEffortUpdating] = useState(false)
  const t = useT()

  const levelLabel = (level: string) => t(level.charAt(0).toUpperCase() + level.slice(1))
  const modelLabel = currentModel?.name || currentModel?.id || t('Select model')
  const effortLabel = currentLevel ? levelLabel(currentLevel) : t('Thinking')
  const updating = modelUpdating || effortUpdating
  const focusSearch = useCallback((input: HTMLInputElement | null) => {
    if (!input) return
    requestAnimationFrame(() => {
      if (input.isConnected && !input.closest('.model-picker')?.contains(document.activeElement)) {
        input.focus()
      }
    })
  }, [])
  const showSelectedModel = useCallback((list: HTMLDivElement | null) => {
    const selected = list?.querySelector<HTMLButtonElement>('.model-picker__row[data-selected="true"]')
    if (!list || !selected) return
    const listRect = list.getBoundingClientRect()
    const selectedRect = selected.getBoundingClientRect()
    if (selectedRect.top < listRect.top || selectedRect.bottom > listRect.bottom) {
      list.scrollTop += selectedRect.top - listRect.top - (list.clientHeight - selectedRect.height) / 2
    }
  }, [])

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
        currentLevel ? `${t('Reasoning effort')}: ${effortLabel}` : null,
        currentContext ? `${currentContext} ${t('ctx')}` : null,
        currentPrice?.title ?? null
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ')
    : undefined

  return (
    <Popover
      placement="top"
      align="right"
      width={showModels ? 340 : 240}
      className="model-picker"
      renderTrigger={({ open, toggle }) => (
        <button
          className="model-chip"
          data-active={open}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={`${t('Model')}: ${modelLabel}${currentLevel ? ` · ${effortLabel}` : ''}`}
          onClick={(e) => {
            if (!open) {
              setModelQuery('')
              setShowModels(false)
            }
            toggle(e)
          }}
          disabled={!ready}
          title={triggerTitle}
        >
          <span className="model-chip__name">{modelLabel}</span>
          {currentLevel && thinkingLevels.length > 0 ? (
            <>
              <span className="model-chip__sep" aria-hidden="true">
                ·
              </span>
              <span className="model-chip__effort">{effortLabel}</span>
            </>
          ) : null}
          <ChevronDown size={11} className="pill__caret" />
        </button>
      )}
    >
      {() => (
        <div
          className="model-picker-container"
          role="dialog"
          aria-label={`${t('Model')} · ${t('Reasoning effort')}`}
          aria-busy={updating}
          onKeyDown={(event) => {
            if (!showModels || event.key !== 'Escape' || event.nativeEvent.isComposing) return
            event.preventDefault()
            event.stopPropagation()
            setShowModels(false)
          }}
        >
          {showModels ? (
            <>
              <div className="model-picker__search">
                <button
                  type="button"
                  className="model-picker__back"
                  aria-label={t('Back')}
                  onClick={() => setShowModels(false)}
                >
                  <ChevronLeft size={15} />
                </button>
                <div className="project-menu__search">
                  <Search size={14} className="project-menu__search-icon" />
                  <input
                    ref={focusSearch}
                    type="text"
                    className="project-menu__search-input"
                    value={modelQuery}
                    placeholder={t('Search models')}
                    aria-label={t('Search models')}
                    onChange={(event) => setModelQuery(event.target.value)}
                  />
                  {modelQuery ? (
                    <button
                      type="button"
                      className="project-menu__search-clear"
                      onClick={() => setModelQuery('')}
                      aria-label={t('Clear')}
                    >
                      <X size={12} />
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="project-menu__divider" />

              <div className="model-picker__list" ref={showSelectedModel}>
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
                          aria-disabled={updating}
                          title={rowTitle}
                          onClick={async () => {
                            if (updating) return
                            if (selected) {
                              setShowModels(false)
                              return
                            }
                            setModelUpdating(true)
                            try {
                              await setModel(model)
                              setShowModels(false)
                            } finally {
                              setModelUpdating(false)
                            }
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
            </>
          ) : (
            <EffortSlider
              disabled={updating}
              modelLabel={modelLabel}
              onOpenModelList={() => {
                if (updating) return
                setModelQuery('')
                setShowModels(true)
              }}
              onBusyChange={setEffortUpdating}
            />
          )}
        </div>
      )}
    </Popover>
  )
}

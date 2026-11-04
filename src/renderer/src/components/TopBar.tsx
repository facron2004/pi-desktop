import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { resolveSavedModel, selectableModels } from '@shared/provider-models'
import { useAppStore } from '../store/useAppStore'
import { EffortSlider } from './EffortSlider'
import { Popover } from './Popover'
import { useT } from '../lib/i18n'
import { filterModels } from '../lib/model-search'
import { modelRecencyKey, readModelRecency, sortModelsByRecency } from '../lib/model-recency'
import { resolveThinkingLevel } from '../lib/thinking'
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
  const threadModels = useAppStore((state) => state.models)
  const catalogModels = useAppStore((state) => state.catalogModels)
  const disabledModelSpecs = useAppStore((state) => state.disabledModelSpecs)
  const savedModel = useAppStore((state) => state.settings.model)
  const savedProvider = useAppStore((state) => state.settings.provider)
  const piState = useAppStore((state) => state.piState)
  const liveModel = piState?.model
  const liveLevel = piState?.thinkingLevel
  const savedLevel = useAppStore((state) => state.settings.thinkingLevel)
  const thinkingLevels = useAppStore((state) => state.thinkingLevels)

  const [configuredThinkingLevels, setConfiguredThinkingLevels] = useState<string[]>([])
  const [configuredLevelsLoading, setConfiguredLevelsLoading] = useState(false)
  const setModel = useAppStore((state) => state.setModel)
  const starting = useAppStore((state) => state.status.phase === 'starting')
  const models = useMemo(
    () => selectableModels(threadModels, catalogModels, disabledModelSpecs),
    [threadModels, catalogModels, disabledModelSpecs]
  )
  const currentModel =
    liveModel?.id && liveModel.provider
      ? liveModel
      : resolveSavedModel(savedModel, savedProvider, models)
  useEffect(() => {
    let cancelled = false
    setConfiguredThinkingLevels([])
    // A live process already reported the levels through `get_state`. Reading
    // the static catalog again would only duplicate that answer.
    if (piState?.model?.provider && piState.model.id) {
      setConfiguredLevelsLoading(false)
      return () => {
        cancelled = true
      }
    }
    if (!currentModel) {
      setConfiguredLevelsLoading(false)
      return () => {
        cancelled = true
      }
    }
    const getLevels = window.pi.modelCatalog?.thinkingLevels
    if (typeof getLevels !== 'function') {
      setConfiguredLevelsLoading(false)
      return () => {
        cancelled = true
      }
    }
    setConfiguredLevelsLoading(true)
    void getLevels(currentModel.provider, currentModel.id)
      .then((levels) => {
        if (!cancelled) setConfiguredThinkingLevels(levels)
      })
      .catch(() => {
        if (!cancelled) setConfiguredThinkingLevels([])
      })
      .finally(() => {
        if (!cancelled) setConfiguredLevelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [currentModel?.provider, currentModel?.id, piState?.model?.provider, piState?.model?.id])

  const availableThinkingLevels = piState ? thinkingLevels : configuredThinkingLevels
  // Before a runtime exists, use the exact level list resolved from Pi's model
  // catalog. A live session's RPC result takes precedence once it is available.
  const currentLevel =
    liveLevel || savedLevel
      ? resolveThinkingLevel(availableThinkingLevels, liveLevel, savedLevel) ??
        (!piState ? liveLevel || savedLevel : liveLevel)
      : undefined
  const [modelQuery, setModelQuery] = useState('')
  const [showModels, setShowModels] = useState(false)
  const [otherModelsExpanded, setOtherModelsExpanded] = useState(false)
  const [modelUpdating, setModelUpdating] = useState(false)
  const [effortUpdating, setEffortUpdating] = useState(false)
  const [recency, setRecency] = useState(readModelRecency)
  const [highlighted, setHighlighted] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
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
  const attachList = useCallback((list: HTMLDivElement | null) => {
    listRef.current = list
  }, [])

  const needle = modelQuery.trim()
  const visibleModels = useMemo(() => filterModels(models, needle), [models, needle])
  // Recently used models are only a shortcut for the empty search state; a
  // search still walks the full provider-grouped list in Pi's order.
  const recentModels = useMemo(() => {
    if (needle) return []
    const used = sortModelsByRecency(models, recency)
      .filter((model) => recency[modelRecencyKey(model)] !== undefined)
      .slice(0, 3)
    return used
  }, [models, needle, recency])
  const showRecents = recentModels.length > 0
  const regularModels = useMemo(() => {
    if (!showRecents) return visibleModels
    const recent = new Set(recentModels.map(modelRecencyKey))
    return visibleModels.filter((model) => !recent.has(modelRecencyKey(model)))
  }, [recentModels, showRecents, visibleModels])
  const visibleRegularModels = useMemo(
    () => (showRecents && !otherModelsExpanded ? [] : regularModels),
    [showRecents, otherModelsExpanded, regularModels]
  )
  const hasOtherModels = showRecents && regularModels.length > 0
  const displayModels = useMemo(
    () => (showRecents ? [...recentModels, ...visibleRegularModels] : visibleModels),
    [recentModels, showRecents, visibleRegularModels, visibleModels]
  )
  // With a recent section the list opens at the top on purpose; scrolling to a
  // model far down the provider groups would hide the shortcut that was just
  // shown. Without it, keep the selected model visible as before.
  useEffect(() => {
    if (!showModels || modelQuery || showRecents) return
    showSelectedModel(listRef.current)
  }, [showModels, modelQuery, showRecents, showSelectedModel])
  const displayIndexByKey = useMemo(
    () => new Map(displayModels.map((model, index) => [modelRecencyKey(model), index])),
    [displayModels]
  )
  const activeIndex = useMemo(
    () =>
      displayModels.findIndex(
        (model) => currentModel?.id === model.id && currentModel.provider === model.provider
      ),
    [displayModels, currentModel?.id, currentModel?.provider]
  )
  const modelGroups = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>()
    for (const model of visibleRegularModels) {
      const group = groups.get(model.provider)
      if (group) group.push(model)
      else groups.set(model.provider, [model])
    }
    return [...groups]
  }, [visibleRegularModels])

  useEffect(() => {
    if (!showModels) return
    setHighlighted(activeIndex >= 0 ? activeIndex : 0)
    setOtherModelsExpanded(false)
    // Another surface (the keyboard cycle) may have picked a model since the
    // last open; recency is cheap to re-read and belongs to the picker's view.
    setRecency(readModelRecency())
  }, [showModels, activeIndex])

  useEffect(() => {
    if (!showModels) return
    const list = listRef.current
    const row = list?.querySelector<HTMLElement>('.model-picker__row[data-highlighted="true"]')
    if (!list || !row) return
    const listRect = list.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    if (rowRect.top < listRect.top) list.scrollTop += rowRect.top - listRect.top
    else if (rowRect.bottom > listRect.bottom) list.scrollTop += rowRect.bottom - listRect.bottom
  }, [highlighted, showModels, displayModels.length])

  const pickModel = async (model: ModelInfo): Promise<void> => {
    if (updating) return
    const selected = currentModel?.id === model.id && currentModel.provider === model.provider
    if (selected) {
      setShowModels(false)
      return
    }
    setModelUpdating(true)
    try {
      if (await setModel(model)) {
        setRecency(readModelRecency())
        setShowModels(false)
      }
    } finally {
      setModelUpdating(false)
    }
  }

  const renderModelRow = (model: ModelInfo) => {
    const modelContext = formatContextWindow(model.contextWindow)
    const price = modelPrice(model, t)
    const images = acceptsImages(model)
    const selected = currentModel?.id === model.id && currentModel.provider === model.provider
    const key = modelRecencyKey(model)
    const modelIndex = displayIndexByKey.get(key) ?? 0
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
        key={key}
        className="popover__item model-picker__row"
        data-selected={selected}
        data-highlighted={highlighted === modelIndex}
        aria-pressed={selected}
        aria-disabled={updating}
        title={rowTitle}
        onMouseEnter={() => setHighlighted(modelIndex)}
        onClick={() => void pickModel(model)}
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
  }

  const currentContext = currentModel ? formatContextWindow(currentModel.contextWindow) : null
  const currentPrice = currentModel ? modelPrice(currentModel, t) : null
  const triggerTitle = currentModel
    ? [
        currentModel.provider,
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
              setRecency(readModelRecency())
            }
            toggle(e)
          }}
          disabled={starting}
          title={triggerTitle}
        >
          <span className="model-chip__name">{modelLabel}</span>
          {currentLevel ? (
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
                    onChange={(event) => {
                      setModelQuery(event.target.value)
                      setHighlighted(0)
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault()
                        if (displayModels.length === 0) return
                        const direction = event.key === 'ArrowDown' ? 1 : -1
                        setHighlighted((index) => (index + direction + displayModels.length) % displayModels.length)
                        return
                      }
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        const model = displayModels[highlighted]
                        if (model && !updating) void pickModel(model)
                      }
                    }}
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

              <div className="model-picker__list" ref={attachList}>
                {displayModels.length === 0 ? (
                  <div className="model-picker__empty">
                    {t('No model matches')} “{modelQuery}”
                  </div>
                ) : null}
                {showRecents ? (
                  <div className="model-picker__group" role="group" aria-label={t('Recent models')}>
                    <div className="popover__label model-picker__group-label" title={t('Recent models')}>
                      {t('Recent models')}
                    </div>
                    {recentModels.map(renderModelRow)}
                  </div>
                ) : null}
                {hasOtherModels ? (
                  <button
                    type="button"
                    className="model-picker__other"
                    aria-expanded={otherModelsExpanded}
                    onClick={() => setOtherModelsExpanded((expanded) => !expanded)}
                  >
                    {otherModelsExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span>{t('Other models')}</span>
                  </button>
                ) : null}
                {modelGroups.map(([provider, group]) => (
                  <div className="model-picker__group" key={provider} role="group" aria-label={provider}>
                    <div className="popover__label model-picker__group-label" title={provider}>
                      {provider}
                    </div>
                    {group.map(renderModelRow)}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EffortSlider
              disabled={updating}
              modelLabel={modelLabel}
              availableLevels={availableThinkingLevels}
              levelsLoading={configuredLevelsLoading && thinkingLevels.length === 0}
              onOpenModelList={() => {
                if (updating) return
                setModelQuery('')
                setRecency(readModelRecency())
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

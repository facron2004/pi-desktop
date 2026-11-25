import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import { isSideSessionKey } from '@shared/side-chat'
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, Search, X } from 'lucide-react'
import { selectableModels, resolveSavedModel } from '@shared/provider-models'
import { useAppStore } from '../store/useAppStore'
import { useSessionViewSlice } from '../lib/conversation-scope'
import { EffortSlider } from './EffortSlider'
import { Popover } from './Popover'
import { useT } from '../lib/i18n'
import { filterModels } from '../lib/model-search'
import { modelRecencyKey, readModelRecency, sortModelsByRecency } from '../lib/model-recency'
import { resolveThinkingLevel } from '../lib/thinking'
import { SidebarTip, useHoverTip, type SidebarTipRow } from './SidebarTip'
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
export const ModelPicker = memo(function ModelPicker({
  sessionKey,
  rememberDefaults
}: {
  sessionKey?: string
  rememberDefaults?: boolean
} = {}) {
  const pickerA11yId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const modelListId = `${pickerA11yId}-model-list`
  const slice = useSessionViewSlice(sessionKey)
  const isSide = Boolean(sessionKey && isSideSessionKey(sessionKey))
  const mainModels = useAppStore((state) => state.models)
  const threadModels = slice.models.length > 0 ? slice.models : mainModels
  const catalogModels = useAppStore((state) => state.catalogModels)
  const disabledModelSpecs = useAppStore((state) => state.disabledModelSpecs)
  const piState = slice.piState
  const liveLevel = piState?.thinkingLevel
  const sideThinkingOverride = useAppStore((state) =>
    sessionKey ? state.sideThinkingOverrides?.[sessionKey] : undefined
  )
  const mainLiveLevel = useAppStore((state) => state.piState?.thinkingLevel)
  const savedLevel = useAppStore((state) => state.settings.thinkingLevel)
  const fallbackLevel = isSide
    ? (sideThinkingOverride ?? mainLiveLevel ?? savedLevel)
    : savedLevel
  const thinkingLevels = slice.thinkingLevels

  const [configuredThinkingLevels, setConfiguredThinkingLevels] = useState<string[]>([])
  const [configuredLevelsLoading, setConfiguredLevelsLoading] = useState(false)
  // A row is one line now; its parameters live only in this card. The global
  // title-tip is suppressed inside an open popover, so a native title cannot
  // carry them — a card owned by this picker is the only place they show.
  const modelTip = useHoverTip<{ title: string; rows: SidebarTipRow[] }>()
  const setModel = useAppStore((state) => state.setModel)
  const starting = slice.status.phase === 'starting' && !slice.cwdWait
  const models = useMemo(
    () => selectableModels(threadModels, catalogModels, disabledModelSpecs),
    [threadModels, catalogModels, disabledModelSpecs]
  )
  // The conversation's own model wins when Pi is cold: a session keeps the
  // model it last used, so the chip must not follow the app default, which
  // other conversations keep moving. Subscribe to stable values and resolve
  // in a memo — a selector returning the fallback literal would repaint the
  // picker on every store notification.
  const liveModel = piState?.model
  const sideModelOverride = useAppStore((state) =>
    sessionKey ? state.sideModelOverrides?.[sessionKey] : undefined
  )
  const mainLiveModel = useAppStore((state) => state.piState?.model)
  const sessionModelSpec = useAppStore((state) => {
    const key = sessionKey ?? state.activeSessionFile
    return key ? state.sessions.find((entry) => entry.file === key)?.model : undefined
  })
  const mainSessionModelSpec = useAppStore((state) =>
    state.activeSessionFile
      ? state.sessions.find((entry) => entry.file === state.activeSessionFile)?.model
      : undefined
  )
  const savedModel = useAppStore((state) => state.settings.model)
  const savedProvider = useAppStore((state) => state.settings.provider)
  const currentModel = useMemo(() => {
    if (liveModel?.id && liveModel.provider) return liveModel
    if (isSide) {
      if (sideModelOverride) {
        const resolved = resolveSavedModel(sideModelOverride.spec, sideModelOverride.provider, models)
        if (resolved) return resolved
      }
      if (sessionModelSpec) {
        const resolved = resolveSavedModel(sessionModelSpec, savedProvider, models)
        if (resolved) return resolved
      }
      if (mainLiveModel?.id && mainLiveModel.provider) return mainLiveModel
      return resolveSavedModel(mainSessionModelSpec ?? savedModel, savedProvider, models)
    }
    return resolveSavedModel(sessionModelSpec ?? savedModel, savedProvider, models)
  }, [
    liveModel,
    isSide,
    sideModelOverride,
    sessionModelSpec,
    mainLiveModel,
    mainSessionModelSpec,
    savedModel,
    savedProvider,
    models
  ])
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
    liveLevel || fallbackLevel
      ? resolveThinkingLevel(availableThinkingLevels, liveLevel, fallbackLevel) ??
        (!piState ? liveLevel || fallbackLevel : liveLevel)
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
  const attachList = useCallback(
    (list: HTMLDivElement | null) => {
      listRef.current = list
      if (!list) modelTip.dismiss()
    },
    [modelTip.dismiss]
  )

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
    if (!showModels) {
      modelTip.dismiss()
      return
    }
    setHighlighted(activeIndex >= 0 ? activeIndex : 0)
    setOtherModelsExpanded(false)
    // Another surface (the keyboard cycle) may have picked a model since the
    // last open; recency is cheap to re-read and belongs to the picker's view.
    setRecency(readModelRecency())
    // `activeIndex` is read at open only. Expanding the list changes it, and
    // re-running on that change would fold "Other models" straight back up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showModels])

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

  const pickModel = async (model: ModelInfo, close: () => void): Promise<void> => {
    modelTip.dismiss()
    if (updating) return
    const selected = currentModel?.id === model.id && currentModel.provider === model.provider
    // Leave the picker before talking to Pi. The switch can wait on a busy or
    // unresponsive process (bounded in the store), and a menu that stays open
    // with no feedback while that happens is what felt like a frozen app.
    setShowModels(false)
    close()
    if (selected) return
    setModelUpdating(true)
    try {
      if (await setModel(model, sessionKey ? { sessionKey, rememberDefaults } : undefined)) {
        setRecency(readModelRecency())
        setShowModels(false)
      }
    } finally {
      setModelUpdating(false)
    }
  }

  const renderModelRow = (model: ModelInfo, close: () => void) => {
    const modelContext = formatContextWindow(model.contextWindow)
    const price = modelPrice(model, t)
    const images = acceptsImages(model)
    const selected = currentModel?.id === model.id && currentModel.provider === model.provider
    const key = modelRecencyKey(model)
    const modelIndex = displayIndexByKey.get(key) ?? 0
    const tipPayload = {
      title: model.name || model.id,
      rows: [
        { label: t('Provider'), value: model.provider },
        modelContext ? { label: t('Context'), value: `${modelContext} ${t('ctx')}` } : null,
        price ? { label: t('Price'), value: price.text } : null,
        model.reasoning ? { label: t('Reasoning'), value: t('Supported') } : null,
        images ? { label: t('Image input'), value: t('Supported') } : null
      ].filter((row): row is SidebarTipRow => row !== null)
    }
    const enter = modelTip.enter(tipPayload)

    return (
      <button
        key={key}
        id={`${modelListId}-option-${modelIndex}`}
        role="option"
        className="popover__item model-picker__row"
        data-selected={selected}
        data-highlighted={highlighted === modelIndex}
        aria-selected={highlighted === modelIndex}
        aria-disabled={updating}
        data-updating={modelUpdating || undefined}
        onMouseEnter={(event) => {
          setHighlighted(modelIndex)
          enter(event)
        }}
        onMouseLeave={modelTip.leave}
        onFocus={enter}
        onBlur={modelTip.leave}
        onClick={() => void pickModel(model, close)}
      >
        <span className="model-picker__row-body">
          <span className="model-picker__row-name">{model.name || model.id}</span>
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
    <>
      <Popover
        placement="top"
      align="right"
      width={showModels ? 340 : 240}
      className="model-picker"
      // The panel calls itself a dialog, so focus has to enter it: Tab from the
      // chip would otherwise leave the portal and dismiss the picker.
      focusPanel
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
          data-busy={updating || undefined}
          aria-busy={updating || undefined}
          title={triggerTitle}
        >
          {updating ? <Loader2 size={11} className="spin" aria-hidden="true" /> : null}
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
      {(close) => (
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
                    role="combobox"
                    aria-autocomplete="list"
                    aria-haspopup="listbox"
                    aria-expanded={showModels}
                    aria-controls={modelListId}
                    aria-activedescendant={
                      displayModels[highlighted]
                        ? `${modelListId}-option-${highlighted}`
                        : undefined
                    }
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
                        if (model && !updating) void pickModel(model, close)
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

              <div
                className="model-picker__list"
                id={modelListId}
                role="listbox"
                aria-label={t('Models')}
                ref={attachList}
              >
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
                    {recentModels.map((model) => renderModelRow(model, close))}
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
                    {group.map((model) => renderModelRow(model, close))}
                  </div>
                ))}
              </div>
              {modelTip.tip ? (
                <SidebarTip
                  anchor={modelTip.tip.anchor}
                  title={modelTip.tip.payload.title}
                  rows={modelTip.tip.payload.rows}
                  onDismiss={modelTip.dismiss}
                />
              ) : null}
            </>
          ) : (
            <EffortSlider
              disabled={updating}
              modelLabel={modelLabel}
              availableLevels={availableThinkingLevels}
              levelsLoading={configuredLevelsLoading && thinkingLevels.length === 0}
              sessionKey={sessionKey}
              rememberDefaults={rememberDefaults}
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
    </>
  )
})

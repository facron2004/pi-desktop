import { useEffect, useMemo, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import {
  Check,
  ChevronDown,
  Cpu,
  FileDiff,
  Files,
  Gauge,
  Minimize2,
  Search,
  Sparkles
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { collectChanges } from '../lib/changes'
import { formatTokens } from '../lib/format'
import { BranchMenu } from './BranchMenu'
import { Popover } from './Popover'
import { ContextPanel } from './ContextPanel'
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
  max: 'Deepest reasoning'
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
        width={320}
        renderTrigger={({ open, toggle }) => (
          <button
            className="pill model-picker__trigger"
            data-active={open}
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
                  autoFocus
                  onChange={(event) => setModelQuery(event.target.value)}
                />
              </div>
            ) : null}

            <div className="popover__label">{t('Models')}</div>
            {visibleModels.length === 0 ? (
              <div className="model-picker__empty">
                {t('No model matches')} “{modelQuery}”
              </div>
            ) : null}
            {visibleModels.map((model) => {
              const modelContext = formatContextWindow(model.contextWindow)
              const price = modelPrice(model, t)
              const images = acceptsImages(model)
              const selected = currentModel?.id === model.id
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
                  title={rowTitle}
                  onClick={() => {
                    void setModel(model)
                    close()
                  }}
                >
                  <span className="model-picker__row-body">
                    <span className="model-picker__row-name">{model.name || model.id}</span>
                    <span className="model-picker__row-meta">
                      {model.provider ? (
                        <span className="model-picker__provider">{model.provider}</span>
                      ) : null}
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
                  </span>
                  {selected ? <Check size={13} className="model-picker__check" /> : null}
                </button>
              )
            })}
          </div>
        )}
      </Popover>

      <Popover
        width={240}
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
                className="popover__item model-picker__reasoning-row"
                data-selected={currentLevel === levelName}
                onClick={() => {
                  void setThinkingLevel(levelName)
                  close()
                }}
              >
                <span className="model-picker__reasoning-body">
                  <span className="model-picker__reasoning-level">
                    {t(levelLabel(levelName))}
                  </span>
                  <span className="model-picker__reasoning-hint">
                    {t(reasoningHint(levelName))}
                  </span>
                </span>
                {currentLevel === levelName ? (
                  <Check size={13} className="model-picker__check" />
                ) : null}
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
  const refreshGit = useAppStore((state) => state.refreshGit)
  const workspace = useAppStore((state) => state.workspace)
  const changes = useMemo(() => collectChanges(items), [items])
  const t = useT()

  // The bar is the first thing the app draws for a project, so it also reads
  // the branch of that project. `openWorkspace` refreshes it too; this covers
  // a project that was already open when the window was restored.
  useEffect(() => {
    void refreshGit()
  }, [refreshGit, workspace?.path])

  return (
    <div className="topbar">
      <div className="topbar__group">
        <BranchMenu onOpenChanges={onOpenChanges} />
      </div>
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

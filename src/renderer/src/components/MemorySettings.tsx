import { useEffect, useMemo, useRef, useState } from 'react'
import { FolderOpen, Loader2, Sparkles, Trash2 } from 'lucide-react'
import type { MemoryEntry, MemoryKind, MemoryState } from '@shared/types'
import { useT } from '../lib/i18n'
import { basename, normalisePathKey } from '../lib/path'
import { useAppStore } from '../store/useAppStore'
import '../styles/memory-settings.css'
import { ConfirmDialog } from './ConfirmDialog'
import { Switch } from './Switch'

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: 'Preference',
  environment: 'Environment',
  knowledge: 'Knowledge',
  failure: 'Failure'
}

interface MemoryGroup {
  key: string
  title: string
  path?: string
  entries: MemoryEntry[]
}

/** A short, locale-aware date for a memory row. */
function formatMemoryDate(timestamp: number, language: string): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleDateString(language === 'zh-CN' ? 'zh-CN' : 'en', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/**
 * Settings → Memory.
 *
 * The memory store is owned by the main process; this page is a projection of
 * `MemoryState` plus the extraction switches in `AppSettings`. Every mutation
 * returns the new state, so the list never keeps a second copy of its own.
 */
export function MemorySettings() {
  const settings = useAppStore((store) => store.settings)
  const updateSettings = useAppStore((store) => store.updateSettings)
  const t = useT()
  const language = settings.language ?? 'en'

  const [state, setState] = useState<MemoryState | null>(null)
  const [loading, setLoading] = useState(true)
  const [learning, setLearning] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [status, setStatus] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [model, setModel] = useState(settings.memoryModel ?? '')
  const modelRef = useRef(model)
  modelRef.current = model
  const savedModelRef = useRef(settings.memoryModel ?? '')

  useEffect(() => {
    let alive = true
    void window.pi.memory
      .get()
      .then((next) => {
        if (!alive) return
        setState(next)
        setLoading(false)
      })
      .catch((error: unknown) => {
        if (!alive) return
        setLoading(false)
        setStatus({
          tone: 'error',
          text: `${t('Could not load memories')}: ${error instanceof Error ? error.message : String(error)}`
        })
      })
    const unsubscribe = window.pi.memory.onChanged((next) => {
      if (alive) setState(next)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  // The settings dialog can stay open while another window changes the value.
  useEffect(() => {
    savedModelRef.current = settings.memoryModel ?? ''
    setModel(settings.memoryModel ?? '')
  }, [settings.memoryModel])

  // Closing the page (or the dialog) must not lose a model name that never
  // blurred; the field is the only draft on this page.
  useEffect(
    () => () => {
      const value = modelRef.current.trim() || undefined
      const saved = savedModelRef.current.trim() || undefined
      if (value !== saved) void updateSettings({ memoryModel: value })
    },
    [updateSettings]
  )

  const groups = useMemo<MemoryGroup[]>(() => {
    const byGroup = new Map<string, MemoryGroup>()
    for (const entry of state?.entries ?? []) {
      const key = entry.scope === 'global' ? 'global' : `project:${normalisePathKey(entry.projectPath ?? '')}`
      let group = byGroup.get(key)
      if (!group) {
        group = {
          key,
          title:
            entry.scope === 'global'
              ? t('Global')
              : entry.projectName || basename(entry.projectPath ?? '') || t('Project'),
          path: entry.scope === 'project' ? entry.projectPath : undefined,
          entries: []
        }
        byGroup.set(key, group)
      }
      group.entries.push(entry)
    }
    return [...byGroup.values()].sort((left, right) => {
      if (left.key === 'global') return -1
      if (right.key === 'global') return 1
      return left.title.localeCompare(right.title)
    })
  }, [state, t])

  const learnFromRecent = async () => {
    setLearning(true)
    setStatus(null)
    try {
      const result = await window.pi.memory.generate({ limit: 3 })
      if (result.error) {
        setStatus({ tone: 'error', text: t(result.error) })
      } else if (result.added > 0) {
        setStatus({
          tone: 'info',
          text: t('Learned {count} new memories.').replace('{count}', String(result.added))
        })
      } else {
        setStatus({
          tone: 'info',
          text: result.skipped ? t(result.skipped) : t('No durable memories found')
        })
      }
    } catch (error) {
      setStatus({
        tone: 'error',
        text: `${t('Could not learn from recent conversations')}: ${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setLearning(false)
    }
  }

  const removeEntry = async (id: string) => {
    setStatus(null)
    try {
      setState(await window.pi.memory.remove(id))
    } catch (error) {
      setStatus({
        tone: 'error',
        text: `${t('Could not delete the memory')}: ${error instanceof Error ? error.message : String(error)}`
      })
    }
  }

  const clearAll = async () => {
    setConfirmClear(false)
    setClearing(true)
    setStatus(null)
    try {
      setState(await window.pi.memory.clear())
      setStatus({ tone: 'info', text: t('All memories cleared') })
    } catch (error) {
      setStatus({
        tone: 'error',
        text: `${t('Could not clear memories')}: ${error instanceof Error ? error.message : String(error)}`
      })
    } finally {
      setClearing(false)
    }
  }

  const openFolder = async () => {
    setStatus(null)
    try {
      await window.pi.memory.openFolder()
    } catch (error) {
      setStatus({
        tone: 'error',
        text: `${t('Could not open the memory folder')}: ${error instanceof Error ? error.message : String(error)}`
      })
    }
  }

  const commitModel = () => {
    const value = model.trim() || undefined
    if (value === (settings.memoryModel?.trim() || undefined)) return
    void updateSettings({ memoryModel: value })
  }

  const entryCount = state?.entries.length ?? 0

  return (
    <div className="settings-page">
      <header className="settings-page-head">
        <h3>{t('Memory')}</h3>
        <p>{t('Pi learns durable facts from your conversations and carries them into new sessions.')}</p>
      </header>

      <section className="memory-learning-card">
        <div className="memory-learning-card__head">
          <span className="memory-learning-card__icon" aria-hidden="true">
            <Sparkles size={16} />
          </span>
          <div className="memory-learning-card__heading">
            <h4>{t('Learning')}</h4>
            <p>{t('Learning runs in the background with the current model and never modifies the conversation.')}</p>
          </div>
        </div>

        <div className="memory-learning-card__rows">
          <div className="memory-learning-card__row">
            <div className="memory-learning-card__copy">
              <span className="memory-learning-card__title">{t('Use memories in new conversations')}</span>
              <span className="memory-learning-card__hint">
                {t('Pi adds what it has learned to new conversations in this app.')}
              </span>
            </div>
            <Switch
              checked={settings.memoriesEnabled !== false}
              onChange={(value) => void updateSettings({ memoriesEnabled: value })}
              label={t('Use memories in new conversations')}
            />
          </div>

          <div className="memory-learning-card__row">
            <div className="memory-learning-card__copy">
              <span className="memory-learning-card__title">{t('Learn from finished conversations')}</span>
              <span className="memory-learning-card__hint">
                {t('When a conversation finishes, Pi learns durable facts from it in the background.')}
              </span>
            </div>
            <Switch
              checked={settings.memoryGeneration !== false}
              onChange={(value) => void updateSettings({ memoryGeneration: value })}
              label={t('Learn from finished conversations')}
            />
          </div>

          <div className="memory-learning-card__row">
            <div className="memory-learning-card__copy">
              <span className="memory-learning-card__title">
                {t('Skip chats that used MCP, web search or computer use')}
              </span>
              <span className="memory-learning-card__hint">
                {t('These chats can carry outside context, so they are not used for learning by default.')}
              </span>
            </div>
            <Switch
              checked={settings.memorySkipExternalContext !== false}
              onChange={(value) => void updateSettings({ memorySkipExternalContext: value })}
              label={t('Skip chats that used MCP, web search or computer use')}
            />
          </div>
        </div>

        <div className="memory-learning-card__model">
          <label className="field__label" htmlFor="memory-model">
            {t('Extraction model')}
          </label>
          <input
            id="memory-model"
            className="input memory-model-input"
            value={model}
            placeholder={t('Empty uses the current model')}
            onChange={(event) => setModel(event.target.value)}
            onBlur={commitModel}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.currentTarget.blur()
              }
            }}
          />
          <span className="field__hint">
            {t('Model used to extract memories. Leave empty to use the current model.')}
          </span>
        </div>

      </section>

      <section className="settings-group">
        <div className="settings-group__head">
          <h4>{t('Stored memories')}</h4>
          {state ? (
            <div className="settings-inline-actions">
              <span className="settings-badge">
                {entryCount} {t('memories')}
              </span>
            </div>
          ) : null}
        </div>

        <div className="settings-fields">
          <div className="memory-actions">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void learnFromRecent()}
              disabled={learning || clearing || state?.generating === true}
            >
              {learning ? <Loader2 size={13} className="memory-spin" /> : <Sparkles size={13} />}
              {learning ? t('Learning…') : t('Learn from recent')}
            </button>
            <button type="button" className="btn btn--sm" onClick={() => void openFolder()}>
              <FolderOpen size={13} />
              {t('Open folder')}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={() => setConfirmClear(true)}
              disabled={clearing || entryCount === 0 || learning || state?.generating === true}
            >
              <Trash2 size={13} />
              {clearing ? t('Clearing…') : t('Clear all')}
            </button>
          </div>

          {state?.lastError ? (
            <div className="memory-status" data-tone="error">
              {t(state.lastError)}
            </div>
          ) : null}

          {state?.generating || (state?.pending ?? 0) > 0 ? (
            <div className="memory-status">
              {state?.generating ? <Loader2 size={12} className="memory-spin" /> : null}
              <span>
                {state?.generating
                  ? t('Learning in the background…')
                  : `${state?.pending ?? 0} ${t('conversations waiting')}`}
              </span>
            </div>
          ) : null}

          {status ? (
            <div className="memory-status" data-tone={status.tone}>
              {status.text}
            </div>
          ) : null}

          {loading ? (
            <div className="settings-empty">{t('Loading memories…')}</div>
          ) : groups.length === 0 ? (
            <div className="settings-empty">
              {t('No memories yet. Finished conversations will appear here after Pi learns from them.')}
            </div>
          ) : (
            <div className="memory-list">
              {groups.map((group) => (
                <section className="memory-group" key={group.key}>
                  <div className="memory-group__head">
                    <span className="memory-group__title">{group.title}</span>
                    <span className="memory-group__count">{group.entries.length}</span>
                    {group.path ? (
                      <span className="memory-group__path" title={group.path}>
                        {group.path}
                      </span>
                    ) : null}
                  </div>
                  <ul className="memory-rows">
                    {group.entries.map((entry) => (
                      <li className="memory-row" key={entry.id}>
                        <span className="memory-kind" data-kind={entry.kind}>
                          {t(KIND_LABEL[entry.kind])}
                        </span>
                        <div className="memory-row__body">
                          <span className="memory-row__text">{entry.text}</span>
                          <span className="memory-row__meta">
                            {entry.source ? (
                              <span className="memory-row__source" title={entry.source}>
                                {basename(entry.source)}
                              </span>
                            ) : null}
                            {entry.source ? <span aria-hidden="true">·</span> : null}
                            <span>{formatMemoryDate(entry.updatedAt, language)}</span>
                          </span>
                        </div>
                        <button
                          type="button"
                          className="icon-btn memory-row__delete"
                          onClick={() => void removeEntry(entry.id)}
                          aria-label={t('Delete memory')}
                          title={t('Delete memory')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}

          <details className="memory-preview">
            <summary>{t('Preview')}</summary>
            <pre>{state?.summary?.trim() || t('Nothing stored yet.')}</pre>
          </details>
        </div>
      </section>

      {confirmClear ? (
        <ConfirmDialog
          title={t('Clear all memories?')}
          body={t(
            'This removes every memory entry and the per-session learning record, so earlier conversations can be learned again. This cannot be undone.'
          )}
          confirmLabel={t('Clear all')}
          tone="danger"
          onConfirm={() => void clearAll()}
          onCancel={() => setConfirmClear(false)}
        />
      ) : null}
    </div>
  )
}

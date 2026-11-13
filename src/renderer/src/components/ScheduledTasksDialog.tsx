import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  AlertTriangle,
  Clock,
  Ellipsis,
  Loader2,
  Pause,
  Play,
  Plus,
  Search,
  X
} from 'lucide-react'
import type {
  AppLanguage,
  ModelInfo,
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskSchedule,
  Workspace
} from '@shared/types'
import { resolveSavedModel, selectableModels } from '@shared/provider-models'
import { DateTimeField } from './DateTimeField'
import { Popover } from './Popover'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { DEFAULT_THINKING_LEVELS } from '../lib/thinking'
import '../styles/scheduled-tasks.css'

type RepeatKind = 'once' | 'daily' | 'weekly'
type TaskState = 'active' | 'paused' | 'ended'
type StatusFilter = TaskState | 'all'
type DetailTab = 'rule' | 'records'

interface TaskForm {
  id?: string
  title: string
  prompt: string
  workspaceId: string
  model: string
  thinkingLevel: string
  kind: RepeatKind
  dateTime: string
  time: string
  weekday: number
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const STATUS_FILTERS: StatusFilter[] = ['active', 'paused', 'ended', 'all']

const modelSpec = (model: ModelInfo): string => `${model.provider}/${model.id}`

function levelLabel(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1)
}

function localDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function newForm(workspaces: Workspace[], activeWorkspaceId?: string | null): TaskForm {
  const nextHour = new Date(Date.now() + 60 * 60 * 1000)
  nextHour.setSeconds(0, 0)
  return {
    title: '',
    prompt: '',
    workspaceId: workspaces.find((item) => item.id === activeWorkspaceId)?.id ?? workspaces[0]?.id ?? '',
    // Empty means the run follows the model and effort saved in Settings.
    model: '',
    thinkingLevel: '',
    kind: 'once',
    dateTime: localDateTime(nextHour.getTime()),
    time: '09:00',
    weekday: 1
  }
}

function editForm(task: ScheduledTask): TaskForm {
  const form: TaskForm = {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    workspaceId: task.workspaceId,
    model: task.model ?? '',
    thinkingLevel: task.thinkingLevel ?? '',
    kind: task.schedule.kind,
    // A recurring task has no single date here; createdAt is a stable stand-in
    // until the user switches the repeat control to "once".
    dateTime: localDateTime(task.schedule.kind === 'once' ? task.schedule.at : task.createdAt),
    time: task.schedule.kind === 'once' ? '09:00' : task.schedule.time,
    weekday: task.schedule.kind === 'weekly' ? task.schedule.weekday : 1
  }
  if (task.schedule.kind === 'daily') form.time = task.schedule.time
  return form
}

function formKey(form: TaskForm): string {
  return JSON.stringify(form)
}

function scheduleFor(form: TaskForm): ScheduledTaskSchedule {
  if (form.kind === 'once') return { kind: 'once', at: new Date(form.dateTime).getTime() }
  if (form.kind === 'weekly') return { kind: 'weekly', time: form.time, weekday: form.weekday }
  return { kind: 'daily', time: form.time }
}

function describeSchedule(task: ScheduledTask, t: (text: string) => string): string {
  if (task.schedule.kind === 'once') {
    return `${t('Once')} · ${new Date(task.schedule.at).toLocaleString()}`
  }
  if (task.schedule.kind === 'daily') return `${t('Daily')} · ${task.schedule.time}`
  return `${t('Weekly on')} ${t(WEEKDAYS[task.schedule.weekday])} · ${task.schedule.time}`
}

function taskState(task: ScheduledTask): TaskState {
  if (task.enabled) return 'active'
  if (task.schedule.kind === 'once' && task.schedule.at <= Date.now()) return 'ended'
  return 'paused'
}

function stateLabel(state: TaskState, t: (text: string) => string): string {
  if (state === 'active') return t('Enabled')
  if (state === 'paused') return t('Paused')
  return t('Ended')
}

function runStatusLabel(task: ScheduledTask, t: (text: string) => string): string {
  if (task.lastStatus === 'running') return t('Running')
  if (task.lastStatus === 'completed') return t('Completed')
  if (task.lastStatus === 'aborted') return t('Stopped')
  if (task.lastStatus === 'error') return t('Failed')
  return stateLabel(taskState(task), t)
}

function formatDateTime(timestamp: number | undefined): string {
  return timestamp ? new Date(timestamp).toLocaleString() : '—'
}

function formatRelative(timestamp: number, language: AppLanguage): string {
  const difference = timestamp - Date.now()
  const absolute = Math.abs(difference)
  const day = 86_400_000
  const hour = 3_600_000
  const minute = 60_000
  const unit = absolute >= day ? 'day' : absolute >= hour ? 'hour' : absolute >= minute ? 'minute' : 'second'
  const step = unit === 'day' ? day : unit === 'hour' ? hour : unit === 'minute' ? minute : 1_000
  try {
    return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(Math.round(difference / step), unit)
  } catch {
    return ''
  }
}

export function ScheduledTasksDialog() {
  const t = useT()
  const settings = useAppStore((state) => state.settings)
  const runtimeModels = useAppStore((state) => state.models)
  const catalogModels = useAppStore((state) => state.catalogModels)
  const disabledModelSpecs = useAppStore((state) => state.disabledModelSpecs)
  const refreshModelCatalog = useAppStore((state) => state.refreshModelCatalog)
  const models = useMemo(
    () => selectableModels(runtimeModels, catalogModels, disabledModelSpecs),
    [runtimeModels, catalogModels, disabledModelSpecs]
  )
  const modelGroups = useMemo(() => {
    const groups = new Map<string, ModelInfo[]>()
    for (const model of models) {
      const group = groups.get(model.provider)
      if (group) group.push(model)
      else groups.set(model.provider, [model])
    }
    return [...groups]
  }, [models])
  const [modelLevels, setModelLevels] = useState<string[]>([])
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [detailTab, setDetailTab] = useState<DetailTab>('rule')
  const [draft, setDraft] = useState<TaskForm | null>(null)
  const [draftBase, setDraftBase] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [workingId, setWorkingId] = useState<string | null>(null)
  /** Deletion is confirmed inside the detail pane; the desk page never opens a modal. */
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState('')

  const workspaces = settings.workspaces ?? []
  const selectedTask = selectedTaskId
    ? tasks.find((task) => task.id === selectedTaskId)
    : undefined
  const detailOpen = Boolean(draft && (manualOpen || selectedTask))
  const dirty = draft !== null && draftBase !== '' && formKey(draft) !== draftBase
  const detailBusy = Boolean(
    selectedTask &&
    (workingId === selectedTask.id || selectedTask.lastStatus === 'running' || saving)
  )

  // The scheduled page can be the first screen after a restart, before the
  // rest of the app has asked for the saved provider catalog.
  useEffect(() => {
    void refreshModelCatalog()
  }, [refreshModelCatalog])

  // Pi reports the efforts a model supports from its local catalog, so the
  // task can offer the same scale as the composer without starting a process.
  useEffect(() => {
    let cancelled = false
    // The previous model's levels must not describe the new one while its
    // catalog answer is still in flight.
    setModelLevels([])
    const target = draft?.model ? resolveSavedModel(draft.model, undefined, models) : undefined
    if (!target) {
      return () => { cancelled = true }
    }
    const query = window.pi.modelCatalog?.thinkingLevels
    if (typeof query !== 'function') {
      return () => { cancelled = true }
    }
    void query(target.provider, target.id)
      .then((levels) => {
        if (!cancelled) setModelLevels(levels)
      })
      .catch(() => {
        if (!cancelled) setModelLevels([])
      })
    return () => { cancelled = true }
  }, [draft?.model, models])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setTasks(await window.pi.scheduledTasks.list())
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.pi.scheduledTasks.onChanged(setTasks)
    void load()
    return unsubscribe
  }, [load])

  // A task deleted in another window must not leave its detail pane behind.
  useEffect(() => {
    if (!selectedTaskId || loading || manualOpen) return
    if (tasks.some((task) => task.id === selectedTaskId)) return
    setSelectedTaskId(null)
    setDraft(null)
    setDraftBase('')
    setConfirmingDelete(false)
  }, [tasks, selectedTaskId, loading, manualOpen])

  // An untouched detail follows a task another window just changed; a dirty
  // draft is the user's work and is never overwritten.
  useEffect(() => {
    if (!selectedTask || manualOpen || dirty) return
    const base = editForm(selectedTask)
    const key = formKey(base)
    if (key === draftBase) return
    setDraft(base)
    setDraftBase(key)
  }, [selectedTask, manualOpen, dirty, draftBase])

  const openTask = (task: ScheduledTask) => {
    if (!manualOpen && selectedTaskId === task.id) return
    const base = editForm(task)
    setSelectedTaskId(task.id)
    setManualOpen(false)
    setDetailTab('rule')
    setDraft(base)
    setDraftBase(formKey(base))
    setConfirmingDelete(false)
    setError('')
  }

  const openNewTask = () => {
    const base = newForm(workspaces, settings.activeWorkspaceId)
    setSelectedTaskId(null)
    setManualOpen(true)
    setDetailTab('rule')
    setDraft(base)
    setDraftBase(formKey(base))
    setConfirmingDelete(false)
    setError('')
  }

  const closeDetail = () => {
    setSelectedTaskId(null)
    setManualOpen(false)
    setDraft(null)
    setDraftBase('')
    setConfirmingDelete(false)
    setError('')
  }

  const save = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!draft || saving || !dirty) return
    if (!draft.title.trim() || !draft.prompt.trim() || !draft.workspaceId) return
    setSaving(true)
    setError('')
    const input: ScheduledTaskInput = {
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      workspaceId: draft.workspaceId,
      schedule: scheduleFor(draft),
      // An empty control follows the app's saved default, so it stays absent.
      model: draft.model || undefined,
      thinkingLevel: draft.thinkingLevel || undefined
    }
    const previousIds = new Set(tasks.map((task) => task.id))
    try {
      const next = manualOpen
        ? await window.pi.scheduledTasks.create(input)
        : draft.id
          ? await window.pi.scheduledTasks.update(draft.id, input)
          : []
      setTasks(next)
      const target = manualOpen
        ? next.find((task) => !previousIds.has(task.id))
        : next.find((task) => task.id === draft.id)
      if (target) {
        const base = editForm(target)
        setSelectedTaskId(target.id)
        setManualOpen(false)
        setDraft(base)
        setDraftBase(formKey(base))
        setDetailTab('rule')
        if (manualOpen) {
          setSearch('')
          setStatusFilter('all')
        }
      } else {
        closeDetail()
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const perform = async (id: string, action: () => Promise<ScheduledTask[]>): Promise<boolean> => {
    setWorkingId(id)
    setError('')
    try {
      setTasks(await action())
      return true
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      return false
    } finally {
      setWorkingId(null)
    }
  }

  const removeTask = async (task: ScheduledTask) => {
    const removed = await perform(task.id, () => window.pi.scheduledTasks.remove(task.id))
    if (removed) closeDetail()
  }

  const discardDraft = () => {
    if (manualOpen) {
      closeDetail()
      return
    }
    if (!selectedTask) {
      closeDetail()
      return
    }
    const base = editForm(selectedTask)
    setDraft(base)
    setDraftBase(formKey(base))
    setError('')
  }

  const currentWorkspaceName = (id: string) =>
    workspaces.find((workspace) => workspace.id === id)?.name ?? t('Project unavailable')
  const selectedModel = draft?.model ? resolveSavedModel(draft.model, undefined, models) : undefined
  // A model the catalog does not know keeps Pi's full scale rather than
  // hiding an effort that was saved earlier.
  const levelChoices = selectedModel && modelLevels.length > 0
    ? modelLevels
    : [...DEFAULT_THINKING_LEVELS]
  const levelOptions = draft?.thinkingLevel &&
    !levelChoices.some((level) => level.toLowerCase() === draft.thinkingLevel.toLowerCase())
    ? [...levelChoices, draft.thinkingLevel]
    : levelChoices
  const canSubmit = Boolean(draft && dirty && draft.title.trim() && draft.prompt.trim() && draft.workspaceId && !saving)
  const language = settings.language ?? 'en'

  const visibleTasks = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return tasks
      .filter((task) => statusFilter === 'all' || taskState(task) === statusFilter)
      .filter((task) => {
        if (!query) return true
        return [task.title, task.prompt, currentWorkspaceName(task.workspaceId), task.model ?? '']
          .join('\n')
          .toLocaleLowerCase()
          .includes(query)
      })
      .sort((left, right) => {
        const leftTime = left.nextRunAt ?? Number.POSITIVE_INFINITY
        const rightTime = right.nextRunAt ?? Number.POSITIVE_INFINITY
        return leftTime - rightTime
      })
  }, [tasks, statusFilter, search, workspaces])

  const emptyMessage = tasks.length === 0
    ? t('No scheduled tasks yet')
    : search.trim()
      ? t('No matching scheduled tasks')
      : statusFilter === 'active'
        ? t('No active scheduled tasks')
        : statusFilter === 'paused'
          ? t('No paused scheduled tasks')
          : t('No ended scheduled tasks')

  const selectedState = selectedTask ? taskState(selectedTask) : undefined
  const detailStatusText = selectedTask
    ? selectedTask.lastStatus === 'running'
      ? t('Running')
      : stateLabel(selectedState!, t)
    : ''

  return (
    <div className="scheduled-tasks" data-detail={detailOpen ? 'open' : 'closed'}>
      <section className="scheduled-tasks__list-pane" aria-label={t('Scheduled tasks')}>
        <div className="scheduled-tasks__scroll">
          <div className="scheduled-tasks__content">
            <header className="scheduled-tasks__page-head">
              <h1 id="scheduled-tasks-title">{t('Scheduled tasks')}</h1>
              <div className="scheduled-tasks__create-actions">
                <button
                  type="button"
                  className="btn btn--primary scheduled-tasks__new"
                  disabled={workspaces.length === 0}
                  onClick={openNewTask}
                >
                  <Plus size={13} />
                  {t('New task')}
                </button>
              </div>
            </header>

            <div className="scheduled-tasks__filters">
              <div className="scheduled-tasks__filter-tabs" role="group" aria-label={t('Task status')}>
                {STATUS_FILTERS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className="scheduled-tasks__filter"
                    data-active={statusFilter === value}
                    aria-pressed={statusFilter === value}
                    onClick={() => setStatusFilter(value)}
                  >
                    {value === 'all' ? t('All') : stateLabel(value, t)}
                  </button>
                ))}
              </div>
            </div>

            <div className="scheduled-tasks__search">
              <div className="scheduled-tasks__search-field">
                <Search size={14} />
                <input
                  type="search"
                  value={search}
                  aria-label={t('Search scheduled tasks')}
                  placeholder={t('Search scheduled tasks')}
                  onChange={(event) => setSearch(event.target.value)}
                />
                {search ? (
                  <button
                    type="button"
                    className="icon-btn scheduled-tasks__search-clear"
                    aria-label={t('Clear search')}
                    title={t('Clear search')}
                    onClick={() => setSearch('')}
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            </div>

            {error && !detailOpen ? (
              <div className="scheduled-tasks__error"><AlertTriangle size={14} />{error}</div>
            ) : null}

            {workspaces.length === 0 && tasks.length === 0 ? (
              <div className="scheduled-tasks__empty" role="status">
                <Clock className="scheduled-tasks__empty-glyph" size={30} />
                <h2>{t('Add a project before creating a scheduled task.')}</h2>
              </div>
            ) : loading ? (
              <div className="scheduled-tasks__empty" role="status">
                <Loader2 size={16} className="spin" />
                <h2>{t('Loading scheduled tasks…')}</h2>
              </div>
            ) : visibleTasks.length === 0 ? (
              <div className="scheduled-tasks__empty" role="status">
                <Clock className="scheduled-tasks__empty-glyph" size={30} />
                <h2>{emptyMessage}</h2>
                {tasks.length === 0 && workspaces.length > 0 ? (
                  <button type="button" className="btn scheduled-tasks__empty-action" onClick={openNewTask}>
                    {t('New task')}
                  </button>
                ) : null}
              </div>
            ) : (
              <ul className="scheduled-tasks__rows" aria-label={t('Task list')}>
                {visibleTasks.map((task) => {
                  const state = taskState(task)
                  return (
                    <li key={task.id}>
                      <button
                        type="button"
                        className="scheduled-task"
                        data-selected={selectedTaskId === task.id}
                        data-state={state}
                        aria-expanded={selectedTaskId === task.id}
                        onClick={() => openTask(task)}
                      >
                        <Clock className="scheduled-task__glyph" size={16} strokeWidth={1.6} aria-hidden="true" />
                        <span className="scheduled-task__content">
                          <span className="scheduled-task__title">{task.title}</span>
                          <span className="scheduled-task__summary">
                            {state !== 'active' ? (
                              <span className="scheduled-task__meta">{stateLabel(state, t)}</span>
                            ) : null}
                            <span className="scheduled-task__meta">{describeSchedule(task, t)}</span>
                            {state === 'active' && task.nextRunAt ? (
                              <span className="scheduled-task__meta">
                                {t('Next run')}: {formatDateTime(task.nextRunAt)}{' '}
                                <span className="scheduled-task__relative">({formatRelative(task.nextRunAt, language)})</span>
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </section>

      {detailOpen && draft ? (
        <aside
          className="scheduled-detail"
          aria-label={manualOpen ? t('New scheduled task') : t('Task details')}
          aria-busy={detailBusy || saving}
        >
          <div className="scheduled-detail__bar">
            {manualOpen ? (
              <h2 className="scheduled-detail__create-title">{t('New scheduled task')}</h2>
            ) : (
              <div className="scheduled-detail__tabs" role="tablist" aria-label={t('Task details tabs')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === 'rule'}
                  className="scheduled-detail__tab"
                  onClick={() => setDetailTab('rule')}
                >
                  {t('Rule')}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={detailTab === 'records'}
                  className="scheduled-detail__tab"
                  onClick={() => setDetailTab('records')}
                >
                  {t('Run history')}
                </button>
              </div>
            )}
            <div className="scheduled-detail__actions">
              {!manualOpen && selectedTask ? (
                <>
                  <button
                    type="button"
                    className="icon-btn scheduled-detail__icon"
                    aria-label={selectedTask.enabled ? t('Pause') : t('Resume')}
                    title={selectedTask.enabled ? t('Pause') : t('Resume')}
                    disabled={detailBusy || dirty || selectedState === 'ended'}
                    onClick={() => void perform(
                      selectedTask.id,
                      () => window.pi.scheduledTasks.setEnabled(selectedTask.id, !selectedTask.enabled)
                    )}
                  >
                    {selectedTask.enabled ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <Popover
                    align="right"
                    width={180}
                    renderTrigger={({ open, toggle }) => (
                      <button
                        type="button"
                        className="icon-btn scheduled-detail__icon"
                        aria-label={t('More task actions')}
                        title={t('More task actions')}
                        aria-haspopup="menu"
                        aria-expanded={open}
                        disabled={detailBusy}
                        onClick={toggle}
                      >
                        <Ellipsis size={17} />
                      </button>
                    )}
                  >
                    {(close) => (
                      <div role="menu" aria-label={t('More task actions')}>
                        <button
                          type="button"
                          role="menuitem"
                          className="popover__item"
                          disabled={detailBusy || dirty || selectedState === 'ended'}
                          onClick={() => {
                            close()
                            void perform(selectedTask.id, () => window.pi.scheduledTasks.runNow(selectedTask.id))
                          }}
                        >
                          <Play size={15} />
                          {t('Run now')}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="popover__item popover__item--danger"
                          disabled={detailBusy || dirty}
                          onClick={() => {
                            close()
                            setDetailTab('rule')
                            setConfirmingDelete(true)
                          }}
                        >
                          {t('Delete task')}
                        </button>
                      </div>
                    )}
                  </Popover>
                </>
              ) : null}
              <button
                type="button"
                className="icon-btn scheduled-detail__icon"
                aria-label={t('Close details')}
                title={t('Close details')}
                disabled={saving}
                onClick={closeDetail}
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="scheduled-detail__scroll">
            {detailTab === 'records' && selectedTask ? (
              <div className="scheduled-detail__records">
                {selectedTask.lastRunAt ? (
                  <div className="scheduled-detail__record">
                    <div className="scheduled-detail__record-head">
                      <Clock size={14} />
                      <time dateTime={new Date(selectedTask.lastRunAt).toISOString()}>
                        {formatDateTime(selectedTask.lastRunAt)}
                      </time>
                      <span className="scheduled-detail__record-status" data-status={selectedTask.lastStatus}>
                        {runStatusLabel(selectedTask, t)}
                      </span>
                    </div>
                    {selectedTask.lastError ? (
                      <p className="scheduled-detail__record-error">{selectedTask.lastError}</p>
                    ) : null}
                  </div>
                ) : (
                  <div className="scheduled-detail__empty">{t('No run records yet')}</div>
                )}
              </div>
            ) : (
              <>
                {selectedTask && !manualOpen ? (
                  <>
                    <h2 className="scheduled-detail__title">{selectedTask.title}</h2>
                    <div className="scheduled-detail__next">
                      {selectedState === 'active' && selectedTask.nextRunAt ? (
                        <p>
                          {t('Next run')}{' '}
                          <time dateTime={new Date(selectedTask.nextRunAt).toISOString()}>
                            {formatDateTime(selectedTask.nextRunAt)}
                          </time>{' '}
                          <span>({formatRelative(selectedTask.nextRunAt, language)})</span>
                        </p>
                      ) : (
                        <p>{detailStatusText}</p>
                      )}
                    </div>
                  </>
                ) : (
                  <h2 className="scheduled-detail__title">{t('New scheduled task')}</h2>
                )}
                {error ? <div className="scheduled-tasks__error"><AlertTriangle size={14} />{error}</div> : null}
                <form className="scheduled-detail__form" onSubmit={(event) => void save(event)}>
                  <label className="scheduled-detail__field">
                    <span>{t('Task name')}</span>
                    <input
                      className="input"
                      value={draft.title}
                      maxLength={120}
                      autoFocus={manualOpen}
                      onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                      placeholder={t('e.g. Review project health')}
                    />
                  </label>
                  <label className="scheduled-detail__field">
                    <span>{t('Prompt')}</span>
                    <textarea
                      className="input scheduled-tasks__prompt"
                      value={draft.prompt}
                      onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
                      placeholder={t('What should Pi do when this task runs?')}
                      rows={5}
                    />
                  </label>
                  <div className="scheduled-detail__rule-rows">
                    <label className="scheduled-detail__rule-row">
                      <span>{t('Project')}</span>
                      <select
                        className="input settings-select"
                        value={draft.workspaceId}
                        onChange={(event) => setDraft({ ...draft, workspaceId: event.target.value })}
                      >
                        {workspaces.map((workspace) => (
                          <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                        ))}
                      </select>
                    </label>
                    <label className="scheduled-detail__rule-row">
                      <span>{t('Repeat')}</span>
                      <select
                        className="input settings-select"
                        value={draft.kind}
                        onChange={(event) => {
                          const kind = event.target.value as RepeatKind
                          // Switching a recurring task to "once" has to land on a
                          // future moment; the value the form opened with may have
                          // passed while it was being edited.
                          const past = !(new Date(draft.dateTime).getTime() > Date.now())
                          setDraft({
                            ...draft,
                            kind,
                            dateTime: kind === 'once' && past
                              ? localDateTime(Date.now() + 60 * 60 * 1000)
                              : draft.dateTime
                          })
                        }}
                      >
                        <option value="once">{t('Once')}</option>
                        <option value="daily">{t('Daily')}</option>
                        <option value="weekly">{t('Weekly')}</option>
                      </select>
                    </label>
                    {draft.kind === 'once' ? (
                      <label className="scheduled-detail__rule-row">
                        <span>{t('Date and time')}</span>
                        <DateTimeField
                          mode="datetime"
                          value={draft.dateTime}
                          onChange={(dateTime) => setDraft({ ...draft, dateTime })}
                        />
                      </label>
                    ) : (
                      <>
                        {draft.kind === 'weekly' ? (
                          <label className="scheduled-detail__rule-row">
                            <span>{t('Day of week')}</span>
                            <select
                              className="input settings-select"
                              value={draft.weekday}
                              onChange={(event) => setDraft({ ...draft, weekday: Number(event.target.value) })}
                            >
                              {WEEKDAYS.map((day, index) => <option key={day} value={index}>{t(day)}</option>)}
                            </select>
                          </label>
                        ) : null}
                        <label className="scheduled-detail__rule-row">
                          <span>{t('Time')}</span>
                          <DateTimeField
                            mode="time"
                            value={draft.time}
                            onChange={(time) => setDraft({ ...draft, time })}
                          />
                        </label>
                      </>
                    )}
                    <label className="scheduled-detail__rule-row">
                      <span>{t('Model')}</span>
                      <select
                        className="input settings-select"
                        value={draft.model}
                        onChange={(event) =>
                          setDraft({ ...draft, model: event.target.value, thinkingLevel: '' })}
                      >
                        <option value="">{t('Follow app default')}</option>
                        {modelGroups.map(([provider, list]) => (
                          <optgroup key={provider} label={provider}>
                            {list.map((model) => (
                              <option key={modelSpec(model)} value={modelSpec(model)}>
                                {model.name || model.id}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                        {draft.model && !models.some((model) => modelSpec(model) === draft.model) ? (
                          <option value={draft.model}>{draft.model}</option>
                        ) : null}
                      </select>
                    </label>
                    <label className="scheduled-detail__rule-row">
                      <span>{t('Reasoning effort')}</span>
                      <select
                        className="input settings-select"
                        value={draft.thinkingLevel}
                        onChange={(event) => setDraft({ ...draft, thinkingLevel: event.target.value })}
                      >
                        <option value="">{t('Follow app default')}</option>
                        {levelOptions.map((level) => (
                          <option key={level} value={level}>{t(levelLabel(level))}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {draft.id && draft.kind === 'once' && new Date(draft.dateTime).getTime() <= Date.now() ? (
                    <p className="scheduled-tasks__hint" data-warning="true">
                      <Clock size={13} />
                      {t('This one-time task has already run. Pick a future date to run it again.')}
                    </p>
                  ) : null}
                  <p className="scheduled-tasks__hint">
                    <Clock size={13} />
                    {t('Every run starts a new conversation in this project. Times use your system local time.')}
                  </p>
                </form>
                {confirmingDelete ? (
                  <div className="scheduled-task__confirm">
                    <span>{t('Delete this scheduled task?')}</span>
                    <button
                      type="button"
                      className="btn btn--sm btn--danger"
                      disabled={detailBusy}
                      onClick={() => selectedTask && void removeTask(selectedTask)}
                    >
                      {t('Delete')}
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => setConfirmingDelete(false)}
                    >
                      {t('Cancel')}
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>

          {detailTab === 'rule' ? (
            <footer className="scheduled-detail__footer">
              <span className="scheduled-detail__footer-note">
                {dirty ? t('Unsaved changes') : ''}
              </span>
              <button type="button" className="btn btn--sm" disabled={saving} onClick={discardDraft}>
                {manualOpen ? t('Cancel') : t('Discard')}
              </button>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={!canSubmit}
                onClick={() => void save()}
              >
                {saving ? <Loader2 size={13} className="spin" /> : null}
                {saving
                  ? manualOpen ? t('Creating…') : t('Saving…')
                  : manualOpen ? t('Create task') : t('Save changes')}
              </button>
            </footer>
          ) : null}
        </aside>
      ) : null}
    </div>
  )
}

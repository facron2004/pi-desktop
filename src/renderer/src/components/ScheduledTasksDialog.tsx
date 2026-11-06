import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { AlertTriangle, Clock, Loader2, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react'
import type { ScheduledTask, ScheduledTaskInput, ScheduledTaskSchedule, Workspace } from '@shared/types'
import { DateTimeField } from './DateTimeField'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import '../styles/scheduled-tasks.css'

type RepeatKind = 'once' | 'daily' | 'weekly'

interface TaskForm {
  id?: string
  title: string
  prompt: string
  workspaceId: string
  kind: RepeatKind
  dateTime: string
  time: string
  weekday: number
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

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
    kind: task.schedule.kind,
    dateTime: localDateTime(task.schedule.kind === 'once' ? task.schedule.at : Date.now() + 60 * 60 * 1000),
    time: task.schedule.kind === 'once' ? '09:00' : task.schedule.time,
    weekday: task.schedule.kind === 'weekly' ? task.schedule.weekday : 1
  }
  if (task.schedule.kind === 'daily') form.time = task.schedule.time
  return form
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

function statusLabel(task: ScheduledTask, t: (text: string) => string): string {
  if (task.lastStatus === 'running') return t('Running')
  if (task.schedule.kind === 'once' && task.enabled) return t('Enabled')
  if (task.schedule.kind !== 'once' && !task.enabled) return t('Paused')
  if (task.lastStatus === 'completed') return t('Completed')
  if (task.lastStatus === 'aborted') return t('Stopped')
  if (task.lastStatus === 'error') return t('Failed')
  return task.enabled ? t('Enabled') : t('Paused')
}

export function ScheduledTasksDialog() {
  const t = useT()
  const settings = useAppStore((state) => state.settings)
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<TaskForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [workingId, setWorkingId] = useState<string | null>(null)
  /** Row awaiting a second click. No native or modal dialog on this page. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [error, setError] = useState('')

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

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!form) return
    setSaving(true)
    setError('')
    const input: ScheduledTaskInput = {
      title: form.title,
      prompt: form.prompt,
      workspaceId: form.workspaceId,
      schedule: scheduleFor(form)
    }
    try {
      const next = form.id
        ? await window.pi.scheduledTasks.update(form.id, input)
        : await window.pi.scheduledTasks.create(input)
      setTasks(next)
      setForm(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const perform = async (id: string, action: () => Promise<ScheduledTask[]>) => {
    setWorkingId(id)
    setError('')
    try {
      setTasks(await action())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setWorkingId(null)
    }
  }

  const workspaces = settings.workspaces ?? []
  const currentWorkspaceName = (id: string) => workspaces.find((workspace) => workspace.id === id)?.name ?? t('Project unavailable')

  return (
      <div
        className="scheduled-tasks"
        aria-labelledby="scheduled-tasks-title"
      >
        <div className="modal__head scheduled-tasks__head">
          <div className="scheduled-tasks__heading">
            <h2 id="scheduled-tasks-title" className="modal__title">
              {form ? (form.id ? t('Edit scheduled task') : t('New scheduled task')) : t('Scheduled tasks')}
            </h2>
            {!form ? <span className="scheduled-tasks__count">{tasks.length}</span> : null}
          </div>
          <div className="scheduled-tasks__head-actions">
            {!form && workspaces.length > 0 ? (
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  setForm(newForm(workspaces, settings.activeWorkspaceId))
                  setConfirmingId(null)
                  setError('')
                }}
              >
                <Plus size={14} />
                {t('New task')}
              </button>
            ) : null}
          </div>
        </div>

        {form ? (
          <form className="scheduled-tasks__form" onSubmit={(event) => void save(event)}>
            <div className="scheduled-tasks__form-body">
              <label className="scheduled-tasks__field">
                <span>{t('Task name')}</span>
                <input
                  className="input"
                  value={form.title}
                  maxLength={120}
                  autoFocus
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  placeholder={t('e.g. Review project health')}
                />
              </label>
              <label className="scheduled-tasks__field">
                <span>{t('Project')}</span>
                <select
                  className="input settings-select"
                  value={form.workspaceId}
                  onChange={(event) => setForm({ ...form, workspaceId: event.target.value })}
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                  ))}
                </select>
              </label>
              <label className="scheduled-tasks__field">
                <span>{t('Prompt')}</span>
                <textarea
                  className="input scheduled-tasks__prompt"
                  value={form.prompt}
                  onChange={(event) => setForm({ ...form, prompt: event.target.value })}
                  placeholder={t('What should Pi do when this task runs?')}
                  rows={5}
                />
              </label>
              <div className="scheduled-tasks__schedule-fields">
                <label className="scheduled-tasks__field">
                  <span>{t('Repeat')}</span>
                  <select
                    className="input settings-select"
                    value={form.kind}
                    onChange={(event) => setForm({ ...form, kind: event.target.value as RepeatKind })}
                  >
                    <option value="once">{t('Once')}</option>
                    <option value="daily">{t('Daily')}</option>
                    <option value="weekly">{t('Weekly')}</option>
                  </select>
                </label>
                {form.kind === 'once' ? (
                  <label className="scheduled-tasks__field">
                    <span>{t('Date and time')}</span>
                    <DateTimeField
                      mode="datetime"
                      value={form.dateTime}
                      onChange={(dateTime) => setForm({ ...form, dateTime })}
                    />
                  </label>
                ) : (
                  <>
                    {form.kind === 'weekly' ? (
                      <label className="scheduled-tasks__field">
                        <span>{t('Day of week')}</span>
                        <select
                          className="input settings-select"
                          value={form.weekday}
                          onChange={(event) => setForm({ ...form, weekday: Number(event.target.value) })}
                        >
                          {WEEKDAYS.map((day, index) => <option key={day} value={index}>{t(day)}</option>)}
                        </select>
                      </label>
                    ) : null}
                    <label className="scheduled-tasks__field">
                      <span>{t('Time')}</span>
                      <DateTimeField
                        mode="time"
                        value={form.time}
                        onChange={(time) => setForm({ ...form, time })}
                      />
                    </label>
                  </>
                )}
              </div>
              <p className="scheduled-tasks__hint">
                <Clock size={13} />
                {t('Every run starts a new conversation in this project. Times use your system local time.')}
              </p>
            </div>
            <div className="modal__foot">
              <button type="button" className="btn" disabled={saving} onClick={() => setForm(null)}>
                {t('Cancel')}
              </button>
              <button type="submit" className="btn btn--primary" disabled={saving || workspaces.length === 0}>
                {saving ? <Loader2 size={13} className="spin" /> : null}
                {form.id ? t('Save changes') : t('Create task')}
              </button>
            </div>
          </form>
        ) : (
          <div className="scheduled-tasks__body">
            <div className="scheduled-tasks__notice">
              <Clock size={14} />
              {t('Tasks run while Pi Desktop is open. Each run starts a new conversation.')}
            </div>
            {error ? <div className="scheduled-tasks__error"><AlertTriangle size={14} />{error}</div> : null}
            {workspaces.length === 0 ? (
              <div className="scheduled-tasks__empty">{t('Add a project before creating a scheduled task.')}</div>
            ) : loading ? (
              <div className="scheduled-tasks__empty"><Loader2 size={14} className="spin" />{t('Loading scheduled tasks…')}</div>
            ) : tasks.length === 0 ? (
              <div className="scheduled-tasks__empty">
                <Clock size={22} />
                <strong>{t('No scheduled tasks yet')}</strong>
                <span>{t('Create a task to have Pi work on a project later.')}</span>
              </div>
            ) : (
              <div className="scheduled-tasks__list">
                {tasks.map((task) => {
                  const busy = workingId === task.id || task.lastStatus === 'running'
                  const cannotResume = !task.enabled && task.schedule.kind === 'once' && task.schedule.at <= Date.now()
                  return (
                    <article className="scheduled-task" key={task.id} data-enabled={task.enabled}>
                      <div className="scheduled-task__main">
                        <div className="scheduled-task__title-row">
                          <strong>{task.title}</strong>
                          <span className="scheduled-task__status" data-status={task.lastStatus ?? (task.enabled ? 'enabled' : 'paused')}>
                            {statusLabel(task, t)}
                          </span>
                        </div>
                        <div className="scheduled-task__meta">
                          <span>{currentWorkspaceName(task.workspaceId)}</span>
                          <span>{describeSchedule(task, t)}</span>
                          {task.nextRunAt && task.enabled ? (
                            <span>{t('Next run')}: {new Date(task.nextRunAt).toLocaleString()}</span>
                          ) : null}
                          {task.lastRunAt ? <span>{t('Last run')}: {new Date(task.lastRunAt).toLocaleString()}</span> : null}
                        </div>
                        {task.lastError ? <div className="scheduled-task__error">{task.lastError}</div> : null}
                      </div>
                      <div className="scheduled-task__actions">
                        <button
                          className="icon-btn"
                          type="button"
                          title={t('Run now')}
                          aria-label={t('Run now')}
                          disabled={busy}
                          onClick={() => void perform(task.id, () => window.pi.scheduledTasks.runNow(task.id))}
                        >
                          {workingId === task.id ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
                        </button>
                        <button
                          className="icon-btn"
                          type="button"
                          title={t(task.enabled ? 'Pause' : 'Resume')}
                          aria-label={t(task.enabled ? 'Pause' : 'Resume')}
                          disabled={busy || cannotResume}
                          onClick={() => void perform(task.id, () => window.pi.scheduledTasks.setEnabled(task.id, !task.enabled))}
                        >
                          {task.enabled ? <Pause size={14} /> : <Play size={14} />}
                        </button>
                        <button
                          className="icon-btn"
                          type="button"
                          title={t('Edit')}
                          aria-label={t('Edit')}
                          disabled={busy}
                          onClick={() => { setForm(editForm(task)); setConfirmingId(null); setError('') }}
                        >
                          <Pencil size={14} />
                        </button>
                        {confirmingId === task.id ? (
                          <div className="scheduled-task__confirm">
                            <span>{t('Delete this scheduled task?')}</span>
                            <button
                              type="button"
                              className="btn btn--sm btn--danger"
                              disabled={busy}
                              onClick={() => {
                                setConfirmingId(null)
                                void perform(task.id, () => window.pi.scheduledTasks.remove(task.id))
                              }}
                            >
                              {t('Delete')}
                            </button>
                            <button
                              type="button"
                              className="btn btn--sm"
                              onClick={() => setConfirmingId(null)}
                            >
                              {t('Cancel')}
                            </button>
                          </div>
                        ) : (
                          <button
                            className="icon-btn scheduled-task__delete"
                            type="button"
                            title={t('Delete')}
                            aria-label={t('Delete')}
                            disabled={busy}
                            onClick={() => setConfirmingId(task.id)}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </div>
                    </article>
                  )
                })}
              </div>
            )}
          </div>
        )}
        {error && form ? <div className="scheduled-tasks__form-error"><AlertTriangle size={14} />{error}</div> : null}
      </div>
  )
}

import { useCallback, useEffect, useId, useState } from 'react'
import { Maximize2, Pause, Play, Trash2 } from 'lucide-react'
import { GOAL_STATUS_KEY, type AppLanguage } from '@shared/types'
import { readGoalStatus } from '@shared/task-mode-state'
import { goalBadge, goalCanToggleRun } from '@shared/goal-display'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { formatElapsed } from './conversation/RunSummary'
import { Popover } from './Popover'
import { GoalTargetIcon } from './GoalTargetIcon'
import '../styles/goal.css'

/**
 * Goal Mode's objective, as one line above the composer.
 *
 * The goal itself belongs to the Pi extension and arrives as a status line;
 * this bar only projects it and sends the extension's own commands back
 * through `runTaskCommand`, so the extension stays the single owner.
 */
export function GoalBar() {
  const rawGoal = useAppStore((state) => state.uiStatuses.find((entry) => entry.key === GOAL_STATUS_KEY)?.text)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const agentMode = useAppStore((state) => state.agentMode)
  const runStartedAt = useAppStore((state) => state.run.startedAt)
  const runSettled = useAppStore((state) => state.run.settled)
  const runDurationMs = useAppStore((state) => state.run.durationMs)
  const language = useAppStore((state) => state.settings.language ?? 'en') as AppLanguage
  const t = useT()
  const [now, setNow] = useState(() => Date.now())

  // The elapsed time beside the objective ticks while a run is live and holds
  // at its settled duration afterwards, the same rule as the run summary.
  useEffect(() => {
    if (runSettled || runStartedAt === undefined) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [runStartedAt, runSettled])

  const elapsedMs =
    runStartedAt === undefined
      ? undefined
      : runSettled
        ? runDurationMs
        : Math.max(0, now - runStartedAt)
  const elapsed = elapsedMs === undefined ? undefined : formatElapsed(elapsedMs, language)
  const detailsId = useId()
  const focusDetails = useCallback((panel: HTMLDivElement | null) => {
    panel?.focus({ preventScroll: true })
  }, [])
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [pending, setPending] = useState(false)

  const goal = readGoalStatus(rawGoal)
  const goalText = goal?.text

  // A recalled branch or another command can replace the goal in this chat.
  // An editor opened for the previous objective must close with it.
  useEffect(() => {
    setEditing(false)
    setDraft('')
  }, [goalText])

  if (!goal) return null

  // A restored objective may still say active even though its run is gone.
  const running = goal.status === 'active' && agentMode === 'goal' && isStreaming
  // Two words, because the bar answers one question: is this goal being worked
  // on right now? A goal the extension paused and a goal nobody is running are
  // the same thing to the reader, so both read "Paused". `blocked` and
  // `complete` keep their own word 鈥?they are outcomes, not a run state.
  const badge = goalBadge(goal.status, running)
  const displayStatus = badge.status
  const canToggleRun = goalCanToggleRun(badge)
  const summary =
    goal.status === 'blocked' || goal.status === 'complete' ? goal.summary : undefined
  // Extension-authored reasons arrive in English; translate the ones the
  // desktop itself wrote and leave a model-written blocker exactly as it is.
  const summaryText = summary ? t(summary) : undefined

  const startEdit = () => {
    setDraft(goal.text)
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft('')
  }

  const runGoalAction = async (action: string) => {
    if (pending) return
    setPending(true)
    try {
      return await useAppStore.getState().runTaskCommand('/desktop-goal ' + action)
    } finally {
      setPending(false)
    }
  }

  const saveEdit = async () => {
    const text = draft.trim()
    if (!text || pending) return
    if (text === goal.text) {
      cancelEdit()
      return
    }
    const savedGoal = readGoalStatus(await runGoalAction('edit ' + text))
    if (savedGoal?.text === text) cancelEdit()
  }

  return (
    <div className="goal-bar" data-status={displayStatus} role="group" aria-label={t('Goal')}>
      <div className="goal-bar__inner" data-editing={editing ? 'true' : undefined}>
        <div className="goal-bar__head">
          <span className="goal-bar__label">
            <GoalTargetIcon className="goal-bar__icon" size={15} />
            <span className="goal-bar__status" data-status={displayStatus}>
              {t(badge.label)}
            </span>
          </span>

          {editing ? null : (
            <>
              <button
                type="button"
                className="goal-bar__objective"
                title={t('Edit')}
                onClick={startEdit}
              >
                {goal.text}
              </button>
              {elapsed ? <span className="goal-bar__elapsed">· {elapsed}</span> : null}
              {summaryText ? <span className="goal-bar__summary" title={summaryText}>· {summaryText}</span> : null}

              <div className="goal-bar__actions">
                <button
                  type="button"
                  className="goal-bar__action goal-bar__action--icon"
                  title={t('Delete')}
                  aria-label={t('Delete')}
                  disabled={isStreaming || pending}
                  onClick={() => void runGoalAction('clear')}
                >
                  <Trash2 size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="goal-bar__action goal-bar__action--icon"
                  title={t(running ? 'Pause' : 'Resume')}
                  aria-label={t(running ? 'Pause' : 'Resume')}
                  disabled={!canToggleRun || pending || (!running && isStreaming)}
                  onClick={() => void runGoalAction(running ? 'pause' : 'resume')}
                >
                  {running ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                </button>
                <Popover
                  placement="bottom"
                  width={420}
                  className="goal-details-popover"
                  renderTrigger={({ open, toggle }) => (
                    <button
                      type="button"
                      className="goal-bar__action goal-bar__action--icon"
                      title={t('Goal details')}
                      aria-label={t('Goal details')}
                      aria-haspopup="dialog"
                      aria-expanded={open}
                      aria-controls={open ? detailsId : undefined}
                      onClick={toggle}
                    >
                      <Maximize2 size={14} aria-hidden="true" />
                    </button>
                  )}
                >
                  {() => (
                    <div id={detailsId} className="goal-details" role="dialog" aria-label={t('Goal details')}
                      tabIndex={-1} ref={focusDetails}>
                      <div className="goal-details__label">{t('Goal')}</div>
                      <p className="goal-details__text">{goal.text}</p>
                      <button type="button" className="goal-bar__action" onClick={startEdit}>
                        {t('Edit')}
                      </button>
                      {summaryText ? (
                        <>
                          <div className="goal-details__label">
                            {t(goal.status === 'blocked' ? 'Blocker' : 'Completion summary')}
                          </div>
                          <p className="goal-details__text">{summaryText}</p>
                        </>
                      ) : null}
                    </div>
                  )}
                </Popover>
              </div>
            </>
          )}
        </div>

        {editing ? (
          <div className="goal-bar__editor">
            <textarea
              className="goal-bar__input"
              value={draft}
              rows={2}
              autoFocus
              readOnly={pending}
              aria-label={t('Edit')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  if (!pending) cancelEdit()
                  return
                }
                if (event.key !== 'Enter') return
                // Enter confirming an IME candidate is composition, not a save.
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
                // A plain Enter (or Ctrl/Cmd+Enter) saves; Shift+Enter keeps
                // the line break for a goal that needs several lines.
                if (event.shiftKey) return
                event.preventDefault()
                void saveEdit()
              }}
            />
            <div className="goal-bar__editor-actions">
              <button
                type="button"
                className="goal-bar__action"
                data-tone="primary"
                disabled={pending || !draft.trim()}
                onClick={() => void saveEdit()}
              >
                {t('Save')}
              </button>
              <button type="button" className="goal-bar__action" disabled={pending} onClick={cancelEdit}>
                {t('Cancel')}
              </button>
            </div>
            <span className="goal-bar__hint">
              {t('Enter to save 路 Shift+Enter for a new line 路 Esc to cancel')}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

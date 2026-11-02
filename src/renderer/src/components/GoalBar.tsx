import { useState } from 'react'
import { Pause, Pencil, Play, Target, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import '../styles/goal.css'

/** The status key the task-modes extension publishes its goal state under. */
const GOAL_STATUS_KEY = 'pi-desktop-goal'

type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete'

interface GoalState {
  text: string
  status: GoalStatus
  summary?: string
}

const STATUS_LABEL: Record<GoalStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  blocked: 'Blocked',
  complete: 'Complete'
}

/**
 * The extension publishes the goal as JSON on a status line, so a malformed
 * or partial value is a normal cold-start state, not an error to show.
 */
function parseGoal(raw: string | undefined): GoalState | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return null
    const record = value as Record<string, unknown>
    const text = typeof record.text === 'string' ? record.text.trim() : ''
    if (!text) return null
    const status = record.status
    if (status !== 'active' && status !== 'paused' && status !== 'blocked' && status !== 'complete') {
      return null
    }
    const summary =
      typeof record.summary === 'string' && record.summary.trim() ? record.summary : undefined
    return { text, status, summary }
  } catch {
    // An unreadable status line is the same as no goal at all.
    return null
  }
}

/**
 * Goal Mode's objective, as one line above the composer.
 *
 * The goal itself belongs to the Pi extension and arrives as a status line;
 * this bar only projects it and sends the extension's own commands back
 * through `runTaskCommand`, so the extension stays the single owner.
 */
export function GoalBar() {
  const uiStatuses = useAppStore((state) => state.uiStatuses)
  const runTaskCommand = useAppStore((state) => state.runTaskCommand)
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const goal = parseGoal(uiStatuses.find((entry) => entry.key === GOAL_STATUS_KEY)?.text)

  if (!goal) return null

  const summary =
    goal.status === 'blocked' || goal.status === 'complete' ? goal.summary : undefined
  const title = summary ? `${goal.text}\n${summary}` : goal.text

  const startEdit = () => {
    setDraft(goal.text)
    setEditing(true)
  }

  const cancelEdit = () => {
    setEditing(false)
    setDraft('')
  }

  const saveEdit = () => {
    const text = draft.trim()
    if (!text) return
    setEditing(false)
    setDraft('')
    void runTaskCommand('/desktop-goal edit ' + text)
  }

  return (
    <div className="goal-bar" data-status={goal.status} role="group" aria-label={t('Goal')}>
      <div className="goal-bar__inner">
        <div className="goal-bar__head">
          <span className="goal-bar__label">
            <Target size={13} className="goal-bar__icon" aria-hidden="true" />
            <span>{t('Goal')}</span>
          </span>
          <span className="goal-bar__badge" data-status={goal.status}>
            {t(STATUS_LABEL[goal.status])}
          </span>

          {editing ? null : (
            <>
              <span className="goal-bar__objective" title={title}>
                {goal.text}
              </span>
              {summary ? (
                <span className="goal-bar__summary" title={summary}>
                  {summary}
                </span>
              ) : null}
              <div className="goal-bar__actions">
                {goal.status === 'active' ? (
                  <button
                    type="button"
                    className="goal-bar__action"
                    title={t('Pause')}
                    aria-label={t('Pause')}
                    onClick={() => void runTaskCommand('/desktop-goal pause')}
                  >
                    <Pause size={12} aria-hidden="true" />
                    <span>{t('Pause')}</span>
                  </button>
                ) : null}
                {goal.status === 'paused' || goal.status === 'blocked' ? (
                  <button
                    type="button"
                    className="goal-bar__action"
                    title={t('Resume')}
                    aria-label={t('Resume')}
                    onClick={() => void runTaskCommand('/desktop-goal resume')}
                  >
                    <Play size={12} aria-hidden="true" />
                    <span>{t('Resume')}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="goal-bar__action"
                  title={t('Edit')}
                  aria-label={t('Edit')}
                  onClick={startEdit}
                >
                  <Pencil size={12} aria-hidden="true" />
                  <span>{t('Edit')}</span>
                </button>
                <button
                  type="button"
                  className="goal-bar__action"
                  data-tone="danger"
                  title={t('Clear')}
                  aria-label={t('Clear')}
                  onClick={() => void runTaskCommand('/desktop-goal clear')}
                >
                  <X size={12} aria-hidden="true" />
                  <span>{t('Clear')}</span>
                </button>
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
              aria-label={t('Edit')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelEdit()
                } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  saveEdit()
                }
              }}
            />
            <div className="goal-bar__editor-actions">
              <button
                type="button"
                className="goal-bar__action"
                data-tone="primary"
                disabled={!draft.trim()}
                onClick={saveEdit}
              >
                {t('Save')}
              </button>
              <button type="button" className="goal-bar__action" onClick={cancelEdit}>
                {t('Cancel')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

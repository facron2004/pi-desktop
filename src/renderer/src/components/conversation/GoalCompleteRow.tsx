import { CheckCircle2, Trash2 } from 'lucide-react'
import { GOAL_STATUS_KEY } from '@shared/types'
import { readGoalStatus } from '@shared/task-mode-state'
import { useAppStore } from '../../store/useAppStore'
import { useConversationScope, useSessionViewSlice } from '../../lib/conversation-scope'
import { useT } from '../../lib/i18n'

/**
 * A finished goal, as the conversation's closing statement.
 *
 * Goal Mode owns the objective, so this row only projects the status line the
 * extension publishes. A completed goal needs no controls above the composer:
 * the work is over, and the bar that used to sit there for the rest of the
 * session was a header for a conversation that no longer had a goal running.
 * The finished objective belongs at the end of the transcript, where the turn
 * that completed it ends — the same place a turn's file changes close out.
 *
 * `clear` stays available because it is the only way to retire the row; it is
 * the extension's own command, so the extension stays the single owner.
 */
export function GoalCompleteRow() {
  const scope = useConversationScope()
  const view = useSessionViewSlice()
  const raw = view.uiStatuses.find((entry) => entry.key === GOAL_STATUS_KEY)?.text
  const t = useT()
  const goal = readGoalStatus(raw)
  if (!goal || goal.status !== 'complete') return null
  const summary = goal.summary?.trim()

  return (
    <div className="goal-done" role="status" data-status="complete">
      <span className="goal-done__mark" aria-hidden="true">
        <CheckCircle2 size={15} strokeWidth={1.8} />
      </span>
      <div className="goal-done__body">
        <div className="goal-done__head">
          <span className="goal-done__label">{t('Goal complete')}</span>
          <button
            type="button"
            className="goal-done__clear"
            title={t('Clear goal')}
            aria-label={t('Clear goal')}
            onClick={() =>
              void useAppStore
                .getState()
                .runTaskCommand(
                  '/desktop-goal clear',
                  scope.surface === 'main' ? scope.sessionKey : (scope.sessionKey ?? '')
                )
            }
          >
            <Trash2 size={12} aria-hidden="true" />
          </button>
        </div>
        <p className="goal-done__objective" title={goal.text}>{goal.text}</p>
        {summary ? <p className="goal-done__summary">{t(summary)}</p> : null}
      </div>
    </div>
  )
}

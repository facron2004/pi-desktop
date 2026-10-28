import { useMemo } from 'react'
import { CheckCircle2, CircleDashed, ListTodo } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { extractPlan } from '../lib/plan'
import { useT } from '../lib/i18n'

/**
 * The checklist of the current conversation.
 *
 * Pi has no task API; the plan the model writes is a markdown checklist in an
 * assistant message, and `PlanStrip` already projects it with `extractPlan`.
 * This panel is the same projection with the steps as rows — one projection,
 * no second copy of the state, so a step ticked in the conversation is ticked
 * here too.
 */
export function TaskPanel() {
  const t = useT()
  const items = useAppStore((state) => state.items)
  const plan = useMemo(() => extractPlan(items), [items])

  if (!plan || plan.entries.length === 0) {
    return (
      <div className="task-panel">
        <div className="task-panel__empty">
          <ListTodo size={20} />
          <span>{t('No checklist in this conversation yet')}</span>
          <span className="task-panel__hint">
            {t('When Pi writes a plan as a checklist, its steps show up here.')}
          </span>
        </div>
      </div>
    )
  }

  const done = plan.entries.filter((entry) => entry.done).length

  return (
    <div className="task-panel">
      <div className="task-panel__summary">
        {done} / {plan.entries.length} {t('done')}
      </div>
      <ul className="task-panel__list">
        {plan.entries.map((entry, index) => (
          <li key={`${index}-${entry.text}`} className="task-panel__row" data-done={entry.done || undefined}>
            {entry.done ? <CheckCircle2 size={14} /> : <CircleDashed size={14} />}
            <span>{entry.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

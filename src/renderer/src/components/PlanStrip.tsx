import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, Circle, ListChecks, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { extractPlan } from '../lib/plan'
import { useT } from '../lib/i18n'

/** Where the strip remembers what the user did with the plan on screen. */
const STORAGE_KEY = 'pi-desktop.plan-strip'

const LIST_ID = 'plan-strip-entries'

interface StripPreference {
  /** The message the plan was read from; a new plan starts over. */
  sourceId: string
  collapsed: boolean
  dismissed: boolean
}

function readPreference(): StripPreference | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as Partial<StripPreference> | null
    if (!stored || typeof stored.sourceId !== 'string') return null
    return {
      sourceId: stored.sourceId,
      collapsed: stored.collapsed === true,
      dismissed: stored.dismissed === true
    }
  } catch {
    // An unreadable value is the same as no value at all.
    return null
  }
}

function writePreference(preference: StripPreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preference))
  } catch {
    // A private window or a full quota; the strip works without remembering.
  }
}

/**
 * The agent's plan, as a strip above the composer.
 *
 * The plan is markdown the agent already wrote, so the strip reads it back out
 * of the thread instead of asking for a channel of its own. Collapsing and
 * dismissing are view preferences and live here, tied to the message the plan
 * came from — a new plan opens again on its own.
 */
export function PlanStrip() {
  const items = useAppStore((state) => state.items)
  const t = useT()
  const plan = useMemo(() => extractPlan(items), [items])
  const [preference, setPreference] = useState<StripPreference | null>(readPreference)

  useEffect(() => {
    if (preference) writePreference(preference)
  }, [preference])

  const sourceId = plan?.sourceId
  const own = preference && preference.sourceId === sourceId ? preference : null
  const collapsed = own?.collapsed === true
  const dismissed = own?.dismissed === true

  const change = useCallback(
    (patch: Partial<Omit<StripPreference, 'sourceId'>>) => {
      if (!sourceId) return
      setPreference((current) => {
        const base: StripPreference =
          current && current.sourceId === sourceId
            ? current
            : { sourceId, collapsed: false, dismissed: false }
        return { ...base, ...patch }
      })
    },
    [sourceId]
  )

  if (!plan || dismissed) return null

  const currentIndex = plan.entries.findIndex((entry) => !entry.done)
  const complete = currentIndex === -1
  const progress = `${Math.round((plan.done / plan.total) * 100)}%`

  return (
    <div className="plan-strip" data-collapsed={collapsed}>
      <div className="plan-strip__inner">
        <div className="plan-strip__head" role="status">
          <button
            className="plan-strip__toggle"
            aria-expanded={!collapsed}
            aria-controls={LIST_ID}
            title={collapsed ? t('Show the plan') : t('Hide the plan')}
            onClick={() => change({ collapsed: !collapsed })}
          >
            <ListChecks size={13} className="plan-strip__icon" aria-hidden="true" />
            <span className="plan-strip__count">
              {plan.done}/{plan.total}
            </span>
            <span className="plan-strip__label" data-complete={complete}>
              {complete ? t('All steps complete') : plan.entries[currentIndex].text}
            </span>
            <ChevronDown
              size={12}
              className="plan-strip__caret"
              data-open={!collapsed}
              aria-hidden="true"
            />
          </button>
          <button
            className="plan-strip__dismiss"
            title={t('Dismiss the plan')}
            aria-label={t('Dismiss the plan')}
            onClick={() => change({ dismissed: true })}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>

        <div
          className="plan-strip__progress"
          role="progressbar"
          aria-label={t('Plan progress')}
          aria-valuemin={0}
          aria-valuemax={plan.total}
          aria-valuenow={plan.done}
        >
          <span
            className="plan-strip__progress-fill"
            data-complete={complete}
            style={{ width: progress }}
          />
        </div>

        <ul className="plan-strip__entries" id={LIST_ID} hidden={collapsed}>
          {plan.entries.map((entry, index) => (
            <li
              className="plan-strip__entry"
              key={`${index}:${entry.text}`}
              data-done={entry.done}
              data-current={index === currentIndex}
            >
              <span className="plan-strip__mark" aria-hidden="true">
                {entry.done ? <Check size={11} strokeWidth={3} /> : <Circle size={8} />}
              </span>
              <span className="plan-strip__text">{entry.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

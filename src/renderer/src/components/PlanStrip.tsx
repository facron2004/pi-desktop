import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  Circle,
  Copy,
  ListChecks,
  MessageSquarePlus,
  X
} from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { extractPlan, type PlanEntry } from '../lib/plan'
import { useT } from '../lib/i18n'

/** Where the strip remembers what the user did with the plan on screen. */
const STORAGE_KEY = 'pi-desktop.plan-strip'

const LIST_ID = 'plan-strip-entries'

interface StripPreference {
  /** The message the plan was read from; a new plan starts over. */
  sourceId: string
  collapsed: boolean
  dismissed: boolean
  completionHandled: boolean
}

function readPreference(): StripPreference | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const stored = JSON.parse(raw) as Partial<StripPreference> | null
    if (!stored || typeof stored.sourceId !== 'string') return null
    return {
      sourceId: stored.sourceId,
      collapsed: stored.collapsed !== false,
      dismissed: stored.dismissed === true,
      completionHandled: stored.completionHandled === true
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
 * The plan the way the agent wrote it: a markdown checklist, one step a line,
 * so it can go back to a message or into the editor unchanged.
 */
function checklistMarkdown(entries: PlanEntry[]): string {
  return entries.map((entry) => `- [${entry.done ? 'x' : ' '}] ${entry.text}`).join('\n')
}

/**
 * The agent's plan, as a strip above the composer.
 *
 * The plan is markdown the agent already wrote, so the strip reads it back out
 * of the thread instead of asking for a channel of its own. Collapsing and
 * dismissing are view preferences and live here, tied to the message the plan
 * came from — a new plan returns as a compact summary.
 */
export function PlanStrip() {
  const items = useAppStore((state) => state.items)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()
  const plan = useMemo(() => extractPlan(items), [items])
  const [preference, setPreference] = useState<StripPreference | null>(readPreference)
  // The copy button says what it just did for a moment, the way the other
  // copy buttons in the app do.
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<number | null>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (preference) writePreference(preference)
  }, [preference])

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const sourceId = plan?.sourceId
  const complete = plan !== null && plan.done === plan.total
  const own = preference && preference.sourceId === sourceId ? preference : null
  const collapsed = own?.collapsed !== false
  const dismissed = own?.dismissed === true

  const change = useCallback(
    (patch: Partial<Omit<StripPreference, 'sourceId'>>) => {
      if (!sourceId) return
      setPreference((current) => {
        const base: StripPreference =
          current && current.sourceId === sourceId
            ? current
            : { sourceId, collapsed: true, dismissed: false, completionHandled: false }
        return { ...base, ...patch }
      })
    },
    [sourceId]
  )

  useEffect(() => {
    if (complete && !own?.completionHandled) {
      // A completion folds once; a manual reopen must survive later renders.
      const focused = document.activeElement
      if (focused instanceof HTMLElement && focused.closest('.plan-strip__entries, .plan-strip__actions')) {
        toggleRef.current?.focus()
      }
      change({ collapsed: true, completionHandled: true })
    } else if (!complete && own?.completionHandled) {
      change({ completionHandled: false })
    }
  }, [complete, own?.completionHandled, change])

  if (!plan || dismissed) return null

  const currentIndex = plan.entries.findIndex((entry) => !entry.done)
  const progress = `${Math.round((plan.done / plan.total) * 100)}%`

  const copyPlan = async () => {
    try {
      await navigator.clipboard.writeText(checklistMarkdown(plan.entries))
      setCopied(true)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopied(false), 1400)
      showToast(t('The plan was copied'))
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }

  // The plan goes into the composer rather than out as a message: what to say
  // about it is the user's, and the strip stays a projection of the thread
  // instead of a second copy of it.
  const putPlanInComposer = () => {
    // `insertIntoComposer` trims its input, so the newline only tells the
    // composer where the plan ends when there is already text there.
    insertIntoComposer(`${checklistMarkdown(plan.entries)}\n`)
    showToast(t('The plan is in the composer'))
  }

  return (
    <div className="plan-strip" data-collapsed={collapsed}>
      <div className="plan-strip__inner">
        <div className="plan-strip__head" role="status">
          <button
            ref={toggleRef}
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
              <button
                type="button"
                className="plan-strip__step"
                title={t('Put this step in the composer')}
                aria-label={`${t('Put this step in the composer')}: ${entry.text}`}
                onClick={() => insertIntoComposer(entry.text)}
              >
                <span className="plan-strip__mark" aria-hidden="true">
                  {entry.done ? <Check size={11} strokeWidth={3} /> : <Circle size={8} />}
                </span>
                <span className="plan-strip__text">{entry.text}</span>
              </button>
            </li>
          ))}
        </ul>

        {collapsed ? null : (
          <div className="plan-strip__actions">
            <button
              type="button"
              className="plan-strip__action"
              data-copied={copied ? 'true' : undefined}
              title={t('Copy the plan')}
              aria-label={t('Copy the plan')}
              onClick={() => void copyPlan()}
            >
              {copied ? (
                <Check size={11} aria-hidden="true" />
              ) : (
                <Copy size={11} aria-hidden="true" />
              )}
              <span>{copied ? t('Copied') : t('Copy the plan')}</span>
            </button>
            <button
              type="button"
              className="plan-strip__action"
              title={t('Put the plan in the composer')}
              aria-label={t('Put the plan in the composer')}
              onClick={putPlanInComposer}
            >
              <MessageSquarePlus size={11} aria-hidden="true" />
              <span>{t('Put the plan in the composer')}</span>
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

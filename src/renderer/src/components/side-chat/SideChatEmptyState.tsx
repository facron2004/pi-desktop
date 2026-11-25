import { memo, useMemo } from 'react'
import {
  Activity,
  CircleAlert,
  FileDiff,
  ListTodo,
  MessageSquareText,
  MessagesSquare,
  type LucideIcon
} from 'lucide-react'
import { GOAL_STATUS_KEY, type SideChatPresetKind } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { buildMainSyncSummary } from '../../lib/side-chat-context'
import { useT } from '../../lib/i18n'

export interface SideChatEmptyStateProps {
  onSelectPreset: (preset: SideChatPresetKind, options?: { autoSend?: boolean }) => void
}

interface QuickPresetCard {
  preset: SideChatPresetKind
  label: string
  icon: LucideIcon
  tone?: 'danger' | 'accent'
}

export const SideChatEmptyState = memo(function SideChatEmptyState({
  onSelectPreset
}: SideChatEmptyStateProps) {
  const t = useT()
  const mainItemCount = useAppStore((state) => state.items.length)
  const mainIsStreaming = useAppStore((state) => state.isStreaming)
  const mainRunPhase = useAppStore((state) => state.run.phase)
  const mainRunSettled = useAppStore((state) => state.run.settled)
  const mainRunOutcome = useAppStore((state) => state.run.outcome)
  const mainRunHadError = useAppStore((state) => Boolean(state.run.hadError))
  const mainCompacting = useAppStore((state) => Boolean(state.run.compaction))
  const mainError = useAppStore((state) => state.error)
  const activeToolsRevision = useAppStore((state) => state.activeToolsRevision)
  const rawGoal = useAppStore(
    (state) => state.uiStatuses.find((entry) => entry.key === GOAL_STATUS_KEY)?.text
  )
  const dirtyWorktreeCount = useAppStore((state) =>
    state.git?.isRepo ? state.git.files.length : 0
  )

  const summary = useMemo(() => {
    const state = useAppStore.getState()
    return buildMainSyncSummary({
      items: state.items,
      isStreaming: state.isStreaming,
      run: state.run,
      error: state.error,
      uiStatuses: state.uiStatuses,
      git: state.git
    })
  }, [
    mainItemCount,
    mainIsStreaming,
    mainRunPhase,
    mainRunSettled,
    mainRunOutcome,
    mainRunHadError,
    mainCompacting,
    mainError,
    activeToolsRevision,
    rawGoal,
    dirtyWorktreeCount
  ])

  const cards = useMemo<QuickPresetCard[]>(() => {
    const next: QuickPresetCard[] = []
    if (summary.mode === 'streaming') {
      next.push({
        preset: 'explain-live',
        label: t('Explain what main chat is doing'),
        icon: Activity,
        tone: 'accent'
      })
    }
    if (summary.hasError) {
      next.push({
        preset: 'diagnose-error',
        label: t('Diagnose the latest error'),
        icon: CircleAlert,
        tone: 'danger'
      })
    }
    if (mainItemCount > 0) {
      next.push({
        preset: 'summarize-main',
        label: t('Summarize progress and key decisions'),
        icon: MessageSquareText
      })
    }
    if (summary.goalText || summary.planTotal !== undefined) {
      next.push({
        preset: 'breakdown-plan',
        label: t('Break down ongoing items'),
        icon: ListTodo
      })
    }
    if (summary.changedFileCount > 0 || summary.dirtyWorktreeCount > 0) {
      next.push({
        preset: summary.changedFileCount > 0 ? 'review-session' : 'review-worktree',
        label: t('Review code changes'),
        icon: FileDiff
      })
    }
    if (next.length === 0) {
      next.push(
        {
          preset: 'explain-live',
          label: t('Explain what main chat is doing'),
          icon: Activity
        },
        {
          preset: 'review-worktree',
          label: t('Review code changes'),
          icon: FileDiff
        }
      )
    }
    return next
  }, [mainItemCount, summary, t])

  return (
    <div className="side-empty">
      <div className="side-empty__inner">
        <span className="side-empty__glyph" aria-hidden="true">
          <MessagesSquare size={20} strokeWidth={1.6} aria-hidden="true" />
        </span>
        <h3 className="side-empty__title">{t('Side chat')}</h3>
        <p className="side-empty__desc">
          {t(
            'Ask questions, break down tasks, or review changes without interrupting the main chat.'
          )}
        </p>

        <div className="side-empty__chips" role="group" aria-label={t('Suggested actions')}>
          {cards.map((card) => {
            const Icon = card.icon
            return (
              <button
                key={card.preset}
                type="button"
                className="side-empty__chip"
                data-tone={card.tone}
                onClick={(event) =>
                  onSelectPreset(card.preset, { autoSend: !event.shiftKey })
                }
              >
                <Icon size={14} className="side-empty__chip-icon" aria-hidden="true" />
                <span className="side-empty__chip-label">{card.label}</span>
              </button>
            )
          })}
        </div>

        <p className="side-empty__hint">
          {t('Click to run · Shift+Click to edit before sending')}
        </p>
      </div>
    </div>
  )
})

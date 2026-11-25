import { memo, useMemo } from 'react'
import { Eye, GitBranch, Layers, ListChecks, Target } from 'lucide-react'
import { GOAL_STATUS_KEY } from '@shared/types'
import { useAppStore } from '../../store/useAppStore'
import { activeConversationTitle } from '../../lib/live-sessions'
import { buildMainSyncSummary } from '../../lib/side-chat-context'
import { useT } from '../../lib/i18n'
import { Popover } from '../Popover'

export const SideChatSyncPill = memo(function SideChatSyncPill() {
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
  const mainTitle = useAppStore(
    (state) =>
      state.piState?.sessionName ||
      activeConversationTitle(
        state.sessions,
        state.threads,
        state.activeSessionFile ?? state.draftId
      ) ||
      state.workspace?.name ||
      ''
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

  const pillText = useMemo(() => {
    if (summary.mode === 'streaming') {
      if (summary.activeVerb) {
        return `${t('Synced')} · ${t(summary.activeVerb)}`
      }
      return t('Synced · Main turn {n} running').replace(
        '{n}',
        String(Math.max(1, summary.turnCount))
      )
    }
    if (summary.mode === 'settled') {
      const base = t('Synced · {n} turns').replace('{n}', String(summary.turnCount))
      return summary.changedFileCount > 0
        ? `${base} · ${summary.changedFileCount} ${t('changed')}`
        : base
    }
    return t('Linked to workspace')
  }, [summary, t])

  return (
    <Popover
      placement="bottom"
      align="left"
      width={280}
      className="side-sync-popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className="side-sync-pill"
          data-mode={summary.mode}
          data-active={open || undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={pillText}
          aria-label={pillText}
          onClick={toggle}
        >
          <span className="side-sync-pill__dot" aria-hidden="true" />
          <span className="side-sync-pill__label">{pillText}</span>
        </button>
      )}
    >
      {() => (
        <div
          className="side-sync-card"
          role="dialog"
          aria-label={t('Main conversation sync')}
        >
          <div className="side-sync-card__head">
            <span className="side-sync-card__title">
              {mainTitle || t('Main conversation')}
            </span>
            <span className="side-sync-card__badge">
              <Eye size={11} aria-hidden="true" />
              <span>{t('Read-only')}</span>
            </span>
          </div>
          <p className="side-sync-card__note">
            {t(
              'Side chat reads the latest main conversation context on every question, including live turns.'
            )}
          </p>
          <div className="side-sync-card__rows">
            <div className="side-sync-card__row">
              <span className="side-sync-card__key">
                <Layers size={12} aria-hidden="true" />
                <span>{t('Synced turns')}</span>
              </span>
              <strong className="side-sync-card__val">{summary.turnCount}</strong>
            </div>
            {summary.goalText ? (
              <div className="side-sync-card__row side-sync-card__row--stack">
                <span className="side-sync-card__key">
                  <Target size={12} aria-hidden="true" />
                  <span>{t('Goal')}</span>
                </span>
                <span className="side-sync-card__goal" title={summary.goalText}>
                  {summary.goalText}
                </span>
              </div>
            ) : null}
            {summary.planTotal !== undefined ? (
              <div className="side-sync-card__row">
                <span className="side-sync-card__key">
                  <ListChecks size={12} aria-hidden="true" />
                  <span>{t('Progress')}</span>
                </span>
                <strong className="side-sync-card__val">
                  {summary.planDone ?? 0}/{summary.planTotal}
                </strong>
              </div>
            ) : null}
            <div className="side-sync-card__row">
              <span className="side-sync-card__key">
                <GitBranch size={12} aria-hidden="true" />
                <span>{t('Conversation changes')}</span>
              </span>
              <strong className="side-sync-card__val">{summary.changedFileCount}</strong>
            </div>
            <div className="side-sync-card__row">
              <span className="side-sync-card__key">
                <span>{t('Working tree')}</span>
              </span>
              <strong className="side-sync-card__val">{summary.dirtyWorktreeCount}</strong>
            </div>
            <div className="side-sync-card__row">
              <span className="side-sync-card__key">
                <span>{t('Tools')}</span>
              </span>
              <code className="side-sync-card__tools">read, grep, find, ls</code>
            </div>
          </div>
        </div>
      )}
    </Popover>
  )
})

import { memo, useMemo, useState } from 'react'
import { ChevronDown, FileDiff, ListTodo, RotateCcw } from 'lucide-react'
import { GOAL_STATUS_KEY, type SideChatPresetKind } from '@shared/types'
import { readGoalStatus } from '@shared/task-mode-state'
import { countChangedFiles } from '../../lib/changes'
import { useAppStore } from '../../store/useAppStore'
import { useSessionViewSlice } from '../../lib/conversation-scope'
import { useT } from '../../lib/i18n'
import { ConfirmDialog } from '../ConfirmDialog'
import { Popover } from '../Popover'
import { SideChatSyncPill } from './SideChatSyncPill'

export interface SideChatHeaderProps {
  sideSessionKey?: string
  onRunPreset: (preset: SideChatPresetKind, options?: { autoSend?: boolean }) => void
  onClear: () => void
}

export const SideChatHeader = memo(function SideChatHeader({
  sideSessionKey,
  onRunPreset,
  onClear
}: SideChatHeaderProps) {
  const t = useT()
  const slice = useSessionViewSlice(sideSessionKey)
  const resolvedSideKey = sideSessionKey ?? slice.sessionKey
  const sideItemCount = slice.items.length
  const sideStreaming = slice.isStreaming
  const hasDraftOrRefs = useAppStore((state) => {
    if (!resolvedSideKey) return false
    const draft = state.drafts[resolvedSideKey]
    const quotes = state.sideQuotes?.[resolvedSideKey]
    return Boolean(
      draft?.text.trim() ||
        (draft?.images?.length ?? 0) > 0 ||
        (draft?.files?.length ?? 0) > 0 ||
        (quotes?.length ?? 0) > 0
    )
  })
  const mainItemCount = useAppStore((state) => state.items.length)
  const activeToolsRevision = useAppStore((state) => state.activeToolsRevision)
  const rawGoal = useAppStore(
    (state) => state.uiStatuses.find((entry) => entry.key === GOAL_STATUS_KEY)?.text
  )
  const worktreeChangedCount = useAppStore((state) =>
    state.git?.isRepo ? state.git.files.length : 0
  )

  const sessionChangedCount = useMemo(
    () => countChangedFiles(useAppStore.getState().items),
    [activeToolsRevision, mainItemCount]
  )

  const hasGoal = Boolean(readGoalStatus(rawGoal))
  const canBreakdown = mainItemCount > 0 || hasGoal
  const hasAnyChanges = sessionChangedCount > 0 || worktreeChangedCount > 0
  const hasBothReviewScopes = sessionChangedCount > 0 && worktreeChangedCount > 0
  const canClear = sideItemCount > 0 || sideStreaming || hasDraftOrRefs

  const [confirmClearOpen, setConfirmClearOpen] = useState(false)

  const handleRequestClear = () => {
    if (!canClear) return
    if (sideItemCount > 0) {
      setConfirmClearOpen(true)
      return
    }
    onClear()
  }

  const reviewLabel = t('Review')
  const reviewDisabledTitle = `${reviewLabel} — ${t('No files have been changed yet.')}`
  const breakdownLabel = t('Break down')
  const breakdownDisabledTitle = `${breakdownLabel} — ${t('Start the main conversation first')}`
  const clearLabel = t('Clear side chat')

  return (
    <header className="side-chat__head">
      <SideChatSyncPill />

      <div className="side-chat__head-actions">
        {hasBothReviewScopes ? (
          <Popover
            placement="bottom"
            align="right"
            width={268}
            className="side-review-popover"
            renderTrigger={({ open, toggle }) => (
              <button
                type="button"
                className="side-chat__action-btn"
                data-active={open || undefined}
                aria-haspopup="menu"
                aria-expanded={open}
                title={reviewLabel}
                aria-label={reviewLabel}
                onClick={toggle}
              >
                <FileDiff size={14} aria-hidden="true" />
                <span className="side-chat__btn-label">{reviewLabel}</span>
                <ChevronDown size={11} className="side-chat__btn-caret" aria-hidden="true" />
              </button>
            )}
          >
            {(close) => (
              <div role="menu" aria-label={t('Review code changes')}>
                <button
                  type="button"
                  role="menuitem"
                  className="popover__item"
                  onClick={(event) => {
                    close()
                    onRunPreset('review-session', { autoSend: !event.shiftKey })
                  }}
                >
                  <FileDiff size={14} aria-hidden="true" />
                  <span className="popover__item-text">
                    {t('Review conversation changes ({n} files)').replace(
                      '{n}',
                      String(sessionChangedCount)
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="popover__item"
                  onClick={(event) => {
                    close()
                    onRunPreset('review-worktree', { autoSend: !event.shiftKey })
                  }}
                >
                  <FileDiff size={14} aria-hidden="true" />
                  <span className="popover__item-text">
                    {t('Review working tree ({n} files)').replace(
                      '{n}',
                      String(worktreeChangedCount)
                    )}
                  </span>
                </button>
              </div>
            )}
          </Popover>
        ) : (
          <button
            type="button"
            className="side-chat__action-btn"
            aria-disabled={!hasAnyChanges || undefined}
            title={hasAnyChanges ? reviewLabel : reviewDisabledTitle}
            aria-label={reviewLabel}
            onClick={(event) => {
              if (!hasAnyChanges) {
                event.preventDefault()
                return
              }
              const targetPreset: SideChatPresetKind =
                sessionChangedCount > 0 ? 'review-session' : 'review-worktree'
              onRunPreset(targetPreset, { autoSend: !event.shiftKey })
            }}
            onKeyDown={(event) => {
              if (!hasAnyChanges && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault()
              }
            }}
          >
            <FileDiff size={14} aria-hidden="true" />
            <span className="side-chat__btn-label">{reviewLabel}</span>
          </button>
        )}

        <button
          type="button"
          className="side-chat__action-btn"
          aria-disabled={!canBreakdown || undefined}
          title={canBreakdown ? breakdownLabel : breakdownDisabledTitle}
          aria-label={breakdownLabel}
          onClick={(event) => {
            if (!canBreakdown) {
              event.preventDefault()
              return
            }
            onRunPreset('breakdown-plan', { autoSend: !event.shiftKey })
          }}
          onKeyDown={(event) => {
            if (!canBreakdown && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
            }
          }}
        >
          <ListTodo size={14} aria-hidden="true" />
          <span className="side-chat__btn-label">{breakdownLabel}</span>
        </button>

        <button
          type="button"
          className="icon-btn side-chat__clear-btn"
          aria-disabled={!canClear || undefined}
          title={clearLabel}
          aria-label={clearLabel}
          onClick={(event) => {
            if (!canClear) {
              event.preventDefault()
              return
            }
            handleRequestClear()
          }}
          onKeyDown={(event) => {
            if (!canClear && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
            }
          }}
        >
          <RotateCcw size={14} aria-hidden="true" />
        </button>
      </div>

      {confirmClearOpen ? (
        <ConfirmDialog
          title={t('Clear this side chat?')}
          body={t(
            'This starts a fresh side chat for the current conversation. The main conversation is not affected.'
          )}
          confirmLabel={t('Clear side chat')}
          tone="danger"
          onConfirm={() => {
            setConfirmClearOpen(false)
            onClear()
          }}
          onCancel={() => setConfirmClearOpen(false)}
        />
      ) : null}
    </header>
  )
})

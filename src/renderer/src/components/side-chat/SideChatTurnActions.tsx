import { memo, useCallback, useMemo, useState } from 'react'
import { Check, Copy, CornerDownLeft, ListPlus, Sparkles } from 'lucide-react'
import type { Turn } from '../../lib/turns'
import { cleanReplyForHandoff, extractActionablePrompts } from '../../lib/side-chat-context'
import { useConversationScope } from '../../lib/conversation-scope'
import { useAppStore } from '../../store/useAppStore'
import { useT } from '../../lib/i18n'

function isReviewTurn(turn: Turn, markdown: string): boolean {
  const userText = turn.user?.text ?? ''
  if (
    /\b(code review|review the|uncommitted|working-tree|files changed)\b/i.test(userText) ||
    /(审查|代码审查|改动|未提交变更)/.test(userText)
  ) {
    return true
  }
  if (turn.user?.sideRefs?.some((ref) => ref.kind === 'file-diff')) return true
  return /\[P[0-3]\]/i.test(markdown)
}

function turnAssistantMarkdown(turn: Turn): string {
  const blocks: string[] = []
  for (const assistant of turn.assistants) {
    for (const block of assistant.blocks) {
      if (block.type === 'text' && block.text.trim()) {
        blocks.push(block.text.trim())
      }
    }
  }
  return blocks.join('\n\n')
}

export interface SideChatTurnActionsProps {
  turn: Turn
  sideSessionKey?: string
  mainRunOpen: boolean
}

export const SideChatTurnActions = memo(function SideChatTurnActions({
  turn,
  sideSessionKey,
  mainRunOpen
}: SideChatTurnActionsProps) {
  const t = useT()
  const handoffSideToMain = useAppStore((state) => state.handoffSideToMain)
  const showToast = useAppStore((state) => state.showToast)

  const markdown = useMemo(() => turnAssistantMarkdown(turn), [turn])
  const handoffText = useMemo(() => cleanReplyForHandoff(markdown), [markdown])
  const hasPromptBlocks = useMemo(
    () => extractActionablePrompts(markdown).length > 0,
    [markdown]
  )
  const reviewMode = useMemo(() => isReviewTurn(turn, markdown), [turn, markdown])

  const [busy, setBusy] = useState(false)

  const handleInsert = useCallback(async () => {
    if (!handoffText || busy) return
    setBusy(true)
    try {
      await handoffSideToMain({
        sideSessionKey,
        text: handoffText,
        mode: 'draft-append'
      })
      window.dispatchEvent(
        new CustomEvent('pi:focus-composer', { detail: { target: 'main' } })
      )
    } finally {
      setBusy(false)
    }
  }, [busy, handoffSideToMain, handoffText, sideSessionKey])

  const handleQueue = useCallback(async () => {
    if (!mainRunOpen || !handoffText || busy) return
    setBusy(true)
    try {
      const outcome = await handoffSideToMain({
        sideSessionKey,
        text: handoffText,
        mode: 'queue-followup'
      })
      if (outcome === 'queued') {
        showToast(t('Queued for the next turn in main chat'))
      }
    } finally {
      setBusy(false)
    }
  }, [busy, handoffSideToMain, handoffText, mainRunOpen, showToast, sideSessionKey, t])

  if (!handoffText) return null

  const insertLabel = t(
    reviewMode ? 'Send fix suggestions to main composer' : 'Insert into main composer'
  )
  const queueLabel = t(
    reviewMode ? 'Queue fixes in main chat' : 'Queue in main chat'
  )
  const disabledQueueReason = t(
    'Available while main chat is running — queues after the current turn'
  )
  const queueTitle = mainRunOpen ? queueLabel : `${queueLabel} — ${disabledQueueReason}`

  return (
    <div
      className="side-chat__turn-actions"
      data-has-prompt-blocks={hasPromptBlocks || undefined}
      role="group"
      aria-label={t('Send to main conversation')}
    >
      <button
        type="button"
        className="side-chat__turn-btn"
        title={insertLabel}
        aria-label={insertLabel}
        onClick={() => void handleInsert()}
      >
        <CornerDownLeft size={13} aria-hidden="true" />
        <span className="side-chat__btn-label">{insertLabel}</span>
      </button>

      <button
        type="button"
        className="side-chat__turn-btn side-chat__turn-btn--queue"
        aria-disabled={!mainRunOpen || undefined}
        title={queueTitle}
        aria-label={queueTitle}
        onClick={(event) => {
          if (!mainRunOpen) {
            event.preventDefault()
            return
          }
          void handleQueue()
        }}
        onKeyDown={(event) => {
          if (!mainRunOpen && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault()
          }
        }}
      >
        <ListPlus size={13} aria-hidden="true" />
        <span className="side-chat__btn-label">{queueLabel}</span>
      </button>
    </div>
  )
})

/**
 * Fenced ```` ```prompt ```` card rendered inside Side Chat replies (`Markdown.tsx`)
 * for Break-down steps and Review fix instructions.
 */
export const SideChatActionCard = memo(function SideChatActionCard({
  code
}: {
  code: string
}) {
  const t = useT()
  const scope = useConversationScope()
  const handoffSideToMain = useAppStore((state) => state.handoffSideToMain)
  const showToast = useAppStore((state) => state.showToast)
  const mainRunOpen = useAppStore(
    (state) =>
      state.isStreaming ||
      Boolean(state.run.compaction) ||
      (state.run.phase !== 'idle' && !state.run.settled)
  )
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const trimmed = code.trim()

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(trimmed)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard may be unavailable */
    }
  }

  const insertPrompt = async () => {
    if (!trimmed || busy) return
    setBusy(true)
    try {
      await handoffSideToMain({
        sideSessionKey: scope.sessionKey,
        text: trimmed,
        mode: 'draft-append'
      })
      window.dispatchEvent(
        new CustomEvent('pi:focus-composer', { detail: { target: 'main' } })
      )
    } finally {
      setBusy(false)
    }
  }

  const queuePrompt = async () => {
    if (!mainRunOpen || !trimmed || busy) return
    setBusy(true)
    try {
      const outcome = await handoffSideToMain({
        sideSessionKey: scope.sessionKey,
        text: trimmed,
        mode: 'queue-followup'
      })
      if (outcome === 'queued') {
        showToast(t('Queued for the next turn in main chat'))
      }
    } finally {
      setBusy(false)
    }
  }

  const insertLabel = t('Insert into main composer')
  const queueLabel = t('Queue in main chat')
  const disabledQueueReason = t(
    'Available while main chat is running — queues after the current turn'
  )
  const queueTitle = mainRunOpen ? queueLabel : `${queueLabel} — ${disabledQueueReason}`

  return (
    <div className="side-action-card">
      <div className="side-action-card__bar">
        <span className="side-action-card__title">
          <Sparkles size={12} aria-hidden="true" />
          <span>{t('Prompt for main chat')}</span>
        </span>
        <div className="side-action-card__tools">
          <button
            type="button"
            className="side-action-card__btn"
            title={insertLabel}
            aria-label={insertLabel}
            onClick={() => void insertPrompt()}
          >
            <CornerDownLeft size={12} aria-hidden="true" />
            <span className="side-chat__btn-label">{insertLabel}</span>
          </button>
          <button
            type="button"
            className="side-action-card__btn side-action-card__btn--queue"
            aria-disabled={!mainRunOpen || undefined}
            title={queueTitle}
            aria-label={queueTitle}
            onClick={(event) => {
              if (!mainRunOpen) {
                event.preventDefault()
                return
              }
              void queuePrompt()
            }}
            onKeyDown={(event) => {
              if (!mainRunOpen && (event.key === 'Enter' || event.key === ' ')) {
                event.preventDefault()
              }
            }}
          >
            <ListPlus size={12} aria-hidden="true" />
            <span className="side-chat__btn-label">{queueLabel}</span>
          </button>
          <button
            type="button"
            className="side-action-card__icon"
            onClick={() => void copyPrompt()}
            title={copied ? t('Copied') : t('Copy prompt')}
            aria-label={copied ? t('Copied') : t('Copy prompt')}
          >
            {copied ? (
              <Check size={12} aria-hidden="true" />
            ) : (
              <Copy size={12} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      <pre className="side-action-card__code">
        <code>{trimmed}</code>
      </pre>
    </div>
  )
})

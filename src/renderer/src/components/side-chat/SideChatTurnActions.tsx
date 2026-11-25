import { memo, useState } from 'react'
import { Check, Copy, CornerDownLeft, ListPlus, Sparkles } from 'lucide-react'
import { useConversationScope } from '../../lib/conversation-scope'
import { useAppStore } from '../../store/useAppStore'
import { useT } from '../../lib/i18n'

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

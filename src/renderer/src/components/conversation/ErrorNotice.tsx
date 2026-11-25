import { CircleAlert, MessagesSquare, X } from 'lucide-react'
import { useT } from '../../lib/i18n'

export interface ErrorNoticeProps {
  /** The error text shown to the reader. */
  message: string
  /** The full error, when `message` is a friendlier summary. */
  title?: string
  /** Optional Side Chat diagnostic trigger on Main conversation errors. */
  onAskSideChat?: () => void
}

/**
 * The inline error row for an answer.
 *
 * It keeps the `notice` class so the existing notice stylesheet applies,
 * and it is deliberately one row: the failure belongs to the answer that
 * stopped, not to the whole conversation.
 */
export function ErrorNotice({ message, title, onAskSideChat }: ErrorNoticeProps) {
  const t = useT()
  return (
    <div className="notice" data-level="error" role="alert" title={title}>
      <CircleAlert size={14} className="notice__icon" aria-hidden="true" />
      <span>{message}</span>
      {onAskSideChat ? (
        <button
          type="button"
          className="notice__ask-side"
          onClick={onAskSideChat}
          title={t('Diagnose in Side Chat')}
          aria-label={t('Diagnose in Side Chat')}
        >
          <MessagesSquare size={12} aria-hidden="true" />
          <span>{t('Diagnose in Side Chat')}</span>
        </button>
      ) : null}
    </div>
  )
}

export interface ThreadErrorBannerProps {
  /** The error text shown to the reader. */
  message: string
  onDismiss?: () => void
  onAskSideChat?: () => void
}

/**
 * The thread-level error banner.
 *
 * A transport or session failure is not an assistant message, so it sits
 * below the turns as its own dismissible banner. The class names are the ones
 * the thread stylesheet already carries.
 */
export function ThreadErrorBanner({ message, onDismiss, onAskSideChat }: ThreadErrorBannerProps) {
  const t = useT()
  return (
    <div className="thread-error-banner" role="alert">
      <div className="thread-error-banner__content">
        <CircleAlert size={16} className="thread-error-banner__icon" aria-hidden="true" />
        <span className="thread-error-banner__text">{t(message)}</span>
      </div>
      <div className="thread-error-banner__actions">
        {onAskSideChat ? (
          <button
            type="button"
            className="thread-error-banner__ask-side"
            onClick={onAskSideChat}
            title={t('Diagnose in Side Chat')}
            aria-label={t('Diagnose in Side Chat')}
          >
            <MessagesSquare size={13} aria-hidden="true" />
            <span>{t('Diagnose in Side Chat')}</span>
          </button>
        ) : null}
        {onDismiss ? (
          <button
            className="icon-btn thread-error-banner__dismiss"
            onClick={onDismiss}
            aria-label={t('Dismiss')}
            title={t('Dismiss')}
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  )
}

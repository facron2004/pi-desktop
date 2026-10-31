import { CircleAlert, X } from 'lucide-react'
import { useT } from '../../lib/i18n'

export interface ErrorNoticeProps {
  /** The error text shown to the reader. */
  message: string
  /** The full error, when `message` is a friendlier summary. */
  title?: string
}

/**
 * The inline error row under an answer.
 *
 * It keeps the `notice` class so the existing notice stylesheet applies,
 * and it is deliberately one row: the failure belongs to the answer that
 * stopped, not to the whole conversation.
 */
export function ErrorNotice({ message, title }: ErrorNoticeProps) {
  return (
    <div className="notice" data-level="error" role="alert" title={title}>
      <CircleAlert size={14} className="notice__icon" />
      <span>{message}</span>
    </div>
  )
}

export interface ThreadErrorBannerProps {
  /** The error text shown to the reader. */
  message: string
  onDismiss?: () => void
}

/**
 * The thread-level error banner.
 *
 * A transport or session failure is not an assistant message, so it sits
 * below the turns as its own dismissible banner. The class names are the ones
 * the thread stylesheet already carries.
 */
export function ThreadErrorBanner({ message, onDismiss }: ThreadErrorBannerProps) {
  const t = useT()
  return (
    <div className="thread-error-banner" role="alert">
      <div className="thread-error-banner__content">
        <CircleAlert size={16} className="thread-error-banner__icon" />
        <span className="thread-error-banner__text">{message}</span>
      </div>
      {onDismiss ? (
        <button
          className="icon-btn thread-error-banner__dismiss"
          onClick={onDismiss}
          aria-label={t('Dismiss')}
          title={t('Dismiss')}
        >
          <X size={14} />
        </button>
      ) : null}
    </div>
  )
}

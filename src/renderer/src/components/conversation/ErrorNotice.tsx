import { CircleAlert, X } from 'lucide-react'
import { useT } from '../../lib/i18n'

export interface ErrorNoticeProps {
  /** The error text shown to the reader. */
  message: string
  /** The full error, when `message` is a friendlier summary. */
  title?: string
}

/**
 * The inline error row for an answer.
 *
 * It keeps the `notice` class so the existing notice stylesheet applies, and it
 * is deliberately one compact row: the failure belongs to the answer that
 * stopped, not to the whole conversation. A provider error can be a paragraph,
 * so the row is clamped to two lines and the full text stays in its tooltip —
 * the notice is a flag, not a report, and the actions that used to sit beside
 * the text (copy, diagnose in Side Chat) pushed the line count up without being
 * what the reader needs at that moment.
 */
export function ErrorNotice({ message, title }: ErrorNoticeProps) {
  return (
    <div className="notice" data-level="error" role="alert" title={title ?? message}>
      <CircleAlert size={14} className="notice__icon" aria-hidden="true" />
      <span className="notice__text">{message}</span>
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
 * A transport or session failure is not an assistant message, so it sits below
 * the turns as its own dismissible banner. The class names are the ones the
 * thread stylesheet already carries. It is clamped like the inline notice: two
 * lines of error and a way to dismiss it.
 */
export function ThreadErrorBanner({ message, onDismiss }: ThreadErrorBannerProps) {
  const t = useT()
  return (
    <div className="thread-error-banner" role="alert">
      <div className="thread-error-banner__content">
        <CircleAlert size={16} className="thread-error-banner__icon" aria-hidden="true" />
        <span className="thread-error-banner__text" title={message}>{t(message)}</span>
      </div>
      {onDismiss ? (
        <div className="thread-error-banner__actions">
          <button
            className="icon-btn thread-error-banner__dismiss"
            onClick={onDismiss}
            aria-label={t('Dismiss')}
            title={t('Dismiss')}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

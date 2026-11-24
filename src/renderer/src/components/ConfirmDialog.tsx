import { X } from 'lucide-react'
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'

interface ConfirmDialogProps {
  className?: string
  title: string
  body: string
  /** A quiet second line, e.g. the version a notice is about. */
  detail?: string
  confirmLabel?: string
  /** `null` asks nothing: the dialog is then a single-button notice. */
  cancelLabel?: string | null
  tone?: 'danger' | 'default'
  onConfirm: () => void
  onCancel: () => void
}

/**
 * One question, asked over whatever is on screen.
 *
 * The layer is portalled to `body` instead of rendering where the caller sits.
 * A `position: fixed` child is laid out against the nearest ancestor that
 * creates a containing block — a transform, a filter, `will-change` — and
 * settings pages, panels and menus are exactly the places that grow one, so a
 * confirmation opened from inside the settings dialog used to be centred on
 * that card instead of the window. Portalling keeps every confirmation centred
 * on the window it is asking about.
 */
export function ConfirmDialog({
  className,
  title,
  body,
  detail,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const t = useT()
  useDialogFocus(dialogRef, onCancel)
  return createPortal(
    <div className="modal-layer" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className={className ? `modal modal--narrow ${className}` : 'modal modal--narrow'}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="confirm-title" className="modal__title">{title}</h2>
          <button
            className="icon-btn"
            type="button"
            onClick={onCancel}
            aria-label={t('Close')}
            title={t('Close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="modal__body">
          <p className="confirm__body">{body}</p>
          {detail ? <p className="confirm__detail">{detail}</p> : null}
        </div>

        <div className="modal__foot">
          {cancelLabel === null ? null : (
            <button className="btn" onClick={onCancel}>
              {t(cancelLabel)}
            </button>
          )}
          <button
            className={tone === 'danger' ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={onConfirm}
          >
            {t(confirmLabel)}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

import { AlertTriangle } from 'lucide-react'
import { useRef } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'

interface ConfirmDialogProps {
  title: string
  body: string
  confirmLabel?: string
  tone?: 'danger' | 'default'
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Confirm',
  tone = 'default',
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const t = useT()
  useDialogFocus(dialogRef, onCancel)
  return (
    <div className="modal-layer" onMouseDown={onCancel}>
      <div
        ref={dialogRef}
        className="modal modal--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="confirm-title" className="modal__title">{title}</h2>
        </div>

        <div className="modal__body">
          <div className="confirm">
            <span className="confirm__icon" data-tone={tone}>
              <AlertTriangle size={15} />
            </span>
            <p className="confirm__body">{body}</p>
          </div>
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={onCancel}>
            {t('Cancel')}
          </button>
          <button
            className={tone === 'danger' ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={onConfirm}
          >
            {t(confirmLabel)}
          </button>
        </div>
      </div>
    </div>
  )
}

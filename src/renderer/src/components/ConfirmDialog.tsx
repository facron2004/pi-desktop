import { AlertTriangle } from 'lucide-react'

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
  return (
    <div className="modal-layer" onMouseDown={onCancel}>
      <div className="modal modal--narrow" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">{title}</h2>
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
            Cancel
          </button>
          <button
            className={tone === 'danger' ? 'btn btn--danger' : 'btn btn--primary'}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

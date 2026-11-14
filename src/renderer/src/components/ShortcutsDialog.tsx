import { X } from 'lucide-react'
import { useRef } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { ShortcutsList } from './ShortcutsList'

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)
  const t = useT()

  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="shortcuts-title" className="modal__title">{t('Keyboard shortcuts')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close')} title={t('Close')}>
            <X size={15} />
          </button>
        </div>

        <div className="modal__body">
          <ShortcutsList />
        </div>

        <div className="modal__foot">
          <button className="btn btn--primary" onClick={onClose}>
            {t('Got it')}
          </button>
        </div>
      </div>
    </div>
  )
}

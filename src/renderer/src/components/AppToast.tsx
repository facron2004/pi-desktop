import { AlertTriangle, Check, X } from 'lucide-react'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import { findSessionMeta } from './RunStatusRow'

/**
 * The app's transient messages: one slim card below the title bar in the
 * window's top-right corner, away from the composer and above whatever is open.
 *
 * The composer used to own this slot, so every confirmation and every warning
 * pushed the input box down. A message about the app is not part of writing a
 * message; it floats over the app and leaves the composer's geometry alone.
 */
export function AppToast() {
  const toast = useAppStore((state) => state.toast)
  const clearToast = useAppStore((state) => state.clearToast)
  const selectSession = useAppStore((state) => state.selectSession)
  const t = useT()

  if (!toast) return null

  const level = toast.level === 'error' ? 'error' : toast.level === 'warning' ? 'warning' : 'success'
  const Icon = level === 'error' ? X : level === 'warning' ? AlertTriangle : Check

  // A toast about a conversation is also the way back to it: the reader is
  // often looking at another one when a background run finishes.
  const openSession = toast.sessionKey
    ? () => {
        const state = useAppStore.getState()
        const meta = findSessionMeta(toast.sessionKey!, state.sessions, state.threads)
        if (!meta) return
        void selectSession(meta, 'toast-open')
        clearToast()
      }
    : undefined

  return (
    <div className="app-toast" data-level={level} role={level === 'error' ? 'alert' : 'status'}>
      <span className="app-toast__mark" aria-hidden="true">
        <Icon size={11} strokeWidth={level === 'success' ? 3 : 2.6} />
      </span>
      {openSession ? (
        <button type="button" className="app-toast__text app-toast__open" onClick={openSession}>
          {t(toast.text)}
        </button>
      ) : (
        <span className="app-toast__text">{t(toast.text)}</span>
      )}
      <button
        type="button"
        className="app-toast__close"
        onClick={clearToast}
        aria-label={t('Dismiss')}
        title={t('Dismiss')}
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, Download, Loader2, RotateCw, TriangleAlert, X } from 'lucide-react'
import type { AppUpdateProgress } from '@shared/types'
import { APP_UPDATE_NOTICE, checkForAppUpdates, type AppUpdateNotice } from '../lib/app-update'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import '../styles/app-update.css'

export function AppUpdateDialog() {
  const t = useT()
  const supported = useAppStore((state) => state.info?.appUpdateSupported !== false)
  const [notice, setNotice] = useState<AppUpdateNotice | null>(null)
  const activeWork = useAppStore((state) => notice !== null && Object.values(state.threads).some((thread) => thread.isStreaming))
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null)
  const [installError, setInstallError] = useState('')
  const busyRef = useRef(false)
  const versionRef = useRef<string | undefined>(undefined)
  const dialogRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    if (!busyRef.current) setNotice(null)
  }, [])
  useDialogFocus(dialogRef, close, { enabled: notice !== null, initialFocus: 'dialog' })

  useEffect(() => {
    const receive = (event: Event) => {
      if (busyRef.current) return
      const next = (event as CustomEvent<AppUpdateNotice>).detail
      versionRef.current = 'result' in next ? next.result.app.latest : undefined
      setNotice(next)
      setProgress(null)
      setInstallError('')
    }
    window.addEventListener(APP_UPDATE_NOTICE, receive)
    const off = window.pi.app.onAppUpdateProgress((next) => {
      if (busyRef.current && next.version === versionRef.current) setProgress(next)
    })
    return () => {
      window.removeEventListener(APP_UPDATE_NOTICE, receive)
      off()
    }
  }, [])

  const install = async () => {
    const version = versionRef.current
    if (!version || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setProgress(null)
    setInstallError('')
    try {
      const result = await window.pi.app.installAppUpdate(version)
      if (!result.success) throw new Error(result.error || 'Update failed. Please try again.')
      setProgress({ version, stage: 'installing', percent: 100 })
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : String(error))
      busyRef.current = false
      setBusy(false)
    }
  }

  const openDownload = async () => {
    if (busyRef.current) return
    const result = await window.pi.app.openReleasePage().catch((error: unknown) => ({ success: false, error: String(error) }))
    if (!result.success) setInstallError(result.error || 'Update failed. Please try again.')
  }

  if (!notice) return null
  const result = 'result' in notice ? notice.result : null
  const error = 'error' in notice ? notice.error : result?.app.error
  const available = Boolean(result?.app.hasUpdate && result.app.latest)
  const title = error ? t('Check failed') : available ? t('Update available') : t('Up to date')
  const Icon = error ? TriangleAlert : busy ? Loader2 : available ? Download : Check
  const percent = Math.min(100, Math.max(0, Math.round(progress?.percent ?? 0)))

  return (
    <div className="modal-layer no-drag" onMouseDown={close}>
      <div ref={dialogRef} className="modal app-update-card" role="dialog" aria-modal="true"
        aria-labelledby="app-update-title" aria-describedby="app-update-description" tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}>
        <div className="app-update-card__head">
          <span className="app-update-card__icon" data-state={error ? 'error' : available ? 'available' : 'current'}>
            <Icon size={20} className={busy ? 'spin' : undefined} aria-hidden="true" />
          </span>
          <div className="app-update-card__heading">
            <h2 id="app-update-title">{title}</h2>
            <p id="app-update-description">
              {error ? t('Could not check for app updates. Please try again.')
                : available ? t('A new Pi Desktop version is ready to install.')
                  : t('You are running the latest Pi Desktop version.')}
            </p>
          </div>
          <button type="button" className="icon-btn" disabled={busy} aria-label={t('Close')} onClick={close}><X size={16} /></button>
        </div>
        <div className="app-update-card__body">
          {result ? (
            <div className="app-update-card__versions">
              <span><span className="app-update-card__version-label">{t('Current version')}</span><strong>v{result.app.current}</strong></span>
              {available ? <><ArrowRight size={15} aria-hidden="true" /><span><span className="app-update-card__version-label">{t('Latest version')}</span><strong>v{result.app.latest}</strong></span></> : null}
            </div>
          ) : null}
          {available ? <p className="app-update-card__note">{t(supported
            ? 'The update will be downloaded and verified before the app restarts.'
            : 'Automatic updates are available in the Windows installer version.')}</p> : null}
          {!available && result?.piCli.hasUpdate ? <p className="app-update-card__note">{t('A built-in service update is available in About settings.')}</p> : null}
          {activeWork && available && supported ? <p className="app-update-card__note">{t('Finish or stop active tasks before updating Pi Desktop.')}</p> : null}
          {busy ? <div className="app-update-card__progress" role="status" aria-live="polite">
            <span>{progress?.stage === 'installing' ? t('Restarting to install the update…') : `${t('Downloading update…')} ${percent}%`}</span>
            <div role="progressbar" aria-label={t('Downloading update…')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
          </div> : null}
          {error || installError ? <p className="app-update-card__error" role="alert">{t(installError || error || '')}</p> : null}
        </div>
        <div className="modal__foot app-update-card__foot">
          <button type="button" className="btn" disabled={busy} onClick={close}>{t(available ? 'Not now' : error ? 'Close' : 'Got it')}</button>
          {available ? <button type="button" className="btn btn--primary" disabled={busy || (supported && activeWork)} onClick={() => void (supported ? install() : openDownload())}>
            {busy ? <Loader2 size={14} className="spin" /> : <RotateCw size={14} />}
            {t(busy ? 'Updating…' : supported ? 'Restart and update' : 'Open download page')}
          </button> : error ? <button type="button" className="btn btn--primary" onClick={() => void checkForAppUpdates().catch(() => {})}>{t('Retry')}</button> : null}
        </div>
      </div>
    </div>
  )
}

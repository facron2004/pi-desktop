import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Info, Loader2, TriangleAlert } from 'lucide-react'
import type { AppUpdateProgress } from '@shared/types'
import { APP_UPDATE_NOTICE, checkForAppUpdates, type AppUpdateNotice } from '../lib/app-update'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import { PiLogo } from './PiLogo'
import '../styles/app-update.css'

/** A note is explanatory copy, not another row of data: one icon, one tone. */
function CardNote({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warning' }) {
  const NoteIcon = tone === 'warning' ? TriangleAlert : Info
  return (
    <p className="app-update-card__note" data-tone={tone}>
      <NoteIcon size={14} aria-hidden="true" />
      <span>{children}</span>
    </p>
  )
}

function hasAnyStreamingThread(threads: Record<string, { isStreaming?: boolean }>): boolean {
  for (const key in threads) {
    if (threads[key]?.isStreaming) return true
  }
  return false
}

export function AppUpdateDialog({ initialNotice = null }: { initialNotice?: AppUpdateNotice | null } = {}) {
  const t = useT()
  const supported = useAppStore((state) => state.info?.appUpdateSupported !== false)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [notice, setNotice] = useState<AppUpdateNotice | null>(initialNotice)
  const activeWork = useAppStore((state) => notice !== null && hasAnyStreamingThread(state.threads))
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<AppUpdateProgress | null>(null)
  const [installError, setInstallError] = useState('')
  const busyRef = useRef(false)
  const versionRef = useRef<string | undefined>(initialNotice && 'result' in initialNotice ? initialNotice.result.app.latest : undefined)
  const dialogRef = useRef<HTMLDivElement>(null)
  const close = useCallback(() => {
    if (!busyRef.current) setNotice(null)
  }, [])
  useDialogFocus(dialogRef, close, { enabled: notice !== null, initialFocus: 'dialog' })

  useEffect(() => {
    if (!initialNotice || busyRef.current) return
    versionRef.current = 'result' in initialNotice ? initialNotice.result.app.latest : undefined
    setNotice(initialNotice)
    setProgress(null)
    setInstallError('')
  }, [initialNotice])

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
    dialogRef.current?.focus()
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

  // Codex remembers the release a reader waved away (`dismissed_version`), so
  // the sidebar notice stops for that one and returns for the next. The
  // reading itself is untouched: About still offers this release on request.
  const dismissVersion = () => {
    const version = versionRef.current
    if (version) void updateSettings({ dismissedUpdateVersion: version })
    close()
  }

  if (!notice) return null
  const result = 'result' in notice ? notice.result : null
  const error = 'error' in notice
    ? notice.error || 'Could not check for app updates. Please try again.'
    : result?.app.error
  const available = Boolean(result?.app.hasUpdate && result.app.latest)
  const state = error ? 'error' : available ? 'available' : 'current'
  const title = error ? t('Check failed') : busy ? t('Updating…') : available ? t('Update available') : t('Up to date')
  const StatusIcon = error ? TriangleAlert : busy ? Loader2 : Check
  const description = error ? t(error) : available && !busy ? t(supported
    ? 'The update will be downloaded and verified before the app restarts.'
    : 'Automatic updates are available in the Windows installer version.') : null
  const progressLabel = t(progress?.stage === 'installing' ? 'Restarting to install the update…' : 'Downloading update…')
  const percent = Math.min(100, Math.max(0, Math.round(progress?.percent ?? 0)))

  return (
    <div className="modal-layer app-update-layer no-drag" onMouseDown={close}>
      <div ref={dialogRef} className="modal app-update-card" data-state={state} role="dialog" aria-modal="true"
        aria-labelledby="app-update-title" aria-describedby="app-update-description" tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}>
        <div className="app-update-card__head">
          <div className="app-update-card__heading">
            <h2 id="app-update-title" className="modal__title">{title}</h2>
            {result && available ? (
              <p className="app-update-card__latest">
                <span className="app-update-card__version-label">{t('Latest version')}{' '}</span>
                v{result.app.latest}
              </p>
            ) : null}
            {result ? (
              <p id={!description && !busy ? 'app-update-description' : undefined} className="app-update-card__current">
                {t('Current version')} v{result.app.current}
              </p>
            ) : null}
          </div>
          <span className="app-update-card__icon" aria-hidden="true">
            {state === 'available' && !busy
              ? <PiLogo size={60} />
              : <StatusIcon size={24} className={busy ? 'spin' : undefined} />}
          </span>
        </div>
        <div className="app-update-card__details">
          {description ? (
            <p id="app-update-description" className="app-update-card__description" role={error ? 'alert' : undefined}>{description}</p>
          ) : null}
          {!available && result?.piCli.hasUpdate ? <CardNote>{t('A built-in service update is available in About settings.')}</CardNote> : null}
          {activeWork && available && supported ? <CardNote tone="warning">{t('Finish or stop active tasks before updating Pi Desktop.')}</CardNote> : null}
          {installError ? <p className="app-update-card__error" role="alert"><TriangleAlert size={14} aria-hidden="true" /><span>{t(installError)}</span></p> : null}
          {busy ? (
            <div className="app-update-card__progress" role="status" aria-live="polite">
              <div className="app-update-card__progress-head">
                <span id={description ? undefined : 'app-update-description'}>{progressLabel}</span>
                <span className="app-update-card__progress-percent">{percent}%</span>
              </div>
              <div role="progressbar" aria-label={progressLabel} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div>
            </div>
          ) : (
            <div className="app-update-card__foot">
              {available && !busy ? (
                <button type="button" className="app-update-card__dismiss" onClick={dismissVersion}>
                  {t("Don't show this version again")}
                </button>
              ) : null}
              <button type="button" className={state === 'current' ? 'btn btn--primary' : 'btn'} onClick={close}>{t(available ? 'Not now' : error ? 'Close' : 'Got it')}</button>
              {available ? <button type="button" className="btn btn--primary" disabled={supported && activeWork} onClick={() => void (supported ? install() : openDownload())}>
                {t(supported ? 'Restart and update' : 'Open download page')}
              </button> : error ? <button type="button" className="btn btn--primary" onClick={() => void checkForAppUpdates().catch(() => {})}>{t('Retry')}</button> : null}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

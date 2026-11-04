import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Copy, RefreshCw, ShieldOff, Smartphone, Wifi } from 'lucide-react'
import type { RemoteAccessStatus } from '@shared/types'
import { useT } from '../lib/i18n'
import { Switch } from './Switch'
import '../styles/remote-access-settings.css'

export function RemoteAccessSettings() {
  const t = useT()
  const [status, setStatus] = useState<RemoteAccessStatus>()
  const [qrCode, setQrCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.pi.remote.status())
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Could not read remote access status'))
    }
  }, [t])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    let cancelled = false
    if (!status?.pairingUrl) {
      setQrCode('')
      return
    }
    void QRCode.toDataURL(status.pairingUrl, {
      width: 220,
      margin: 1,
      color: { dark: '#17181c', light: '#ffffff' }
    }).then((dataUrl) => {
      if (!cancelled) setQrCode(dataUrl)
    }).catch(() => {
      if (!cancelled) setQrCode('')
    })
    return () => { cancelled = true }
  }, [status?.pairingUrl])

  const setEnabled = async (enabled: boolean) => {
    setBusy(true)
    setError('')
    try {
      const next = await window.pi.remote.setEnabled(enabled)
      setStatus(next)
      if (next.error) setError(next.error)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Could not change remote access'))
    } finally {
      setBusy(false)
    }
  }

  const createPairing = async () => {
    setBusy(true)
    setError('')
    try {
      const next = await window.pi.remote.newPairing()
      setStatus(next)
      if (next.error) setError(next.error)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Could not create a pairing code'))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      setStatus(await window.pi.remote.revokeDevice(id))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Could not remove the paired phone'))
    } finally {
      setBusy(false)
    }
  }

  const copyUrl = async () => {
    const url = status?.urls[0]
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      setError(t('Could not copy the address'))
    }
  }

  return (
    <div className="settings-page settings-page--compact remote-access-settings">
      <header className="settings-page-head">
        <h3>{t('Remote access')}</h3>
        <p>{t('Connect a phone on the same Wi-Fi network to view conversations and send messages.')}</p>
      </header>

      <section className="settings-group">
        <div className="settings-group__head"><h4>{t('Connection')}</h4></div>
        <div className="settings-fields">
          <div className="settings-item-row settings-item-row--agent">
            <div className="settings-item-row__info">
              <span className="settings-item-row__title">{t('Enable remote access')}</span>
              <span className="settings-item-row__desc">
                {t('The mobile page can browse registered projects and send messages to existing conversations.')}
              </span>
            </div>
            <Switch
              checked={status?.enabled === true}
              disabled={busy || !status}
              label={t('Enable remote access')}
              onChange={(value) => void setEnabled(value)}
            />
          </div>
        </div>
      </section>

      <div className="remote-access-warning">
        <Wifi size={16} />
        <p>{t('Use only on a trusted Wi-Fi network. Local network traffic is not encrypted. Mobile messages use the same agent permissions as Pi Desktop.')}</p>
      </div>

      {status?.enabled ? (
        <>
          <section className="settings-group remote-access-pairing">
            <div className="settings-group__head">
              <h4>{t('Pair a phone')}</h4>
              {status.pairingUrl ? (
                <span className="remote-access-expiry">{t('Code expires in 3 minutes')}</span>
              ) : null}
            </div>
            {status.pairingUrl ? (
              <div className="remote-access-pairing__content">
                {qrCode ? <img src={qrCode} width={176} height={176} alt={t('Phone pairing QR code')} /> : null}
                <div className="remote-access-pairing__info">
                  <strong>{t('Scan with your phone camera')}</strong>
                  <span>{t('Open the link in a mobile browser, then tap Connect.')}</span>
                  <div className="remote-access-address">
                    <code>{status.urls[0]}</code>
                    <button type="button" className="btn btn--sm" onClick={() => void copyUrl()}>
                      <Copy size={13} /> {t('Copy address')}
                    </button>
                  </div>
                  <small>{t('The QR code works once and expires after 3 minutes.')}</small>
                </div>
              </div>
            ) : (
              <div className="remote-access-new-pairing">
                <span>{t('No pairing code is active. Create one to connect another phone.')}</span>
                <button type="button" className="btn btn--sm" disabled={busy} onClick={() => void createPairing()}>
                  <RefreshCw size={13} /> {t('Create pairing QR code')}
                </button>
              </div>
            )}
          </section>

          <section className="settings-group">
            <div className="settings-group__head"><h4>{t('Paired phones')}</h4></div>
            <div className="settings-fields">
              {status.devices.map((device) => (
                <div className="settings-item-row settings-item-row--agent" key={device.id}>
                  <div className="settings-item-row__info remote-access-device">
                    <Smartphone size={16} />
                    <span><strong>{device.name}</strong><small>{new Date(device.pairedAt).toLocaleString()}</small></span>
                  </div>
                  <button
                    type="button"
                    className="icon-btn remote-access-revoke"
                    aria-label={t('Remove paired phone')}
                    title={t('Remove paired phone')}
                    disabled={busy}
                    onClick={() => void revoke(device.id)}
                  ><ShieldOff size={15} /></button>
                </div>
              ))}
              {!status.devices.length ? <p className="remote-access-empty">{t('No phones are paired.')}</p> : null}
            </div>
          </section>
        </>
      ) : null}

      {status?.error ? <div className="remote-access-error">{status.error}</div> : null}
      {error ? <div className="remote-access-error">{error}</div> : null}
    </div>
  )
}

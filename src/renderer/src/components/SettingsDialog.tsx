import { useEffect, useState } from 'react'
import { Check, RefreshCw, X } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { Switch } from './Switch'
import type { AuthStatus } from '@shared/types'

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useAppStore((state) => state.settings)
  const info = useAppStore((state) => state.info)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const showToast = useAppStore((state) => state.showToast)

  const [piPath, setPiPath] = useState(settings.piPath ?? '')
  const [provider, setProvider] = useState(settings.provider ?? '')
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setPiPath(settings.piPath ?? '')
  }, [settings.piPath])

  const save = async () => {
    await updateSettings({
      piPath: piPath.trim() || undefined,
      provider: provider.trim() || undefined
    })
    showToast('Settings saved')
  }

  const check = async () => {
    if (!provider.trim()) {
      showToast('Enter a provider first, e.g. anthropic')
      return
    }
    setChecking(true)
    try {
      const result = await window.pi.auth.check(provider.trim())
      setAuth(result)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal__head">
          <h2 className="modal__title">Settings</h2>
          <button className="icon-btn" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <div className="modal__body">
          <div className="field">
            <label className="field__label" htmlFor="pi-path">
              Pi CLI path
            </label>
            <div className="field__row">
              <input
                id="pi-path"
                className="input"
                value={piPath}
                placeholder="Leave empty to use the bundled Pi"
                onChange={(event) => setPiPath(event.target.value)}
              />
              <button
                className="btn"
                onClick={() => {
                  setPiPath('')
                  void updateSettings({ piPath: undefined })
                }}
              >
                Reset
              </button>
            </div>
            <span className="field__hint">
              Point this at a `pi` executable or at the CLI script of a checkout. When empty, Pi
              Desktop uses the copy bundled with the app.
            </span>
          </div>

          <div className="field">
            <label className="field__label">Appearance</label>
            <div className="field__row">
              <div className="segmented">
                {(['dark', 'light', 'system'] as const).map((theme) => (
                  <button
                    key={theme}
                    data-active={settings.theme === theme}
                    onClick={() => void updateSettings({ theme })}
                  >
                    {theme[0].toUpperCase() + theme.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="field">
            <label className="field__label">Text size</label>
            <div className="field__row">
              <div className="segmented">
                {[
                  { label: 'Small', value: 0.92 },
                  { label: 'Default', value: 1 },
                  { label: 'Large', value: 1.1 },
                  { label: 'XL', value: 1.22 }
                ].map((option) => (
                  <button
                    key={option.label}
                    data-active={Math.abs((settings.fontScale ?? 1) - option.value) < 0.01}
                    onClick={() => void updateSettings({ fontScale: option.value })}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="field">
            <label className="field__label">Provider credentials</label>
            <div className="field__row">
              <input
                className="input"
                value={provider}
                placeholder="e.g. anthropic"
                onChange={(event) => setProvider(event.target.value)}
              />
              <button className="btn" onClick={() => void check()} disabled={checking}>
                {checking ? <span className="spinner" /> : <Check size={13} />}
                Check
              </button>
            </div>
            {auth ? (
              <span className="field__hint" style={{ color: auth.ready ? 'var(--green)' : 'var(--red)' }}>
                {auth.ready
                  ? `${auth.provider} is ready to use.`
                  : `${auth.provider ?? 'provider'} is not ready${auth.detail ? `: ${auth.detail}` : '.'}`}
              </span>
            ) : (
              <span className="field__hint">
                Runs <code>pi auth check</code> to confirm the provider can be used.
              </span>
            )}
          </div>

          <div className="field">
            <label className="field__label">Project resources</label>
            <div className="field__row">
              <Switch
                checked={settings.trustProject !== false}
                onChange={(value) => void updateSettings({ trustProject: value })}
                label="Trust project-local extensions and settings"
              />
              <span className="field__hint" style={{ flex: 1 }}>
                Allow this project&apos;s <code>.pi/extensions</code>, <code>.pi/skills</code> and{' '}
                <code>.pi/settings.json</code> to load. Turn this off for projects you do not
                trust.
              </span>
            </div>
          </div>

          <div className="field">
            <label className="field__label">Environment</label>
            <div className="kv">
              <span className="kv__key">Pi CLI</span>
              <span className="kv__value">{info?.pi.display ?? '—'}</span>
              <span className="kv__key">Pi version</span>
              <span className="kv__value">{info?.pi.version ?? '—'}</span>
              <span className="kv__key">Session folder</span>
              <span className="kv__value">{info?.sessionRoot ?? '—'}</span>
              <span className="kv__key">Electron</span>
              <span className="kv__value">{info?.electron ?? '—'}</span>
              <span className="kv__key">Node</span>
              <span className="kv__value">{info?.node ?? '—'}</span>
            </div>
          </div>
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn--primary" onClick={() => void save()}>
            <RefreshCw size={13} />
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

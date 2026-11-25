import { useEffect, useRef, useState } from 'react'
import { Download, Sparkles } from 'lucide-react'
import type { PiCliUpgradeProgress, VersionCheckResult } from '@shared/types'
import { useT } from '../../lib/i18n'
import { useAppStore } from '../../store/useAppStore'
import { piCliUpdate, subscribePiCliUpdate } from '../../lib/app-update'
import { Switch } from '../Switch'
import { SettingsGroup } from './SettingsShared'

export function AboutSettings({
  updateStatus,
  checking,
  upgradingCli,
  piCliProgress,
  onCheck,
  onUpgradeCli
}: {
  updateStatus: VersionCheckResult | null
  checking: boolean
  upgradingCli: boolean
  piCliProgress: PiCliUpgradeProgress | null
  onCheck: (silent?: boolean) => void
  onUpgradeCli: () => void
}) {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const info = useAppStore((state) => state.info)
  const refreshInfo = useAppStore((state) => state.refreshInfo)
  const t = useT()
  const infoRequested = useRef(false)
  // The CLI reading is its own: the app checks the bundled agent on its own
  // schedule, so this row still learns about a newer CLI while automatic app
  // updates are off. A manual check fills the same slot.
  const [piCliStatus, setPiCliStatus] = useState(() => piCliUpdate())
  useEffect(() => subscribePiCliUpdate(setPiCliStatus), [])

  useEffect(() => {
    if (infoRequested.current || info?.pi.version) return
    infoRequested.current = true
    void refreshInfo()
  }, [info?.pi.version, refreshInfo])

  const appCurrent = info?.version ?? '—'
  const piCliCurrent = info?.pi.version ?? '—'
  // A check that could not answer used to be dropped on the floor, which made
  // "the registry never answered" read exactly like "you are up to date" — the
  // reason the CLI update went missing. Say so instead.
  const piCliError = piCliStatus?.error?.trim() || null

  return (
    <div className="settings-page settings-page--compact">
      <SettingsGroup title={t('Version and updates')}>
        <div className="settings-about-card">
          <div className="settings-item-row settings-about-row">
            <div className="settings-item-row__info">
              <span className="settings-item-row__title">{t('Application version')}</span>
              <span className="settings-item-row__desc">{t('Current application version')}</span>
            </div>
            <div className="settings-version-actions">
              <span className="settings-about-value">{appCurrent}</span>
              {updateStatus?.app.hasUpdate ? (
                <>
                  <span className="settings-badge" data-tone="amber">
                    <Sparkles size={11} style={{ marginRight: 4 }} />
                    {t('New version')} v{updateStatus.app.latest}
                  </span>
                  {/* The update lives on the sidebar button beside Settings: one
                      affordance for check, download and restart, no dialog. */}
                  <span className="settings-about-hint">{t('Update from the button beside Settings')}</span>
                </>
              ) : null}
            </div>
          </div>
          <div className="settings-item-row settings-about-row">
            <div className="settings-item-row__info">
              <span className="settings-item-row__title">{t('Built-in service version')}</span>
              <span className="settings-item-row__desc">{t('Current built-in service version')}</span>
            </div>
            <div className="settings-version-actions">
              <span className="settings-about-value">{piCliCurrent}</span>
              {piCliStatus?.hasUpdate ? (
                <>
                  <span className="settings-badge" data-tone="amber">
                    <Sparkles size={11} style={{ marginRight: 4 }} />
                    {t('New version')} v{piCliStatus.latest}
                  </span>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={upgradingCli || checking}
                    onClick={() => void onUpgradeCli()}
                  >
                    <Download size={12} />
                    {upgradingCli
                      ? `${t('Upgrading...')}${piCliProgress ? ` ${Math.round(piCliProgress.percent)}%` : ''}`
                      : t('Reinstall & Upgrade')}
                  </button>
                </>
              ) : null}
            </div>
          </div>
          {piCliError ? (
            <div className="settings-about-error" role="status" title={piCliError}>
              {t('Update check failed')}: {piCliError}
            </div>
          ) : null}
          {upgradingCli && piCliProgress ? (
            <div
              className="settings-upgrade-progress"
              role="progressbar"
              aria-label={t('Upgrading...')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(piCliProgress.percent)}
            >
              <span style={{ width: `${Math.min(100, Math.max(0, piCliProgress.percent))}%` }} />
            </div>
          ) : null}

          <div className="settings-item-row settings-about-row">
            <div className="settings-item-row__info">
              <span className="settings-item-row__title">{t('Check for updates')}</span>
              <span className="settings-item-row__desc">{t('Manually check for available updates')}</span>
            </div>
            <button
              type="button"
              className="btn btn--sm"
              disabled={checking || upgradingCli}
              onClick={() => void onCheck()}
            >
              {/* No spinner here: the label itself says which of the two states
                  the check is in. */}
              {checking ? t('Checking…') : t('Check now')}
            </button>
          </div>

          <div className="settings-item-row settings-about-row">
            <div className="settings-item-row__info">
              <span className="settings-item-row__title">{t('Automatically check for updates')}</span>
              <span className="settings-item-row__desc">
                {t('Check for new versions in the background and download them; restart from the icon beside Settings')}
              </span>
            </div>
            <Switch
              checked={settings.automaticUpdates === true}
              onChange={(value) => void updateSettings({ automaticUpdates: value })}
              label={t('Automatically check for updates')}
            />
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

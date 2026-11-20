import { useEffect, useRef } from 'react'
import { Download, RefreshCw, Sparkles } from 'lucide-react'
import type { PiCliUpgradeProgress, VersionCheckResult } from '@shared/types'
import { useT } from '../../lib/i18n'
import { useAppStore } from '../../store/useAppStore'
import { Switch } from '../Switch'
import { SettingsGroup } from './SettingsShared'

export function AboutSettings({
  updateStatus,
  checking,
  upgradingCli,
  piCliProgress,
  onCheck,
  onUpgradeCli,
  onShowUpdate
}: {
  updateStatus: VersionCheckResult | null
  checking: boolean
  upgradingCli: boolean
  piCliProgress: PiCliUpgradeProgress | null
  onCheck: (silent?: boolean) => void
  onUpgradeCli: () => void
  onShowUpdate: () => void
}) {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const info = useAppStore((state) => state.info)
  const refreshInfo = useAppStore((state) => state.refreshInfo)
  const t = useT()
  const infoRequested = useRef(false)

  useEffect(() => {
    if (infoRequested.current || info?.pi.version) return
    infoRequested.current = true
    void refreshInfo()
  }, [info?.pi.version, refreshInfo])

  const appCurrent = info?.version ?? '—'
  const piCliCurrent = info?.pi.version ?? '—'

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
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={checking || upgradingCli}
                    onClick={onShowUpdate}
                  >
                    <Download size={12} />
                    {t('View update')}
                  </button>
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
              {updateStatus?.piCli.hasUpdate ? (
                <>
                  <span className="settings-badge" data-tone="amber">
                    <Sparkles size={11} style={{ marginRight: 4 }} />
                    {t('New version')} v{updateStatus.piCli.latest}
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
              <RefreshCw size={12} className={checking ? 'spin' : ''} />
              {checking ? t('Checking...') : t('Check now')}
            </button>
          </div>

          {info?.isPackaged === false && info.pi.source === 'bundled' ? (
            <div className="settings-item-row settings-about-row">
              <div className="settings-item-row__info">
                <span className="settings-item-row__title">{t('Automatically download updates')}</span>
                <span className="settings-item-row__desc">
                  {t('Download built-in service updates in the background and restart the app to finish installing')}
                </span>
              </div>
              <Switch
                checked={settings.automaticUpdates === true}
                onChange={(value) => void updateSettings({ automaticUpdates: value })}
                label={t('Automatically download updates')}
              />
            </div>
          ) : null}
        </div>
      </SettingsGroup>
    </div>
  )
}

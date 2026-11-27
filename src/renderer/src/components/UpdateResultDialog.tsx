import { useEffect, useState } from 'react'
import {
  appUpdateResultNotice,
  dismissAppUpdateResult,
  subscribeAppUpdateResult,
  type AppUpdateResultNotice
} from '../lib/app-update'
import { useT } from '../lib/i18n'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * The manual check's answer when there is nothing to install.
 *
 * A release with an update is not a question: it appears on the round button
 * beside Settings, where it can be downloaded and installed. "You are already
 * current" and "the check failed" have no such control, so they are said once
 * here and dismissed with one button.
 */
export function UpdateResultDialog() {
  const t = useT()
  const [notice, setNotice] = useState<AppUpdateResultNotice | null>(() => appUpdateResultNotice())

  useEffect(() => subscribeAppUpdateResult(setNotice), [])

  if (!notice) return null

  const title = notice.kind === 'error' ? t('Check failed') : t('Up to date')
  const piCli = notice.kind === 'current' ? notice.piCli : undefined
  const body = notice.kind === 'error'
    ? notice.error
    : piCli
      ? t('You are running the latest Pi Desktop version. A built-in service update is available in About settings.')
      : t('You are running the latest Pi Desktop version.')
  const detail = notice.kind === 'error'
    ? undefined
    : piCli
      ? `${t('Built-in service version')}: ${piCli.current} → ${piCli.latest}`
      : `${t('Current version')} v${notice.current}`

  return (
    <ConfirmDialog
      title={title}
      body={body}
      detail={detail}
      confirmLabel="Got it"
      cancelLabel={null}
      onConfirm={() => dismissAppUpdateResult()}
      onCancel={() => dismissAppUpdateResult()}
    />
  )
}

import type { VersionCheckResult } from '@shared/types'

export const APP_UPDATE_NOTICE = 'pi:app-update-notice'
export type AppUpdateNotice = { result: VersionCheckResult } | { error: string }

let checking: Promise<VersionCheckResult> | undefined

export function showAppUpdate(result: VersionCheckResult): void {
  window.dispatchEvent(new CustomEvent<AppUpdateNotice>(APP_UPDATE_NOTICE, { detail: { result } }))
}

/** Both manual entry points share one request and one result card. Background checks stay silent. */
export function checkForAppUpdates(): Promise<VersionCheckResult> {
  if (checking) return checking
  checking = (async () => {
    try {
      const result = await window.pi.app.checkUpdate()
      showAppUpdate(result)
      return result
    } catch (error) {
      window.dispatchEvent(new CustomEvent<AppUpdateNotice>(APP_UPDATE_NOTICE, {
        detail: { error: error instanceof Error ? error.message : String(error) }
      }))
      throw error
    }
  })().finally(() => { checking = undefined })
  return checking
}

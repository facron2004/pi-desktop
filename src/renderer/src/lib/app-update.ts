import type { UpdateState, VersionCheckResult } from '@shared/types'

export const APP_UPDATE_NOTICE = 'pi:app-update-notice'
export type AppUpdateNotice = { result: VersionCheckResult } | { error: string }

/** A newer app release found by a check. The sidebar button reads this. */
export interface AvailableAppUpdate {
  current: string
  latest: string
  /** Size of the release installer, when the check could read it. */
  bytes?: number
}

type AvailableListener = (update: AvailableAppUpdate | null) => void
type CheckListener = (result: VersionCheckResult | null) => void

let checking: Promise<VersionCheckResult> | undefined
let available: AvailableAppUpdate | null = null
const listeners = new Set<AvailableListener>()
// The settings dialog unmounts when it closes, so its About page cannot own the
// last check. Keep the full result here as well as the sidebar's summary: a
// version the reader just looked up survives closing/reopening Settings and
// toggling switches in between.
let lastCheck: VersionCheckResult | null = null
const checkListeners = new Set<CheckListener>()

export function lastAppUpdateCheck(): VersionCheckResult | null {
  return lastCheck
}

export function subscribeAppUpdateCheck(listener: CheckListener): () => void {
  checkListeners.add(listener)
  return () => { checkListeners.delete(listener) }
}

export function availableAppUpdate(): AvailableAppUpdate | null {
  return available
}

export function subscribeAvailableAppUpdate(listener: AvailableListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Remember a newer app release, or clear the notice when a check says the
 * running version is current. A failed check keeps the last known release:
 * a network error must not hide an update the reader already saw.
 */
export function noteAppUpdateCheck(result: VersionCheckResult): void {
  // A failed check must not replace the last good reading either — the About
  // page reads the same persisted result as the sidebar badge.
  if (!result.app.error) {
    lastCheck = result
    for (const listener of checkListeners) listener(lastCheck)
  }
  const next = result.app.hasUpdate && result.app.latest
    ? {
        current: result.app.current,
        latest: result.app.latest,
        ...(result.app.installerBytes ? { bytes: result.app.installerBytes } : {})
      }
    : result.app.error
      ? available
      : null
  if (
    available?.current === next?.current &&
    available?.latest === next?.latest &&
    available?.bytes === next?.bytes
  ) return
  available = next
  for (const listener of listeners) listener(available)
}

export function showAppUpdate(result: VersionCheckResult): void {
  noteAppUpdateCheck(result)
  window.dispatchEvent(new CustomEvent<AppUpdateNotice>(APP_UPDATE_NOTICE, { detail: { result } }))
}

/**
 * Restore the reading kept from the last check that reached the network.
 *
 * The renderer holds its reading in memory, so a restart drops it. The main
 * process keeps the same reading on disk, and this puts it back before the
 * app's own check answers: a machine that is offline at startup still shows
 * the release it found yesterday.
 *
 * A stored reading names the version that was running when it was taken, so
 * it is only restored when that version is still the running one — after an
 * update the old reading must not claim a new version is waiting.
 */
export async function restorePersistedAppUpdate(): Promise<void> {
  // A check that already answered is the better reading, and it is the only
  // one that names this run's Pi CLI version. Restoring over it would replace
  // a live answer with yesterday's snapshot.
  if (lastCheck) return
  let state: UpdateState | null = null
  try {
    state = await window.pi.app.updateState()
  } catch {
    // A missing reading is not an error: the app checks on its own.
    return
  }
  if (!state?.app) return
  const result: VersionCheckResult = {
    app: state.app,
    piCli: state.piCli ?? { current: state.app.current, hasUpdate: false }
  }
  // A failed reading never replaces a good one, so restore only what was
  // actually fetched. The check may also have answered while this read was in
  // flight, in which case its result wins.
  if (result.app.error || lastCheck) return
  noteAppUpdateCheck(result)
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

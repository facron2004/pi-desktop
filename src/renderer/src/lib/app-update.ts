import type {
  AppUpdateProgress,
  DownloadedAppUpdate,
  UpdateState,
  UpgradeResult,
  VersionCheckResult,
  VersionItemStatus
} from '@shared/types'

/** A newer app release found by a check. The sidebar button reads this. */
export interface AvailableAppUpdate {
  current: string
  latest: string
  /** Size of the release installer, when the check could read it. */
  bytes?: number
}

/**
 * Where the installer for an offered release stands.
 *
 * `downloading` is the ring; `ready` means the verified setup file is on disk
 * and a click restarts into it; `installing` is the moment between that click
 * and the app quitting. A failed download or install keeps the record with
 * `error` set, so the icon can say why instead of silently going back to idle.
 */
export type AppUpdateStage = 'downloading' | 'ready' | 'installing' | 'error'

export interface AppUpdateInstall {
  version: string
  stage: AppUpdateStage
  /** 0-100. A verified installer rests at 100. */
  percent: number
  transferredBytes?: number
  totalBytes?: number
  error?: string
}

type AvailableListener = (update: AvailableAppUpdate | null) => void
type CheckListener = (result: VersionCheckResult | null) => void
type InstallListener = (install: AppUpdateInstall | null) => void
type PiCliListener = (status: VersionItemStatus | null) => void

/**
 * The manual check's answer when there is nothing to install.
 *
 * A release with an update belongs on the sidebar button — that is where it can
 * be downloaded and installed — but "you are already current" and "the check
 * failed" have no button to live on, so they are said once, in a notice the
 * reader dismisses. `null` means no notice is showing.
 */
export type AppUpdateResultNotice =
  | { kind: 'current'; current: string }
  | { kind: 'error'; error: string }

type ResultNoticeListener = (notice: AppUpdateResultNotice | null) => void

let checking: Promise<VersionCheckResult> | undefined
let available: AvailableAppUpdate | null = null
const listeners = new Set<AvailableListener>()
let resultNotice: AppUpdateResultNotice | null = null
const resultNoticeListeners = new Set<ResultNoticeListener>()
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

// The bundled CLI's reading, kept beside the app release because they are two
// different questions with two different schedules. The app release is fetched
// from GitHub and is the reader's choice; the CLI is the agent this app drives,
// so the app checks it on its own — a stale agent is a wrong answer, not a
// missing feature. A full check answers both, so it fills this slot too.
let piCliReading: VersionItemStatus | null = null
const piCliListeners = new Set<PiCliListener>()

export function piCliUpdate(): VersionItemStatus | null {
  return piCliReading
}

export function subscribePiCliUpdate(listener: PiCliListener): () => void {
  piCliListeners.add(listener)
  return () => { piCliListeners.delete(listener) }
}

/**
 * Remember a CLI reading.
 *
 * A failed check keeps the last good one: a machine that cannot reach npm right
 * now has not stopped having the version it found yesterday. The App schedules
 * this check itself, so the About page and the badge read the same slot.
 */
export function notePiCliUpdate(status: VersionItemStatus | null): void {
  if (!status) return
  if (status.error) {
    // Keep the last good version on screen, but publish the failure: the About
    // page renders `error`, and a check that never answered must not read as
    // "up to date".
    if (piCliReading?.error === status.error) return
    piCliReading = { ...(piCliReading ?? { current: status.current, hasUpdate: false }), error: status.error }
    for (const listener of piCliListeners) listener(piCliReading)
    return
  }
  if (
    piCliReading?.current === status.current &&
    piCliReading?.latest === status.latest &&
    piCliReading?.hasUpdate === status.hasUpdate
  ) return
  piCliReading = status
  for (const listener of piCliListeners) listener(piCliReading)
}

export function availableAppUpdate(): AvailableAppUpdate | null {
  return available
}

export function subscribeAvailableAppUpdate(listener: AvailableListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// The download lives in this module rather than in the sidebar, because the
// sidebar is a list that can be folded away: an icon that vanished with it
// would lose the progress of a download that is still running. The main
// process keeps the finished installer on disk, and `restoreDownloadedAppUpdate`
// puts the same state back after a restart.
let install: AppUpdateInstall | null = null
const installListeners = new Set<InstallListener>()
let progressSubscribed = false
let downloadInFlight: { version: string; promise: Promise<UpgradeResult> } | null = null
let restoreInFlight: Promise<void> | null = null
// Bumped whenever the record is dropped, so a download that was already in
// flight cannot publish a release the app no longer offers.
let installEpoch = 0

export function appUpdateInstall(): AppUpdateInstall | null {
  return install
}

export function subscribeAppUpdateInstall(listener: InstallListener): () => void {
  installListeners.add(listener)
  return () => { installListeners.delete(listener) }
}

function publishInstall(next: AppUpdateInstall | null): void {
  if (
    install?.version === next?.version &&
    install?.stage === next?.stage &&
    install?.percent === next?.percent &&
    install?.transferredBytes === next?.transferredBytes &&
    install?.totalBytes === next?.totalBytes &&
    install?.error === next?.error
  ) return
  install = next
  for (const listener of installListeners) listener(install)
}

/** Drop the download record, e.g. the release is no longer the one offered. */
export function forgetAppUpdateDownload(): void {
  installEpoch += 1
  downloadInFlight = null
  publishInstall(null)
}

function percentOf(progress: AppUpdateProgress): number {
  return Math.min(100, Math.max(0, Math.round(progress.percent)))
}

/**
 * Fold one progress event into the record.
 *
 * The event carries the newest reading, never an increment, and only the
 * release being downloaded may move it: a stale event from an earlier attempt
 * must not repaint the ring.
 */
export function noteAppUpdateProgress(progress: AppUpdateProgress): void {
  const current = install
  if (!current || current.version !== progress.version) return
  // A finished download is not "99% again": late events from the stream must
  // not take the record back out of the ready state.
  if (current.stage === 'ready') return
  const percent = progress.stage === 'installing' ? 100 : percentOf(progress)
  publishInstall({
    version: current.version,
    stage: progress.stage === 'installing' ? 'installing' : 'downloading',
    percent,
    ...(progress.transferredBytes !== undefined ? { transferredBytes: progress.transferredBytes } : {}),
    ...(progress.totalBytes !== undefined ? { totalBytes: progress.totalBytes } : {})
  })
}

/** One subscription for the whole app; the main process sends these events per window. */
function ensureProgressSubscription(): void {
  if (progressSubscribed || typeof window === 'undefined') return
  progressSubscribed = true
  try {
    window.pi.app.onAppUpdateProgress(noteAppUpdateProgress)
  } catch {
    // A bridge without the channel (an old preload) simply keeps the ring at
    // the percentages the request itself reports.
    progressSubscribed = false
  }
}

/**
 * Fetch the installer for a release without restarting.
 *
 * This is what a background check does when automatic updates are on, and what
 * clicking the icon does when the release was found by a manual check. The
 * installer is verified in the main process; a failure leaves the record in
 * `error` so the icon can explain itself.
 */
export function startAppUpdateDownload(
  version: string,
  options: { supported: boolean; bytes?: number }
): Promise<UpgradeResult> {
  if (!options.supported) {
    return window.pi.app.openReleasePage()
  }
  if (install?.version === version && install.stage === 'ready') {
    return Promise.resolve({ success: true, version })
  }
  if (downloadInFlight?.version === version) return downloadInFlight.promise
  ensureProgressSubscription()
  const knownBytes = install?.version === version ? install.totalBytes : options.bytes
  publishInstall({
    version,
    stage: 'downloading',
    percent: 0,
    ...(knownBytes ? { totalBytes: knownBytes } : {})
  })
  const promise = (async (): Promise<UpgradeResult> => {
    const epoch = installEpoch
    try {
      const result = await window.pi.app.downloadUpdate(version)
      if (!result.success) throw new Error(result.error || 'Update failed. Please try again.')
      const bytes = install?.totalBytes ?? knownBytes
      if (epoch === installEpoch) {
        publishInstall({
          version,
          stage: 'ready',
          percent: 100,
          ...(bytes ? { transferredBytes: bytes, totalBytes: bytes } : {})
        })
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (epoch === installEpoch) publishInstall({ version, stage: 'error', percent: 0, error: message })
      return { success: false, error: message }
    }
  })()
  downloadInFlight = { version, promise }
  void promise.finally(() => {
    if (downloadInFlight?.promise === promise) downloadInFlight = null
  })
  return promise
}

/**
 * How long the app may stay alive after the installer was launched.
 *
 * A successful install ends with the app quitting, so this only elapses when the
 * restart did not happen — the usual cause is the setup asking for elevation
 * (UAC) with nobody answering it, or a shutdown that cannot finish. The record
 * goes back to `ready` when it does, because the button must never be a dead
 * spinner: the installer is still verified on disk and a second click retries.
 */
const INSTALL_WATCHDOG_MS = 20_000
let installWatchdog: ReturnType<typeof setTimeout> | undefined

function armInstallWatchdog(version: string): void {
  if (installWatchdog) clearTimeout(installWatchdog)
  installWatchdog = setTimeout(() => {
    installWatchdog = undefined
    const current = install
    if (!current || current.version !== version || current.stage !== 'installing') return
    publishInstall({
      version: current.version,
      stage: 'ready',
      percent: 100,
      ...(current.transferredBytes !== undefined ? { transferredBytes: current.transferredBytes } : {}),
      ...(current.totalBytes !== undefined ? { totalBytes: current.totalBytes } : {}),
      error: 'The installer did not take over. Retry, or open the download page.'
    })
  }, INSTALL_WATCHDOG_MS)
}

/**
 * Restart into the downloaded installer. Only a verified download can do this;
 * a click while the file is still arriving is ignored.
 */
export async function applyAppUpdate(): Promise<UpgradeResult | null> {
  const current = install
  if (!current || current.stage !== 'ready') return null
  publishInstall({
    version: current.version,
    stage: 'installing',
    percent: 100,
    ...(current.transferredBytes !== undefined ? { transferredBytes: current.transferredBytes } : {}),
    ...(current.totalBytes !== undefined ? { totalBytes: current.totalBytes } : {})
  })
  try {
    const result = await window.pi.app.installAppUpdate(current.version)
    if (!result.success) throw new Error(result.error || 'Update failed. Please try again.')
    // The app is expected to quit now. If it does not, the button comes back.
    armInstallWatchdog(current.version)
    return result
  } catch (error) {
    if (installWatchdog) clearTimeout(installWatchdog)
    installWatchdog = undefined
    // The installer is still on disk: staying ready lets the reader retry
    // after finishing whatever kept the app from restarting.
    publishInstall({
      version: current.version,
      stage: 'ready',
      percent: 100,
      ...(current.transferredBytes !== undefined ? { transferredBytes: current.transferredBytes } : {}),
      ...(current.totalBytes !== undefined ? { totalBytes: current.totalBytes } : {}),
      error: error instanceof Error ? error.message : String(error)
    })
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Put back the installer a previous run downloaded.
 *
 * The main process keeps it on disk; without this read a restart would show an
 * idle icon and download the same release a second time. A download that is
 * already under way wins over the stored record.
 */
export function restoreDownloadedAppUpdate(): Promise<void> {
  if (install) return Promise.resolve()
  if (restoreInFlight) return restoreInFlight
  restoreInFlight = (async () => {
    let downloaded: DownloadedAppUpdate | null = null
    try {
      downloaded = await window.pi.app.downloadedUpdate()
    } catch {
      // No stored installer is normal; the check decides what to offer.
      return
    }
    // A check may have started its own download while this read was in flight.
    if (!downloaded || install) return
    publishInstall({
      version: downloaded.version,
      stage: 'ready',
      percent: 100,
      ...(downloaded.bytes
        ? { transferredBytes: downloaded.bytes, totalBytes: downloaded.bytes }
        : {})
    })
  })().finally(() => {
    restoreInFlight = null
  })
  return restoreInFlight
}

/**
 * Remember a newer app release, or clear the notice when a check says the
 * running version is current. A failed check keeps the last known release:
 * a network error must not hide an update the reader already saw.
 */
export function noteAppUpdateCheck(result: VersionCheckResult): void {
  // One check answers both questions, so the CLI slot is refreshed with it.
  notePiCliUpdate(result.piCli)
  publishAppUpdateCheck(result)
}

/** The app-release half on its own; a restore has no live CLI answer to publish. */function publishAppUpdateCheck(result: VersionCheckResult): void {
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
  // A downloaded installer belongs to one release. A check that *reached the
  // network* and names another release — or says the running version is
  // current — means that file is not what a click would install. A failed check
  // knows nothing about the release, so it must not drop the record: the bytes
  // are still on disk, still verified, and the main process only prunes them
  // after a check that succeeded.
  if (
    !result.app.error &&
    install &&
    install.stage !== 'installing' &&
    (!next || next.latest !== install.version)
  ) {
    forgetAppUpdateDownload()
  }
  if (
    available?.current === next?.current &&
    available?.latest === next?.latest &&
    available?.bytes === next?.bytes
  ) return
  available = next
  for (const listener of listeners) listener(available)
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
  // The CLI half rides along only when it was stored, and only while this run
  // has not answered for itself: the pair the check reported is a fact, the
  // fallback above is not a CLI reading at all.
  if (state.piCli && !piCliReading) notePiCliUpdate(state.piCli)
  publishAppUpdateCheck(result)
}

/**
 * Check for a release and publish the reading.
 *
 * There is no update dialog: a release with an update lands on the sidebar's
 * round button beside Settings, which already owns download, progress and
 * "restart to install". A check that answered "you are current" — or that could
 * not answer at all — has nowhere to show itself, so it raises one dismissible
 * notice instead. A failed check keeps the last good reading either way.
 */
export function checkForAppUpdates(): Promise<VersionCheckResult> {
  if (checking) return checking
  checking = (async () => {
    const result = await window.pi.app.checkUpdate()
    noteAppUpdateCheck(result)
    if (result.app.error) noteAppUpdateResult({ kind: 'error', error: result.app.error })
    else if (!result.app.hasUpdate) noteAppUpdateResult({ kind: 'current', current: result.app.current })
    else dismissAppUpdateResult()
    return result
  })().finally(() => { checking = undefined })
  return checking
}

/** The notice currently showing, if any. */
export function appUpdateResultNotice(): AppUpdateResultNotice | null {
  return resultNotice
}

export function subscribeAppUpdateResult(listener: ResultNoticeListener): () => void {
  resultNoticeListeners.add(listener)
  return () => {
    resultNoticeListeners.delete(listener)
  }
}

export function noteAppUpdateResult(notice: AppUpdateResultNotice | null): void {
  resultNotice = notice
  for (const listener of resultNoticeListeners) listener(resultNotice)
}

export function dismissAppUpdateResult(): void {
  if (!resultNotice) return
  noteAppUpdateResult(null)
}

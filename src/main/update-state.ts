import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { VersionItemStatus } from '@shared/types'
import { isNewerVersion } from './app-updates'

/**
 * The last successful version check, kept on disk under the Electron
 * userData directory.
 *
 * The renderer keeps the reading in memory, so a restart drops it. Without
 * this file a machine that is offline at startup shows no update notice at
 * all, even though the reader looked at one yesterday. The file only ever
 * holds a reading that was actually fetched, so it is never a guess.
 */
export const UPDATE_STATE_FILE = 'update-state.json'

const MAX_UPDATE_STATE_BYTES = 64 * 1024

export interface UpdateState {
  /** The application release that was found. */
  app?: VersionItemStatus
  /** The bundled Pi CLI release that was found. */
  piCli?: VersionItemStatus
  /** When the check ran, so a stale reading can be told from a fresh one. */
  checkedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A stored status is only usable when it names a version and a verdict. */
function normalizeStatus(value: unknown): VersionItemStatus | undefined {
  if (!isRecord(value)) return undefined
  const current = value.current
  if (typeof current !== 'string' || !current) return undefined
  const latest = value.latest
  const status: VersionItemStatus = {
    current,
    hasUpdate: value.hasUpdate === true
  }
  if (typeof latest === 'string' && latest) status.latest = latest
  if (typeof value.installerBytes === 'number' && Number.isSafeInteger(value.installerBytes) && value.installerBytes > 0) {
    status.installerBytes = value.installerBytes
  }
  return status
}

/**
 * The stored reading, or null when there is none.
 *
 * A corrupt or oversized file is treated as no reading at all: a broken cache
 * must never keep the app from checking again.
 */
export function readUpdateState(userDataDir: string): UpdateState | null {
  try {
    const file = path.join(userDataDir, UPDATE_STATE_FILE)
    if (!existsSync(file)) return null
    const stats = statSync(file)
    if (!stats.isFile() || stats.size > MAX_UPDATE_STATE_BYTES) return null
    const raw = readFileSync(file, 'utf8')
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''))
    if (!isRecord(parsed) || typeof parsed.checkedAt !== 'number' || !Number.isFinite(parsed.checkedAt)) {
      return null
    }
    const state: UpdateState = { checkedAt: parsed.checkedAt }
    const app = normalizeStatus(parsed.app)
    if (app) state.app = app
    const piCli = normalizeStatus(parsed.piCli)
    if (piCli) state.piCli = piCli
    return state.app || state.piCli ? state : null
  } catch {
    return null
  }
}

/**
 * The stored reading, but only when it still applies to the running version.
 *
 * A reading names the version that was running when it was taken. After an
 * update the running version has moved on, so the stored release is either
 * the version now running (nothing to offer) or an older one. Restoring it
 * would claim a new version is waiting when there is none, so a reading that
 * does not match the running version is dropped.
 */
export function readUpdateStateForVersion(
  userDataDir: string,
  runningVersion: string
): UpdateState | null {
  const state = readUpdateState(userDataDir)
  if (!state?.app) return null
  if (state.app.current !== runningVersion) return null
  // A stored release that is not newer than the running version is stale.
  if (!state.app.hasUpdate || !state.app.latest) return null
  if (!isNewerVersion(state.app.latest, runningVersion)) return null
  return state
}

/**
 * Store the reading. The write is atomic, so a crash mid-write leaves the
 * previous file intact rather than a half-written one.
 *
 * A failed write is not fatal: the reading still lives in the renderer for
 * this session, which is the common case anyway.
 */
export function writeUpdateState(userDataDir: string, state: UpdateState): void {
  try {
    mkdirSync(userDataDir, { recursive: true })
    const file = path.join(userDataDir, UPDATE_STATE_FILE)
    const temporary = `${file}.tmp`
    writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    console.error('[pi-desktop] failed to write update state:', error)
  }
}

/** Drop the stored reading, used when the running version is the newest one. */
export function clearUpdateState(userDataDir: string): void {
  try {
    const file = path.join(userDataDir, UPDATE_STATE_FILE)
    if (!existsSync(file)) return
    unlinkSync(file)
  } catch (error) {
    console.error('[pi-desktop] failed to clear update state:', error)
  }
}

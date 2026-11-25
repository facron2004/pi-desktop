import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import type { AppUpdateProgress } from '@shared/types'
import {
  installerAssetNames,
  isNewerVersion,
  orderedInstallerAssetNames,
  releaseDownloadUrl
} from './app-updates'
import { properLockfile } from './proper-lockfile'

const RELEASES_API = 'https://api.github.com/repos/facron2004/pi-desktop/releases/tags/'
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024

/** The one verified setup file kept in the update folder. */
export const INSTALLER_FILE = 'installer.exe'
/** Its record: which release it is and how large it was. */
const INSTALLER_RECORD_FILE = 'installer.json'
const MAX_INSTALLER_RECORD_BYTES = 16 * 1024

export interface DownloadedInstaller {
  version: string
  /** Installer size in bytes, when the record carries it. */
  bytes?: number
  digest?: string
}

/** The record a completed download leaves beside the installer. */
function installerRecordPath(directory: string): string {
  return path.join(directory, INSTALLER_RECORD_FILE)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The stored record, without asking whether it applies to the running
 * version. Callers that need a usable installer use
 * `findDownloadedInstaller`; this is for pruning a record that names another
 * release.
 */
function readInstallerRecord(directory: string): DownloadedInstaller | null {
  try {
    const file = installerRecordPath(directory)
    if (!existsSync(file)) return null
    const stats = statSync(file)
    if (!stats.isFile() || stats.size > MAX_INSTALLER_RECORD_BYTES) return null
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    if (!isRecord(parsed) || typeof parsed.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(parsed.version)) {
      return null
    }
    const bytes = parsed.bytes
    const digest = typeof parsed.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(parsed.digest)
      ? parsed.digest.toLowerCase()
      : undefined
    return typeof bytes === 'number' && Number.isSafeInteger(bytes) && bytes > 0
      ? { version: parsed.version, bytes, ...(digest ? { digest } : {}) }
      : { version: parsed.version }
  } catch {
    return null
  }
}

/**
 * The verified installer already on disk for a newer release, if there is one.
 *
 * Startup only checks the length. Reusing the file recomputes its hash before
 * returning the installer path, so startup does not have to read the entire file.
 */
export function readDownloadedInstaller(
  directory: string,
  runningVersion: string
): DownloadedInstaller & { path: string } | undefined {
  const record = readInstallerRecord(directory)
  if (!record || !isNewerVersion(record.version, runningVersion)) return undefined
  try {
    const installer = path.join(directory, INSTALLER_FILE)
    if (!existsSync(installer)) return undefined
    const stats = statSync(installer)
    if (!stats.isFile() || stats.size <= 0) return undefined
    if (record.bytes !== undefined && stats.size !== record.bytes) return undefined
    return { ...record, path: installer }
  } catch {
    return undefined
  }
}

/** The downloaded installer, but only when it is the exact release asked for. */
export function findDownloadedInstaller(
  directory: string,
  version: string,
  runningVersion: string
): DownloadedInstaller & { path: string } | undefined {
  const downloaded = readDownloadedInstaller(directory, runningVersion)
  return downloaded?.version === version ? downloaded : undefined
}

/** Remember which release the installer belongs to, atomically. */
function writeInstallerRecord(directory: string, version: string, bytes: number, digest: string): void {
  const file = installerRecordPath(directory)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(temporary, JSON.stringify({ version, bytes, digest, downloadedAt: Date.now() }, null, 2), 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      /* temporary file may not have been created */
    }
    // The download still installs from the file just written; only the
    // "already downloaded" state after a restart is lost.
    console.error('[pi-desktop] failed to write installer state:', error)
  }
}

async function withInstallerLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await mkdir(directory, { recursive: true })
  const release = await properLockfile.lock(installerRecordPath(directory), {
    realpath: false,
    stale: 120_000,
    retries: { retries: 25, minTimeout: 20, maxTimeout: 200, factor: 2 }
  })
  try {
    return await action()
  } finally {
    await release().catch(() => {})
  }
}

/** Remove the installer and its record; a missing pair is not an error. */
export function clearDownloadedInstaller(directory: string): void {
  for (const file of [path.join(directory, INSTALLER_FILE), installerRecordPath(directory)]) {
    try {
      rmSync(file, { force: true })
    } catch (error) {
      console.error('[pi-desktop] failed to remove a downloaded installer:', error)
    }
  }
}

/**
 * Drop an installer that belongs to another release — either the app has been
 * updated past it, or the release moved on. Only a record naming the newest
 * release keeps its files.
 */
export function pruneDownloadedInstaller(directory: string, latestVersion: string): void {
  // A successful check is also the one moment the update folder is examined, so
  // it is where a staging folder left by a killed download gets cleaned up —
  // whether or not the installer itself is still the newest one.
  clearStaleDownloads(directory)
  if (readInstallerRecord(directory)?.version === latestVersion) return
  clearDownloadedInstaller(directory)
}

/** A staging folder older than this cannot belong to a download still running. */
const STALE_DOWNLOAD_MS = 60 * 60_000

/**
 * Remove the staging folders a killed download left behind.
 *
 * Each download streams into its own `download-XXXXXX` folder inside the update
 * directory and deletes it in a `finally`. A process that is killed or force-quit
 * mid-download never reaches that, so the partial file — up to the installer's
 * own size — sits there for good and the next attempt adds another one.
 *
 * The age check is what keeps this from deleting another instance's live
 * download: a folder that is still being written has a fresh mtime, and two
 * copies of the app can download at the same time.
 */
export function clearStaleDownloads(directory: string, now = Date.now()): void {
  let entries: string[]
  try {
    entries = readdirSync(directory)
  } catch {
    // No update folder yet: nothing to sweep.
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith('download-')) continue
    const target = path.join(directory, entry)
    try {
      let newestMtime = statSync(target).mtimeMs
      // On Windows, streaming writes into `installer.exe` do not bump the parent
      // staging directory's mtime; check the file itself so slow downloads stay safe.
      try {
        newestMtime = Math.max(newestMtime, statSync(path.join(target, INSTALLER_FILE)).mtimeMs)
      } catch {
        /* staging folder may not have created installer.exe yet */
      }
      if (now - newestMtime < STALE_DOWNLOAD_MS) continue
      rmSync(target, { recursive: true, force: true })
    } catch {
      // A folder another process still holds is swept the next time round.
    }
  }
}

/** Portable folders have no install record and must not be silently converted to installs. */
export function supportsAppUpdate(isPackaged: boolean, platform: string, executable: string): boolean {
  if (!isPackaged || platform !== 'win32') return false
  const directory = path.dirname(executable)
  return existsSync(path.join(directory, 'install.json')) || existsSync(path.join(directory, 'Uninstall Pi Desktop.exe'))
}

interface InstallerOptions {
  currentVersion: string
  arch: string
  directory: string
  onProgress: (progress: AppUpdateProgress) => void
  fetcher?: typeof fetch
}

/** The release asset this machine would install, already validated. */
interface ReleaseAsset {
  name: string
  size: number
  /** `sha256:<hex>` as GitHub reports it. */
  digest: string
}

function assertUpdatable(version: string, options: { currentVersion: string; arch: string }): void {
  if (typeof version !== 'string' || version.length > 64 || !/^\d+\.\d+\.\d+$/.test(version) || !isNewerVersion(version, options.currentVersion)) {
    throw new Error('The requested app update is not a newer release.')
  }
  if (options.arch !== 'x64' && options.arch !== 'arm64') throw new Error('Automatic updates are not supported on this architecture.')
}

/** A REST API answer that is worth falling back from, not retrying. */
class ReleaseApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

/**
 * Read the release through the REST API: it carries the asset size and GitHub's
 * own SHA-256 digest, so nothing is inferred.
 */
async function selectReleaseAssetFromApi(
  version: string,
  options: { arch: string; fetcher: typeof fetch }
): Promise<ReleaseAsset> {
  const releaseResponse = await options.fetcher(`${RELEASES_API}v${version}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Pi-Desktop'
    },
    signal: AbortSignal.timeout(15_000)
  })
  if (!releaseResponse.ok) {
    throw new ReleaseApiError(
      `Could not read the update release (HTTP ${releaseResponse.status}).`,
      releaseResponse.status
    )
  }
  const release = await releaseResponse.json() as {
    tag_name?: string
    draft?: boolean
    prerelease?: boolean
    assets?: { name?: string; size?: number; digest?: string }[]
  }
  if (release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error('The update release is invalid.')
  }
  const names = installerAssetNames(version, options.arch)
  // Prefer the architecture-specific build to the larger universal installer.
  const asset = release.assets.find((entry) => names.includes(entry.name ?? '') && entry.name?.endsWith(`-${options.arch}.exe`))
    ?? release.assets.find((entry) => names.includes(entry.name ?? ''))
  if (!asset?.name || !asset.size || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) {
    throw new Error('No verified installer is available for this release.')
  }
  return { name: asset.name, size: asset.size, digest: asset.digest! }
}

/**
 * The release's published `SHA256SUMS.txt`, as a name → digest map.
 *
 * This file is a normal release asset: reading it costs no REST API quota, and
 * the installer it describes is verified exactly like an API digest would be —
 * both arrive over TLS from the same release.
 */
async function readReleaseChecksums(
  version: string,
  options: { fetcher: typeof fetch }
): Promise<Map<string, string>> {
  const response = await options.fetcher(releaseDownloadUrl(version, 'SHA256SUMS.txt'), {
    redirect: 'follow',
    headers: { 'User-Agent': 'Pi-Desktop' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`Could not read the update checksums (HTTP ${response.status}).`)
  const checksums = new Map<string, string>()
  for (const line of (await response.text()).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+?)\s*$/i.exec(line.trim())
    if (match) checksums.set(match[2]!, `sha256:${match[1]!.toLowerCase()}`)
  }
  return checksums
}

/**
 * Pick the asset through the public download files instead of the REST API.
 *
 * This is the fallback that keeps updates working when the anonymous API quota
 * is exhausted (HTTP 403, 60 requests an hour per network) or the API host is
 * blocked: the asset names are deterministic, a HEAD answers the size, and
 * `SHA256SUMS.txt` answers the digest. The version itself came from the web
 * `/releases/latest` redirect, which only ever names a published release, so
 * this path can never pick a draft or a prerelease.
 */
async function selectReleaseAssetFromDownloads(
  version: string,
  options: { arch: string; fetcher: typeof fetch }
): Promise<ReleaseAsset> {
  const checksums = await readReleaseChecksums(version, options)
  for (const name of orderedInstallerAssetNames(version, options.arch)) {
    const digest = checksums.get(name)
    if (!digest) continue
    const response = await options.fetcher(releaseDownloadUrl(version, name), {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'Pi-Desktop' },
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) continue
    const size = Number(response.headers.get('content-length'))
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_INSTALLER_BYTES) continue
    return { name, size, digest }
  }
  throw new Error('No verified installer is available for this release.')
}

/**
 * Pick and validate the release asset. Everything the download needs is decided
 * here — the renderer never supplies a URL, a file name or an executable path.
 * A rate-limited API falls back to the public files; a genuine server error is
 * still an error.
 */
async function selectReleaseAsset(
  version: string,
  options: { arch: string; fetcher: typeof fetch }
): Promise<ReleaseAsset> {
  try {
    return await selectReleaseAssetFromApi(version, options)
  } catch (error) {
    const rateLimited = error instanceof ReleaseApiError && (error.status === 403 || error.status === 429)
    if (!rateLimited) throw error
    console.warn(
      `[pi-desktop] the update release API answered HTTP ${error.status}; reading the release's public downloads instead.`
    )
    return selectReleaseAssetFromDownloads(version, options)
  }
}

/**
 * Stream one release asset into `target`, hashing as it goes.
 *
 * The hash and the byte count decide the outcome: a short, long or altered file
 * is deleted rather than kept, so a half-written installer can never be offered
 * as ready. Progress stops at 99% — only the caller knows when the file is
 * really in place.
 */
async function streamReleaseAsset(
  target: string,
  version: string,
  asset: ReleaseAsset,
  options: { onProgress: (progress: AppUpdateProgress) => void; fetcher: typeof fetch }
): Promise<void> {
  // A total deadline made the download impossible on a slow line: the current
  // asset is about 136 MiB, which needs roughly 240 KB/s to fit in ten minutes.
  // What matters is whether bytes still arrive, so the watchdog restarts on
  // every chunk and aborts only a transfer that has stalled.
  const controller = new AbortController()
  let stallTimer: ReturnType<typeof setTimeout> | undefined
  const stopStallWatch = () => {
    if (stallTimer) clearTimeout(stallTimer)
    stallTimer = undefined
  }
  const bumpStall = () => {
    stopStallWatch()
    stallTimer = setTimeout(() => controller.abort(new Error('The update download stalled. Please try again.')), 60_000)
    stallTimer.unref?.()
  }
  bumpStall()
  let response: Response
  try {
    response = await options.fetcher(releaseDownloadUrl(version, encodeURIComponent(asset.name)), {
      headers: { 'User-Agent': 'Pi-Desktop' },
      signal: controller.signal
    })
  } catch (error) {
    stopStallWatch()
    throw controller.signal.reason instanceof Error ? controller.signal.reason : error
  }
  if (!response.ok || !response.body) {
    stopStallWatch()
    throw new Error(`Could not download the update (HTTP ${response.status}).`)
  }
  const hash = createHash('sha256')
  let transferred = 0
  let lastPercent = -1
  options.onProgress({ version, stage: 'downloading', percent: 0, transferredBytes: 0, totalBytes: asset.size })
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bumpStall()
      transferred += chunk.length
      if (transferred > asset.size || transferred > MAX_INSTALLER_BYTES) {
        callback(new Error('The update download is larger than expected.'))
        return
      }
      hash.update(chunk)
      const percent = Math.min(99, Math.floor(transferred / asset.size * 100))
      if (percent !== lastPercent) {
        lastPercent = percent
        options.onProgress({ version, stage: 'downloading', percent, transferredBytes: transferred, totalBytes: asset.size })
      }
      callback(null, chunk)
    }
  })
  try {
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      verify,
      createWriteStream(target, { flags: 'w', mode: 0o600 })
    )
    if (transferred !== asset.size || hash.digest('hex') !== asset.digest.slice(7).toLowerCase()) {
      throw new Error('The update download failed verification. Please try again.')
    }
  } catch (error) {
    await rm(target, { force: true })
    throw controller.signal.reason instanceof Error ? controller.signal.reason : error
  } finally {
    stopStallWatch()
  }
}

async function matchesInstaller(file: string, size: number, digest: string): Promise<boolean> {
  if (size > MAX_INSTALLER_BYTES) return false
  const hash = createHash('sha256')
  let bytes = 0
  try {
    for await (const chunk of createReadStream(file)) {
      bytes += chunk.length
      if (bytes > size) return false
      hash.update(chunk)
    }
    return bytes === size && hash.digest('hex') === digest.slice(7).toLowerCase()
  } catch {
    return false
  }
}

/** Select and verify the release asset in main; the renderer never supplies a URL or executable path. */
export async function downloadAppInstaller(version: string, options: InstallerOptions): Promise<string> {
  assertUpdatable(version, options)
  const fetcher = options.fetcher ?? fetch
  const releaseOptions = { arch: options.arch, fetcher }
  return withInstallerLock(options.directory, async () => {
    const cached = findDownloadedInstaller(options.directory, version, options.currentVersion)
    // The record lives in a folder any process running as this user can write,
    // so it cannot be its own trust anchor. Ask the release what this version's
    // digest is and require the cached bytes to match it; a cache that disagrees
    // is discarded and fetched again. When the release cannot be reached the
    // cache is still used, but only because its bytes hash to the digest that was
    // written after a verified download.
    let asset: ReleaseAsset | undefined
    let cache = cached
    if (cached) {
      try {
        asset = await selectReleaseAsset(version, releaseOptions)
      } catch {
        asset = undefined
      }
      // A legacy record has no digest yet; the published digest is then what
      // verifies it. A record that names a different digest or size than the
      // release does is not this release's installer.
      if (asset && cached.digest && (cached.digest !== asset.digest || cached.bytes !== asset.size)) {
        await rm(cached.path, { force: true })
        await rm(installerRecordPath(options.directory), { force: true })
        cache = undefined
      }
    }
    if (cache) {
      const bytes = asset?.size ?? cache.bytes
      const digest = asset?.digest ?? cache.digest
      if (bytes && digest && await matchesInstaller(cache.path, bytes, digest)) {
        if (!cache.digest) writeInstallerRecord(options.directory, version, bytes, digest)
        options.onProgress({ version, stage: 'downloading', percent: 100, transferredBytes: bytes, totalBytes: bytes })
        return cache.path
      }
    }
    const releaseAsset = asset ?? await selectReleaseAsset(version, releaseOptions)
    await mkdir(options.directory, { recursive: true })
    // Clear what a killed attempt left behind before this one adds its own folder.
    clearStaleDownloads(options.directory)
    const staging = await mkdtemp(path.join(options.directory, 'download-'))
    const partial = path.join(staging, 'installer.exe')
    const installer = path.join(options.directory, INSTALLER_FILE)
    try {
      await streamReleaseAsset(partial, version, releaseAsset, { onProgress: options.onProgress, fetcher })
      // Keep only one complete installer; a failed download never replaces it.
      await rename(partial, installer)
      // The record is what lets a restart offer "restart to install" instead of
      // downloading the same release again.
      writeInstallerRecord(options.directory, version, releaseAsset.size, releaseAsset.digest)
      options.onProgress({ version, stage: 'downloading', percent: 100, transferredBytes: releaseAsset.size, totalBytes: releaseAsset.size })
      return installer
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  })
}

/** These are the setup app's silent-update flags; no command shell is involved. */
export function launchAppInstaller(installer: string, spawnProcess = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(installer, [
      '--updated',
      '/S',
      '--force-run',
      `--install-dir=${path.dirname(process.execPath)}`
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

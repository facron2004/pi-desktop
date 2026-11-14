import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream } from 'node:stream/web'
import type { AppUpdateProgress } from '@shared/types'
import { isNewerVersion } from './app-updates'

const RELEASES_API = 'https://api.github.com/repos/facron2004/pi-desktop/releases/tags/'
const DOWNLOAD_ROOT = 'https://github.com/facron2004/pi-desktop/releases/download/'
const MAX_INSTALLER_BYTES = 1024 * 1024 * 1024

/** Portable folders have no NSIS registration and must not be silently converted to installs. */
export function supportsAppUpdate(isPackaged: boolean, platform: string, executable: string): boolean {
  return isPackaged && platform === 'win32' && existsSync(path.join(path.dirname(executable), 'Uninstall Pi Desktop.exe'))
}

interface InstallerOptions {
  currentVersion: string
  arch: string
  directory: string
  onProgress: (progress: AppUpdateProgress) => void
  fetcher?: typeof fetch
}

/** Select and verify the release asset in main; the renderer never supplies a URL or executable path. */
export async function downloadAppInstaller(version: string, options: InstallerOptions): Promise<string> {
  if (typeof version !== 'string' || version.length > 64 || !/^\d+\.\d+\.\d+$/.test(version) || !isNewerVersion(version, options.currentVersion)) {
    throw new Error('The requested app update is not a newer release.')
  }
  if (options.arch !== 'x64' && options.arch !== 'arm64') throw new Error('Automatic updates are not supported on this architecture.')
  const fetcher = options.fetcher ?? fetch
  const releaseResponse = await fetcher(`${RELEASES_API}v${version}`, {
    headers: { Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(15_000)
  })
  if (!releaseResponse.ok) throw new Error(`Could not read the update release (HTTP ${releaseResponse.status}).`)
  const release = await releaseResponse.json() as {
    tag_name?: string
    draft?: boolean
    prerelease?: boolean
    assets?: { name?: string; size?: number; digest?: string }[]
  }
  if (release.tag_name !== `v${version}` || release.draft !== false || release.prerelease !== false || !Array.isArray(release.assets)) {
    throw new Error('The update release is invalid.')
  }
  const names = ['Pi.Desktop', 'Pi Desktop', 'Pi-Desktop'].flatMap((prefix) => [
    `${prefix}-${version}-${options.arch}.exe`, `${prefix}-${version}.exe`
  ])
  // Prefer the architecture-specific build to the larger universal installer.
  const asset = release.assets.find((entry) => names.includes(entry.name ?? '') && entry.name?.endsWith(`-${options.arch}.exe`))
    ?? release.assets.find((entry) => names.includes(entry.name ?? ''))
  if (!asset?.name || !asset.size || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest ?? '')) {
    throw new Error('No verified installer is available for this release.')
  }
  const response = await fetcher(`${DOWNLOAD_ROOT}v${version}/${encodeURIComponent(asset.name)}`, {
    signal: AbortSignal.timeout(10 * 60_000)
  })
  if (!response.ok || !response.body) throw new Error(`Could not download the update (HTTP ${response.status}).`)
  await mkdir(options.directory, { recursive: true })
  const staging = await mkdtemp(path.join(options.directory, 'download-'))
  const partial = path.join(staging, 'installer.exe')
  const installer = path.join(options.directory, 'installer.exe')
  try {
    const hash = createHash('sha256')
    let transferred = 0
    let lastPercent = -1
    options.onProgress({ version, stage: 'downloading', percent: 0 })
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transferred += chunk.length
        if (transferred > asset.size! || transferred > MAX_INSTALLER_BYTES) {
          callback(new Error('The update download is larger than expected.'))
          return
        }
        hash.update(chunk)
        const percent = Math.min(99, Math.floor(transferred / asset.size! * 100))
        if (percent !== lastPercent) {
          lastPercent = percent
          options.onProgress({ version, stage: 'downloading', percent })
        }
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
      verify,
      createWriteStream(partial, { flags: 'wx', mode: 0o600 })
    )
    if (transferred !== asset.size || hash.digest('hex') !== asset.digest!.slice(7).toLowerCase()) {
      throw new Error('The update download failed verification. Please try again.')
    }
    // Keep only one complete installer; a failed download never replaces it.
    await rename(partial, installer)
    options.onProgress({ version, stage: 'downloading', percent: 100 })
    return installer
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** These are electron-builder's NSIS update flags; no command shell is involved. */
export function launchAppInstaller(installer: string, spawnProcess = spawn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(installer, ['--updated', '/S', '--force-run'], {
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

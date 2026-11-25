import type { VersionItemStatus } from '@shared/types'

export const APP_RELEASE_PAGE_URL = 'https://github.com/facron2004/pi-desktop/releases/latest'

const LATEST_RELEASE_URL = APP_RELEASE_PAGE_URL
const LATEST_RELEASE_TAG_PATH = /^\/facron2004\/pi-desktop\/releases\/tag\/v?(\d+\.\d+\.\d+)$/
const SEMVER_PATTERN = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

interface ParsedVersion {
  core: [bigint, bigint, bigint]
  prerelease: string[]
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = SEMVER_PATTERN.exec(value)
  if (!match) return undefined
  const prerelease = match[4]?.split('.') ?? []
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    return undefined
  }
  return {
    core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)],
    prerelease
  }
}

function comparePrerelease(left: string[], right: string[]): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }
  return Math.sign(left.length - right.length)
}

export function isNewerVersion(latest: string, current: string): boolean {
  const left = parseVersion(latest)
  const right = parseVersion(current)
  if (!left || !right) return false
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! > right.core[index]!
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === 0 && right.prerelease.length > 0
  }
  return comparePrerelease(left.prerelease, right.prerelease) > 0
}

export async function fetchLatestAppVersion(fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher(LATEST_RELEASE_URL, {
    method: 'HEAD',
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000)
  })
  if (response.status < 300 || response.status >= 400) {
    throw new Error(`GitHub release check failed (HTTP ${response.status})`)
  }

  const location = response.headers.get('location')
  if (!location) throw new Error('GitHub did not redirect to the latest release')
  const releaseUrl = new URL(location, LATEST_RELEASE_URL)
  if (releaseUrl.origin !== 'https://github.com') {
    throw new Error('GitHub redirected to an unexpected release host')
  }
  const match = LATEST_RELEASE_TAG_PATH.exec(releaseUrl.pathname)
  if (!match) throw new Error('GitHub redirected to an invalid latest release tag')
  return match[1]!
}

/** Where the release's public download files live. No REST API quota here. */
export const RELEASE_DOWNLOAD_ROOT = 'https://github.com/facron2004/pi-desktop/releases/download/'

/** A release file's public URL: the browser download endpoint GitHub serves. */
export function releaseDownloadUrl(version: string, file: string): string {
  return `${RELEASE_DOWNLOAD_ROOT}v${version}/${file}`
}

/** The asset names an electron-builder release may use for this version. */
export function installerAssetNames(version: string, arch: string): string[] {
  return ['Pi.Desktop', 'Pi Desktop', 'Pi-Desktop'].flatMap((prefix) => [
    `${prefix}-${version}-${arch}.exe`,
    `${prefix}-${version}.exe`
  ])
}

/**
 * The candidate assets in the order a download should try them: the
 * architecture-specific build first, the larger universal one after it.
 */
export function orderedInstallerAssetNames(version: string, arch: string): string[] {
  const names = installerAssetNames(version, arch)
  const specific = names.filter((name) => name.endsWith(`-${arch}.exe`))
  const universal = names.filter((name) => !name.endsWith(`-${arch}.exe`))
  return [...specific, ...universal]
}

/**
 * Size of the release installer, so an update card can say how large the
 * download is before it starts. A missing answer is not an error: the version
 * check still stands on its own.
 *
 * This reads the public download endpoint with a HEAD. The REST API allows 60
 * anonymous requests per hour per network, and the old implementation spent one
 * of them on every check; a machine that restarted the app a few times could
 * exhaust that quota and then could not download an update at all.
 */
export async function fetchInstallerBytes(
  version: string,
  arch: string,
  fetcher: typeof fetch = fetch
): Promise<number | undefined> {
  for (const name of orderedInstallerAssetNames(version, arch)) {
    try {
      const response = await fetcher(releaseDownloadUrl(version, name), {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'User-Agent': 'Pi-Desktop' },
        signal: AbortSignal.timeout(8_000)
      })
      if (!response.ok) continue
      const bytes = Number(response.headers.get('content-length'))
      if (Number.isSafeInteger(bytes) && bytes > 0) return bytes
    } catch {
      /* the next candidate may still be downloadable */
    }
  }
  return undefined
}

export async function checkAppVersion(
  current: string,
  fetcher: typeof fetch = fetch
): Promise<VersionItemStatus> {
  try {
    const latest = await fetchLatestAppVersion(fetcher)
    const hasUpdate = isNewerVersion(latest, current)
    if (!hasUpdate) return { current, latest, hasUpdate }
    const installerBytes = await fetchInstallerBytes(latest, process.arch, fetcher)
    return installerBytes
      ? { current, latest, hasUpdate, installerBytes }
      : { current, latest, hasUpdate }
  } catch (err: unknown) {
    return {
      current,
      hasUpdate: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

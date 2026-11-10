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

export async function checkAppVersion(
  current: string,
  fetcher: typeof fetch = fetch
): Promise<VersionItemStatus> {
  try {
    const latest = await fetchLatestAppVersion(fetcher)
    return { current, latest, hasUpdate: isNewerVersion(latest, current) }
  } catch (err: unknown) {
    return {
      current,
      hasUpdate: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

import type { VersionItemStatus } from '@shared/types'

export const APP_RELEASE_PAGE_URL = 'https://github.com/facron2004/pi-desktop/releases/latest'

const LATEST_RELEASE_URL = APP_RELEASE_PAGE_URL
const LATEST_RELEASE_TAG_PATH = /^\/facron2004\/pi-desktop\/releases\/tag\/v?(\d+\.\d+\.\d+)$/

export function isNewerVersion(latest: string, current: string): boolean {
  const l = latest.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const c = current.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const li = l[i] ?? 0
    const ci = c[i] ?? 0
    if (li > ci) return true
    if (li < ci) return false
  }
  return false
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

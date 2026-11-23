import { get } from 'node:https'
import type { VersionItemStatus } from '@shared/types'

/**
 * Asking npm what the newest Pi CLI is.
 *
 * Two rules this module exists for:
 *
 * 1. **Upstream decides.** The CLI is a component the app drives, not a pinned
 *    part of this app's own release; the version offered must be what the
 *    registry publishes as `latest`, not the greatest version some local range
 *    happens to allow. A `package.json` range describes what a checkout was
 *    installed with, and reading it here turned a stale range — or a stale
 *    lockfile — into "you are up to date" while upstream had moved on.
 *
 * 2. **The answer has to arrive.** `npm view` costs a Node process plus npm's
 *    own start-up before it touches the network: a cold npm cache on a slow
 *    registry took **194 s** on the machine this was written for, against 2.5 s
 *    warm. The old 8 s cap therefore failed the check on exactly the run where
 *    the reader wanted it, and a failed check was indistinguishable from "up to
 *    date" in the UI. So the registry is asked directly — one HTTPS request for
 *    the abbreviated packument npm itself installs from (no readmes, ~100 KB),
 *    answered in about a second. npm stays the fallback, because it alone
 *    understands every registry and proxy setting the reader has configured.
 */

export const CLI_PACKAGE_NAME = '@earendil-works/pi-coding-agent'

const REGISTRY_ORIGIN = 'https://registry.npmjs.org'
/** npm's own media type for install-resolution metadata. */
const ABBREVIATED_PACKUMENT = 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8'
const REGISTRY_TIMEOUT_MS = 12_000

const TRIPLET = /^\s*v?(\d+)\.(\d+)\.(\d+)\s*$/
/** A version with a prerelease tail, e.g. `2.0.0-rc.1`. Not a bare word that
 *  happens to contain a dash. */
const PRERELEASE = /^\s*v?\d+\.\d+\.\d+-[0-9A-Za-z.-]+\s*$/

/** `1.6.0` -> [1, 6, 0]; a prerelease or a tag is not a triplet. */
export function parseTriplet(value: string): [number, number, number] | null {
  const match = TRIPLET.exec(value ?? '')
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareTriplet(
  left: [number, number, number],
  right: [number, number, number]
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
  }
  return 0
}

/** The packument URL npm itself fetches. The scope is left readable, the
 *  slash is escaped — the form the registry serves. */
export function packumentUrl(packageName: string, origin = REGISTRY_ORIGIN): string {
  return `${origin}/${encodeURIComponent(packageName).replace(/^%40/, '@')}`
}

/**
 * The version upstream calls current: the packument's `latest` dist-tag.
 *
 * When that tag is missing or malformed, the greatest published stable version
 * stands in. A prerelease is never chosen by the fallback — only a `latest` tag
 * that names one, which is upstream's own statement.
 */
export function pickLatestVersion(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const packument = body as {
    'dist-tags'?: Record<string, unknown>
    versions?: Record<string, unknown>
  }
  const tagged = packument['dist-tags']?.latest
  if (typeof tagged === 'string' && tagged.trim()) {
    const version = tagged.trim()
    if (parseTriplet(version) || PRERELEASE.test(version)) return version
  }
  let best: { raw: string; triple: [number, number, number] } | null = null
  for (const raw of Object.keys(packument.versions ?? {})) {
    if (raw.includes('-')) continue
    const triple = parseTriplet(raw)
    if (!triple) continue
    if (!best || compareTriplet(triple, best.triple) > 0) best = { raw, triple }
  }
  return best?.raw ?? null
}

export interface RegistryLookupOptions {
  /** Reads and parses a JSON body; replaceable for tests. */
  getJson?: JsonGetter
  timeoutMs?: number
  origin?: string
}

export type JsonGetter = (
  url: string,
  headers: Record<string, string>,
  timeoutMs: number
) => Promise<unknown | null>

/**
 * One HTTPS GET, parsed as JSON.
 *
 * This deliberately uses `node:https` rather than `fetch`: in Electron's main
 * process `fetch` is the one bound to a session, so it follows the session's
 * proxy configuration. On a machine whose system proxy does not carry the
 * registry, that call hangs until the timeout — observed here as a 12 s stall
 * that dropped the check onto the slow npm path. `node:https` goes where npm
 * itself would go by default; a reader who truly needs a proxy for the registry
 * still has the npm fallback, which honours their npm config.
 */
export const httpsGetJson: JsonGetter = (url, headers, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false
    const finish = (value: unknown | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const request = get(
        url,
        { headers: { ...headers, 'accept-encoding': 'identity' } },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume()
            finish(null)
            return
          }
          let body = ''
          response.setEncoding('utf8')
          response.on('data', (chunk: string) => {
            body += chunk
          })
          response.on('end', () => {
            try {
              finish(JSON.parse(body) as unknown)
            } catch {
              finish(null)
            }
          })
          response.on('error', () => finish(null))
        }
      )
      request.setTimeout(timeoutMs, () => {
        request.destroy()
        finish(null)
      })
      request.on('error', () => finish(null))
    } catch {
      finish(null)
    }
  })

/**
 * The newest version upstream publishes, read from the registry.
 *
 * Answers `null` for "ask npm instead" — a network or proxy failure, an
 * unreadable body. It never throws: this runs behind a check whose whole job is
 * to answer something.
 */
export async function fetchLatestCliVersionFromRegistry(
  packageName: string,
  options: RegistryLookupOptions = {}
): Promise<string | null> {
  const getJson = options.getJson ?? httpsGetJson
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS
  try {
    const body = await getJson(
      packumentUrl(packageName, options.origin),
      { accept: ABBREVIATED_PACKUMENT },
      timeoutMs
    )
    return pickLatestVersion(body)
  } catch {
    return null
  }
}

/** A reading whose `error` is worth showing: the check could not answer. */
export function describeCheckFailure(status: VersionItemStatus): string | null {
  return status.error && status.error.trim() ? status.error.trim() : null
}

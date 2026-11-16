import { lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Canonical paths, remembered for the life of the process.
 *
 * `listSessions` asks for the identity of every JSONL on every refresh, and
 * `realpathSync` is synchronous disk work: one call per file after every turn,
 * on the main thread. A session file does not move, so the answer is cached;
 * the bound keeps a long-lived process from growing the map without limit.
 */
const CANONICAL_CACHE_LIMIT = 5000
const PATH_CACHE_LIMIT = 2000
const canonicalCache = new Map<string, string>()

interface CachedPathIdentity {
  dev: bigint
  ino: bigint
  ctimeNs: bigint
  mtimeNs: bigint
  canonical: string
}
const pathIdentityCache = new Map<string, CachedPathIdentity>()

function rememberBounded<K, V>(cache: Map<K, V>, limit: number, key: K, value: V): void {
  if (cache.has(key)) cache.delete(key)
  else if (cache.size >= limit) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
}

/**
 * Identity of one session JSONL file.
 *
 * Windows accepts both slash directions and treats paths as case-insensitive.
 * Two strings that name the same file must take one writer lock.
 */
export function canonicalSessionFile(file: string): string {
  const absolute = path.resolve(file)
  // A case-insensitive key merges two spellings of one file on Windows, where
  // both would resolve to the same canonical value anyway.
  const cacheKey = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const cached = canonicalCache.get(cacheKey)
  if (cached) {
    // True LRU promotion so active conversations stay hot.
    canonicalCache.delete(cacheKey)
    canonicalCache.set(cacheKey, cached)
    return cached
  }

  const canonical = canonicalPath(absolute)
  rememberBounded(canonicalCache, CANONICAL_CACHE_LIMIT, cacheKey, canonical)
  return canonical
}

/** Resolve a live filesystem path without caching a possibly stale symlink identity. */
export function canonicalPath(file: string): string {
  const absolute = path.resolve(file)
  const cacheKey = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  let stat: ReturnType<typeof lstatSync> | undefined
  try {
    stat = lstatSync(absolute, { bigint: true, throwIfNoEntry: false })
  } catch {
    stat = undefined
  }
  // Never serve cached paths for missing entries, symlinks/junctions, or hard-linked files
  // so replaced symlinks/directories resolve immediately.
  const cacheable = Boolean(stat && !stat.isSymbolicLink() && (stat.isDirectory() || stat.nlink <= 1n))
  if (cacheable && stat) {
    const hit = pathIdentityCache.get(cacheKey)
    if (
      hit &&
      hit.dev === stat.dev &&
      hit.ino === stat.ino &&
      hit.ctimeNs === stat.ctimeNs &&
      hit.mtimeNs === stat.mtimeNs
    ) {
      pathIdentityCache.delete(cacheKey)
      pathIdentityCache.set(cacheKey, hit)
      return hit.canonical
    }
  }

  let resolved = absolute
  try {
    resolved = realpathSync.native(resolved)
  } catch {
    // A draft's file may not exist yet, but its directory can be a junction.
    try { resolved = path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved)) } catch { /* use the resolved path */ }
  }
  const slashNormalized = resolved.replace(/\\/g, '/')
  const normalizedRoot = path.parse(resolved).root.replace(/\\/g, '/')
  // Preserve filesystem roots. Trimming the separator turns `/` into an empty
  // key and `C:/` into drive-relative `C:`, so the root no longer overlaps its
  // child directories in CwdGate.
  const isRoot = process.platform === 'win32'
    ? slashNormalized.toLowerCase() === normalizedRoot.toLowerCase()
    : slashNormalized === normalizedRoot
  const normalized = isRoot ? slashNormalized : slashNormalized.replace(/\/$/, '')
  const canonical = process.platform === 'win32' ? normalized.toLowerCase() : normalized

  if (cacheable && stat) {
    rememberBounded(pathIdentityCache, PATH_CACHE_LIMIT, cacheKey, {
      dev: stat.dev,
      ino: stat.ino,
      ctimeNs: stat.ctimeNs,
      mtimeNs: stat.mtimeNs,
      canonical
    })
  }
  return canonical
}

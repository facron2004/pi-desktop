import { realpathSync } from 'node:fs'
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
const canonicalCache = new Map<string, string>()

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
  if (cached) return cached

  let resolved = absolute
  try {
    resolved = realpathSync.native(resolved)
  } catch {
    // A draft's file may not exist yet, but its directory can be a junction.
    try { resolved = path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved)) } catch { /* use the resolved path */ }
  }
  const normalized = resolved.replace(/\\/g, '/').replace(/\/$/, '')
  const canonical = process.platform === 'win32' ? normalized.toLowerCase() : normalized
  if (canonicalCache.size >= CANONICAL_CACHE_LIMIT) {
    const oldest = canonicalCache.keys().next().value
    if (oldest !== undefined) canonicalCache.delete(oldest)
  }
  canonicalCache.set(cacheKey, canonical)
  return canonical
}

import { realpathSync } from 'node:fs'
import path from 'node:path'

/**
 * Identity of one session JSONL file.
 *
 * Windows accepts both slash directions and treats paths as case-insensitive.
 * Two strings that name the same file must take one writer lock.
 */
export function canonicalSessionFile(file: string): string {
  let resolved = path.resolve(file)
  try {
    resolved = realpathSync.native(resolved)
  } catch {
    // A draft's file may not exist yet, but its directory can be a junction.
    try { resolved = path.join(realpathSync.native(path.dirname(resolved)), path.basename(resolved)) } catch { /* use the resolved path */ }
  }
  const normalized = resolved.replace(/\\/g, '/').replace(/\/$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

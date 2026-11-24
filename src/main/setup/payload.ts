import { statSync } from 'node:fs'
import path from 'node:path'

/** One file the installer has to copy; an asar archive is one opaque file. */
export interface SourceEntry {
  relative: string
  /** Byte length, or 0 for an archive whose size is not enumerated. */
  size: number
}

/** A file the copy did not deliver as it is in the payload. */
export interface PayloadMismatch {
  relative: string
  expected: number
  actual: number | null
}

/**
 * Check a copied tree against the payload it came from.
 *
 * The installer used to write straight over the installed folder and then start
 * the app, so a copy that ran out of disk (or hit a file another process held
 * open past robocopy's retries) launched a directory holding the new executable
 * next to an old archive. The copy now goes to a staging folder and this check
 * decides whether it may replace the real one: every listed file must exist and
 * have the payload's size before anything is swapped or marked installed.
 */
export function verifyPayload(target: string, entries: readonly SourceEntry[]): PayloadMismatch[] {
  const mismatches: PayloadMismatch[] = []
  for (const entry of entries) {
    const file = path.join(target, entry.relative)
    let actual: number | null = null
    try {
      const stats = statSync(file)
      if (stats.isFile()) actual = stats.size
    } catch {
      actual = null
    }
    // An archive is copied as one opaque file, so its exact size is not known
    // from the listing; a present, non-empty file is the whole contract.
    if (entry.size === 0 ? actual === null || actual === 0 : actual !== entry.size) {
      mismatches.push({ relative: entry.relative, expected: entry.size, actual })
    }
  }
  return mismatches
}

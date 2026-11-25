import { rmSync, statSync } from 'node:fs'
import path from 'node:path'

/** One file the installer has to copy; an asar archive is one opaque file. */
export interface SourceEntry {
  relative: string
  /** Byte length, or 0 when it could not be read (see `statPayloadFile`). */
  size: number
}

/** A file the copy did not deliver as it is in the payload. */
export interface PayloadMismatch {
  relative: string
  expected: number
  actual: number | null
}

/**
 * Read a path as the file it is, not as the archive Electron would open.
 *
 * Electron's patched `fs` treats any path ending in `.asar` as an archive and
 * parses it: a staged `resources/app.asar` is a perfectly good file, but
 * `statSync` on it throws "Invalid package", and a real archive answers with a
 * virtual directory. The copy is made by robocopy, which sees the file — so
 * verifying with the patched `fs` called a file that had copied correctly
 * "missing", and every silent update died on `resources\app.asar` alone.
 * `noAsar` is Electron's own switch for one raw read; it only ever covers the
 * copy's own folder, never a running archive.
 */
export function statPayloadFile(file: string): number | null {
  const previous = process.noAsar
  process.noAsar = true
  try {
    const stats = statSync(file)
    return stats.isFile() ? stats.size : null
  } catch {
    return null
  } finally {
    process.noAsar = previous
  }
}

/**
 * Remove a copy the installer made (a staging or backup folder).
 *
 * The same `noAsar` switch: deleting the tree walks into `resources/app.asar`,
 * and the patched `fs` refuses to unlink a file it is trying to open as an
 * archive — which left a whole staging copy (an `app.asar` of ~187 MB) beside
 * the install after every failed update.
 */
export function removeTree(target: string): void {
  const previous = process.noAsar
  process.noAsar = true
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    /* A folder another process still holds is removed by the next install. */
  } finally {
    process.noAsar = previous
  }
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
 *
 * An archive is compared by its size like any other file — it is one file to
 * the copy, and reading its length is what `statPayloadFile` is for. A size of
 * 0 means the payload side could not be read, and then a present, non-empty
 * file is the whole contract.
 */
export function verifyPayload(target: string, entries: readonly SourceEntry[]): PayloadMismatch[] {
  const mismatches: PayloadMismatch[] = []
  for (const entry of entries) {
    const actual = statPayloadFile(path.join(target, entry.relative))
    if (entry.size === 0 ? actual === null || actual === 0 : actual !== entry.size) {
      mismatches.push({ relative: entry.relative, expected: entry.size, actual })
    }
  }
  return mismatches
}

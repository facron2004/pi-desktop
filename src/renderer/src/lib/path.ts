/** Path helpers that work without Node in the renderer. */

/** True when the value is already absolute (POSIX root or Windows drive). */
export function isAbsolutePath(value: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(value)
}

/**
 * Resolve a path that Pi returned. Pi's `export_html` reports a bare file
 * name, relative to the working directory of the session.
 */
export function resolveAgainst(base: string | undefined, target: string): string {
  if (isAbsolutePath(target)) return target
  if (!base) return target
  return `${base.replace(/[\\/]+$/, '')}/${target}`
}

/** The last segment of a path, for display. */
export function basename(value: string): string {
  const parts = value.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? value
}

/**
 * The path of `target` relative to `root`, for display.
 * Falls back to the full path when the two are unrelated.
 *
 * Pi reports Windows paths with forward slashes while the workspace path
 * uses backslashes, so the comparison is done on normalised separators.
 */
export function relativePath(root: string, target: string): string {
  if (!root) return target
  const normalise = (value: string) =>
    value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const normalisedRoot = normalise(root)
  const normalisedTarget = normalise(target)
  if (!normalisedTarget.startsWith(`${normalisedRoot}/`)) return target
  // Normalising keeps the length, so the original prefix is the same size.
  return target.slice(root.replace(/[\\/]+$/, '').length + 1)
}

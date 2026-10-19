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
 */
export function relativePath(root: string, target: string): string {
  if (!root) return target
  const normalisedRoot = root.replace(/[\\/]+$/, '').toLowerCase()
  const normalisedTarget = target.toLowerCase()
  if (!normalisedTarget.startsWith(`${normalisedRoot}/`) && !normalisedTarget.startsWith(`${normalisedRoot}\\`)) {
    return target
  }
  return target.slice(normalisedRoot.length + 1)
}

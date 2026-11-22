/** Archive paths have Windows-style case and separator rules only on Windows paths. */
export function archiveSessionKey(file: string): string {
  if (!/^(?:[a-z]:[\\/]|\\\\|\/\/)/i.test(file)) return file
  return file.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

import { samePath } from './path'

/**
 * The folders a project is worked in. Position is the whole state: the first
 * row is the primary folder — the path the project opens in — so a new folder
 * is appended and promoting one moves it to the front. Nothing stores a
 * second flag that could disagree with the order.
 */

/** Append a folder, or answer null when the project already has it. */
export function addProjectFolder(folders: readonly string[], folder: string): string[] | null {
  if (folders.some((existing) => samePath(existing, folder))) return null
  return [...folders, folder]
}

/** Remove one folder; the next one becomes primary when it was the first. */
export function removeProjectFolder(folders: readonly string[], target: string): string[] {
  return folders.filter((folder) => !samePath(folder, target))
}

/** Move an existing folder to the front, keeping the rest in order. */
export function promoteProjectFolder(folders: readonly string[], target: string): string[] {
  const primary = folders.find((folder) => samePath(folder, target))
  if (!primary) return [...folders]
  return [primary, ...folders.filter((folder) => !samePath(folder, target))]
}

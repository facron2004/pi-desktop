import {
  PROJECT_ICON_EMOJIS,
  type ProjectIconCategory,
  type ProjectIconEntry
} from './project-icon-data'

export { PROJECT_ICON_EMOJIS, type ProjectIconCategory, type ProjectIconEntry }

/**
 * The emoji that match a search, or that belong to a category.
 *
 * Kept separate from `project-icons.ts` so the emoji keyword table stays inside
 * the lazy-loaded `ProjectIconPicker` chunk instead of the eager startup bundle.
 */
export function searchProjectIcons(
  query: string,
  category?: ProjectIconCategory
): ProjectIconEntry[] {
  const needle = query.trim().toLowerCase()
  const pool = category
    ? PROJECT_ICON_EMOJIS.filter((entry) => entry.category === category)
    : PROJECT_ICON_EMOJIS
  if (!needle) return pool
  return pool.filter((entry) =>
    `${entry.emoji} ${entry.keywords}`.toLowerCase().includes(needle)
  )
}

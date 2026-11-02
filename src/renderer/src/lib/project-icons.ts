import type { ProjectIconColor } from '@shared/types'
import {
  PROJECT_ICON_EMOJIS,
  type ProjectIconCategory,
  type ProjectIconEntry
} from './project-icon-data'

export type { ProjectIconCategory, ProjectIconEntry }

/**
 * The tints a project icon can wear, in the order MCode offers them.
 *
 * The colour itself lives in the stylesheet: the component only writes the
 * name into `data-icon-color`, and the token behind it is picked per theme.
 */
export const PROJECT_ICON_COLORS: ProjectIconColor[] = [
  'neutral',
  'yellow',
  'orange',
  'green',
  'blue',
  'purple',
  'pink',
  'red'
]

export const DEFAULT_PROJECT_ICON_COLOR: ProjectIconColor = 'neutral'

/** The colour of a project that never picked one. */
export function projectIconColor(color: string | undefined): ProjectIconColor {
  return PROJECT_ICON_COLORS.includes(color as ProjectIconColor)
    ? (color as ProjectIconColor)
    : DEFAULT_PROJECT_ICON_COLOR
}

/**
 * The emoji a project wears, or undefined when it wears the folder icon.
 *
 * An emoji that is not a single character cannot be rendered in the badge, so
 * it is treated as no icon at all.
 */
export function projectIconEmoji(icon: string | undefined): string | undefined {
  if (!icon) return undefined
  const trimmed = icon.trim()
  if (!trimmed) return undefined
  return [...trimmed].length === 1 ? trimmed : undefined
}

/**
 * The emoji that match a search, or that belong to a category.
 *
 * The words are matched against the emoji and its keywords, so "编程" finds
 * the laptop and "code" finds it too.
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

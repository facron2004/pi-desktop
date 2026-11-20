import type { SidebarArchiveFilter, SidebarSortBy, SessionMeta } from '@shared/types'
import { normalisePathKey } from './path'

/** The newest activity a project has, from its own metadata or its conversations. */
function latestActivity(project: { lastOpenedAt: number; sessions: SessionMeta[] }): number {
  let latest = project.lastOpenedAt || 0
  for (const session of project.sessions) {
    const at = session.updatedAt || session.createdAt || 0
    if (at > latest) latest = at
  }
  return latest
}

/**
 * Hide archived conversations (the default), show them alongside everything
 * else, or show only them. A session file is archived by path, not by project,
 * so the same rule covers registered and session-only projects.
 */
export function filterByArchive<Session extends SessionMeta>(
  sessions: readonly Session[],
  archived: ReadonlySet<string>,
  mode: SidebarArchiveFilter
): Session[] {
  if (mode === 'all') return [...sessions]
  // Settings keeps the original spelling; compare canonicalised keys on both
  // sides so a backslash or drive-letter difference cannot hide an archive.
  const archivedKeys = new Set(Array.from(archived, normalisePathKey))
  if (mode === 'archived') return sessions.filter((session) => archivedKeys.has(normalisePathKey(session.file)))
  return sessions.filter((session) => !archivedKeys.has(normalisePathKey(session.file)))
}

/**
 * Sort projects and the conversations inside them. `manual` keeps the order
 * `collectProjects` produced from `settings.projectOrder`; `updated` puts the
 * most recently active project first and its newest conversation on top.
 */
export function sortByMode<
  Session extends SessionMeta,
  Project extends { lastOpenedAt: number; sessions: Session[] }
>(projects: readonly Project[], mode: SidebarSortBy): Project[] {
  if (mode === 'manual') return [...projects]
  return projects
    .map((project) => ({
      ...project,
      sessions: [...project.sessions].sort((a, b) =>
        (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
      )
    }))
    .sort((a, b) => latestActivity(b) - latestActivity(a) || a.sessions.length - b.sessions.length) as Project[]
}

/**
 * Depth of each project in the workspace tree. A project nested under another
 * project's folder is one level deeper; unrelated folders stay at the root, so
 * the tree is derived from the paths the reader already has, not new metadata.
 */
export function projectDepths<Project extends { path: string }>(
  projects: readonly Project[]
): Map<string, number> {
  const keys = projects.map((project) => normalisePathKey(project.path))
  const depths = new Map<string, number>()
  keys.forEach((key, index) => {
    let depth = 0
    keys.forEach((other, otherIndex) => {
      if (index === otherIndex || !other) return
      if (key.startsWith(`${other}/`)) depth += 1
    })
    depths.set(key, depth)
  })
  return depths
}

/** One flat list: every conversation in the order it was last touched. */
export function flatSessions<Session extends SessionMeta>(sessions: readonly Session[]): Session[] {
  return [...sessions].sort((a, b) =>
    (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)
  )
}

import type { SidebarArchiveFilter, SidebarSortBy, SessionMeta } from '@shared/types'
import { archiveSessionKey } from '@shared/session-archive'
import { basename, normalisePathKey } from './path'

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
  const archivedKeys = new Set(Array.from(archived, archiveSessionKey))
  return sessions.filter((session) => archivedKeys.has(archiveSessionKey(session.file)) === (mode === 'archived'))
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

/** Archived conversations from one project folder. */
export interface ArchivedProjectGroup<Session> {
  /** The project folder, normalised; '' for chats with no folder of their own. */
  key: string
  name: string
  sessions: Session[]
}

/**
 * Group archived conversations by the project they belong to.
 *
 * The flat list is one newest-first column with no project rows, which is what
 * makes it quick to scan — but an archived conversation is exactly the row whose
 * folder is not obvious from its surroundings, so those are grouped under their
 * project instead of sitting unlabelled in the column. Groups keep the caller's
 * project order (a reader who arranged their projects expects it to hold);
 * folders that order does not name, and chats with no folder at all, come last,
 * newest activity first, with the projectless chat group closing the list.
 */
export function groupArchivedByProject<Session extends SessionMeta>(
  sessions: readonly Session[],
  options: {
    /** Display name for a project folder; the folder's own name is the fallback. */
    projectName?: (path: string) => string | undefined
    /** Heading for archived chats that were never opened in a folder. */
    projectlessName: string
    /** Project order to honour, as the sidebar's project rows have it. */
    order?: readonly string[]
  }
): ArchivedProjectGroup<Session>[] {
  const order = (options.order ?? []).map((path) => normalisePathKey(path))
  const groups = new Map<string, ArchivedProjectGroup<Session>>()
  for (const session of sessions) {
    const finished = session.cwd
    const key = finished ? normalisePathKey(finished) : ''
    let group = groups.get(key)
    if (!group) {
      const named = finished ? options.projectName?.(finished) : undefined
      group = {
        key,
        name: key ? (named || basename(finished ?? '')) : options.projectlessName,
        sessions: []
      }
      groups.set(key, group)
    }
    group.sessions.push(session)
  }
  const newest = (group: ArchivedProjectGroup<Session>): number =>
    group.sessions.reduce(
      (at, session) => Math.max(at, session.updatedAt || session.createdAt || 0),
      0
    )
  return [...groups.values()]
    .map((group) => ({ ...group, sessions: flatSessions(group.sessions) }))
    .sort((left, right) => {
      // Chats with no folder are their own block and always close the list.
      if (left.key === '') return right.key === '' ? 0 : 1
      if (right.key === '') return -1
      const leftRank = order.indexOf(left.key)
      const rightRank = order.indexOf(right.key)
      const leftPlace = leftRank === -1 ? Number.POSITIVE_INFINITY : leftRank
      const rightPlace = rightRank === -1 ? Number.POSITIVE_INFINITY : rightRank
      if (leftPlace !== rightPlace) return leftPlace - rightPlace
      return newest(right) - newest(left) || left.name.localeCompare(right.name)
    })
}

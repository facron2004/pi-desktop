import type { ProjectIconColor, SessionMeta, Workspace } from '@shared/types'
import { basename, normalisePathKey } from './path'

/** A project: a folder Pi can run in. */
export interface Project<Session extends SessionMeta = SessionMeta> {
  path: string
  name: string
  /** The settings id, when the project is registered. */
  id?: string
  /** True when the project is in the settings and can be removed from there. */
  registered: boolean
  lastOpenedAt: number
  sessions: Session[]
  folders?: string[]
  /** Emoji the project wears instead of the folder icon. */
  icon?: string
  /** Tint of the project icon. */
  iconColor?: ProjectIconColor
}

/**
 * Every project the user can work in.
 *
 * A project is either registered in the settings, or known because it has
 * conversations on disk. The second kind shows up in the sidebar so that a
 * conversation can always be found, and it is registered the first time it
 * is opened. A path in `hiddenPaths` is one the user already removed: its
 * conversations must not bring the row back. Registering the folder again
 * wins over that list.
 *
 * Paths are canonicalised by `normalisePathKey` so case, slashes or trailing
 * slashes never cause duplicate entries.
 */
export function collectProjects<Session extends SessionMeta>(
  workspaces: Workspace[],
  sessions: Session[],
  hiddenPaths: readonly string[] = []
): Project<Session>[] {
  const hidden = new Set(hiddenPaths.map((path) => normalisePathKey(path)))
  const map = new Map<string, Project<Session>>()

  for (const item of workspaces) {
    if (!item?.path) continue
    const key = normalisePathKey(item.path)
    const existing = map.get(key)
    if (existing) {
      existing.registered = true
      existing.id = item.id || existing.id
      existing.lastOpenedAt = Math.max(existing.lastOpenedAt, item.lastOpenedAt || 0)
      if (item.name && (!existing.name || existing.name === 'Unknown project')) {
        existing.name = basename(item.name)
      }
      if (item.folders && item.folders.length > 0) {
        existing.folders = item.folders
      }
      if (item.icon) existing.icon = item.icon
      if (item.iconColor) existing.iconColor = item.iconColor
    } else {
      map.set(key, {
        path: item.path,
        name: item.name ? basename(item.name) : (basename(item.path) || 'Unknown project'),
        id: item.id,
        registered: true,
        lastOpenedAt: item.lastOpenedAt || 0,
        sessions: [],
        folders: item.folders && item.folders.length > 0 ? [...item.folders] : [item.path],
        icon: item.icon,
        iconColor: item.iconColor
      })
    }
  }

  for (const session of sessions) {
    if (!session?.cwd) continue
    const key = normalisePathKey(session.cwd)
    let project = map.get(key)
    if (!project) {
      if (hidden.has(key)) continue
      project = {
        path: session.cwd,
        name: basename(session.cwd) || 'Unknown project',
        registered: false,
        lastOpenedAt: 0,
        sessions: [],
        folders: [session.cwd]
      }
      map.set(key, project)
    }
    project.sessions.push(session)
  }

  return Array.from(map.values())
}

/**
 * Keep the order the projects were added in.
 *
 * Opening a conversation must not pull its folder to the top. `collectProjects`
 * already walks the settings list first, and that list is the creation order
 * until the user drags a row. `activePath` is unused on purpose: the open
 * project is marked, not moved.
 */
export function sortProjects<Session extends SessionMeta>(
  projects: Project<Session>[],
  activePath?: string
): Project<Session>[] {
  void activePath
  return [...projects]
}

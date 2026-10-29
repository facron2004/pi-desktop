import type { SessionMeta, Workspace } from '@shared/types'
import { basename, normalisePathKey } from './path'

/** A project: a folder Pi can run in. */
export interface Project {
  path: string
  name: string
  /** The settings id, when the project is registered. */
  id?: string
  /** True when the project is in the settings and can be removed from there. */
  registered: boolean
  lastOpenedAt: number
  sessions: SessionMeta[]
  folders?: string[]
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
export function collectProjects(
  workspaces: Workspace[],
  sessions: SessionMeta[],
  hiddenPaths: readonly string[] = []
): Project[] {
  const hidden = new Set(hiddenPaths.map((path) => normalisePathKey(path)))
  const map = new Map<string, Project>()

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
    } else {
      map.set(key, {
        path: item.path,
        name: item.name ? basename(item.name) : (basename(item.path) || 'Unknown project'),
        id: item.id,
        registered: true,
        lastOpenedAt: item.lastOpenedAt || 0,
        sessions: [],
        folders: item.folders && item.folders.length > 0 ? [...item.folders] : [item.path]
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
 * The order the projects are shown in: the open one first, then the ones
 * that were used most recently.
 */
export function sortProjects(projects: Project[], activePath?: string): Project[] {
  const activeKey = activePath ? normalisePathKey(activePath) : undefined
  return [...projects].sort((a, b) => {
    if (activeKey) {
      const aIsActive = normalisePathKey(a.path) === activeKey
      const bIsActive = normalisePathKey(b.path) === activeKey
      if (aIsActive && !bIsActive) return -1
      if (!aIsActive && bIsActive) return 1
    }
    const left = Math.max(a.lastOpenedAt, a.sessions[0]?.updatedAt ?? 0)
    const right = Math.max(b.lastOpenedAt, b.sessions[0]?.updatedAt ?? 0)
    return right - left
  })
}

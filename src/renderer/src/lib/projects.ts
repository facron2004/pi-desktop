import type { SessionMeta, Workspace } from '@shared/types'
import { basename } from './path'

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
}

/**
 * Every project the user can work in.
 *
 * A project is either registered in the settings, or known because it has
 * conversations on disk. The second kind shows up in the sidebar so that a
 * conversation can always be found, and it is registered the first time it
 * is opened.
 */
export function collectProjects(workspaces: Workspace[], sessions: SessionMeta[]): Project[] {
  const map = new Map<string, Project>()

  for (const item of workspaces) {
    map.set(item.path.toLowerCase(), {
      path: item.path,
      name: item.name,
      id: item.id,
      registered: true,
      lastOpenedAt: item.lastOpenedAt,
      sessions: []
    })
  }

  for (const session of sessions) {
    const key = session.cwd.toLowerCase()
    let project = map.get(key)
    if (!project) {
      project = {
        path: session.cwd,
        name: session.cwd ? basename(session.cwd) : 'Unknown project',
        registered: false,
        lastOpenedAt: 0,
        sessions: []
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
  return [...projects].sort((a, b) => {
    if (a.path === activePath) return -1
    if (b.path === activePath) return 1
    const left = Math.max(a.lastOpenedAt, a.sessions[0]?.updatedAt ?? 0)
    const right = Math.max(b.lastOpenedAt, b.sessions[0]?.updatedAt ?? 0)
    return right - left
  })
}

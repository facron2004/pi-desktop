import { constants } from 'node:fs'
import { open, realpath, stat, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

const READ_FILE_FLAGS = constants.O_NONBLOCK === undefined
  ? 'r'
  : constants.O_RDONLY | constants.O_NONBLOCK

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/** Resolve both workspace and target while rejecting lexical and symlink escapes. */
export async function resolveWorkspaceLocation(
  root: string,
  file: string
): Promise<{ root: string; target: string } | null> {
  if (!root || typeof file !== 'string') return null
  const lexicalRoot = path.resolve(root)
  const lexicalTarget = path.resolve(lexicalRoot, file)
  if (!isInside(lexicalRoot, lexicalTarget)) return null
  try {
    const [realRoot, realTarget] = await Promise.all([realpath(lexicalRoot), realpath(lexicalTarget)])
    return isInside(realRoot, realTarget) ? { root: realRoot, target: realTarget } : null
  } catch {
    return null
  }
}

/** Resolve a workspace path and reject links whose real target escapes it. */
export async function resolveWorkspacePath(root: string, file: string): Promise<string | null> {
  return (await resolveWorkspaceLocation(root, file))?.target ?? null
}

/** Open a contained workspace file and reject hard links that cannot be confined. */
export async function openWorkspaceFile(
  root: string,
  file: string
): Promise<{ target: string; handle: FileHandle } | null> {
  const location = await resolveWorkspaceLocation(root, file)
  if (!location) return null

  let handle: FileHandle | undefined
  try {
    const beforeOpen = await stat(location.target)
    if (!beforeOpen.isFile() || beforeOpen.nlink > 1) return null
    handle = await open(location.target, READ_FILE_FLAGS)
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || opened.nlink > 1n) return null

    const current = await resolveWorkspaceLocation(root, file)
    if (!current || current.root !== location.root || current.target !== location.target) return null
    const named = await stat(current.target, { bigint: true })
    if (opened.dev !== named.dev || opened.ino !== named.ino || named.nlink > 1n) return null

    const result = { target: location.target, handle }
    handle = undefined
    return result
  } catch {
    return null
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

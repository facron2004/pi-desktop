/**
 * Files attached to a composer draft.
 *
 * A non-image file is an attachment, not visible prose. The composer shows its
 * icon and name in the attachment strip, and turns it into the `@"<path>"` token
 * only when the message is sent — that keeps the token out of the textarea
 * without losing the path Pi needs to read the file.
 */

import { normalisePathKey } from './path'

export interface ComposerDraftFile {
  id: string
  path: string
  name: string
}

const WINDOWS_ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/\/[^/\\]+\/[^/\\]+(?:\/|$))/
const UNIX_ABSOLUTE = /^\//

export function isAbsoluteFilePath(value: string): boolean {
  return WINDOWS_ABSOLUTE.test(value) || UNIX_ABSOLUTE.test(value)
}

function normalizeFileSeparators(value: string): string {
  return WINDOWS_ABSOLUTE.test(value) ? value.replace(/\\/g, '/') : value
}

function composerFileKey(file: ComposerDraftFile): string {
  return WINDOWS_ABSOLUTE.test(file.path) ? normalisePathKey(file.path) : file.path
}

/** The name shown in the attachment chip; the full path stays in the title. */
export function fileNameFromPath(value: string): string {
  const trimmed = normalizeFileSeparators(value).replace(/\/+$/, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  // A path copied out of a browser can still carry percent escapes in the
  // basename; show the readable name while keeping the real path for Pi.
  if (!name.includes('%')) return name
  try {
    const decoded = decodeURIComponent(name)
    return decoded && !decoded.includes('\uFFFD') ? decoded : name
  } catch {
    return name
  }
}

export function makeComposerFile(filePath: string): ComposerDraftFile {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    path: filePath,
    name: fileNameFromPath(filePath)
  }
}

/** The token Pi receives for one attached file. */
export function composerFileToken(file: ComposerDraftFile): string {
  return '@' + JSON.stringify(normalizeFileSeparators(file.path))
}

/** Merge new files into an existing list, dropping a path already present. */
export function mergeComposerFiles(
  current: readonly ComposerDraftFile[],
  added: readonly ComposerDraftFile[]
): ComposerDraftFile[] {
  const seen = new Set(current.map(composerFileKey))
  const next = [...current]
  for (const file of added) {
    const key = composerFileKey(file)
    if (seen.has(key)) continue
    seen.add(key)
    next.push(file)
  }
  return next
}

/**
 * Pull standalone absolute-path tokens out of existing draft text.
 *
 * Older builds put `@"C:/..."` lines directly in the textarea; opening such a
 * draft should show the chips the new composer uses instead of leaving the
 * encoded path on screen. Only a whole line that is an absolute path is lifted:
 * `@relative/path` mentions the user typed stay text.
 */
export function extractFilePathMentions(text: string): {
  text: string
  files: ComposerDraftFile[]
} {
  const files: ComposerDraftFile[] = []
  const kept: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      kept.push(line)
      continue
    }
    const match = /^@(?:"((?:[^"\\]|\\.)*)"|(\S.*))$/.exec(trimmed)
    if (!match) {
      kept.push(line)
      continue
    }
    let candidate = match[2] ?? ''
    if (match[1] !== undefined) {
      try {
        candidate = JSON.parse(`"${match[1]}"`) as string
      } catch {
        candidate = match[1]
      }
    }
    if (!isAbsoluteFilePath(candidate)) {
      kept.push(line)
      continue
    }
    files.push(makeComposerFile(candidate))
  }
  return {
    text: kept.join('\n').replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n'),
    files
  }
}

/**
 * What the `@` list says when it has no rows to show.
 *
 * "No file matches that name." was printed for three different situations: a
 * search still running, a name that really matched nothing, and a chat with no
 * project — where no search happened at all and the file name was never the
 * problem. The line names the reason instead. The project case comes first
 * because a projectless chat is never searching.
 */
export function mentionEmptyLine(state: { noProject: boolean; searching: boolean }): string {
  if (state.noProject) return 'Open a project to reference its files.'
  if (state.searching) return 'Searching files…'
  return 'No file matches that name.'
}

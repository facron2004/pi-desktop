import type { ThreadItem } from './thread'
import { buildDiff, type DiffBlock } from '../components/DiffView'

export interface FileChange {
  path: string
  /** How the file was touched. */
  kind: 'edit' | 'write'
  /** Number of tool calls that touched this file. */
  edits: number
  diffs: DiffBlock[]
  /** The whole file content, for files that were created or overwritten. */
  content?: string
  /** Wall-clock time of the first change. */
  at: number
}

function pathOf(args: Record<string, unknown> | undefined): string {
  if (!args) return ''
  const value = args.path
  return typeof value === 'string' ? value : ''
}

/**
 * Collect the files the agent changed during this session.
 *
 * Derived from the tool calls in the thread, so the session file on disk stays
 * the single source of truth.
 */
export function collectChanges(items: ThreadItem[]): FileChange[] {
  const changes = new Map<string, FileChange>()

  for (const item of items) {
    if (item.kind !== 'tool') continue
    if (item.toolName !== 'edit' && item.toolName !== 'write') continue
    const path = pathOf(item.args)
    if (!path) continue

    const existing = changes.get(path)
    const diffs =
      item.toolName === 'edit'
        ? ((item.args.edits as { oldText?: string; newText?: string }[] | undefined) ?? [])
            .map((edit) => buildDiff(edit?.oldText ?? '', edit?.newText ?? ''))
            .filter((block) => block.rows.length > 0)
        : []

    const content =
      item.toolName === 'write' && typeof item.args.content === 'string'
        ? item.args.content
        : existing?.content

    changes.set(path, {
      path,
      kind: item.toolName,
      edits: (existing?.edits ?? 0) + 1,
      diffs: existing ? [...existing.diffs, ...diffs] : diffs,
      content,
      at: existing?.at ?? item.timestamp
    })
  }

  return Array.from(changes.values()).sort((a, b) => a.at - b.at)
}

import type { SessionMeta, TrayConversation } from '@shared/types'
import type { SessionThread } from '../store/useAppStore'
import { conversationRows, type ConversationRow } from './live-sessions'
import { normalisePathKey } from './path'

/** Keep the tray menu short: three running and three recent conversations. */
const MAX_RUNNING = 3
const MAX_RECENT = 3
/** A menu label must stay on one line. */
const MAX_TITLE = 48

function titleOf(row: ConversationRow): string {
  const oneLine = (row.name || row.preview || '').replace(/\s+/g, ' ').trim()
  if (!oneLine) return '(new chat)'
  return oneLine.length > MAX_TITLE ? `${oneLine.slice(0, MAX_TITLE - 1)}…` : oneLine
}

interface TrayGroups {
  running: TrayConversation[]
  recent: TrayConversation[]
}

/**
 * Build the two conversation sections of the tray menu.
 *
 * The list is the same projection the sidebar uses — disk sessions plus live
 * threads Pi has not written yet — so a chat that just started is reachable
 * from the tray during exactly the window it is missing from disk. Each row is
 * keyed by its thread key, which is what the store uses to open a conversation.
 * The lists are already newest-first from `conversationRows` and capped so the
 * native menu keeps a fixed, modest height.
 */
export function trayConversationGroups(
  sessions: readonly SessionMeta[],
  threads: Readonly<Record<string, SessionThread>>,
  workspacePath: string | undefined
): TrayGroups {
  const rows = conversationRows(sessions, threads, workspacePath)
  const running: TrayConversation[] = []
  const recent: TrayConversation[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const key = normalisePathKey(row.file)
    if (seen.has(key)) continue
    seen.add(key)
    const item: TrayConversation = {
      key: row.file,
      title: titleOf(row),
      isStreaming: false
    }
    if (threads[row.file]?.isStreaming) {
      // A streaming conversation belongs to the running section only. When
      // that section is full, drop the extra rather than show it unmarked in
      // "recent" — the menu must not grow past its cap.
      if (running.length < MAX_RUNNING) running.push({ ...item, isStreaming: true })
      continue
    }
    if (recent.length < MAX_RECENT) recent.push(item)
  }

  return { running, recent }
}

/** Flat list in the order the menu shows it: running first, then recent. */
export function trayConversations(
  sessions: readonly SessionMeta[],
  threads: Readonly<Record<string, SessionThread>>,
  workspacePath: string | undefined
): TrayConversation[] {
  const { running, recent } = trayConversationGroups(sessions, threads, workspacePath)
  return [...running, ...recent]
}

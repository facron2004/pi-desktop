import type { AssistantItem, NoticeItem, ThreadItem, ToolItem, UserItem } from './thread'

/**
 * A user message and everything it produced.
 *
 * The transcript is stored as a flat list of items; the timeline draws turns.
 * A turn is a view-model, not a second source of truth: every array holds the
 * same item objects the reducer produced, so a memoised turn can compare by
 * reference and a streamed delta only re-renders the turn it belongs to.
 */
export interface Turn {
  id: string
  user?: UserItem
  assistants: AssistantItem[]
  tools: ToolItem[]
  notices: NoticeItem[]
  bash: Extract<ThreadItem, { kind: 'bash' }>[]
}

/** Group the flat item list into turns: a user message and everything it produced. */
export function buildTurns(items: ThreadItem[]): Turn[] {
  const turns: Turn[] = []
  let current: Turn | null = null

  for (const item of items) {
    if (item.kind === 'user') {
      current = { id: item.id, user: item, assistants: [], tools: [], notices: [], bash: [] }
      turns.push(current)
      continue
    }
    if (!current) {
      current = { id: `turn-${item.id}`, assistants: [], tools: [], notices: [], bash: [] }
      turns.push(current)
    }
    if (item.kind === 'assistant') current.assistants.push(item)
    else if (item.kind === 'tool') current.tools.push(item)
    else if (item.kind === 'notice') current.notices.push(item)
    else if (item.kind === 'bash') current.bash.push(item)
  }

  return turns
}

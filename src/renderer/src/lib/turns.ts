import type { Usage } from '@shared/types'
import type { AssistantBlock, AssistantItem, NoticeItem, ThreadItem, ToolItem, UserItem } from './thread'
import { changedThreadItemsFrom } from './thread'

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

/** Sum a turn only when every assistant request reported token usage. */
export function usageForTurn(turn: Turn): Usage | undefined {
  if (turn.assistants.length === 0 || turn.assistants.some((assistant) => !assistant.usage)) {
    return undefined
  }
  const messages = turn.assistants.map((assistant) => assistant.usage!)

  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0
  }
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  let costComplete = true

  for (const message of messages) {
    usage.input += message.input
    usage.output += message.output
    usage.cacheRead += message.cacheRead
    usage.cacheWrite += message.cacheWrite
    usage.totalTokens += message.totalTokens
    if (message.cost) {
      cost.input += message.cost.input
      cost.output += message.cost.output
      cost.cacheRead += message.cost.cacheRead
      cost.cacheWrite += message.cost.cacheWrite
      cost.total += message.cost.total
    } else {
      costComplete = false
    }
  }

  if (costComplete) usage.cost = cost
  return usage
}

/** The spoken reply after the last tool call; earlier text is progress commentary. */
export function replyStartOf(turn: Turn): AssistantBlock | undefined {
  const referenced = new Set<string>()
  for (const assistant of turn.assistants) {
    for (const block of assistant.blocks) {
      if (block.type === 'toolCall') referenced.add(block.id)
    }
  }
  // A resumed call may have no assistant block. Its first-appearance order
  // still keeps text before that call out of the final reply.
  const lastOrphanOrder = turn.tools.reduce(
    (order, tool) => (referenced.has(tool.toolCallId) ? order : Math.max(order, tool.order)),
    -Infinity
  )
  let start: AssistantBlock | undefined
  for (const assistant of turn.assistants) {
    if (assistant.order <= lastOrphanOrder) continue
    for (const block of assistant.blocks) {
      if (block.type === 'toolCall') start = undefined
      else if (!start && (block.type === 'image' || (block.type === 'text' && block.text.trim()))) {
        start = block
      }
    }
  }
  // No reply after the tools means there is only progress so far. Callers
  // must keep that partial text visible, including after a stop or failure.
  return start
}

interface TurnBuild {
  items: ThreadItem[]
  turns: Turn[]
  /** Item index where each turn begins. */
  starts: number[]
}

let lastBuild: TurnBuild | null = null
const turnChanges = new WeakMap<Turn[], { base: Turn[]; firstChangedIndex: number }>()

/** Earliest turn changed since `base`, when `buildTurns` recorded the lineage. */
export function changedTurnsFrom(turns: Turn[], base: Turn[]): number | undefined {
  let current = turns
  let firstChangedIndex = Number.POSITIVE_INFINITY
  while (current !== base) {
    const change = turnChanges.get(current)
    if (!change) return undefined
    firstChangedIndex = Math.min(firstChangedIndex, change.firstChangedIndex)
    current = change.base
  }
  return Number.isFinite(firstChangedIndex) ? firstChangedIndex : undefined
}

/**
 * Group a flat item list into turns from scratch.
 *
 * Kept private: callers use `buildTurns`, which reuses the untouched prefix of
 * the previous build instead of walking a long transcript again on every
 * streamed delta.
 */
function buildFresh(items: ThreadItem[]): TurnBuild {
  const turns: Turn[] = []
  const starts: number[] = []
  let current: Turn | null = null

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'user') {
      current = { id: item.id, user: item, assistants: [], tools: [], notices: [], bash: [] }
      turns.push(current)
      starts.push(index)
      continue
    }
    if (!current) {
      current = { id: `turn-${item.id}`, assistants: [], tools: [], notices: [], bash: [] }
      turns.push(current)
      starts.push(index)
    }
    if (item.kind === 'assistant') current.assistants.push(item)
    else if (item.kind === 'tool') current.tools.push(item)
    else if (item.kind === 'notice') current.notices.push(item)
    else if (item.kind === 'bash') current.bash.push(item)
  }

  return { items, turns, starts }
}

/**
 * Group the flat item list into turns: a user message and everything it produced.
 *
 * The reducer replaces one item at a time (`replaceItem` keeps the identity of
 * every other item), so a live delta always produces an items array sharing a
 * long prefix with the previous one. Rebuilding only the turn that contains the
 * first changed item keeps the per-frame work proportional to the live turn
 * rather than to the whole conversation.
 */
export function buildTurns(items: ThreadItem[]): Turn[] {
  const cache = lastBuild
  if (!cache) {
    lastBuild = buildFresh(items)
    return lastBuild.turns
  }
  if (cache.items === items) return cache.turns

  let firstDiff = changedThreadItemsFrom(items, cache.items)
  if (firstDiff === undefined) {
    const shared = Math.min(cache.items.length, items.length)
    firstDiff = 0
    while (firstDiff < shared && cache.items[firstDiff] === items[firstDiff]) firstDiff += 1
  }

  if (firstDiff === cache.items.length && firstDiff === items.length) {
    return cache.turns
  }

  let reuseTurns = 0
  let rebuildFrom = 0
  if (firstDiff >= cache.items.length) {
    // Items were appended. Anything but a user message continues the old last
    // turn, so that turn has to be rebuilt; everything before it survives.
    const appended = items[firstDiff]
    if (appended && appended.kind !== 'user' && cache.turns.length > 0) {
      reuseTurns = cache.turns.length - 1
      rebuildFrom = cache.starts[cache.starts.length - 1]
    } else {
      reuseTurns = cache.turns.length
      rebuildFrom = cache.items.length
    }
  } else {
    // An existing item was replaced: rebuild the turn that contains it.
    let low = 0
    let high = cache.starts.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (cache.starts[middle] <= firstDiff) low = middle + 1
      else high = middle
    }
    const turnIndex = Math.max(0, low - 1)
    reuseTurns = turnIndex
    rebuildFrom = cache.starts[turnIndex] ?? firstDiff
  }

  const suffix = buildFresh(items.slice(rebuildFrom))
  const turns =
    reuseTurns > 0 ? [...cache.turns.slice(0, reuseTurns), ...suffix.turns] : suffix.turns
  lastBuild = {
    items,
    turns,
    starts: [
      ...cache.starts.slice(0, reuseTurns),
      ...suffix.starts.map((index) => index + rebuildFrom)
    ]
  }
  turnChanges.set(turns, { base: cache.turns, firstChangedIndex: reuseTurns })
  return turns
}

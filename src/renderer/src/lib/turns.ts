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

export interface TurnUserMetadata {
  userCount: number
  timestampCounts: ReadonlyMap<number, number>
  lastUserTurnIndex: number
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
const turnChanges = new WeakMap<Turn[], { base: WeakRef<Turn[]>; firstChangedIndex: number }>()
const userMetadataByTurns = new WeakMap<Turn[], TurnUserMetadata>()

/** Earliest turn changed since `base`, when `buildTurns` recorded the lineage. */
export function changedTurnsFrom(turns: Turn[], base: Turn[]): number | undefined {
  let current = turns
  let firstChangedIndex = Number.POSITIVE_INFINITY
  while (current !== base) {
    const change = turnChanges.get(current)
    if (!change) return undefined
    firstChangedIndex = Math.min(firstChangedIndex, change.firstChangedIndex)
    const baseTurns = change.base.deref()
    if (!baseTurns) return undefined
    current = baseTurns
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
  const timestampCounts = new Map<number, number>()
  let userCount = 0
  let lastUserTurnIndex = -1
  let current: Turn | null = null

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'user') {
      current = { id: item.id, user: item, assistants: [], tools: [], notices: [], bash: [] }
      turns.push(current)
      starts.push(index)
      userCount += 1
      lastUserTurnIndex = turns.length - 1
      timestampCounts.set(item.timestamp, (timestampCounts.get(item.timestamp) ?? 0) + 1)
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

  userMetadataByTurns.set(turns, { userCount, timestampCounts, lastUserTurnIndex })
  return { items, turns, starts }
}

/** Metadata built with the turn list and incrementally reused across stream updates. */
export function userMetadataForTurns(turns: Turn[]): TurnUserMetadata {
  const cached = userMetadataByTurns.get(turns)
  if (cached) return cached
  let userCount = 0
  let lastUserTurnIndex = -1
  const timestampCounts = new Map<number, number>()
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]
    if (!turn.user) continue
    userCount += 1
    lastUserTurnIndex = index
    timestampCounts.set(turn.user.timestamp, (timestampCounts.get(turn.user.timestamp) ?? 0) + 1)
  }
  const metadata = { userCount, timestampCounts, lastUserTurnIndex }
  userMetadataByTurns.set(turns, metadata)
  return metadata
}

function userTimestamps(turns: Turn[]): number[] {
  const timestamps: number[] = []
  for (const turn of turns) {
    if (turn.user) timestamps.push(turn.user.timestamp)
  }
  return timestamps
}

function sameTimestamps(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((timestamp, index) => timestamp === right[index])
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
  const previousMetadata = userMetadataForTurns(cache.turns)
  const previousSuffixTimestamps = userTimestamps(cache.turns.slice(reuseTurns))
  const nextSuffixTimestamps = userTimestamps(suffix.turns)
  const timestampsChanged = !sameTimestamps(previousSuffixTimestamps, nextSuffixTimestamps)
  let timestampCounts = previousMetadata.timestampCounts
  if (timestampsChanged) {
    const nextTimestampCounts = new Map(previousMetadata.timestampCounts)
    for (const timestamp of previousSuffixTimestamps) {
      const count = nextTimestampCounts.get(timestamp) ?? 0
      if (count <= 1) nextTimestampCounts.delete(timestamp)
      else nextTimestampCounts.set(timestamp, count - 1)
    }
    for (const timestamp of nextSuffixTimestamps) {
      nextTimestampCounts.set(timestamp, (nextTimestampCounts.get(timestamp) ?? 0) + 1)
    }
    timestampCounts = nextTimestampCounts
  }
  let lastUserTurnIndex = -1
  for (let index = turns.length - 1; index >= reuseTurns; index -= 1) {
    if (turns[index]?.user) {
      lastUserTurnIndex = index
      break
    }
  }
  if (lastUserTurnIndex < 0 && previousMetadata.lastUserTurnIndex < reuseTurns) {
    lastUserTurnIndex = previousMetadata.lastUserTurnIndex
  } else if (lastUserTurnIndex < 0) {
    for (let index = reuseTurns - 1; index >= 0; index -= 1) {
      if (turns[index]?.user) {
        lastUserTurnIndex = index
        break
      }
    }
  }
  const userCount = previousMetadata.userCount - previousSuffixTimestamps.length + nextSuffixTimestamps.length
  const metadata = timestampsChanged ||
    userCount !== previousMetadata.userCount ||
    lastUserTurnIndex !== previousMetadata.lastUserTurnIndex
    ? { userCount, timestampCounts, lastUserTurnIndex }
    : previousMetadata
  userMetadataByTurns.set(turns, metadata)
  lastBuild = {
    items,
    turns,
    starts: [
      ...cache.starts.slice(0, reuseTurns),
      ...suffix.starts.map((index) => index + rebuildFrom)
    ]
  }
  turnChanges.set(turns, { base: new WeakRef(cache.turns), firstChangedIndex: reuseTurns })
  return turns
}

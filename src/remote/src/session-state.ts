import type { AgentMessage, ContentBlock, PiEvent } from '@shared/types'
import {
  applyStreamEventBatch,
  itemsFromMessages,
  type AssistantItem,
  type ThreadItem
} from '@renderer/lib/thread'
import { normalizePiEvent, type StreamEvent } from '@renderer/lib/stream-events'

export type RemoteSendRequests = Record<string, number>

export function beginRemoteSendRequest(
  current: RemoteSendRequests,
  key: string,
  requestId: number
): RemoteSendRequests {
  return { ...current, [key]: requestId }
}

export function finishRemoteSendRequest(
  current: RemoteSendRequests,
  key: string,
  requestId: number
): RemoteSendRequests {
  if (current[key] !== requestId) return current
  const next = { ...current }
  delete next[key]
  return next
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableValue(entry)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function messageIdentity(message: AgentMessage): string {
  return stableValue(message)
}

function assistantBlocks(content: AgentMessage['content']): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

function assistantMatchesSnapshot(item: AssistantItem, message: AgentMessage): boolean {
  if (message.role !== 'assistant' || item.timestamp !== message.timestamp) return false
  const blocks = assistantBlocks(message.content)
  if (item.blocks.length > blocks.length) return false
  return item.blocks.every((block, index) => {
    const snapshot = blocks[index]
    if (block.type === 'text') {
      return snapshot?.type === 'text' && snapshot.text.startsWith(block.text)
    }
    if (block.type === 'thinking') {
      return snapshot?.type === 'thinking' && snapshot.thinking.startsWith(block.text)
    }
    if (block.type === 'image') {
      return snapshot?.type === 'image' && snapshot.data === block.data && snapshot.mimeType === block.mimeType
    }
    return block.type === 'toolCall' && snapshot?.type === 'toolCall'
      && snapshot.id === block.id
      && snapshot.name === block.name
  })
}

/** Rebuild the disk snapshot, then replay live events buffered while it loaded. */
export function restoreRemoteSessionItems(
  messages: AgentMessage[],
  events: PiEvent[],
  sessionKey: string,
  previousItems: ThreadItem[]
): ThreadItem[] {
  const items = itemsFromMessages(messages)
  const snapshotByTimestamp = new Map<number | undefined, AgentMessage[]>()
  const snapshotIdentities = new Map<AgentMessage, string>()
  for (const message of messages) {
    const bucket = snapshotByTimestamp.get(message.timestamp)
    if (bucket) bucket.push(message)
    else snapshotByTimestamp.set(message.timestamp, [message])
  }
  const matchesSnapshotMessage = (candidate: AgentMessage): boolean => {
    const bucket = snapshotByTimestamp.get(candidate.timestamp)
    if (!bucket) return false
    let candidateId: string | undefined
    for (const existing of bucket) {
      if (existing.role !== candidate.role) continue
      candidateId ??= messageIdentity(candidate)
      let existingId = snapshotIdentities.get(existing)
      if (existingId === undefined) {
        existingId = messageIdentity(existing)
        snapshotIdentities.set(existing, existingId)
      }
      if (existingId === candidateId) return true
    }
    return false
  }
  const representedMessageIds = new Set<string>()
  const normalized: StreamEvent[] = []

  for (const event of events) {
    const streamEvent = normalizePiEvent(event, { sessionKey })
    if (!streamEvent) continue
    normalized.push(streamEvent)
    if (
      streamEvent.type === 'message.completed' &&
      streamEvent.messageId &&
      streamEvent.message &&
      matchesSnapshotMessage(streamEvent.message)
    ) {
      representedMessageIds.add(streamEvent.messageId)
    }
  }

  // A disk snapshot may not include the current partial assistant message.
  // Keep that live tail and its tool calls so later deltas/results have nodes
  // to update, while the timestamp prevents a completed snapshot message from
  // being added a second time.
  const snapshotAssistants = messages.filter((message) => message.role === 'assistant')
  const liveToolIds = new Set<string>()
  const liveAssistants = previousItems.filter(
    (item): item is AssistantItem =>
      item.kind === 'assistant' &&
      item.streaming &&
      !representedMessageIds.has(item.messageId ?? '') &&
      !snapshotAssistants.some((message) => assistantMatchesSnapshot(item, message))
  )
  for (const assistant of liveAssistants) {
    for (const block of assistant.blocks) {
      if (block.type === 'toolCall') liveToolIds.add(block.id)
    }
  }
  // Tool nodes can precede their parent assistant in the event order, so add
  // them after collecting the calls from every preserved assistant.
  const retainedLiveItems = [
    ...liveAssistants,
    ...previousItems.filter((item) => item.kind === 'tool' && liveToolIds.has(item.toolCallId))
  ]
  let nextOrder = items.reduce((maximum, item) => Math.max(maximum, item.order), 0)
  for (const item of retainedLiveItems) {
    items.push({ ...item, order: ++nextOrder })
  }

  // A tool can outlive its assistant message: Pi may have flushed
  // `message_end` while the execution-start/update events were still live-only.
  // Keep that observed running state over a snapshot's proposed tool node.
  const toolIndexByCallId = new Map<string, number>()
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]
    if (item.kind === 'tool') toolIndexByCallId.set(item.toolCallId, index)
  }
  for (const previous of previousItems) {
    if (previous.kind !== 'tool' || previous.status !== 'running') continue
    const index = toolIndexByCallId.get(previous.toolCallId) ?? -1
    if (index < 0) {
      toolIndexByCallId.set(previous.toolCallId, items.length)
      items.push({ ...previous, order: ++nextOrder })
      continue
    }
    const snapshotTool = items[index]
    if (snapshotTool.kind !== 'tool' || snapshotTool.status !== 'proposed') continue
    items[index] = {
      ...snapshotTool,
      ...previous,
      id: snapshotTool.id,
      order: snapshotTool.order
    }
  }

  const snapshotRoundBreaks = new Map<number, number>()
  for (const item of items) {
    if (item.kind !== 'roundBreak') continue
    snapshotRoundBreaks.set(item.timestamp, (snapshotRoundBreaks.get(item.timestamp) ?? 0) + 1)
  }

  const eventsToReplay: StreamEvent[] = []
  for (const event of normalized) {
    const duplicateMessageLifecycle =
      event.type === 'message.started' ||
      event.type === 'message.block.started' ||
      event.type === 'message.delta' ||
      event.type === 'message.block.completed' ||
      event.type === 'message.completed'
    if (duplicateMessageLifecycle && event.messageId && representedMessageIds.has(event.messageId)) {
      continue
    }
    if (event.type === 'round.continued') {
      const remaining = snapshotRoundBreaks.get(event.timestamp) ?? 0
      if (remaining > 0) {
        snapshotRoundBreaks.set(event.timestamp, remaining - 1)
        continue
      }
    }
    eventsToReplay.push(event)
  }

  return applyStreamEventBatch(items, eventsToReplay)
}

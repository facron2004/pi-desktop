import type { AgentMessage, ContentBlock, ForkTarget, PiEvent, Usage } from '@shared/types'

export type AssistantBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'toolCall'; id: string; name: string; argsText: string; args?: Record<string, unknown> }

export interface UserItem {
  id: string
  kind: 'user'
  text: string
  images: { data: string; mimeType: string }[]
  timestamp: number
}

export interface AssistantItem {
  id: string
  kind: 'assistant'
  blocks: AssistantBlock[]
  usage?: Usage
  model?: string
  stopReason?: string
  error?: string
  streaming: boolean
  timestamp: number
}

export interface ToolItem {
  id: string
  kind: 'tool'
  toolCallId: string
  toolName: string
  args: Record<string, unknown>
  status: 'running' | 'ok' | 'error'
  result?: string
  isError?: boolean
  durationMs?: number
  timestamp: number
}

export interface BashItem {
  id: string
  kind: 'bash'
  command: string
  output: string
  exitCode?: number
  timestamp: number
}

export interface NoticeItem {
  id: string
  kind: 'notice'
  level: 'info' | 'warn' | 'error' | 'success'
  text: string
  timestamp: number
}

export type ThreadItem = UserItem | AssistantItem | ToolItem | BashItem | NoticeItem

let counter = 0
export function nextId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const typed = block as Partial<ContentBlock> & { text?: string; thinking?: string }
      if (typed.type === 'text') return typed.text ?? ''
      return ''
    })
    .join('')
}

export function imagesOf(content: unknown): { data: string; mimeType: string }[] {
  if (!Array.isArray(content)) return []
  return content
    .filter((block) => block && typeof block === 'object' && (block as ContentBlock).type === 'image')
    .map((block) => {
      const image = block as Extract<ContentBlock, { type: 'image' }>
      return { data: image.data, mimeType: image.mimeType }
    })
}

function blocksFromContent(content: unknown): AssistantBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const blocks: AssistantBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const block = raw as ContentBlock
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text ?? '' })
    } else if (block.type === 'thinking') {
      blocks.push({ type: 'thinking', text: block.thinking ?? '' })
    } else if (block.type === 'image') {
      // A model that can draw hands the picture back as an image block.
      blocks.push({ type: 'image', data: block.data ?? '', mimeType: block.mimeType ?? 'image/png' })
    } else if (block.type === 'toolCall') {
      blocks.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        argsText: JSON.stringify(block.arguments ?? {}, null, 2),
        args: block.arguments ?? {}
      })
    }
  }
  return blocks
}

function lastStreamingAssistant(items: ThreadItem[]): AssistantItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind === 'assistant' && item.streaming) return item
  }
  return undefined
}

function replaceItem(items: ThreadItem[], id: string, next: ThreadItem): ThreadItem[] {
  return items.map((item) => (item.id === id ? next : item))
}

function upsertTool(items: ThreadItem[], next: ToolItem): ThreadItem[] {
  const index = items.findIndex((item) => item.kind === 'tool' && item.toolCallId === next.toolCallId)
  if (index === -1) return [...items, next]
  const copy = [...items]
  copy[index] = { ...(copy[index] as ToolItem), ...next }
  return copy
}

function notice(level: NoticeItem['level'], text: string): NoticeItem {
  return { id: nextId('notice'), kind: 'notice', level, text, timestamp: Date.now() }
}

/** Build a thread from a full message list (session hydration). */
export function itemsFromMessages(messages: AgentMessage[]): ThreadItem[] {
  const items: ThreadItem[] = []

  // The arguments of a tool call live on the assistant message, not on the
  // result. Collect them first so a resumed session still knows which file
  // was edited and which command was run.
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of blocksFromContent(message.content)) {
      if (block.type !== 'toolCall') continue
      calls.set(block.id, { name: block.name, args: block.args ?? {} })
    }
  }

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        items.push({
          id: nextId('user'),
          kind: 'user',
          text: textOf(message.content),
          images: imagesOf(message.content),
          timestamp: message.timestamp ?? Date.now()
        })
        break
      }
      case 'assistant': {
        items.push({
          id: nextId('assistant'),
          kind: 'assistant',
          blocks: blocksFromContent(message.content),
          usage: message.usage,
          model: message.model,
          stopReason: message.stopReason,
          error: message.errorMessage,
          streaming: false,
          timestamp: message.timestamp ?? Date.now()
        })
        break
      }
      case 'toolResult': {
        const call = calls.get(message.toolCallId ?? '')
        items.push({
          id: nextId('tool'),
          kind: 'tool',
          toolCallId: message.toolCallId ?? '',
          toolName: message.toolName ?? call?.name ?? 'tool',
          args: call?.args ?? {},
          status: message.isError ? 'error' : 'ok',
          result: textOf(message.content),
          isError: message.isError,
          timestamp: message.timestamp ?? Date.now()
        })
        break
      }
      case 'bashExecution': {
        const bash = message as unknown as {
          command?: string
          output?: string
          exitCode?: number
          timestamp?: number
        }
        items.push({
          id: nextId('bash'),
          kind: 'bash',
          command: bash.command ?? '',
          output: bash.output ?? '',
          exitCode: bash.exitCode,
          timestamp: bash.timestamp ?? Date.now()
        })
        break
      }
      case 'compactionSummary': {
        const summary = message as unknown as { summary?: string }
        items.push(notice('info', `Context compacted — ${summary?.summary ?? 'summary'}`))
        break
      }
      case 'branchSummary': {
        const summary = message as unknown as { summary?: string }
        items.push(notice('info', `Branch summary — ${summary?.summary ?? ''}`))
        break
      }
      default:
        break
    }
  }
  return items
}

/**
 * Fold a Pi session event into the thread.
 * Returns a new array when something changed.
 */
export function applyEvent(items: ThreadItem[], event: PiEvent): ThreadItem[] {
  switch (event.type) {
    case 'message_start': {
      const message = event.message as AgentMessage | undefined
      if (!message) return items
      if (message.role === 'user') {
        return [
          ...items,
          {
            id: nextId('user'),
            kind: 'user',
            text: textOf(message.content),
            images: imagesOf(message.content),
            timestamp: message.timestamp ?? Date.now()
          }
        ]
      }
      if (message.role === 'assistant') {
        return [
          ...items,
          {
            id: nextId('assistant'),
            kind: 'assistant',
            blocks: [],
            streaming: true,
            timestamp: message.timestamp ?? Date.now()
          }
        ]
      }
      return items
    }

    case 'message_update': {
      const payload = event.assistantMessageEvent as
        | {
            type: string
            contentIndex?: number
            delta?: string
            content?: string
            id?: string
            toolName?: string
            toolCall?: { id: string; name: string; arguments: Record<string, unknown> }
          }
        | undefined
      if (!payload) return items
      const assistant = lastStreamingAssistant(items)
      if (!assistant) return items

      const blocks = assistant.blocks.slice()
      const index = payload.contentIndex ?? blocks.length

      const ensure = (): AssistantBlock => {
        if (!blocks[index]) {
          blocks[index] = { type: 'text', text: '' }
        }
        return blocks[index]
      }

      switch (payload.type) {
        case 'text_start': {
          blocks[index] = { type: 'text', text: '' }
          break
        }
        case 'text_delta': {
          const block = ensure()
          if (block.type === 'text') block.text += payload.delta ?? ''
          break
        }
        case 'text_end': {
          const block = ensure()
          if (block.type === 'text') block.text = payload.content ?? block.text
          break
        }
        case 'thinking_start': {
          blocks[index] = { type: 'thinking', text: '' }
          break
        }
        case 'thinking_delta': {
          const block = ensure()
          if (block.type === 'thinking') block.text += payload.delta ?? ''
          break
        }
        case 'thinking_end': {
          const block = ensure()
          if (block.type === 'thinking') block.text = payload.content ?? block.text
          break
        }
        case 'toolcall_start': {
          blocks[index] = {
            type: 'toolCall',
            id: payload.id ?? nextId('call'),
            name: payload.toolName ?? 'tool',
            argsText: ''
          }
          break
        }
        case 'toolcall_delta': {
          const block = ensure()
          if (block.type === 'toolCall') block.argsText += payload.delta ?? ''
          break
        }
        case 'toolcall_end': {
          const call = payload.toolCall
          const previous = blocks[index]
          const previousId = previous && previous.type === 'toolCall' ? previous.id : undefined
          blocks[index] = {
            type: 'toolCall',
            id: call?.id ?? previousId ?? nextId('call'),
            name: call?.name ?? (previous && previous.type === 'toolCall' ? previous.name : 'tool'),
            argsText: JSON.stringify(call?.arguments ?? {}, null, 2),
            args: call?.arguments ?? {}
          }
          break
        }
        default:
          break
      }

      return replaceItem(items, assistant.id, { ...assistant, blocks })
    }

    case 'message_end': {
      const message = event.message as AgentMessage | undefined
      if (!message) return items
      if (message.role === 'assistant') {
        const assistant = lastStreamingAssistant(items)
        if (!assistant) return items
        const next: AssistantItem = {
          ...assistant,
          blocks: blocksFromContent(message.content),
          usage: message.usage,
          model: message.model,
          stopReason: message.stopReason,
          error: message.errorMessage,
          streaming: false
        }
        return replaceItem(items, assistant.id, next)
      }
      return items
    }

    case 'tool_execution_start': {
      return upsertTool(items, {
        id: nextId('tool'),
        kind: 'tool',
        toolCallId: String(event.toolCallId ?? ''),
        toolName: String(event.toolName ?? 'tool'),
        args: (event.args as Record<string, unknown>) ?? {},
        status: 'running',
        timestamp: Date.now()
      })
    }

    case 'tool_execution_update': {
      const target = items.find(
        (item) => item.kind === 'tool' && item.toolCallId === String(event.toolCallId ?? '')
      )
      if (!target || target.kind !== 'tool') return items
      return upsertTool(items, {
        ...target,
        status: 'running',
        result: extractToolResult(event.partialResult) ?? target.result
      })
    }

    case 'tool_execution_end': {
      const target = items.find(
        (item) => item.kind === 'tool' && item.toolCallId === String(event.toolCallId ?? '')
      )
      const base: ToolItem = target && target.kind === 'tool'
        ? target
        : {
            id: nextId('tool'),
            kind: 'tool',
            toolCallId: String(event.toolCallId ?? ''),
            toolName: String(event.toolName ?? 'tool'),
            args: (event.args as Record<string, unknown>) ?? {},
            status: 'ok',
            timestamp: Date.now()
          }
      return upsertTool(items, {
        ...base,
        status: event.isError ? 'error' : 'ok',
        isError: Boolean(event.isError),
        result: extractToolResult(event.result) ?? base.result,
        durationMs:
          typeof event.durationMs === 'number' ? event.durationMs : base.durationMs
      })
    }

    case 'bash_execution_update': {
      const delta = String(event.delta ?? '')
      const existing = items.find((item) => item.kind === 'bash') as BashItem | undefined
      if (existing) {
        return replaceItem(items, existing.id, { ...existing, output: existing.output + delta })
      }
      return [
        ...items,
        { id: nextId('bash'), kind: 'bash', command: '', output: delta, timestamp: Date.now() }
      ]
    }

    case 'compaction_start': {
      const reason = String(event.reason ?? 'manual')
      return [...items, notice('info', `Compacting context (${reason})…`)]
    }

    case 'compaction_end': {
      const aborted = Boolean(event.aborted)
      if (aborted) return [...items, notice('warn', 'Compaction aborted')]
      if (event.errorMessage) {
        return [...items, notice('error', `Compaction failed: ${String(event.errorMessage)}`)]
      }
      const result = event.result as { tokensBefore?: number; estimatedTokensAfter?: number } | undefined
      const before = result?.tokensBefore
      const after = result?.estimatedTokensAfter
      const detail = before && after ? ` (${before} → ~${after} tokens)` : ''
      return [...items, notice('success', `Context compacted${detail}`)]
    }

    case 'auto_retry_start': {
      return [
        ...items,
        notice(
          'warn',
          `Retrying (attempt ${String(event.attempt ?? 1)}/${String(event.maxAttempts ?? '?')}) — ${String(event.errorMessage ?? 'transient error')}`
        )
      ]
    }

    case 'auto_retry_end': {
      if (event.success) return [...items, notice('success', 'Retry succeeded')]
      return [...items, notice('error', `Retry failed: ${String(event.finalError ?? 'unknown error')}`)]
    }

    case 'extension_error': {
      return [...items, notice('error', `Extension error: ${String(event.error ?? '')}`)]
    }

    case 'client_notice': {
      const level = (event.level as NoticeItem['level']) ?? 'warn'
      return [...items, notice(level, String(event.text ?? ''))]
    }

    default:
      return items
  }
}

function extractToolResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((block) => {
        if (!block || typeof block !== 'object') return ''
        const typed = block as { type?: string; text?: string }
        return typed.type === 'text' ? typed.text ?? '' : ''
      })
      .filter(Boolean)
    return parts.length ? parts.join('\n') : undefined
  }
  if (typeof value === 'object') {
    const typed = value as { content?: unknown }
    if (typed.content !== undefined) return extractToolResult(typed.content)
    return JSON.stringify(value, null, 2)
  }
  return String(value)
}

/** Collapse a prompt to a comparable shape. */
function normalizePrompt(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The text of the last answer in the thread, if there is one. */
export function lastAssistantText(items: ThreadItem[]): string {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.kind !== 'assistant') continue
    const text = item.blocks
      .filter((block): block is Extract<AssistantBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
      .trim()
    if (text) return text
  }
  return ''
}

/**
 * The whole conversation as plain text.
 *
 * Only the messages are written down — the tool calls are noise for whoever
 * reads the transcript.
 */
export function transcriptOf(items: ThreadItem[]): string {
  const parts: string[] = []
  for (const item of items) {
    if (item.kind === 'user') {
      if (!item.text.trim()) continue
      parts.push(`## You\n\n${item.text.trim()}`)
      continue
    }
    if (item.kind !== 'assistant') continue
    const text = item.blocks
      .filter((block): block is Extract<AssistantBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
      .trim()
    if (text) parts.push(`## Pi\n\n${text}`)
  }
  return parts.join('\n\n')
}

/**
 * Map the user messages in the thread to the entry ids Pi can fork from.
 *
 * Pi reports the forkable prompts of the active branch in order, so the
 * pairing is positional. The text is used first, because a resumed session
 * and a live stream can disagree about whitespace.
 */
export function pairForkTargets(
  items: ThreadItem[],
  targets: ForkTarget[]
): Map<string, string> {
  const paired = new Map<string, string>()
  if (!targets.length) return paired

  const byText = new Map<string, string[]>()
  for (const target of targets) {
    const key = normalizePrompt(target.text)
    const bucket = byText.get(key)
    if (bucket) bucket.push(target.entryId)
    else byText.set(key, [target.entryId])
  }

  const users = items.filter((item): item is UserItem => item.kind === 'user')
  const used = new Set<string>()

  for (const user of users) {
    const bucket = byText.get(normalizePrompt(user.text))
    const entryId = bucket?.shift()
    if (!entryId) continue
    paired.set(user.id, entryId)
    used.add(entryId)
  }

  // A prompt with no text — an image-only message — still lines up by
  // position within the branch.
  const leftover = targets.filter((target) => !used.has(target.entryId))
  let index = 0
  for (const user of users) {
    if (paired.has(user.id)) continue
    const target = leftover[index]
    index += 1
    if (!target) break
    paired.set(user.id, target.entryId)
  }

  return paired
}

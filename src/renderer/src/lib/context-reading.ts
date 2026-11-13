import type { AgentMessage, ContextBreakdown, ModelInfo, SessionStats } from '@shared/types'
import type { ThreadItem } from './thread'

/**
 * The one context-window reading the usage line and the context panel share.
 *
 * Pi's `get_session_stats` is the authority: it knows the model's window and
 * its own estimate of what the conversation currently occupies. But that
 * command only answers while a process is running, and a conversation that was
 * merely reopened from disk has no process yet — which used to leave the ring
 * and the panel blank with no way to ask. So the transcript is the fallback:
 * every assistant message carries its own usage, and the newest one is the
 * closest stand-in for "what the last request put in the window".
 *
 * `source` says which side answered, so the UI can be honest about it instead
 * of presenting a derived number as Pi's own.
 */
export interface ContextReading {
  /** Tokens Pi (or the transcript) says are in the window now. */
  tokens: number | null
  contextWindow: number | null
  percent: number | null
  source: 'pi' | 'transcript'
  /** Session totals, for the panels that list the token split. */
  tokensTotal: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /** Pi's own cost reading; the transcript cannot derive it. */
  cost: number | null
}

function windowOf(...models: (ModelInfo | { contextWindow?: number } | undefined)[]): number | null {
  for (const model of models) {
    const window = model?.contextWindow
    if (typeof window === 'number' && window > 0) return window
  }
  return null
}

function percentOf(tokens: number | null, window: number | null): number | null {
  if (tokens === null || window === null || window <= 0) return null
  return (tokens / window) * 100
}

function estimateTextTokens(value: string): number {
  // Pi's context estimator also uses the conservative chars/4 heuristic.
  return value ? Math.ceil(value.length / 4) : 0
}

function messageText(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content.map((block) => {
    if (block.type === 'text') return block.text
    if (block.type === 'thinking') return block.thinking
    if (block.type === 'toolCall') {
      return `${block.name} ${JSON.stringify(block.arguments)}`
    }
    // Image tokenization depends on the provider and image dimensions.
    return ''
  }).join('\n')
}

/**
 * Estimate the visible breakdown from the context messages Pi actually has.
 * Pi reports a single context total, so the individual rows are approximate;
 * when that total exists, the conversation row absorbs provider and image
 * overhead so the three rows still add up to Pi's total.
 */
export function estimateContextBreakdown(
  messages: readonly AgentMessage[],
  reportedContextTokens?: number | null
): ContextBreakdown {
  const sections = new Map<string, string>()
  const tools = new Map<string, unknown>()
  let hasSystemMessage = false
  let hasToolData = false
  let conversationTokens = 0
  let newestUsageTokens: number | null = null

  for (const message of messages) {
    if (message.role !== 'system') {
      conversationTokens += estimateTextTokens(`${message.role}\n${messageText(message)}`)
      if (message.role === 'assistant' && typeof message.usage?.totalTokens === 'number') {
        newestUsageTokens = message.usage.totalTokens
      }
      continue
    }

    hasSystemMessage = true
    const system = message as AgentMessage & {
      sections?: Record<string, unknown>
      toolsAdded?: unknown[]
      toolsRemoved?: { name?: string }[]
    }
    for (const [name, value] of Object.entries(system.sections ?? {})) {
      if (value === null) sections.delete(name)
      else if (typeof value === 'string') sections.set(name, value)
    }
    for (const tool of system.toolsRemoved ?? []) {
      if (tool.name) tools.delete(tool.name)
    }
    if (Array.isArray(system.toolsAdded)) {
      hasToolData = true
      for (const tool of system.toolsAdded) {
        const name = tool && typeof tool === 'object' && 'name' in tool
          ? String((tool as { name: unknown }).name)
          : ''
        if (name) tools.set(name, tool)
      }
    }
    if (Object.hasOwn(system.sections ?? {}, 'tools')) hasToolData = true
  }

  let promptTokens: number | null = null
  let toolTokens: number | null = null
  if (hasSystemMessage) {
    const sectionText = [...sections.entries()]
      .filter(([name]) => name !== 'tools')
      .map(([name, text]) => `${name}\n${text}`)
      .join('\n')
    const firstSystemMessage = messages.find((message) => message.role === 'system')
    const systemContent = sections.size === 0 && firstSystemMessage
      ? messageText(firstSystemMessage)
      : ''
    promptTokens = estimateTextTokens(sectionText || systemContent)

    if (hasToolData) {
      const toolSection = sections.get('tools') ?? ''
      const toolSchemas = JSON.stringify([...tools.values()])
      toolTokens = estimateTextTokens(`${toolSection}\n${toolSchemas}`)
    }
  }

  const totalTokens = typeof reportedContextTokens === 'number' && reportedContextTokens > 0
    ? reportedContextTokens
    : newestUsageTokens
  if (totalTokens === null || totalTokens === undefined) {
    return {
      systemPrompt: promptTokens,
      toolDefinitions: toolTokens,
      conversationMessages: messages.some((message) => message.role !== 'system')
        ? conversationTokens
        : null,
      source: 'session'
    }
  }

  const knownTotal = (promptTokens ?? 0) + (toolTokens ?? 0)
  const scale = knownTotal > totalTokens && knownTotal > 0 ? totalTokens / knownTotal : 1
  const systemPrompt = promptTokens === null ? null : Math.round(promptTokens * scale)
  const toolDefinitions = toolTokens === null ? null : Math.round(toolTokens * scale)
  const knownRows = (systemPrompt ?? 0) + (toolDefinitions ?? 0)
  return {
    systemPrompt,
    toolDefinitions,
    conversationMessages: messages.some((message) => message.role !== 'system')
      ? Math.max(0, totalTokens - knownRows)
      : null,
    source: 'session'
  }
}

export function parseRequestContextBreakdown(value: string | undefined): ContextBreakdown | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<ContextBreakdown>
    const validCount = (count: unknown): count is number | null =>
      count === null || (typeof count === 'number' && Number.isFinite(count) && count >= 0)
    if (
      !validCount(parsed.systemPrompt) ||
      !validCount(parsed.toolDefinitions) ||
      !validCount(parsed.conversationMessages)
    ) return null
    return {
      systemPrompt: parsed.systemPrompt,
      toolDefinitions: parsed.toolDefinitions,
      conversationMessages: parsed.conversationMessages,
      source: 'request'
    }
  } catch {
    return null
  }
}

export function contextReading(input: {
  stats?: SessionStats
  items: readonly ThreadItem[]
  /** The model the live session reported, when there is one. */
  model?: ModelInfo
  /** The model the app would start with, for a conversation with no process. */
  fallbackModel?: ModelInfo
}): ContextReading {
  const { stats, items, model, fallbackModel } = input

  let inputTokens = 0
  let outputTokens = 0
  let cacheRead = 0
  let cacheWrite = 0
  let total = 0
  let newestContext: number | null = null
  for (const item of items) {
    if (item.kind !== 'assistant' || !item.usage) continue
    const usage = item.usage
    inputTokens += usage.input
    outputTokens += usage.output
    cacheRead += usage.cacheRead
    cacheWrite += usage.cacheWrite
    total += usage.totalTokens
    // The newest message is the closest thing the transcript knows to "what
    // the last request actually put in the window". A message that reported
    // zero usage (a failed or cut-off answer) cannot erase a real reading.
    if (usage.totalTokens > 0) newestContext = usage.totalTokens
  }

  const statsTokens = stats?.tokens
  const hasStats = Boolean(statsTokens && statsTokens.total > 0)
  const totals = hasStats
    ? {
        tokensTotal: statsTokens!.total,
        input: statsTokens!.input,
        output: statsTokens!.output,
        cacheRead: statsTokens!.cacheRead,
        cacheWrite: statsTokens!.cacheWrite
      }
    : {
        tokensTotal: total,
        input: inputTokens,
        output: outputTokens,
        cacheRead,
        cacheWrite
      }

  const context = stats?.contextUsage
  const reportedTokens = typeof context?.tokens === 'number' ? context.tokens : null
  const reportedWindow =
    typeof context?.contextWindow === 'number' && context.contextWindow > 0
      ? context.contextWindow
      : null
  const window = reportedWindow ?? windowOf(model, fallbackModel)

  // Pi reporting `null` tokens means it has no valid usage yet (right after a
  // compaction). The transcript's newest message is then the honest estimate.
  const tokens = reportedTokens ?? newestContext
  const percent = context?.percent ?? percentOf(tokens, window)

  return {
    tokens,
    contextWindow: window,
    percent,
    source: reportedTokens !== null || context?.percent != null ? 'pi' : 'transcript',
    ...totals,
    cost: typeof stats?.cost === 'number' ? stats.cost : null
  }
}

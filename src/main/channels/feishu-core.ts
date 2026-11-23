import type { ImChannelConfig } from '@shared/types'
import { MAX_IM_MESSAGE_CHARS, type ChannelAdapter, type ChannelAdapterContext } from './im-channel-service'

/** Feishu re-pushes an event whose handler has not answered within 3 seconds. */
const DEDUPE_ENTRIES = 256

function logError(channelId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[pi-desktop] feishu channel ${channelId}:`, message)
}

export interface FeishuMessageClient {
  sendText(chatId: string, text: string): Promise<void>
}

export interface FeishuWsTransport {
  start(onMessage: (data: unknown) => void): Promise<void>
  close(params?: { force?: boolean }): void
}

export interface FeishuSdkDeps {
  createClient: (config: { appId: string; appSecret: string }) => FeishuMessageClient
  createWsClient: (config: { appId: string; appSecret: string }) => FeishuWsTransport
}

/**
 * SDK-agnostic Feishu channel adapter logic so unit tests can exercise
 * `stop()` teardown, handler guards, dedupe, mention replacement, and
 * `allowedChatIds` without bundling the CJS Lark SDK into ESM test runs.
 */
export function createFeishuAdapter(
  channel: ImChannelConfig,
  context: ChannelAdapterContext,
  deps: FeishuSdkDeps
): ChannelAdapter {
  const config = channel.feishu
  if (!config) throw new Error('Feishu credentials are missing.')
  const channelId = channel.id
  const seen = new Map<string, true>()
  let client: FeishuMessageClient | null = null
  let wsClient: FeishuWsTransport | null = null
  let stopped = false
  let lastChatId: string | undefined
  let current: { state: 'connecting' | 'connected' | 'error' | 'disabled'; error?: string } = { state: 'connecting' }

  const remember = (id: string): boolean => {
    if (seen.has(id)) return false
    if (seen.size >= DEDUPE_ENTRIES) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    seen.set(id, true)
    return true
  }

  const handleInbound = (data: unknown): void => {
    if (stopped) return
    // Return fast: Feishu re-pushes events answered after three
    // seconds, and the routing below is fire-and-forget on purpose.
    try {
      const message = (data as { message?: Record<string, unknown> }).message
      if (!message) return
      const messageId = typeof message.message_id === 'string' ? message.message_id : ''
      if (!messageId || !remember(messageId)) return
      if (message.message_type !== 'text') return
      const chatId = typeof message.chat_id === 'string' ? message.chat_id : ''
      if (!chatId) return
      if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(chatId)) return
      let text = ''
      try {
        const content = typeof message.content === 'string' ? JSON.parse(message.content) : {}
        text = typeof content.text === 'string' ? content.text : ''
      } catch {
        return
      }
      const mentions = Array.isArray(message.mentions) ? (message.mentions as { key?: string; name?: string }[]) : []
      for (const mention of mentions) {
        if (!mention.key || !mention.name) continue
        text = text.split(mention.key).join(`${mention.name} `)
      }
      text = text.replace(/@_user_\d+/g, '').trim()
      if (!text) return
      lastChatId = chatId
      void context.router(channelId, text).catch((error: unknown) => logError(channelId, error))
    } catch (error) {
      logError(channelId, error)
    }
  }

  const adapter: ChannelAdapter = {
    async start(): Promise<void> {
      if (stopped) return
      const nextClient = deps.createClient({ appId: config.appId, appSecret: config.appSecret })
      const nextWsClient = deps.createWsClient({ appId: config.appId, appSecret: config.appSecret })
      client = nextClient
      wsClient = nextWsClient
      await nextWsClient.start(handleInbound)
      if (stopped || wsClient !== nextWsClient) {
        try {
          nextWsClient.close({ force: true })
        } catch (error) {
          logError(channelId, error)
        }
        return
      }
      current = { state: 'connected' }
      context.onState('connected')
    },

    async stop(): Promise<void> {
      stopped = true
      const activeWs = wsClient
      wsClient = null
      client = null
      current = { state: 'disabled' }
      try {
        activeWs?.close({ force: true })
      } catch (error) {
        logError(channelId, error)
      }
    },

    async send(text: string): Promise<void> {
      if (stopped || !client) throw new Error('The Feishu channel is not running.')
      const target = lastChatId ?? config.allowedChatIds[0]
      if (!target) return
      await client.sendText(target, text.slice(0, MAX_IM_MESSAGE_CHARS))
    },

    async test(): Promise<{ ok: boolean; error?: string }> {
      if (current.state === 'connected') return { ok: true }
      return { ok: false, error: current.error ?? 'The Feishu connection is not established yet.' }
    },

    state: () => current
  }
  return adapter
}

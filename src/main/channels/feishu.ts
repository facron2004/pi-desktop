import * as lark from '@larksuiteoapi/node-sdk'
import type { ImChannelConfig } from '@shared/types'
import { MAX_IM_MESSAGE_CHARS, type ChannelAdapter, type ChannelAdapterContext } from './im-channel-service'

/** Feishu re-pushes an event whose handler has not answered within 3 seconds. */
const DEDUPE_ENTRIES = 256

function logError(channelId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[pi-desktop] feishu channel ${channelId}:`, message)
}

/**
 * Feishu transport for one 自建应用 in long-connection mode.
 *
 * The official WSClient owns the socket, the handshake and the reconnect, so
 * no public URL, decryption or signature handling exists here. Inbound text
 * messages are deduped on `message_id`, mention placeholders are replaced
 * with the mention's name, and replies go to the chat they came from.
 */
export function buildFeishuAdapter(channel: ImChannelConfig, context: ChannelAdapterContext): ChannelAdapter {
  const config = channel.feishu
  if (!config) throw new Error('Feishu credentials are missing.')
  const channelId = channel.id
  const seen = new Map<string, true>()
  let client: lark.Client | null = null
  let wsClient: lark.WSClient | null = null
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

  const adapter: ChannelAdapter = {
    async start(): Promise<void> {
      client = new lark.Client({ appId: config.appId, appSecret: config.appSecret, loggerLevel: lark.LoggerLevel.warn })
      wsClient = new lark.WSClient({ appId: config.appId, appSecret: config.appSecret, loggerLevel: lark.LoggerLevel.warn })
      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': (data: unknown) => {
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
      })
      await wsClient.start({ eventDispatcher: dispatcher })
      current = { state: 'connected' }
      context.onState('connected')
    },

    async stop(): Promise<void> {
      // The SDK's WSClient exposes no public close in every version; dropping
      // every reference makes the adapter inert even if the socket lingers
      // until process exit.
      wsClient = null
      client = null
      current = { state: 'disabled' }
    },

    async send(text: string): Promise<void> {
      if (!client) throw new Error('The Feishu channel is not running.')
      const target = lastChatId ?? config.allowedChatIds[0]
      if (!target) return
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: target,
          msg_type: 'text',
          content: JSON.stringify({ text: text.slice(0, MAX_IM_MESSAGE_CHARS) })
        }
      })
    },

    async test(): Promise<{ ok: boolean; error?: string }> {
      if (current.state === 'connected') return { ok: true }
      return { ok: false, error: current.error ?? 'The Feishu connection is not established yet.' }
    },

    state: () => current
  }
  return adapter
}

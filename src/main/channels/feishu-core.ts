import type { ImChannelConfig } from '@shared/types'
import { MAX_IM_MESSAGE_CHARS, type ChannelAdapter, type ChannelAdapterContext } from './im-channel-service'

/** Feishu re-pushes an event whose handler has not answered within 3 seconds. */
const DEDUPE_ENTRIES = 256
/** A channel that never reports ready is not connecting, it is broken. */
const CONNECT_TIMEOUT_MS = 20_000

function logError(channelId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[pi-desktop] feishu channel ${channelId}:`, message)
}

export interface FeishuMessageClient {
  sendText(chatId: string, text: string): Promise<void>
}

export interface FeishuWsTransport {
  /**
   * `start` returns once the reconnect loop is scheduled, not once a socket
   * exists, so the transport reports the handshake through these callbacks.
   */
  start(onMessage: (data: unknown) => void, handlers?: {
    onReady: () => void
    onError: (error: Error) => void
  }): Promise<void>
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
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  let current: { state: 'connecting' | 'connected' | 'error' | 'disabled'; error?: string } = { state: 'connecting' }

  const clearSettleTimer = (): void => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = undefined
  }

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
      const isCurrent = (): boolean => !stopped && wsClient === nextWsClient
      // The SDK's start() resolves as soon as its reconnect loop is scheduled and
      // logs-and-returns for an app id it refuses, so "connected" may only come
      // from onReady. A handshake that never reports leaves the channel honestly
      // in "connecting" for a bounded time instead of lying forever.
      clearSettleTimer()
      settleTimer = setTimeout(() => {
        settleTimer = undefined
        if (!isCurrent() || current.state !== 'connecting') return
        current = { state: 'error', error: 'The Feishu connection did not complete its handshake.' }
        context.onState('error', current.error)
      }, CONNECT_TIMEOUT_MS)
      settleTimer.unref?.()
      try {
        await nextWsClient.start(handleInbound, {
          onReady: () => {
            if (!isCurrent()) return
            clearSettleTimer()
            current = { state: 'connected' }
            context.onState('connected')
          },
          onError: (error) => {
            if (!isCurrent()) return
            clearSettleTimer()
            const message = error instanceof Error ? error.message : String(error)
            current = { state: 'error', error: message }
            context.onState('error', message)
            logError(channelId, error)
          }
        })
      } catch (error) {
        if (!isCurrent()) throw error
        clearSettleTimer()
        const message = error instanceof Error ? error.message : String(error)
        current = { state: 'error', error: message }
        context.onState('error', message)
        throw error
      }
      if (!isCurrent()) {
        try {
          nextWsClient.close({ force: true })
        } catch (error) {
          logError(channelId, error)
        }
      }
    },

    async stop(): Promise<void> {
      stopped = true
      clearSettleTimer()
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

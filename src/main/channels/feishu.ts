import * as lark from '@larksuiteoapi/node-sdk'
import type { ImChannelConfig } from '@shared/types'
import type { ChannelAdapter, ChannelAdapterContext } from './im-channel-service'
import { createFeishuAdapter } from './feishu-core'

/**
 * Feishu transport for one 自建应用 in long-connection mode.
 *
 * The official WSClient owns the socket, the handshake and the reconnect, so
 * no public URL, decryption or signature handling exists here. Inbound text
 * messages are deduped on `message_id`, mention placeholders are replaced
 * with the mention's name, and replies go to the chat they came from.
 */
export function buildFeishuAdapter(channel: ImChannelConfig, context: ChannelAdapterContext): ChannelAdapter {
  return createFeishuAdapter(channel, context, {
    createClient: ({ appId, appSecret }) => {
      const sdkClient = new lark.Client({ appId, appSecret, loggerLevel: lark.LoggerLevel.warn })
      return {
        async sendText(chatId: string, text: string): Promise<void> {
          await sdkClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text })
            }
          })
        }
      }
    },
    createWsClient: ({ appId, appSecret }) => {
      const sdkWs = new lark.WSClient({ appId, appSecret, loggerLevel: lark.LoggerLevel.warn })
      return {
        async start(onMessage: (data: unknown) => void): Promise<void> {
          const dispatcher = new lark.EventDispatcher({}).register({
            'im.message.receive_v1': onMessage
          })
          await sdkWs.start({ eventDispatcher: dispatcher })
        },
        close(params?: { force?: boolean }): void {
          ;(sdkWs as unknown as { close?: (opts?: { force?: boolean }) => void }).close?.(params)
        }
      }
    }
  })
}

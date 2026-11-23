import type { ImChannelConfig } from '@shared/types'
import type { ChannelAdapter, ChannelAdapterContext } from './im-channel-service'

/**
 * Build the transport adapter for one channel. Feishu speaks the official
 * long-connection SDK; WeChat speaks the wechatbot-webhook HTTP contract.
 * Implemented by `feishu.ts` / `wechat.ts`.
 */
export function createChannelAdapter(
  channel: ImChannelConfig,
  context: ChannelAdapterContext
): ChannelAdapter {
  void context
  void channel
  // ADAPTERS-TODO: dispatch on `channel.kind` to buildFeishuAdapter /
  // buildWechatAdapter from './feishu' / './wechat'.
  return {
    async start(): Promise<void> {
      throw new Error('This channel transport is not available yet.')
    },
    async stop(): Promise<void> {},
    async send(_text: string): Promise<void> {
      throw new Error('This channel transport is not available yet.')
    },
    async test(): Promise<{ ok: boolean; error?: string }> {
      return { ok: false, error: 'This channel transport is not available yet.' }
    },
    state: () => ({ state: 'disabled' })
  }
}

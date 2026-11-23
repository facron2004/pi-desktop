import type { ImChannelConfig } from '@shared/types'
import type { ChannelAdapter, ChannelAdapterContext } from './im-channel-service'
import { buildFeishuAdapter } from './feishu'
import { buildWechatAdapter } from './wechat'

/**
 * Build the transport adapter for one channel. Feishu speaks the official
 * long-connection SDK; WeChat speaks the wechatbot-webhook HTTP contract.
 * The service itself never imports this file — tests inject a fake through
 * the same constructor seam.
 */
export function createChannelAdapter(
  channel: ImChannelConfig,
  context: ChannelAdapterContext
): ChannelAdapter {
  if (channel.kind === 'feishu' && channel.feishu) return buildFeishuAdapter(channel, context)
  if (channel.kind === 'wechat' && channel.wechat) return buildWechatAdapter(channel, context)
  throw new Error('This channel has no usable configuration.')
}

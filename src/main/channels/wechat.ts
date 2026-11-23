import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ImChannelConfig } from '@shared/types'
import { isPrivateClient } from '../remote-access'
import { MAX_IM_MESSAGE_CHARS, type ChannelAdapter, type ChannelAdapterContext } from './im-channel-service'
import { parseMultipartTextFields } from './multipart'

const MAX_BODY_BYTES = 1024 * 1024
const RATE_WINDOW_MS = 1_000
const MAX_REQUESTS_PER_WINDOW = 5
const MAX_RATE_SOURCES = 64

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function logError(channelId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[pi-desktop] wechat channel ${channelId}:`, message)
}

/**
 * WeChat transport speaking the wechatbot-webhook contract.
 *
 * Pi Desktop never hooks the WeChat client: the user runs the open-source
 * bridge themselves. The bridge POSTs received messages to a local listener
 * (LAN only, receive-token digest compare, per-IP rate limit); replies go
 * back through the bridge's `webhook/msg/v2` API and `test()` is its
 * `/healthz` endpoint. The account risk stays with the bridge project.
 */
export function buildWechatAdapter(channel: ImChannelConfig, context: ChannelAdapterContext): ChannelAdapter {
  const config = channel.wechat
  if (!config) throw new Error('WeChat bridge settings are missing.')
  const channelId = channel.id
  const receiveTokenHash = sha256(config.receiveToken)
  const rate = new Map<string, { count: number; resetsAt: number }>()
  let server: Server | null = null
  let lastSenderName: string | undefined
  let lastSenderWasRoom = false
  let current: { state: 'connecting' | 'connected' | 'error' | 'disabled'; error?: string } = { state: 'connecting' }

  const allowRequest = (address: string, now = Date.now()): boolean => {
    for (const [source, record] of rate) {
      if (record.resetsAt <= now) rate.delete(source)
    }
    const entry = rate.get(address)
    if (entry) {
      if (entry.count >= MAX_REQUESTS_PER_WINDOW) return false
      entry.count += 1
      return true
    }
    if (rate.size >= MAX_RATE_SOURCES) {
      const oldest = rate.keys().next().value
      if (oldest !== undefined) rate.delete(oldest)
    }
    rate.set(address, { count: 1, resetsAt: now + RATE_WINDOW_MS })
    return true
  }

  const sendJson = (response: ServerResponse, status: number, value: unknown): void => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(value))
  }

  const readBody = async (request: IncomingMessage): Promise<Buffer> => {
    const declared = Number(request.headers['content-length'] ?? 0)
    if (declared > MAX_BODY_BYTES) throw new Error('too large')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > MAX_BODY_BYTES) throw new Error('too large')
      chunks.push(bytes)
    }
    return Buffer.concat(chunks)
  }

  const handleInbound = (fields: Record<string, string>): void => {
    const type = fields.type ?? ''
    if (type === 'system_event_login') {
      current = { state: 'connected' }
      context.onState('connected')
      return
    }
    if (type === 'system_event_logout') {
      current = { state: 'error', error: '微信已退出登录' }
      context.onState('error', '微信已退出登录')
      return
    }
    if (type === 'system_event_error') {
      const detail = (fields.content ?? '').replace(/\s+/g, ' ').slice(0, 200)
      current = { state: 'error', error: detail || '桥接服务报告了错误' }
      context.onState('error', current.error)
      return
    }
    if (type !== 'text') return // files, links, friendships and pushes stay untouched
    if (fields.isMsgFromSelf === '1') return
    const content = (fields.content ?? '').trim()
    if (!content) return
    try {
      const source = JSON.parse(fields.source ?? '{}') as {
        room?: unknown
        from?: { payload?: { name?: unknown; id?: unknown } }
      }
      const fromPayload = source.from?.payload
      if (typeof fromPayload?.name === 'string' && fromPayload.name) lastSenderName = fromPayload.name.slice(0, 120)
      lastSenderWasRoom = Boolean(source.room)
    } catch {
      /* a malformed source only loses sender tracking, not the message */
    }
    void context.router(channelId, content).catch((error: unknown) => logError(channelId, error))
  }

  const adapter: ChannelAdapter = {
    async start(): Promise<void> {
      if (server) return
      await new Promise<void>((resolve, reject) => {
        const listening = createServer((request, response) => {
          void (async () => {
            try {
              const address = request.socket.remoteAddress ?? 'unknown'
              if (!isPrivateClient(address)) return sendJson(response, 403, { success: false, message: 'Local network access only.' })
              if (request.method !== 'POST') return sendJson(response, 405, { success: false, message: 'POST is required.' })
              if (!allowRequest(address)) return sendJson(response, 429, { success: false, message: 'Too many requests.' })
              const url = new URL(request.url ?? '/', 'http://localhost')
              const presented = url.searchParams.get('token') ?? ''
              const digest = Buffer.from(sha256(presented), 'hex')
              const expected = Buffer.from(receiveTokenHash, 'hex')
              if (presented.length === 0 || digest.length !== expected.length || !timingSafeEqual(digest, expected)) {
                return sendJson(response, 401, { success: false, message: 'Invalid receive token.' })
              }
              const contentType = String(request.headers['content-type'] ?? '')
              if (!/^multipart\/form-data/i.test(contentType)) {
                return sendJson(response, 415, { success: false, message: 'multipart/form-data is required.' })
              }
              const body = await readBody(request)
              handleInbound(parseMultipartTextFields(contentType, body))
              sendJson(response, 200, { success: true })
            } catch (error) {
              const message = error instanceof Error ? error.message : ''
              sendJson(response, message === 'too large' ? 413 : 500, { success: false, message: message || 'Request failed.' })
            }
          })()
        })
        listening.once('error', reject)
        listening.once('listening', () => {
          listening.off('error', reject)
          resolve()
        })
        listening.listen(config.listenPort, '0.0.0.0')
        server = listening
      })
      current = { state: 'connected' }
      context.onState('connected')
    },

    async stop(): Promise<void> {
      const listening = server
      server = null
      current = { state: 'disabled' }
      if (!listening) return
      await new Promise<void>((resolve) => {
        listening.close(() => resolve())
        listening.closeAllConnections?.()
      })
    },

    async send(text: string): Promise<void> {
      const to = config.sendTo || lastSenderName
      if (!to) return
      const isRoom = config.sendTo ? config.sendToIsRoom : lastSenderWasRoom
      const base = config.bridgeUrl.replace(/\/+$/, '')
      const url = `${base}/webhook/msg/v2?token=${encodeURIComponent(config.bridgeToken)}`
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, isRoom, data: { type: 'text', content: text.slice(0, MAX_IM_MESSAGE_CHARS) } })
      })
      if (!response.ok) throw new Error(`桥接服务返回 ${response.status}`)
      const result = await response.json().catch(() => ({})) as { success?: boolean; message?: string }
      if (result.success === false) throw new Error(result.message || '桥接服务未能发送消息')
    },

    async test(): Promise<{ ok: boolean; error?: string }> {
      const base = config.bridgeUrl.replace(/\/+$/, '')
      try {
        const response = await fetch(`${base}/healthz?token=${encodeURIComponent(config.bridgeToken)}`)
        const body = await response.text().catch(() => '')
        const healthy = response.ok && body.includes('healthy') && !body.includes('unHealthy')
        context.onBridgeHealth?.(healthy)
        return healthy ? { ok: true } : { ok: false, error: '桥接服务未就绪（微信可能未登录）' }
      } catch (error) {
        context.onBridgeHealth?.(false)
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, error: `无法连接桥接服务：${message}` }
      }
    },

    state: () => current
  }
  return adapter
}

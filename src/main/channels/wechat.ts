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
export const WECHAT_HTTP_LIMITS = {
  maxConnections: 64,
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 30_000
} as const
const OUTBOUND_TIMEOUT_MS = 15_000
const MAX_BRIDGE_RESPONSE_BYTES = 256 * 1024

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function scrubBridgeToken(message: string, token: string): string {
  let clean = message.replace(/([?&]token=)[^&\s"']+/gi, '$1••••')
  if (token) {
    clean = clean.split(token).join('••••')
    const encoded = encodeURIComponent(token)
    if (encoded !== token) clean = clean.split(encoded).join('••••')
  }
  return clean
}

async function readBoundedText(response: Response, maxBytes = MAX_BRIDGE_RESPONSE_BYTES): Promise<string> {
  const contentLength = response.headers?.get?.('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error('桥接服务响应过大')
  }
  const reader = response.body?.getReader()
  if (reader) {
    const chunks: Buffer[] = []
    let bytes = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (bytes + value.byteLength > maxBytes) {
          await reader.cancel().catch(() => {})
          throw new Error('桥接服务响应过大')
        }
        const chunk = Buffer.from(value)
        chunks.push(chunk)
        bytes += chunk.length
      }
    } finally {
      reader.releaseLock()
    }
    return Buffer.concat(chunks, bytes).toString('utf8')
  }
  const text = await response.text().catch(() => '')
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('桥接服务响应过大')
  return text
}

function logError(channelId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[pi-desktop] wechat channel ${channelId}:`, message)
}

export interface WechatAdapterDeps {
  fetcher?: typeof fetch
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
export function buildWechatAdapter(
  channel: ImChannelConfig,
  context: ChannelAdapterContext,
  deps?: WechatAdapterDeps
): ChannelAdapter {
  const config = channel.wechat
  if (!config) throw new Error('WeChat bridge settings are missing.')
  const fetcher = deps?.fetcher ?? fetch
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

  const sendJson = (response: ServerResponse, status: number, value: unknown, closeConnection = false): void => {
    if (response.headersSent || response.writableEnded || response.destroyed) return
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8' }
    if (closeConnection) headers.Connection = 'close'
    response.writeHead(status, headers)
    response.end(JSON.stringify(value))
  }

  const readBody = async (request: IncomingMessage): Promise<Buffer> => {
    const declared = Number(request.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('too large')
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
    let sender = ''
    let isRoom = false
    try {
      const source = JSON.parse(fields.source ?? '{}') as {
        room?: unknown
        from?: { payload?: { name?: unknown; id?: unknown } }
      }
      const fromPayload = source.from?.payload
      if (typeof fromPayload?.name === 'string' && fromPayload.name) sender = fromPayload.name.slice(0, 120)
      isRoom = Boolean(source.room)
      if (sender) lastSenderName = sender
      lastSenderWasRoom = isRoom
    } catch {
      /* a malformed source only loses sender tracking, not the message */
    }
    // The reply belongs to whoever wrote this message, not to the last contact
    // that happened to speak before it.
    const replyTo = sender ? `${isRoom ? 'room' : 'user'}:${sender}` : undefined
    void context.router(channelId, content, replyTo).catch((error: unknown) => logError(channelId, error))
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
              const tooLarge = message === 'too large'
              const badMultipart = /multipart/i.test(message)
              sendJson(
                response,
                tooLarge ? 413 : badMultipart ? 400 : 500,
                { success: false, message: message || 'Request failed.' },
                tooLarge
              )
              if (tooLarge) {
                if (response.writableEnded) request.destroy()
                else response.once('finish', () => request.destroy())
              }
            }
          })()
        })
        listening.maxConnections = WECHAT_HTTP_LIMITS.maxConnections
        listening.headersTimeout = WECHAT_HTTP_LIMITS.headersTimeoutMs
        listening.requestTimeout = WECHAT_HTTP_LIMITS.requestTimeoutMs
        const onStartError = (error: Error) => {
          listening.off('listening', onListening)
          if (server === listening) server = null
          reject(error)
        }
        const onListening = () => {
          listening.off('error', onStartError)
          listening.on('error', (error: Error) => {
            logError(channelId, error)
            if (server === listening) {
              current = { state: 'error', error: error.message }
              context.onState('error', error.message)
            }
          })
          resolve()
        }
        listening.once('error', onStartError)
        listening.once('listening', onListening)
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

    async send(text: string, target?: string): Promise<void> {
      let to = config.sendTo || lastSenderName
      let isRoom = config.sendTo ? config.sendToIsRoom : lastSenderWasRoom
      if (target) {
        const separator = target.indexOf(':')
        const kind = target.slice(0, Math.max(0, separator))
        const name = target.slice(separator + 1)
        if (name && (kind === 'room' || kind === 'user')) {
          to = name
          isRoom = kind === 'room'
        }
      }
      if (!to) {
        logError(channelId, new Error('No WeChat contact to reply to yet.'))
        return
      }
      const base = config.bridgeUrl.replace(/\/+$/, '')
      const url = `${base}/webhook/msg/v2?token=${encodeURIComponent(config.bridgeToken)}`
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to, isRoom, data: { type: 'text', content: text.slice(0, MAX_IM_MESSAGE_CHARS) } }),
          signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
          redirect: 'error'
        })
        const raw = await readBoundedText(response)
        if (!response.ok) throw new Error(`桥接服务返回 ${response.status}`)
        let result: { success?: boolean; message?: string } = {}
        try {
          result = raw ? (JSON.parse(raw) as { success?: boolean; message?: string }) : {}
        } catch {
          result = {}
        }
        if (result.success === false) throw new Error(result.message || '桥接服务未能发送消息')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(scrubBridgeToken(message, config.bridgeToken))
      }
    },

    async test(): Promise<{ ok: boolean; error?: string }> {
      const base = config.bridgeUrl.replace(/\/+$/, '')
      try {
        const response = await fetcher(`${base}/healthz?token=${encodeURIComponent(config.bridgeToken)}`, {
          signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
          redirect: 'error'
        })
        const body = await readBoundedText(response)
        const healthy = response.ok && body.includes('healthy') && !body.includes('unHealthy')
        context.onBridgeHealth?.(healthy)
        return healthy ? { ok: true } : { ok: false, error: '桥接服务未就绪（微信可能未登录）' }
      } catch (error) {
        context.onBridgeHealth?.(false)
        const message = scrubBridgeToken(error instanceof Error ? error.message : String(error), config.bridgeToken)
        return { ok: false, error: `无法连接桥接服务：${message}` }
      }
    },

    state: () => current
  }
  return adapter
}

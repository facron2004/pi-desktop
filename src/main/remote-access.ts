import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  AgentMessage,
  PiEvent,
  RemoteAccessDevice,
  RemoteAccessStatus,
  RemoteSession,
  RemoteWorkspace
} from '@shared/types'
import { listSessions, readSessionMessages } from './sessions'
import type { SessionSupervisor } from './pi/supervisor'
import type { SettingsStore } from './settings'

const PAIRING_TTL_MS = 3 * 60 * 1000
const MAX_DEVICES = 12
const MAX_BODY_BYTES = 64 * 1024
const MAX_REMOTE_MESSAGES = 100
const MAX_REMOTE_STRING = 16_000

interface StoredDevice extends RemoteAccessDevice {
  tokenHash: string
}

interface PersistedRemoteState {
  enabled: boolean
  devices: StoredDevice[]
}

interface SessionRef {
  workspaceId: string
  sessionId: string
  cwd: string
  file: string
}

interface EventStream {
  deviceId: string
  workspaceId: string
  sessionId: string
  fileKey: string
  response: ServerResponse
  heartbeat: ReturnType<typeof setInterval>
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function pathKey(file: string): string {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [a, b] = parts
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function localIpv4Addresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address))
    .map((entry) => entry.address)
  return [...new Set(addresses)]
}

function isPrivateClient(address?: string): boolean {
  if (!address) return false
  if (address === '::1') return true
  if (address.startsWith('::ffff:')) return isPrivateIpv4(address.slice('::ffff:'.length))
  if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true
  return isPrivateIpv4(address)
}

function safeRemoteValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_REMOTE_STRING ? `${value.slice(0, MAX_REMOTE_STRING)}\n…` : value
  }
  if (!value || typeof value !== 'object' || depth > 12) return value
  if (!Array.isArray(value) && (value as { type?: unknown }).type === 'image') {
    return { type: 'text', text: '[Image omitted on mobile]' }
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeRemoteValue(item, depth + 1))

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (['ownerId', 'sessionKey', 'sessionFile', 'cwd'].includes(key)) continue
    result[key] = safeRemoteValue(item, depth + 1)
  }
  return result
}

export class RemoteAccessService {
  private readonly stateFile: string
  private enabled = false
  private devices: StoredDevice[] = []
  private server: Server | null = null
  private port: number | undefined
  private error: string | undefined
  private pairing: { secret: string; expiresAt: number } | undefined
  private readonly pairAttempts = new Map<string, { count: number; resetsAt: number }>()
  private readonly sessionRefs = new Map<string, SessionRef>()
  private readonly streams = new Set<EventStream>()

  constructor(
    private readonly options: {
      userData: string
      uiDirectory: string
      settings: SettingsStore
      supervisor: SessionSupervisor
      customInstructions: (cwd: string) => string | undefined
    }
  ) {
    this.stateFile = path.join(options.userData, 'remote-access.json')
  }

  async initialize(): Promise<RemoteAccessStatus> {
    this.readState()
    if (this.enabled) {
      try {
        await this.startServer()
        this.newPairing()
        this.writeState()
      } catch (error) {
        this.enabled = false
        this.error = error instanceof Error ? error.message : String(error)
        this.writeState()
      }
    }
    return this.status()
  }

  status(): RemoteAccessStatus {
    const addresses = this.enabled && this.port
      ? localIpv4Addresses().map((address) => `http://${address}:${this.port}/`)
      : []
    const pairing = this.enabled ? this.currentPairing() : undefined
    const pairingUrl = pairing && addresses[0]
      ? `${addresses[0]}#pair=${encodeURIComponent(pairing.secret)}`
      : undefined
    return {
      enabled: this.enabled,
      urls: addresses,
      pairingUrl,
      pairingExpiresAt: pairingUrl ? pairing?.expiresAt : undefined,
      devices: this.devices.map(({ id, name, pairedAt }) => ({ id, name, pairedAt })),
      error: this.error ?? (this.enabled && !addresses.length ? 'No private IPv4 network address is available.' : undefined)
    }
  }

  async setEnabled(enabled: boolean): Promise<RemoteAccessStatus> {
    this.error = undefined
    if (!enabled) {
      this.enabled = false
      this.pairing = undefined
      this.writeState()
      await this.stopServer()
      return this.status()
    }
    if (this.enabled && this.server) return this.status()

    try {
      await this.startServer()
      this.enabled = true
      this.pairing = undefined
      this.newPairing()
      this.writeState()
    } catch (error) {
      this.enabled = false
      this.error = error instanceof Error ? error.message : String(error)
      await this.stopServer()
      this.writeState()
    }
    return this.status()
  }

  newPairing(): RemoteAccessStatus {
    if (!this.enabled || !this.server) {
      this.error = 'Start remote access before creating a pairing code.'
      return this.status()
    }
    this.error = undefined
    this.pairing = {
      secret: randomBytes(24).toString('base64url'),
      expiresAt: Date.now() + PAIRING_TTL_MS
    }
    return this.status()
  }

  revokeDevice(id: string): RemoteAccessStatus {
    const next = this.devices.filter((device) => device.id !== id)
    if (next.length === this.devices.length) return this.status()
    this.devices = next
    this.writeState()
    for (const stream of [...this.streams]) {
      if (stream.deviceId === id) this.closeStream(stream)
    }
    return this.status()
  }

  async dispose(): Promise<void> {
    this.enabled = false
    await this.stopServer()
  }

  private readState(): void {
    if (!existsSync(this.stateFile)) return
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<PersistedRemoteState>
      this.enabled = parsed.enabled === true
      this.devices = Array.isArray(parsed.devices)
        ? parsed.devices.filter((device): device is StoredDevice =>
            typeof device?.id === 'string' &&
            typeof device.name === 'string' &&
            typeof device.pairedAt === 'number' &&
            typeof device.tokenHash === 'string'
          ).slice(0, MAX_DEVICES)
        : []
    } catch {
      this.enabled = false
      this.devices = []
      this.error = 'Saved remote access settings could not be read.'
    }
  }

  private writeState(): void {
    mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const tempFile = `${this.stateFile}.tmp`
    writeFileSync(tempFile, JSON.stringify({ enabled: this.enabled, devices: this.devices }), { mode: 0o600 })
    renameSync(tempFile, this.stateFile)
  }

  private currentPairing(): { secret: string; expiresAt: number } | undefined {
    if (this.pairing && this.pairing.expiresAt <= Date.now()) this.pairing = undefined
    return this.pairing
  }

  private async startServer(): Promise<void> {
    const addresses = localIpv4Addresses()
    if (!addresses.length) throw new Error('No private IPv4 network address is available.')

    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        if (response.headersSent) {
          response.end()
          return
        }
        const status = error instanceof HttpError ? error.status : 500
        const message = error instanceof HttpError ? error.message : 'Remote request failed.'
        this.sendJson(response, status, { error: message })
      })
    })
    const listening = new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening)
        reject(error)
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(0, '0.0.0.0')
    })
    await listening
    const address = server.address()
    if (!address || typeof address === 'string') {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      throw new Error('The remote access listener did not return a TCP port.')
    }

    this.server = server
    this.port = address.port
    this.enabled = true
    this.error = undefined
    this.options.supervisor.on('event', this.onRuntimeEvent)
  }

  private async stopServer(): Promise<void> {
    this.options.supervisor.off('event', this.onRuntimeEvent)
    for (const stream of [...this.streams]) this.closeStream(stream)
    const server = this.server
    this.server = null
    this.port = undefined
    this.sessionRefs.clear()
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private readonly onRuntimeEvent = (payload: { ownerId: string; event: PiEvent }): void => {
    const ref = this.sessionRefs.get(pathKey(payload.ownerId))
    if (!ref) return
    let event = payload.event
    if (event.type === 'extension_ui_request') {
      if (!['select', 'confirm', 'input', 'editor'].includes(String(event.method))) return
      event = { type: 'remote_waiting_for_desktop' }
    }
    const data = JSON.stringify(safeRemoteValue(event))
    for (const stream of this.streams) {
      if (stream.fileKey !== pathKey(payload.ownerId)) continue
      stream.response.write(`event: pi\ndata: ${data}\n\n`)
    }
  }

  private closeStream(stream: EventStream): void {
    if (!this.streams.delete(stream)) return
    clearInterval(stream.heartbeat)
    stream.response.end()
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setSecurityHeaders(response)
    if (!this.enabled || !this.server) throw new HttpError(503, 'Remote access is turned off.')
    if (!isPrivateClient(request.socket.remoteAddress)) throw new HttpError(403, 'Local network access only.')

    const hostHeader = request.headers.host ?? ''
    let hostname = ''
    try {
      hostname = new URL(`http://${hostHeader}`).hostname
    } catch {
      throw new HttpError(400, 'Invalid host header.')
    }
    const hosts = new Set(localIpv4Addresses())
    if (hostname !== 'localhost' && hostname !== '127.0.0.1' && !hosts.has(hostname)) {
      throw new HttpError(421, 'This address is not served by Pi Desktop.')
    }

    const url = new URL(request.url ?? '/', `http://${hostHeader}`)
    if (request.method === 'GET' && this.serveUi(url.pathname, response)) return

    if (request.method === 'POST' && url.pathname === '/api/pair') {
      this.requireSameOrigin(request)
      await this.pairDevice(request, response)
      return
    }

    const device = this.authenticate(request)
    if (request.method === 'GET' && url.pathname === '/api/workspaces') {
      const workspaces: RemoteWorkspace[] = this.options.settings.get().workspaces.map(
        ({ id, name, icon, iconColor }) => ({ id, name, icon, iconColor })
      )
      this.sendJson(response, 200, { workspaces })
      return
    }

    const workspaceSessions = /^\/api\/workspaces\/([^/]+)\/sessions$/.exec(url.pathname)
    if (request.method === 'GET' && workspaceSessions) {
      const workspaceId = decodeURIComponent(workspaceSessions[1])
      const workspace = this.getWorkspace(workspaceId)
      const sessions = (await listSessions(workspace.path)).map((session): RemoteSession => {
        this.rememberSession(workspace.id, workspace.path, session.id, session.file)
        return {
          id: session.id,
          name: session.name,
          preview: session.preview,
          updatedAt: session.updatedAt,
          messageCount: session.messageCount,
          model: session.model,
          isRunning: this.isSessionRunning(session.file)
        }
      })
      this.sendJson(response, 200, { sessions })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/session') {
      const workspaceId = url.searchParams.get('workspaceId') ?? ''
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const ref = await this.resolveSession(workspaceId, sessionId)
      const messages = await readSessionMessages(ref.file)
      const safeMessages = safeRemoteValue(messages.slice(-MAX_REMOTE_MESSAGES)) as AgentMessage[]
      this.sendJson(response, 200, {
        messages: safeMessages,
        truncated: messages.length > MAX_REMOTE_MESSAGES,
        isRunning: this.isSessionRunning(ref.file)
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      const workspaceId = url.searchParams.get('workspaceId') ?? ''
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const ref = await this.resolveSession(workspaceId, sessionId)
      this.openEventStream(device.id, ref, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/message') {
      this.requireSameOrigin(request)
      await this.sendMessage(request, response)
      return
    }

    throw new HttpError(404, 'Remote endpoint not found.')
  }

  private serveUi(pathname: string, response: ServerResponse): boolean {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1)
    if (relative !== 'index.html' && !/^assets\/[\w.-]+$/.test(relative)) return false
    const root = path.resolve(this.options.uiDirectory)
    const file = path.resolve(root, relative)
    if (!file.startsWith(`${root}${path.sep}`)) return false

    try {
      const content = readFileSync(file)
      const extension = path.extname(file).toLowerCase()
      const mime = extension === '.html'
        ? 'text/html; charset=utf-8'
        : extension === '.js'
          ? 'text/javascript; charset=utf-8'
          : extension === '.css'
            ? 'text/css; charset=utf-8'
            : extension === '.svg'
              ? 'image/svg+xml'
              : 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' })
      response.end(content)
      return true
    } catch {
      throw new HttpError(404, 'The mobile interface is not built yet.')
    }
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    )
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(value))
  }

  private requireSameOrigin(request: IncomingMessage): void {
    const origin = request.headers.origin
    const host = request.headers.host
    if (!origin || !host) throw new HttpError(403, 'A same-origin request is required.')
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== 'http:' || parsed.host.toLowerCase() !== host.toLowerCase()) {
        throw new HttpError(403, 'A same-origin request is required.')
      }
    } catch (error) {
      if (error instanceof HttpError) throw error
      throw new HttpError(403, 'A same-origin request is required.')
    }
  }

  private authenticate(request: IncomingMessage): RemoteAccessDevice {
    const header = request.headers.authorization ?? ''
    const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(header)
    if (!match) throw new HttpError(401, 'This phone is not paired with Pi Desktop.')
    const digest = Buffer.from(sha256(match[1]), 'hex')
    const device = this.devices.find((candidate) => {
      const expected = Buffer.from(candidate.tokenHash, 'hex')
      return expected.length === digest.length && timingSafeEqual(expected, digest)
    })
    if (!device) throw new HttpError(401, 'This phone is no longer paired with Pi Desktop.')
    return { id: device.id, name: device.name, pairedAt: device.pairedAt }
  }

  private async pairDevice(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = request.socket.remoteAddress ?? 'unknown'
    const attempts = this.pairAttempts.get(address)
    const now = Date.now()
    if (attempts && attempts.resetsAt > now && attempts.count >= 8) {
      throw new HttpError(429, 'Too many pairing attempts. Try again in a minute.')
    }
    if (!attempts || attempts.resetsAt <= now) {
      this.pairAttempts.set(address, { count: 1, resetsAt: now + 60_000 })
    } else {
      attempts.count += 1
    }

    const body = await this.readJson(request)
    const candidate = typeof body.secret === 'string' ? body.secret : ''
    const pairing = this.currentPairing()
    if (!pairing || !candidate || candidate.length !== pairing.secret.length) {
      throw new HttpError(401, 'This pairing code has expired or was already used.')
    }
    const candidateBytes = Buffer.from(candidate)
    const secretBytes = Buffer.from(pairing.secret)
    if (candidateBytes.length !== secretBytes.length || !timingSafeEqual(candidateBytes, secretBytes)) {
      throw new HttpError(401, 'This pairing code has expired or was already used.')
    }
    if (this.devices.length >= MAX_DEVICES) throw new HttpError(409, 'Remove a paired phone before adding another.')

    const accessToken = randomBytes(32).toString('base64url')
    const id = randomUUID()
    const rawName = typeof body.deviceName === 'string' ? body.deviceName : ''
    const name = rawName.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 40) || 'Mobile device'
    const device: StoredDevice = { id, name, pairedAt: now, tokenHash: sha256(accessToken) }
    this.devices = [...this.devices, device]
    this.pairing = undefined
    this.pairAttempts.delete(address)
    this.writeState()
    this.sendJson(response, 200, {
      accessToken,
      device: { id: device.id, name: device.name, pairedAt: device.pairedAt }
    })
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const declaredLength = Number(request.headers['content-length'] ?? 0)
    if (declaredLength > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.')
      chunks.push(bytes)
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
      return value as Record<string, unknown>
    } catch {
      throw new HttpError(400, 'Invalid JSON request.')
    }
  }

  private getWorkspace(id: string) {
    const workspace = this.options.settings.get().workspaces.find((item) => item.id === id)
    if (!workspace) throw new HttpError(404, 'Project not found.')
    return workspace
  }

  private rememberSession(workspaceId: string, cwd: string, sessionId: string, file: string): SessionRef {
    const ref = { workspaceId, sessionId, cwd, file }
    this.sessionRefs.set(pathKey(file), ref)
    return ref
  }

  private async resolveSession(workspaceId: string, sessionId: string): Promise<SessionRef> {
    if (!sessionId) throw new HttpError(400, 'Conversation id is required.')
    const workspace = this.getWorkspace(workspaceId)
    const session = (await listSessions(workspace.path)).find((item) => item.id === sessionId)
    if (!session) throw new HttpError(404, 'Conversation not found in this project.')
    return this.rememberSession(workspace.id, workspace.path, session.id, session.file)
  }

  private isSessionRunning(file: string): boolean {
    return this.options.supervisor.sessionInfo(file)?.running ?? false
  }

  private openEventStream(
    deviceId: string,
    ref: SessionRef,
    response: ServerResponse
  ): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache, no-transform'
    })
    response.write('retry: 2000\n\n')
    const stream: EventStream = {
      deviceId,
      workspaceId: ref.workspaceId,
      sessionId: ref.sessionId,
      fileKey: pathKey(ref.file),
      response,
      heartbeat: setInterval(() => response.write(': keep-alive\n\n'), 20_000)
    }
    stream.heartbeat.unref?.()
    this.streams.add(stream)
    response.on('close', () => this.closeStream(stream))
  }

  private async sendMessage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readJson(request)
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message || message.length > 100_000) throw new HttpError(400, 'Enter a message up to 100,000 characters.')

    const ref = await this.resolveSession(workspaceId, sessionId)
    const started = await this.options.supervisor.ensure({
      sessionKey: ref.file,
      cwd: ref.cwd,
      sessionFile: ref.file,
      customInstructions: this.options.customInstructions(ref.cwd)
    })
    if (!started.ok) throw new HttpError(503, started.error ?? 'Pi could not start for this conversation.')

    await this.options.supervisor.request(
      ref.file,
      'prompt',
      { message, streamingBehavior: 'steer' },
      900_000,
      { sourceAction: 'remote-send', uiSessionId: ref.file }
    )
    this.sendJson(response, 200, { ok: true })
  }
}

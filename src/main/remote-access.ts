import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  AgentMessage,
  PiEvent,
  RemoteAccessDevice,
  RemoteAccessStatus,
  RemoteSession,
  RemoteWorkspace
} from '@shared/types'
import { MAX_REMOTE_MESSAGE_CHARS } from '@shared/types'
import { listSessions, openSessionFile, readSessionConversation } from './sessions'
import type { SessionSupervisor } from './pi/supervisor'
import type { SettingsStore } from './settings'
import { properLockfile } from './proper-lockfile'

const PAIRING_TTL_MS = 3 * 60 * 1000
const MAX_DEVICES = 12
const PAIR_ATTEMPT_WINDOW_MS = 60_000
const MAX_PAIR_ATTEMPTS_PER_WINDOW = 8
const REMOTE_STATE_SYNC_MS = 1_000
export const MAX_PAIR_ATTEMPT_SOURCES = 256
export const MAX_REMOTE_EVENT_STREAMS = 24
const MAX_PAIR_BODY_BYTES = 64 * 1024
export const MAX_REMOTE_MESSAGE_BODY_BYTES = 1024 * 1024
const MAX_REMOTE_HTTP_CONNECTIONS = 64
const REMOTE_HEADERS_TIMEOUT_MS = 15_000
const REMOTE_REQUEST_TIMEOUT_MS = 120_000
const MAX_REMOTE_MESSAGES = 100
const MAX_REMOTE_STRING = 16_000
const MAX_REMOTE_VALUE_CHARS = 64_000
const MAX_REMOTE_VALUE_NODES = 2_000
const REMOTE_CONTENT_OMITTED = '[Content omitted on mobile]'

interface RemoteValueBudget {
  chars: number
  nodes: number
  exhausted: boolean
}

export function hasRemoteEventStreamCapacity(activeStreams: number): boolean {
  return activeStreams < MAX_REMOTE_EVENT_STREAMS
}

export function configureRemoteHttpServer(server: Server): void {
  server.maxConnections = MAX_REMOTE_HTTP_CONNECTIONS
  server.headersTimeout = REMOTE_HEADERS_TIMEOUT_MS
  server.requestTimeout = REMOTE_REQUEST_TIMEOUT_MS
}

export function recordPairAttempt(
  attempts: Map<string, { count: number; resetsAt: number }>,
  address: string,
  now = Date.now()
): boolean {
  for (const [source, record] of attempts) {
    if (record.resetsAt <= now) attempts.delete(source)
  }

  const current = attempts.get(address)
  if (current) {
    if (current.count >= MAX_PAIR_ATTEMPTS_PER_WINDOW) return false
    current.count += 1
    return true
  }

  while (attempts.size >= MAX_PAIR_ATTEMPT_SOURCES) {
    const oldest = attempts.keys().next().value
    if (oldest === undefined) break
    attempts.delete(oldest)
  }
  attempts.set(address, { count: 1, resetsAt: now + PAIR_ATTEMPT_WINDOW_MS })
  return true
}

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

export async function awaitRemoteDeviceAuthorization<T>(
  isAuthorized: () => boolean,
  action: () => Promise<T>
): Promise<T> {
  if (!isAuthorized()) throw new HttpError(401, 'This phone is no longer paired with Pi Desktop.')
  const result = await action()
  if (!isAuthorized()) throw new HttpError(401, 'This phone is no longer paired with Pi Desktop.')
  return result
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
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function localIpv4Addresses(): string[] {
  const addresses = Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === 'IPv4' && !entry.internal && isPrivateIpv4(entry.address))
    .map((entry) => entry.address)
  return [...new Set(addresses)]
}

export function isPrivateClient(address?: string): boolean {
  if (!address) return false
  if (address === '::1') return true
  if (address.startsWith('::ffff:')) return isPrivateIpv4(address.slice('::ffff:'.length))
  if (address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:')) return true
  return isPrivateIpv4(address)
}

export function safeRemoteValue(value: unknown, depth = 0): unknown {
  return sanitizeRemoteValue(value, depth, {
    chars: MAX_REMOTE_VALUE_CHARS,
    nodes: MAX_REMOTE_VALUE_NODES,
    exhausted: false
  })
}

function sanitizeRemoteValue(value: unknown, depth: number, budget: RemoteValueBudget): unknown {
  if (budget.exhausted) return REMOTE_CONTENT_OMITTED
  if (budget.nodes <= 0) {
    budget.exhausted = true
    return REMOTE_CONTENT_OMITTED
  }
  budget.nodes -= 1
  if (typeof value === 'string') {
    const maximum = Math.min(MAX_REMOTE_STRING, budget.chars)
    if (maximum <= 0) {
      budget.exhausted = true
      return REMOTE_CONTENT_OMITTED
    }
    const truncated = value.length > maximum
    const result = truncated
      ? `${value.slice(0, Math.max(0, maximum - 1))}…`
      : value
    budget.chars -= result.length
    if (budget.chars === 0) budget.exhausted = true
    return result
  }
  if (!value || typeof value !== 'object') return value
  if (depth > 12) return '[Nested content omitted on mobile]'
  if (budget.chars <= 0) {
    budget.exhausted = true
    return REMOTE_CONTENT_OMITTED
  }
  if (!Array.isArray(value)) {
    const media = value as { type?: unknown; data?: unknown; mimeType?: unknown }
    const isImage = media.type === 'image' || (
      typeof media.data === 'string' &&
      typeof media.mimeType === 'string' &&
      /^image\//i.test(media.mimeType)
    )
    if (isImage) return { type: 'text', text: '[Image omitted on mobile]' }
  }
  if (Array.isArray(value)) {
    const result: unknown[] = []
    const length = Math.min(value.length, 100)
    for (let index = 0; index < length; index += 1) {
      const item = sanitizeRemoteValue(value[index], depth + 1, budget)
      result.push(item)
      if (budget.exhausted) {
        if (item !== REMOTE_CONTENT_OMITTED) result.push(REMOTE_CONTENT_OMITTED)
        break
      }
    }
    return result
  }

  const result: Record<string, unknown> = {}
  const type = (value as { type?: unknown }).type
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    if (budget.exhausted || budget.nodes <= 0 || key.length > budget.chars) {
      budget.exhausted = true
      Object.defineProperty(result, REMOTE_CONTENT_OMITTED, {
        value: true,
        enumerable: true,
        configurable: true,
        writable: true
      })
      break
    }
    if (
      (type === 'thinking' && (key === 'thinking' || key === 'thinkingSignature')) ||
      (type === 'thinking_delta' && key === 'delta') ||
      (type === 'thinking_end' && key === 'content')
    ) continue
    if (['ownerId', 'sessionKey', 'sessionFile', 'cwd', 'path', 'filePath', 'absolutePath'].includes(key)) continue
    budget.chars -= key.length
    Object.defineProperty(result, key, {
      value: sanitizeRemoteValue((value as Record<string, unknown>)[key], depth + 1, budget),
      enumerable: true,
      configurable: true,
      writable: true
    })
    if (budget.exhausted) {
      Object.defineProperty(result, REMOTE_CONTENT_OMITTED, {
        value: true,
        enumerable: true,
        configurable: true,
        writable: true
      })
      break
    }
  }
  return result
}

export class RemoteAccessService {
  private readonly stateFile: string
  private enabled = false
  private devices: StoredDevice[] = []
  private server: Server | null = null
  private port: number | undefined
  private lifecycle: Promise<void> = Promise.resolve()
  private error: string | undefined
  private pairing: { secret: string; expiresAt: number } | undefined
  private readonly pairAttempts = new Map<string, { count: number; resetsAt: number }>()
  // Keep only references needed to authorize active streams, not every session a phone browses.
  private readonly sessionRefs = new Map<string, SessionRef>()
  private readonly streams = new Set<EventStream>()
  private stateSyncTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

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
        if (!await this.persistState((current) => ({ ...current, enabled: true }))) await this.stopServer()
        else this.newPairing()
      } catch (error) {
        this.enabled = false
        this.error = error instanceof Error ? error.message : String(error)
        await this.stopServer()
        await this.persistState((current) => ({ ...current, enabled: false }))
      }
    }
    this.scheduleStateSync()
    return this.status()
  }

  status(): RemoteAccessStatus {
    this.refreshStateFromDisk()
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
    return this.enqueueLifecycle(async () => {
      this.error = undefined
      if (!enabled) {
        this.enabled = false
        this.pairing = undefined
        await this.stopServer()
        await this.persistState((current) => ({ ...current, enabled: false }))
        return this.status()
      }
      if (this.enabled && this.server) return this.status()

      try {
        await this.startServer()
        this.enabled = true
        this.pairing = undefined
        if (!await this.persistState((current) => ({ ...current, enabled: true }))) await this.stopServer()
        else this.newPairing()
      } catch (error) {
        this.enabled = false
        this.error = error instanceof Error ? error.message : String(error)
        await this.stopServer()
        await this.persistState((current) => ({ ...current, enabled: false }))
      }
      return this.status()
    })
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

  async revokeDevice(id: string): Promise<RemoteAccessStatus> {
    if (!await this.persistState((current) => ({
      ...current,
      devices: current.devices.filter((device) => device.id !== id)
    }))) await this.stopServer()
    return this.status()
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.stateSyncTimer) clearTimeout(this.stateSyncTimer)
    this.stateSyncTimer = undefined
    await this.enqueueLifecycle(async () => {
      this.enabled = false
      await this.stopServer()
    })
  }

  private enqueueLifecycle<T>(action: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(action)
    this.lifecycle = result.then(() => undefined, () => undefined)
    return result
  }

  private readState(): void {
    try {
      const state = this.readPersistedState()
      this.enabled = state.enabled
      this.devices = state.devices
    } catch {
      this.enabled = false
      this.devices = []
      this.error = 'Saved remote access settings could not be read.'
    }
  }

  private readPersistedState(): PersistedRemoteState {
    if (!existsSync(this.stateFile)) return { enabled: false, devices: [] }
    const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<PersistedRemoteState>
    return {
      enabled: parsed.enabled === true,
      devices: Array.isArray(parsed.devices)
        ? parsed.devices.filter((device): device is StoredDevice =>
            typeof device?.id === 'string' &&
            typeof device.name === 'string' &&
            typeof device.pairedAt === 'number' &&
            typeof device.tokenHash === 'string'
          ).slice(0, MAX_DEVICES)
        : []
    }
  }

  private writeState(state: PersistedRemoteState): void {
    mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const tempFile = `${this.stateFile}.${randomUUID()}.tmp`
    try {
      writeFileSync(tempFile, JSON.stringify(state), { mode: 0o600 })
      renameSync(tempFile, this.stateFile)
    } catch (error) {
      try {
        unlinkSync(tempFile)
      } catch {
        /* the temporary file may not have been created */
      }
      throw error
    }
  }

  private async withStateLock<T>(action: () => T | Promise<T>): Promise<T> {
    mkdirSync(path.dirname(this.stateFile), { recursive: true })
    const release = await properLockfile.lock(this.stateFile, {
      realpath: false,
      retries: { retries: 5, minTimeout: 10, maxTimeout: 40, factor: 2 }
    })
    try {
      return await action()
    } finally {
      await release()
    }
  }

  private async persistState(
    update: (current: PersistedRemoteState) => PersistedRemoteState
  ): Promise<boolean> {
    try {
      await this.withStateLock(() => {
        const next = update(this.readPersistedState())
        this.writeState(next)
        this.enabled = next.enabled
        this.devices = next.devices
        if (!next.enabled) this.pairing = undefined
        this.closeUnauthorizedStreams(next)
      })
      return true
    } catch (error) {
      if (error instanceof HttpError) {
        this.refreshStateFromDisk()
        throw error
      }
      console.error('[pi-desktop] remote access state update failed:', error)
      this.enabled = false
      this.pairing = undefined
      this.devices = []
      this.error = 'Remote access settings could not be saved. Remote access was stopped.'
      for (const stream of [...this.streams]) this.closeStream(stream)

      try {
        await this.withStateLock(() => {
          mkdirSync(path.dirname(this.stateFile), { recursive: true })
          writeFileSync(this.stateFile, JSON.stringify({ enabled: false, devices: [] }), { mode: 0o600 })
        })
      } catch {
        try {
          unlinkSync(this.stateFile)
        } catch {
          if (existsSync(this.stateFile)) {
            this.error = 'Remote access is stopped for this session, but a saved phone pairing may return after restart.'
          }
        }
      }
      return false
    }
  }

  private closeUnauthorizedStreams(state: PersistedRemoteState): void {
    const deviceIds = new Set(state.devices.map((device) => device.id))
    for (const stream of [...this.streams]) {
      if (!state.enabled || !deviceIds.has(stream.deviceId)) this.closeStream(stream)
    }
  }

  private closeUnregisteredWorkspaceStreams(): void {
    for (const stream of [...this.streams]) {
      const ref = this.sessionRefs.get(stream.fileKey)
      if (
        !ref ||
        ref.workspaceId !== stream.workspaceId ||
        ref.sessionId !== stream.sessionId ||
        !this.isWorkspaceRegistered(ref.workspaceId, ref.cwd)
      ) this.closeStream(stream)
    }
  }

  private refreshStateFromDisk(): void {
    let state: PersistedRemoteState
    try {
      state = this.readPersistedState()
    } catch {
      state = { enabled: false, devices: [] }
      this.error = 'Saved remote access settings could not be read.'
    }

    this.devices = state.devices
    this.closeUnauthorizedStreams(state)
    if (!state.enabled) {
      this.enabled = false
      this.pairing = undefined
      if (this.server) void this.stopServer().catch(() => {})
      return
    }

    this.enabled = this.server !== null
    if (this.enabled) this.error = undefined
  }

  private scheduleStateSync(): void {
    if (this.disposed) return
    this.stateSyncTimer = setTimeout(() => {
      this.stateSyncTimer = undefined
      this.refreshStateFromDisk()
      this.closeUnregisteredWorkspaceStreams()
      this.scheduleStateSync()
    }, REMOTE_STATE_SYNC_MS)
    this.stateSyncTimer.unref?.()
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
    configureRemoteHttpServer(server)
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
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  }

  private readonly onRuntimeEvent = (payload: { ownerId: string; event: PiEvent }): void => {
    const fileKey = pathKey(payload.ownerId)
    const matchingStreams = [...this.streams].filter((stream) => stream.fileKey === fileKey)
    if (!matchingStreams.length) return

    // A different app instance may revoke a phone or remove its workspace.
    // Recheck persisted authorization before each push so an open SSE stream
    // cannot keep receiving events between the periodic state-sync ticks.
    this.refreshStateFromDisk()
    const ref = this.sessionRefs.get(fileKey)
    const activeStreams = matchingStreams.filter((stream) => this.streams.has(stream))
    if (!activeStreams.length || !this.enabled || !this.server) return

    if (!ref || !this.isWorkspaceRegistered(ref.workspaceId, ref.cwd)) {
      for (const stream of activeStreams) this.closeStream(stream)
      return
    }

    const authorizedStreams = activeStreams.filter((stream) => {
      if (stream.workspaceId === ref.workspaceId && stream.sessionId === ref.sessionId) return true
      this.closeStream(stream)
      return false
    })
    if (!authorizedStreams.length) return

    let event = payload.event
    if (event.type === 'extension_ui_request') {
      if (!['select', 'confirm', 'input', 'editor'].includes(String(event.method))) return
      event = { type: 'remote_waiting_for_desktop' }
    }
    const data = JSON.stringify(safeRemoteValue(event))
    for (const stream of authorizedStreams) {
      if (!this.streams.has(stream)) continue
      if (!stream.response.write(`event: pi\ndata: ${data}\n\n`)) this.closeStream(stream)
    }
  }

  private closeStream(stream: EventStream): void {
    if (!this.streams.delete(stream)) return
    clearInterval(stream.heartbeat)
    if (![...this.streams].some((active) => active.fileKey === stream.fileKey)) {
      this.sessionRefs.delete(stream.fileKey)
    }
    stream.response.end()
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setSecurityHeaders(response)
    this.refreshStateFromDisk()
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
      const workspaces: RemoteWorkspace[] = this.registeredWorkspaces().map(
        ({ id, name, icon, iconColor }) => ({ id, name, icon, iconColor })
      )
      this.requireActiveDevice(device.id)
      this.sendJson(response, 200, { workspaces })
      return
    }

    const workspaceSessions = /^\/api\/workspaces\/([^/]+)\/sessions$/.exec(url.pathname)
    if (request.method === 'GET' && workspaceSessions) {
      const workspaceId = decodeURIComponent(workspaceSessions[1])
      const workspace = this.getWorkspace(workspaceId)
      const listed = await this.awaitWorkspaceAction(device.id, workspace, () => listSessions(workspace.path))
      const sessions = listed.map((session): RemoteSession => {
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
      this.requireActiveDevice(device.id)
      this.requireActiveWorkspace(workspace.id, workspace.path)
      this.sendJson(response, 200, { sessions })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/session') {
      const workspaceId = url.searchParams.get('workspaceId') ?? ''
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const workspace = this.getWorkspace(workspaceId)
      const ref = await this.awaitWorkspaceAction(device.id, workspace, () => this.resolveSession(workspaceId, sessionId))
      const opened = await openSessionFile(ref.file)
      if (!opened) throw new HttpError(404, 'Conversation not found in this project.')
      let messages: AgentMessage[]
      let historyTruncated = false
      try {
        this.requireActiveSession(device.id, ref)
        const conversation = await this.awaitSessionAction(device.id, ref, () =>
          readSessionConversation(opened.target, opened.handle)
        )
        messages = conversation.messages
        historyTruncated = conversation.historyTruncated
      } finally {
        await opened.handle.close().catch(() => {})
      }
      this.requireActiveSession(device.id, ref)
      const recentMessages = messages.slice(-MAX_REMOTE_MESSAGES)
      const sanitizedNewestFirst = safeRemoteValue([...recentMessages].reverse()) as unknown[]
      const safeMessages = sanitizedNewestFirst
        .filter((message): message is AgentMessage =>
          Boolean(message && typeof message === 'object' && !Array.isArray(message))
        )
        .reverse()
      const truncated =
        historyTruncated ||
        messages.length > MAX_REMOTE_MESSAGES ||
        safeMessages.length < recentMessages.length
      this.requireActiveSession(device.id, ref)
      this.sendJson(response, 200, {
        messages: safeMessages,
        truncated,
        isRunning: this.isSessionRunning(ref.file)
      })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/events') {
      const workspaceId = url.searchParams.get('workspaceId') ?? ''
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const workspace = this.getWorkspace(workspaceId)
      const ref = await this.awaitWorkspaceAction(device.id, workspace, () => this.resolveSession(workspaceId, sessionId))
      this.requireActiveSession(device.id, ref)
      this.openEventStream(device.id, ref, response)
      return
    }

    if (request.method === 'POST' && url.pathname === '/api/message') {
      this.requireSameOrigin(request)
      await this.sendMessage(request, response, device.id)
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

  private requireActiveDevice(deviceId: string): void {
    if (!this.isDeviceAuthorized(deviceId)) {
      throw new HttpError(401, 'This phone is no longer paired with Pi Desktop.')
    }
  }

  private requireActiveWorkspace(workspaceId: string, cwd: string): void {
    if (!this.isWorkspaceRegistered(workspaceId, cwd)) {
      throw new HttpError(404, 'This project is no longer registered.')
    }
  }

  private isWorkspaceRegistered(workspaceId: string, cwd: string): boolean {
    return this.registeredWorkspaces().some(
      (workspace) => workspace.id === workspaceId && pathKey(workspace.path) === pathKey(cwd)
    )
  }

  private registeredWorkspaces(): ReturnType<SettingsStore['get']>['workspaces'] {
    const settings = this.options.settings as SettingsStore & {
      getRegisteredWorkspaces?: () => ReturnType<SettingsStore['get']>['workspaces']
    }
    return settings.getRegisteredWorkspaces?.() ?? settings.get().workspaces
  }

  private requireActiveSession(deviceId: string, ref: SessionRef): void {
    this.requireActiveDevice(deviceId)
    this.requireActiveWorkspace(ref.workspaceId, ref.cwd)
  }

  private async awaitWorkspaceAction<T>(
    deviceId: string,
    workspace: { id: string; path: string },
    action: () => Promise<T>
  ): Promise<T> {
    this.requireActiveDevice(deviceId)
    this.requireActiveWorkspace(workspace.id, workspace.path)
    const result = await action()
    this.requireActiveDevice(deviceId)
    this.requireActiveWorkspace(workspace.id, workspace.path)
    return result
  }

  private awaitSessionAction<T>(
    deviceId: string,
    ref: SessionRef,
    action: () => Promise<T>
  ): Promise<T> {
    return this.awaitWorkspaceAction(deviceId, { id: ref.workspaceId, path: ref.cwd }, action)
  }

  private isDeviceAuthorized(deviceId: string): boolean {
    this.refreshStateFromDisk()
    return this.enabled && this.server !== null && this.devices.some((device) => device.id === deviceId)
  }

  private awaitDeviceAction<T>(deviceId: string, action: () => Promise<T>): Promise<T> {
    return awaitRemoteDeviceAuthorization(
      () => this.isDeviceAuthorized(deviceId),
      action
    )
  }

  private async pairDevice(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = request.socket.remoteAddress ?? 'unknown'
    const now = Date.now()
    if (!recordPairAttempt(this.pairAttempts, address, now)) {
      throw new HttpError(429, 'Too many pairing attempts. Try again in a minute.')
    }

    const body = await this.readJson(request)
    this.refreshStateFromDisk()
    if (!this.enabled || !this.server) throw new HttpError(503, 'Remote access is turned off.')
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
    // Consume the in-memory one-time code before the first await so concurrent
    // requests cannot both validate it while the device registry is written.
    this.pairing = undefined
    const accessToken = randomBytes(32).toString('base64url')
    const id = randomUUID()
    const rawName = typeof body.deviceName === 'string' ? body.deviceName : ''
    const name = rawName.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 40) || 'Mobile device'
    const device: StoredDevice = { id, name, pairedAt: now, tokenHash: sha256(accessToken) }
    if (!await this.persistState((current) => {
      if (!current.enabled) throw new HttpError(503, 'Remote access is turned off.')
      if (current.devices.length >= MAX_DEVICES) {
        throw new HttpError(409, 'Remove a paired phone before adding another.')
      }
      return { ...current, devices: [...current.devices, device] }
    })) {
      void this.stopServer().catch(() => {})
      throw new HttpError(503, 'Remote access settings could not be saved.')
    }
    this.pairAttempts.delete(address)
    this.sendJson(response, 200, {
      accessToken,
      device: { id: device.id, name: device.name, pairedAt: device.pairedAt }
    })
  }

  private async readJson(
    request: IncomingMessage,
    maxBytes = MAX_PAIR_BODY_BYTES
  ): Promise<Record<string, unknown>> {
    const declaredLength = Number(request.headers['content-length'] ?? 0)
    if (declaredLength > maxBytes) throw new HttpError(413, 'Request body is too large.')
    const chunks: Buffer[] = []
    let length = 0
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += bytes.length
      if (length > maxBytes) throw new HttpError(413, 'Request body is too large.')
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
    const workspace = this.registeredWorkspaces().find((item) => item.id === id)
    if (!workspace) throw new HttpError(404, 'Project not found.')
    return workspace
  }

  private async resolveSession(workspaceId: string, sessionId: string): Promise<SessionRef> {
    if (!sessionId) throw new HttpError(400, 'Conversation id is required.')
    const workspace = this.getWorkspace(workspaceId)
    const session = (await listSessions(workspace.path)).find((item) => item.id === sessionId)
    if (!session) throw new HttpError(404, 'Conversation not found in this project.')
    return { workspaceId: workspace.id, sessionId: session.id, cwd: workspace.path, file: session.file }
  }

  private isSessionRunning(file: string): boolean {
    return this.options.supervisor.sessionInfo(file)?.running ?? false
  }

  private openEventStream(
    deviceId: string,
    ref: SessionRef,
    response: ServerResponse
  ): void {
    if (!hasRemoteEventStreamCapacity(this.streams.size)) {
      throw new HttpError(429, 'Too many live conversation connections.')
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Connection': 'keep-alive',
      'Cache-Control': 'no-cache, no-transform'
    })
    response.write('retry: 2000\n\n')
    let stream: EventStream | undefined
    const heartbeat = setInterval(() => {
      if (!response.write(': keep-alive\n\n') && stream) this.closeStream(stream)
    }, 20_000)
    stream = {
      deviceId,
      workspaceId: ref.workspaceId,
      sessionId: ref.sessionId,
      fileKey: pathKey(ref.file),
      response,
      heartbeat
    }
    stream.heartbeat.unref?.()
    this.streams.add(stream)
    this.sessionRefs.set(stream.fileKey, ref)
    response.on('close', () => this.closeStream(stream))
  }

  private async sendMessage(
    request: IncomingMessage,
    response: ServerResponse,
    deviceId: string
  ): Promise<void> {
    const body = await this.awaitDeviceAction(deviceId, () =>
      this.readJson(request, MAX_REMOTE_MESSAGE_BODY_BYTES)
    )
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message || message.length > MAX_REMOTE_MESSAGE_CHARS) {
      throw new HttpError(400, `Enter a message up to ${MAX_REMOTE_MESSAGE_CHARS.toLocaleString()} characters.`)
    }

    const workspace = this.getWorkspace(workspaceId)
    const ref = await this.awaitWorkspaceAction(deviceId, workspace, () => this.resolveSession(workspaceId, sessionId))
    const started = await this.awaitSessionAction(
      deviceId,
      ref,
      () => this.options.supervisor.ensure({
        sessionKey: ref.file,
        cwd: ref.cwd,
        sessionFile: ref.file,
        customInstructions: this.options.customInstructions(ref.cwd)
      })
    )
    if (!started.ok) throw new HttpError(503, started.error ?? 'Pi could not start for this conversation.')

    await this.awaitSessionAction(
      deviceId,
      ref,
      () => this.options.supervisor.request(
        ref.file,
        'prompt',
        { message, streamingBehavior: 'steer' },
        900_000,
        { sourceAction: 'remote-send', uiSessionId: ref.file },
        () => this.requireActiveSession(deviceId, ref)
      )
    )
    this.sendJson(response, 200, { ok: true })
  }
}

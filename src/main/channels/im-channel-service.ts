import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  FeishuChannelConfig,
  ImChannelConfig,
  ImChannelStatus,
  ImChannelTestResult,
  WechatChannelConfig
} from '@shared/types'
import type { SessionSupervisor } from '../pi/supervisor'
import type { SettingsStore } from '../settings'
import { properLockfile } from '../proper-lockfile'

const MAX_CHANNELS = 4
const MAX_CHANNEL_FILE_BYTES = 16 * 1024
/** Keep pushes and confirmations readable on a phone: same cap as a remote run preview. */
export const MAX_IM_MESSAGE_CHARS = 4_000

/**
 * One running IM transport (Feishu long connection, WeChat bridge listener).
 *
 * `send` replies through the channel's own active target: the Feishu chat_id
 * of the last inbound message (or the first allowed chat), the WeChat
 * `sendTo` config or the last sender. The service never needs the target.
 */
export interface ChannelAdapter {
  start(): Promise<void>
  stop(): Promise<void>
  send(text: string): Promise<void>
  /** Transport-level connectivity probe for the settings page's test button. */
  test(): Promise<{ ok: boolean; error?: string }>
  /** Update credentials in place after a save; returns false when restart is required. */
  reconfigure?(config: ImChannelConfig): boolean
  state(): { state: 'connecting' | 'connected' | 'error' | 'disabled'; error?: string }
}

export type ImChannelRouter = (channelId: string, text: string) => Promise<void>

/** The seams a transport adapter uses: inbound routing and state reporting. */
export interface ChannelAdapterContext {
  /** Hand one inbound IM message to the conversation router. */
  router: ImChannelRouter
  /** Publish connection-state changes for the settings page. */
  onState: (state: ChannelRuntime['state'], error?: string) => void
  /** WeChat only: publish the latest bridge health probe. */
  onBridgeHealth?: (healthy: boolean | null) => void
}

interface ChannelRuntime {
  adapter: ChannelAdapter
  state: 'connecting' | 'connected' | 'error' | 'disabled'
  error?: string
  lastMessageAt?: number
  bridgeHealthy?: boolean | null
  startTask?: Promise<void>
}

interface PersistedChannelState {
  channels: StoredChannel[]
}

type StoredChannel = ImChannelConfig

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : undefined
}

function stringArray(value: unknown, max: number, itemMax: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const raw of value.slice(0, max)) {
    const item = boundedString(raw, itemMax)
    if (item === undefined) return undefined
    items.push(item)
  }
  return items
}

function parsePort(value: unknown): number | undefined {
  const port = typeof value === 'number' ? Math.round(value) : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined
  return port
}

/**
 * The IM-channel registry: persistence, validation and connection lifecycle
 * for Feishu and WeChat channels. Transport specifics live in `feishu.ts` and
 * `wechat.ts`; the conversation routing lives in `routeInbound`.
 */
export class ImChannelService extends EventEmitter {
  private readonly stateFile: string
  private channels: StoredChannel[] = []
  private readonly runtimes = new Map<string, ChannelRuntime>()
  private disposed = false

  constructor(
    private readonly options: {
      userData: string
      settings: SettingsStore
      supervisor: SessionSupervisor
      customInstructions: (cwd: string) => string | undefined
      /** Build the transport adapter for one channel. */
      createAdapter: (channel: ImChannelConfig, context: ChannelAdapterContext) => ChannelAdapter
    }
  ) {
    super()
    this.stateFile = path.join(options.userData, 'im-channels.json')
  }

  async initialize(): Promise<void> {
    if (this.disposed) return
    this.loadState()
    // CHANNELS-TODO: register supervisor event listeners (event/rekey/ui-responded)
    // and start an adapter for every enabled channel.
  }

  async dispose(): Promise<void> {
    this.disposed = true
    // CHANNELS-TODO: detach supervisor listeners and stop every adapter.
    for (const id of [...this.runtimes.keys()]) {
      await this.remove(id).catch(() => {})
    }
  }

  status(): ImChannelStatus[] {
    return this.channels.map((channel) => {
      const runtime = this.runtimes.get(channel.id)
      return this.maskChannel(channel, runtime)
    })
  }

  async save(config: unknown): Promise<ImChannelStatus[]> {
    const parsed = this.validateConfig(config, this.channels)
    if (!parsed.ok) throw new Error(parsed.error)
    await this.withStateLock(() => {
      const stored = this.readPersistedState()
      const next = this.mergeSecrets(parsed.channel, stored.channels)
      this.channels = next
      this.writeState({ channels: next })
    })
    await this.reconcileChannel(parsed.channel.id)
    this.emit('changed', this.status())
    return this.status()
  }

  async remove(id: string): Promise<ImChannelStatus[]> {
    await this.withStateLock(() => {
      const stored = this.readPersistedState()
      const next = stored.channels.filter((channel) => channel.id !== id)
      this.channels = next
      this.writeState({ channels: next })
    })
    const runtime = this.runtimes.get(id)
    this.runtimes.delete(id)
    if (runtime) await runtime.adapter.stop().catch(() => {})
    this.emit('changed', this.status())
    return this.status()
  }

  async test(id: string): Promise<ImChannelTestResult> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return { ok: false, error: 'This channel is not running.' }
    return runtime.adapter.test()
  }

  /** An empty secret on update means "keep the stored one". */
  private mergeSecrets(channel: ImChannelConfig, existing: StoredChannel[]): StoredChannel[] {
    const previous = existing.find((item) => item.id === channel.id)
    const next = previous
      ? existing.map((item) => (item.id === channel.id ? channel : item))
      : [...existing, channel]
    return next.slice(-MAX_CHANNELS)
  }

  private validateConfig(
    config: unknown,
    existing: StoredChannel[]
  ): { ok: true; channel: StoredChannel } | { ok: false; error: string } {
    if (!isPlainObject(config)) return { ok: false, error: 'A channel config object is required.' }
    const kind = config.kind
    if (kind !== 'feishu' && kind !== 'wechat') return { ok: false, error: 'Only feishu and wechat channels are supported.' }
    const previous = typeof config.id === 'string' ? existing.find((item) => item.id === config.id) : undefined
    const id = previous?.id ?? randomUUID()

    const bindingRaw = config.binding
    if (!isPlainObject(bindingRaw)) return { ok: false, error: 'Pick the project and conversation this channel drives.' }
    const workspaceId = boundedString(bindingRaw.workspaceId, 200)
    const sessionId = boundedString(bindingRaw.sessionId, 200)
    if (!workspaceId) return { ok: false, error: 'Pick the project this channel drives.' }
    if (!sessionId) return { ok: false, error: 'Pick the conversation this channel drives.' }
    const workspace = this.registeredWorkspaces().find((item) => item.id === workspaceId)
    if (!workspace) return { ok: false, error: 'That project is no longer registered.' }

    const enabled = config.enabled === true
    const base = { id, kind, enabled, binding: { workspaceId, sessionId } } as StoredChannel

    if (kind === 'feishu') {
      const raw = config.feishu
      if (!isPlainObject(raw)) return { ok: false, error: 'Feishu app credentials are required.' }
      const appId = boundedString(raw.appId, 120)
      if (!appId) return { ok: false, error: 'Fill in the Feishu App ID.' }
      const secret = boundedString(raw.appSecret, 400)
      if (!secret && !(previous?.feishu?.appSecret)) return { ok: false, error: 'Fill in the Feishu App Secret.' }
      const allowedChatIds = stringArray(raw.allowedChatIds, 32, 120) ?? []
      const feishu: FeishuChannelConfig = {
        appId,
        appSecret: secret ?? previous?.feishu?.appSecret ?? '',
        allowedChatIds
      }
      return { ok: true, channel: { ...base, feishu } }
    }

    const raw = config.wechat
    if (!isPlainObject(raw)) return { ok: false, error: 'WeChat bridge settings are required.' }
    const bridgeUrl = boundedString(raw.bridgeUrl, 300)
    if (!bridgeUrl || !/^https?:\/\//i.test(bridgeUrl)) return { ok: false, error: 'The bridge URL must start with http:// or https://.' }
    const listenPort = parsePort(raw.listenPort)
    if (!listenPort) return { ok: false, error: 'The listen port must be a number between 1 and 65535.' }
    const bridgeToken = boundedString(raw.bridgeToken, 400)
    if (!bridgeToken && !(previous?.wechat?.bridgeToken)) return { ok: false, error: "Fill in the bridge's personal token." }
    const receiveToken = boundedString(raw.receiveToken, 400) ?? previous?.wechat?.receiveToken ?? randomBytes(24).toString('base64url')
    const sendTo = boundedString(raw.sendTo, 120) ?? ''
    const wechat: WechatChannelConfig = {
      bridgeUrl,
      bridgeToken: bridgeToken ?? previous?.wechat?.bridgeToken ?? '',
      listenPort,
      receiveToken,
      sendTo,
      sendToIsRoom: raw.sendToIsRoom === true
    }
    return { ok: true, channel: { ...base, wechat } }
  }

  private registeredWorkspaces(): ReturnType<SettingsStore['get']>['workspaces'] {
    const settings = this.options.settings as SettingsStore & {
      getRegisteredWorkspaces?: () => ReturnType<SettingsStore['get']>['workspaces']
    }
    return settings.getRegisteredWorkspaces?.() ?? settings.get().workspaces
  }

  /** Stop or (re)start one channel's adapter so it matches the saved config. */
  private async reconcileChannel(id: string): Promise<void> {
    const channel = this.channels.find((item) => item.id === id)
    const runtime = this.runtimes.get(id)
    if (!channel || !channel.enabled) {
      if (!runtime) return
      this.runtimes.delete(id)
      await runtime.adapter.stop().catch(() => {})
      return
    }
    // CHANNELS-TODO: start (or reconfigure) the adapter for the enabled
    // channel. A failed start must surface in `state` as 'error' with the
    // message, never throw.
  }

  private maskChannel(channel: StoredChannel, runtime?: ChannelRuntime): ImChannelStatus {
    const binding = { ...channel.binding }
    const state = runtime?.state ?? (channel.enabled ? 'connecting' : 'disabled')
    const status: ImChannelStatus = {
      id: channel.id,
      kind: channel.kind,
      enabled: channel.enabled,
      state,
      error: runtime?.error,
      binding,
      lastMessageAt: runtime?.lastMessageAt
    }
    if (channel.feishu) {
      status.feishu = {
        appId: channel.feishu.appId,
        appSecretSet: channel.feishu.appSecret.length > 0,
        allowedChatIds: channel.feishu.allowedChatIds
      }
    }
    if (channel.wechat) {
      status.wechat = {
        bridgeUrl: channel.wechat.bridgeUrl,
        listenPort: channel.wechat.listenPort,
        receiveTokenSet: channel.wechat.receiveToken.length > 0,
        callbackUrl: this.wechatCallbackUrl(channel),
        sendTo: channel.wechat.sendTo,
        sendToIsRoom: channel.wechat.sendToIsRoom,
        bridgeHealthy: runtime?.bridgeHealthy ?? null
      }
    }
    return status
  }

  /**
   * The URL the bridge POSTs received messages to, including the receive
   * token. The settings page shows it so the reader can paste it into the
   * bridge's `RECVD_MSG_API` environment variable.
   */
  private wechatCallbackUrl(channel: StoredChannel): string {
    const wechat = channel.wechat
    if (!wechat) return ''
    const host = '127.0.0.1'
    return `http://${host}:${wechat.listenPort}/api/im/wechat?token=${encodeURIComponent(wechat.receiveToken)}`
  }

  private loadState(): void {
    try {
      this.channels = this.readPersistedState().channels
    } catch (error) {
      this.channels = []
      console.error('[pi-desktop] im channel settings could not be read:', error)
    }
  }

  private readPersistedState(): PersistedChannelState {
    if (!existsSync(this.stateFile)) return { channels: [] }
    const stats = statSync(this.stateFile)
    if (!stats.isFile()) throw new Error('IM channel settings are not a file.')
    if (stats.size > MAX_CHANNEL_FILE_BYTES) throw new Error('IM channel settings exceed the size limit.')
    const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<PersistedChannelState>
    const channels = Array.isArray(parsed.channels) ? parsed.channels : []
    const validated: StoredChannel[] = []
    for (const raw of channels.slice(0, MAX_CHANNELS)) {
      const result = this.validateConfig(raw, validated)
      if (result.ok) validated.push(result.channel)
    }
    return { channels: validated }
  }

  private writeState(state: PersistedChannelState): void {
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

  // CHANNELS-TODO: routeInbound(channelId, text) plus the supervisor event
  // wiring described in the design brief: command parsing (/help /status
  // /stop /new), prompt dispatch through the bound conversation, run-settle
  // pushes and needs-input notices. The helpers below are the seams the
  // adapter files implement.

  /** True while this service owns a live adapter for that channel id. */
  hasRuntime(id: string): boolean {
    return this.runtimes.has(id)
  }

  storedChannels(): readonly StoredChannel[] {
    return this.channels
  }
}

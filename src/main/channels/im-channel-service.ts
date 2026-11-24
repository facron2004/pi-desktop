import { EventEmitter } from 'node:events'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  FeishuChannelConfig,
  ImChannelConfig,
  ImChannelStatus,
  ImChannelTestResult,
  PiEvent,
  RuntimeRekey,
  WechatChannelConfig
} from '@shared/types'
import type { SessionSupervisor } from '../pi/supervisor'
import type { SettingsStore } from '../settings'
import { describeRunCompletion } from '../desktop-notification'
import { listSessions } from '../sessions'
import { properLockfile } from '../proper-lockfile'

const MAX_CHANNELS = 4
const MAX_CHANNEL_FILE_BYTES = 16 * 1024
/** Keep pushes and confirmations readable on a phone: same cap as a remote run preview. */
export const MAX_IM_MESSAGE_CHARS = 4_000
const MAX_INBOUND_CHARS = 8_000
/** A reply that names the project and conversation needs both to be readable on a phone. */
const NAME_LIMIT = 60
/** How long `/new` waits for Pi to write the JSONL of the draft it started. */
const REKEY_WAIT_MS = 15_000

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
  private readonly channelOps = new Map<string, Promise<void>>()
  private readonly boundFileCache = new Map<string, { workspaceId: string; sessionId: string; fileKey: string }>()
  private readonly pendingNewConversation = new Set<string>()
  private readonly activeRekeys = new Set<() => void>()
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
    this.options.supervisor.on('event', this.onRuntimeEvent)
    this.options.supervisor.on('rekey', this.onRuntimeRekey)
    for (const channel of this.channels) {
      if (channel.enabled) await this.reconcileChannel(channel.id)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.stopAll()
      return
    }
    this.disposed = true
    this.options.supervisor.off('event', this.onRuntimeEvent)
    this.options.supervisor.off('rekey', this.onRuntimeRekey)
    for (const cancel of [...this.activeRekeys]) cancel()
    this.activeRekeys.clear()
    this.pendingNewConversation.clear()
    this.boundFileCache.clear()
    this.runCompletions.clear()
    await Promise.allSettled([...this.channelOps.values()])
    await this.stopAll()
  }

  private async stopAll(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) {
      const runtime = this.runtimes.get(id)
      this.runtimes.delete(id)
      if (runtime) await runtime.adapter.stop().catch(() => {})
    }
  }

  private enqueueChannelOp(id: string, task: () => Promise<void>): Promise<void> {
    const previous = this.channelOps.get(id) ?? Promise.resolve()
    const next = previous.then(task, task)
    const tracked = next.finally(() => {
      if (this.channelOps.get(id) === tracked) this.channelOps.delete(id)
    })
    this.channelOps.set(id, tracked)
    return next
  }

  status(): ImChannelStatus[] {
    return this.channels.map((channel) => {
      const runtime = this.runtimes.get(channel.id)
      return this.maskChannel(channel, runtime)
    })
  }

  async save(config: unknown): Promise<ImChannelStatus[]> {
    let savedId = ''
    let evictedIds: string[] = []
    await this.withStateLock(() => {
      const stored = this.readPersistedState()
      const parsed = this.validateConfig(config, stored.channels, { requireRegisteredWorkspace: true })
      if (!parsed.ok) throw new Error(parsed.error)
      savedId = parsed.channel.id
      const next = this.mergeSecrets(parsed.channel, stored.channels)
      const keptIds = new Set(next.map((item) => item.id))
      evictedIds = [...new Set([
        ...stored.channels.map((item) => item.id),
        ...this.runtimes.keys()
      ])].filter((id) => !keptIds.has(id))
      this.channels = next
      this.writeState({ channels: next })
    })
    this.boundFileCache.delete(savedId)
    this.pendingNewConversation.delete(savedId)
    for (const evictedId of evictedIds) {
      this.boundFileCache.delete(evictedId)
      this.pendingNewConversation.delete(evictedId)
      await this.reconcileChannel(evictedId)
    }
    await this.reconcileChannel(savedId)
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
    this.boundFileCache.delete(id)
    this.pendingNewConversation.delete(id)
    await this.reconcileChannel(id)
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
    if (!previous && existing.length >= MAX_CHANNELS) {
      // Refuse the add rather than evicting the oldest binding: silently dropping
      // a channel deletes its tokens and takes its bot offline, and nothing in
      // the UI would say why the row vanished.
      throw new Error(`At most ${MAX_CHANNELS} channels can be bound. Remove one before adding another.`)
    }
    return previous
      ? existing.map((item) => (item.id === channel.id ? channel : item))
      : [...existing, channel]
  }

  private validateConfig(
    config: unknown,
    existing: StoredChannel[],
    options: { requireRegisteredWorkspace?: boolean } = {}
  ): { ok: true; channel: StoredChannel } | { ok: false; error: string } {
    if (!isPlainObject(config)) return { ok: false, error: 'A channel config object is required.' }
    const kind = config.kind
    if (kind !== 'feishu' && kind !== 'wechat') return { ok: false, error: 'Only feishu and wechat channels are supported.' }
    // A caller may supply a stable id (settings form round-trips one); only
    // mint a new id for a create with no usable id at all.
    const supplied = isPlainObject(config) && typeof config.id === 'string' && config.id.trim()
      ? config.id.trim().slice(0, 120)
      : undefined
    const previous = (supplied ?? (typeof config.id === 'string' ? config.id : undefined))
      ? existing.find((item) => item.id === (supplied ?? config.id))
      : undefined
    const id = previous?.id ?? supplied ?? randomUUID()

    const bindingRaw = config.binding
    if (!isPlainObject(bindingRaw)) return { ok: false, error: 'Pick the project and conversation this channel drives.' }
    const workspaceId = boundedString(bindingRaw.workspaceId, 200)
    const sessionId = boundedString(bindingRaw.sessionId, 200)
    if (!workspaceId) return { ok: false, error: 'Pick the project this channel drives.' }
    if (!sessionId) return { ok: false, error: 'Pick the conversation this channel drives.' }
    if (options.requireRegisteredWorkspace !== false) {
      const workspace = this.registeredWorkspaces().find((item) => item.id === workspaceId)
      if (!workspace) return { ok: false, error: 'That project is no longer registered.' }
    }

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
    await this.enqueueChannelOp(id, async () => {
      const channel = this.channels.find((item) => item.id === id)
      const runtime = this.runtimes.get(id)
      if (this.disposed || !channel || !channel.enabled) {
        if (!runtime) return
        this.runtimes.delete(id)
        await runtime.adapter.stop().catch(() => {})
        return
      }
      if (runtime?.adapter.reconfigure?.(channel)) {
        this.emit('changed', this.status())
        return
      }
      if (runtime) {
        this.runtimes.delete(id)
        await runtime.adapter.stop().catch(() => {})
        if (this.disposed) return
      }
      const next: ChannelRuntime = { adapter: null as never, state: 'connecting' }
      try {
        next.adapter = this.options.createAdapter(channel, {
          router: (targetId, text) => this.routeInbound(targetId, text),
          onState: (state, error) => {
            const entry = this.runtimes.get(id)
            if (!entry || entry !== next || this.disposed) return
            entry.state = state
            entry.error = error
            if (!this.disposed) this.emit('changed', this.status())
          },
          onBridgeHealth: (healthy) => {
            const entry = this.runtimes.get(id)
            if (!entry || entry !== next || this.disposed) return
            entry.bridgeHealthy = healthy
            if (!this.disposed) this.emit('changed', this.status())
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.runtimes.set(id, { adapter: { async stop() {}, async send() {}, async test() { return { ok: false, error: message } }, async start() {}, state: () => ({ state: 'error' }) }, state: 'error', error: message })
        this.emit('changed', this.status())
        return
      }
      this.runtimes.set(id, next)
      // A failed start is a state, not an exception: the settings page reads it.
      next.startTask = next.adapter.start()
        .then(() => {
          if (this.runtimes.get(id) === next) next.state = 'connected'
        })
        .catch((error: unknown) => {
          if (this.runtimes.get(id) !== next) return
          next.state = 'error'
          next.error = error instanceof Error ? error.message : String(error)
          void next.adapter.stop().catch(() => {})
        })
        .finally(() => {
          if (!this.disposed && this.runtimes.get(id) === next) this.emit('changed', this.status())
        })
      this.emit('changed', this.status())
    })
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
      const result = this.validateConfig(raw, validated, { requireRegisteredWorkspace: false })
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

  /* ---------------------------------------------------------------- *
   * Routing
   * ---------------------------------------------------------------- */

  /** Normalized session-file identity, matching remote-access keying. */
  private pathKey(file: string): string {
    const resolved = path.resolve(file)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }

  private channelById(id: string): StoredChannel | undefined {
    return this.channels.find((item) => item.id === id)
  }

  private async reply(channelId: string, text: string): Promise<void> {
    const runtime = this.runtimes.get(channelId)
    if (!runtime) return
    await runtime.adapter.send(text.slice(0, MAX_IM_MESSAGE_CHARS))
  }

  /**
   * One inbound IM message: a command, or a prompt for the bound
   * conversation. Every failure path answers through the channel instead of
   * throwing — the sender must learn what happened to their message.
   */
  private async routeInbound(channelId: string, text: string): Promise<void> {
    if (this.disposed) return
    const channel = this.channelById(channelId)
    if (!channel || !channel.enabled) return
    const runtime = this.runtimes.get(channelId)
    if (runtime) runtime.lastMessageAt = Date.now()

    const message = text.trim()
    if (!message) return
    if (message.length > MAX_INBOUND_CHARS) {
      await this.reply(channelId, `消息过长（上限 ${MAX_INBOUND_CHARS.toLocaleString()} 字），请拆开发送。`)
      return
    }

    const command = /^\/(help|status|stop)$/i.exec(message)
    if (command) {
      const verb = command[1].toLowerCase()
      if (verb === 'help') {
        await this.reply(channelId, '可用命令：/status 查看绑定对话、/stop 停止当前运行、/new [消息] 开始新对话。其他文字会作为指令发送给 Pi。')
        return
      }
      if (verb === 'status') {
        await this.replyStatus(channelId, channel)
        return
      }
      const file = await this.resolveBoundFile(channel)
      if (!file) return // resolveBoundFile already explained the failure
      await this.options.supervisor.stop(file)
      await this.reply(channelId, '已停止当前运行。')
      return
    }

    const newMatch = /^\/new(?:\s+([\s\S]+))?$/i.exec(message)
    if (newMatch) {
      const promptText = (newMatch[1] ?? '').trim()
      if (!promptText) {
        this.pendingNewConversation.add(channelId)
        await this.reply(channelId, '已准备新对话，请发送第一条消息（或直接用 /new 消息内容）。')
        return
      }
      this.pendingNewConversation.delete(channelId)
      await this.startNewConversation(channelId, channel, promptText)
      return
    }

    if (this.pendingNewConversation.delete(channelId)) {
      await this.startNewConversation(channelId, channel, message)
      return
    }

    await this.dispatchPrompt(channelId, channel, message)
  }

  private async boundWorkspace(channel: StoredChannel): Promise<{ id: string; path: string; name: string } | null> {
    const workspace = this.registeredWorkspaces().find((item) => item.id === channel.binding.workspaceId)
    return workspace ?? null
  }

  /** The JSONL of the bound conversation, or null (the channel replied why). */
  private async resolveBoundFile(channel: StoredChannel): Promise<string | null> {
    const workspace = await this.boundWorkspace(channel)
    if (!workspace) {
      await this.reply(channel.id, '绑定的项目已不在应用中，请在设置里重新选择。')
      return null
    }
    const sessions = await listSessions(workspace.path)
    const session = sessions.find((item) => item.id === channel.binding.sessionId)
    if (!session) {
      await this.reply(channel.id, '绑定的对话已不存在，可用 /new 开始新对话。')
      return null
    }
    this.boundFileCache.set(channel.id, {
      workspaceId: workspace.id,
      sessionId: session.id,
      fileKey: this.pathKey(session.file)
    })
    return session.file
  }

  private async replyStatus(channelId: string, channel: StoredChannel): Promise<void> {
    const workspace = await this.boundWorkspace(channel)
    if (!workspace) {
      await this.reply(channelId, '绑定的项目已不在应用中，请在设置里重新选择。')
      return
    }
    const sessions = await listSessions(workspace.path)
    const session = sessions.find((item) => item.id === channel.binding.sessionId)
    if (!session) {
      await this.reply(channelId, `项目「${clipName(workspace.name)}」· 绑定的对话已不存在，可用 /new 开始新对话。`)
      return
    }
    const info = this.options.supervisor.sessionInfo(session.file)
    const state = info?.waitingForInput ? '等待确认' : info?.running ? '正在运行' : '空闲'
    await this.reply(channelId, `项目「${clipName(workspace.name)}」· ${clipName(session.name || session.preview || '未命名对话')}：${state}。`)
  }

  /** One ordinary message: ensure Pi, then hand it over as a steering prompt. */
  private async dispatchPrompt(channelId: string, channel: StoredChannel, message: string): Promise<void> {
    const file = await this.resolveBoundFile(channel)
    if (!file) return
    const workspace = await this.boundWorkspace(channel)
    if (!workspace) return
    const started = await this.options.supervisor.ensure({
      sessionKey: file,
      cwd: workspace.path,
      sessionFile: file,
      customInstructions: this.options.customInstructions(workspace.path)
    }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }))
    if (!started.ok) {
      await this.reply(channelId, `Pi 未能启动：${clipText(started.error ?? '', 200)}`)
      return
    }
    try {
      await this.options.supervisor.request(
        file,
        'prompt',
        { message, streamingBehavior: 'steer' },
        900_000,
        { sourceAction: 'im-send', uiSessionId: file }
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      await this.reply(channelId, `消息未能送达：${clipText(detail, 200)}`)
    }
  }

  /** `/new`: run the message in a draft conversation, then re-bind the channel. */
  private async startNewConversation(channelId: string, channel: StoredChannel, message: string): Promise<void> {
    const workspace = await this.boundWorkspace(channel)
    if (!workspace) {
      await this.reply(channelId, '绑定的项目已不在应用中，请在设置里重新选择。')
      return
    }
    const draftKey = `draft:${randomUUID()}`
    const rekey = this.awaitRekey(draftKey)
    try {
      const started = await this.options.supervisor.ensure({
        sessionKey: draftKey,
        cwd: workspace.path,
        customInstructions: this.options.customInstructions(workspace.path)
      }).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }))
      if (!started.ok) {
        await this.reply(channelId, `Pi 未能启动：${clipText(started.error ?? '', 200)}`)
        return
      }
      try {
        await this.options.supervisor.request(
          draftKey,
          'prompt',
          { message, streamingBehavior: 'steer' },
          900_000,
          { sourceAction: 'im-send', uiSessionId: draftKey }
        )
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        await this.reply(channelId, `消息未能送达：${clipText(detail, 200)}`)
        return
      }
      const rekeyed = await rekey.promise
      if (rekeyed) {
        await this.rebind(channel, rekeyed)
        await this.reply(channelId, '已切换到新对话。')
      } else {
        // The conversation exists and is running; only the binding update is
        // missing. Say so rather than pretending the switch happened.
        await this.reply(channelId, '新对话已开始，但暂时无法更新频道绑定，请稍后用 /status 查看。')
      }
    } finally {
      rekey.cancel()
    }
  }

  /** One bounded wait for the JSONL a draft is about to become. */
  private awaitRekey(draftKey: string): { promise: Promise<string | null>; cancel: () => void } {
    let finish!: (value: string | null) => void
    const promise = new Promise<string | null>((resolve) => {
      let done = false
      finish = (value: string | null): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.options.supervisor.off('rekey', listener)
        this.activeRekeys.delete(cancel)
        resolve(value)
      }
      const listener = (change: RuntimeRekey): void => {
        if (change.from === draftKey) finish(change.to)
      }
      const timer = setTimeout(() => finish(null), REKEY_WAIT_MS)
      timer.unref?.()
      this.options.supervisor.on('rekey', listener)
    })
    const cancel = () => finish(null)
    this.activeRekeys.add(cancel)
    return { promise, cancel }
  }

  /** Persist the new binding for a channel and republish the settings view. */
  private async rebind(channel: StoredChannel, file: string): Promise<void> {
    const workspace = await this.boundWorkspace(channel)
    if (!workspace) return
    const sessions = await listSessions(workspace.path)
    const session = sessions.find((item) => this.pathKey(item.file) === this.pathKey(file))
    if (!session) return
    await this.withStateLock(() => {
      const stored = this.readPersistedState()
      const next = stored.channels.map((item) =>
        item.id === channel.id ? { ...item, binding: { workspaceId: workspace.id, sessionId: session.id } } : item
      )
      this.channels = next
      this.writeState({ channels: next })
    })
    this.boundFileCache.set(channel.id, {
      workspaceId: workspace.id,
      sessionId: session.id,
      fileKey: this.pathKey(session.file)
    })
    if (!this.disposed) this.emit('changed', this.status())
  }

  /* ---------------------------------------------------------------- *
   * Supervisor pushes
   * ---------------------------------------------------------------- */

  private readonly onRuntimeRekey = (change: RuntimeRekey): void => {
    const fromKey = this.pathKey(change.from)
    const toKey = this.pathKey(change.to)
    if (fromKey === toKey) return
    const pending = this.runCompletions.get(fromKey)
    if (pending) {
      this.runCompletions.delete(fromKey)
      this.runCompletions.set(toKey, pending)
    }
  }

  /** Final answers and needs-confirmation notices, per bound session file. */
  private readonly onRuntimeEvent = (payload: { ownerId: string; event: PiEvent }): void => {
    if (this.disposed) return
    const ownerKey = this.pathKey(payload.ownerId)
    const event = payload.event
    if (event.type === 'agent_start') {
      this.runCompletions.delete(ownerKey)
      return
    }
    if (event.type === 'agent_settled') {
      const completion = this.runCompletions.get(ownerKey)
      this.runCompletions.delete(ownerKey)
      if (this.runtimes.size === 0) return
      if (event.aborted || event.runtimeStopped) return
      if (event.crashed) {
        this.pushToBound(ownerKey, `任务失败：${clipText(completion?.body || 'Pi 在任务完成前退出', 300)}`)
        return
      }
      if (!completion) return
      if (completion.failed) {
        this.pushToBound(ownerKey, `任务失败：${clipText(completion.body || 'Pi 在任务完成前退出', 300)}`)
        return
      }
      if (!completion.body) return
      this.pushToBound(ownerKey, completion.body)
      return
    }
    if (this.runtimes.size === 0) return
    if (event.type === 'agent_end') {
      if (this.runCompletions.size >= 256 && !this.runCompletions.has(ownerKey)) {
        const oldest = this.runCompletions.keys().next().value
        if (oldest !== undefined) this.runCompletions.delete(oldest)
      }
      this.runCompletions.set(ownerKey, describeRunCompletion(event.messages))
      return
    }
    if (event.type === 'extension_ui_request') {
      const method = String(event.method ?? '')
      if (!['select', 'confirm', 'input', 'editor'].includes(method)) return
      const ask = clipText(String(event.title ?? event.message ?? ''), 200).replace(/\s+/g, ' ').trim()
      this.pushToBound(ownerKey, ask ? `Pi 需要确认：${ask}` : 'Pi 需要在桌面端确认后才能继续。')
      return
    }
  }

  /** Push one text to the channel whose binding currently owns that file. */
  private pushToBound(ownerKey: string, text: string): void {
    for (const channel of this.channels) {
      if (!channel.enabled) continue
      const workspace = this.registeredWorkspaces().find((item) => item.id === channel.binding.workspaceId)
      // A synchronous lookup cannot resolve the session file without IO, so
      // bindings carry the file identity only through the id → resolve lazily
      // but never block the event: the check below runs on the next tick.
      if (!workspace) continue
      void this.matchesBinding(channel, ownerKey).then((matches) => {
        if (matches) void this.reply(channel.id, text).catch(() => {})
      })
    }
  }

  private async matchesBinding(channel: StoredChannel, ownerKey: string): Promise<boolean> {
    const cached = this.boundFileCache.get(channel.id)
    if (
      cached &&
      cached.workspaceId === channel.binding.workspaceId &&
      cached.sessionId === channel.binding.sessionId
    ) {
      return cached.fileKey === ownerKey
    }
    const workspace = await this.boundWorkspace(channel)
    if (!workspace) return false
    try {
      const sessions = await listSessions(workspace.path)
      const session = sessions.find((item) => item.id === channel.binding.sessionId)
      if (!session) return false
      const fileKey = this.pathKey(session.file)
      this.boundFileCache.set(channel.id, {
        workspaceId: workspace.id,
        sessionId: session.id,
        fileKey
      })
      return fileKey === ownerKey
    } catch {
      return false
    }
  }

  private readonly runCompletions = new Map<string, ReturnType<typeof describeRunCompletion>>()

  /** True while this service owns a live adapter for that channel id. */
  hasRuntime(id: string): boolean {
    return this.runtimes.has(id)
  }

  storedChannels(): readonly StoredChannel[] {
    return this.channels
  }
}

function clipName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, NAME_LIMIT)
}

function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

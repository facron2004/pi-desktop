import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ImChannelService,
  type ChannelAdapter,
  type ChannelAdapterContext
} from '../src/main/channels/im-channel-service'
import { createFeishuAdapter } from '../src/main/channels/feishu-core'
import { buildWechatAdapter, WECHAT_HTTP_LIMITS } from '../src/main/channels/wechat'
import { parseMultipartTextFields } from '../src/main/channels/multipart'
import type { ImChannelConfig } from '../src/shared/types'

const FEISHU: ImChannelConfig = {
  id: 'channel-1',
  kind: 'feishu',
  enabled: true,
  binding: { workspaceId: 'ws-1', sessionId: 'session-1' },
  feishu: { appId: 'cli_app', appSecret: 'very-secret', allowedChatIds: ['oc_chat'] }
}

interface FakeAdapter extends ChannelAdapter {
  sent: string[]
  stopped: boolean
  started: boolean
  contexts: ChannelAdapterContext[]
}

function fakeAdapter(): FakeAdapter {
  const adapter: FakeAdapter = {
    sent: [],
    stopped: false,
    started: false,
    contexts: [],
    async start() { this.started = true },
    async stop() { this.stopped = true },
    async send(text: string) { this.sent.push(text) },
    async test() { return { ok: true } },
    state: () => ({ state: 'connected' as const })
  }
  return adapter
}

function service(t: { after: (fn: () => void) => void }, adapter: FakeAdapter) {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-im-channels-'))
  const supervisor = Object.assign(new EventEmitter(), {
    sessionInfo: () => ({ running: false, waitingForInput: false, cwd: 'C:/project', externalContext: false }),
    ensure: async (options: Record<string, unknown>) => { calls.ensures.push(options); return { ok: true } },
    request: async (...args: unknown[]) => { calls.requests.push(args); return {} },
    stop: async (key: string) => { calls.stops.push(key) },
    respondUi: () => {}
  }) as EventEmitter & Record<string, unknown>
  const calls = { ensures: [] as Record<string, unknown>[], requests: [] as unknown[][], stops: [] as string[] }
  const settings = {
    get: () => ({ workspaces: [{ id: 'ws-1', name: 'Project', path: 'C:/project' }] }),
    getRegisteredWorkspaces: () => [{ id: 'ws-1', name: 'Project', path: 'C:/project' }]
  }
  const instance = new ImChannelService({
    userData,
    settings: settings as never,
    supervisor: supervisor as never,
    customInstructions: () => undefined,
    createAdapter: (_channel, context) => {
      adapter.contexts.push(context)
      return adapter
    }
  })
  t.after(() => rmSync(userData, { recursive: true, force: true }))
  return { instance, supervisor, calls, settings }
}

test('channel save masks secrets, validates input and keeps an empty secret on update', async (t) => {
  const adapter = fakeAdapter()
  const { instance } = service(t, adapter)
  await assert.rejects(instance.save({ ...FEISHU, kind: 'other' }), /Only feishu and wechat/)
  await assert.rejects(instance.save({ ...FEISHU, feishu: { ...FEISHU.feishu!, appId: '' } }), /App ID/)
  const saved = await instance.save({ ...FEISHU, feishu: { ...FEISHU.feishu!, appSecret: 'very-secret' } }).catch((error: Error) => { throw new Error(`save failed: ${error.message}`) })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].feishu?.appSecretSet, true)
  assert.equal(JSON.stringify(saved).includes('very-secret'), false)
  assert.ok(saved[0].wechat === undefined)

  const updated = await instance.save({
    ...FEISHU,
    feishu: { appId: 'cli_app', appSecret: '', allowedChatIds: ['oc_chat'] }
  })
  assert.equal(updated[0].feishu?.appSecretSet, true)
  const stored = instance.storedChannels()[0]
  assert.equal(stored.feishu?.appSecret, 'very-secret')
})

test('channel remove stops its adapter and clears the runtime', async (t) => {
  const adapter = fakeAdapter()
  const { instance } = service(t, adapter)
  await instance.save(FEISHU)
  await instance.initialize()
  assert.equal(adapter.started, true)
  await instance.remove('channel-1')
  assert.equal(adapter.stopped, true)
  assert.equal(instance.status().length, 0)
  await instance.dispose()
})

test('routeInbound commands and prompts use the bound conversation', async (t) => {
  const adapter = fakeAdapter()
  const { instance, calls, supervisor } = service(t, adapter)
  await instance.save(FEISHU)
  await instance.initialize()
  const router = adapter.contexts[0].router

  await router('channel-1', '/help')
  assert.match(adapter.sent.at(-1)!, /\/status/)

  await router('channel-1', '/stop')
  // No bound file resolves on this fake disk, so /stop reports the missing
  // conversation instead of stopping an arbitrary key.
  assert.match(adapter.sent.at(-1)!, /不存在/)
  assert.equal(calls.stops.length, 0, 'an unresolved binding never stops a runtime')

  await router('channel-1', 'hello pi')
  assert.equal(calls.ensures.length, 0, 'a missing bound session is reported, not started')
  assert.match(adapter.sent.at(-1)!, /不存在/)

  // Feed a real session row to the fake disk through the resolving seam.
  ;(instance as unknown as { resolveBoundFile: () => Promise<string | null> }).resolveBoundFile = async () => 'C:/project/session.jsonl'
  ;(instance as unknown as { boundWorkspace: () => Promise<{ id: string; path: string; name: string } | null> }).boundWorkspace = async () => ({ id: 'ws-1', path: 'C:/project', name: 'Project' })
  await router('channel-1', 'hello pi')
  assert.equal(calls.ensures.length, 1)
  assert.equal(calls.ensures[0].sessionFile, 'C:/project/session.jsonl')
  assert.equal(calls.requests[0][1], 'prompt')
  assert.deepEqual(calls.requests[0][2], { message: 'hello pi', streamingBehavior: 'steer' })
  assert.equal((calls.requests[0][4] as { sourceAction: string }).sourceAction, 'im-send')
  assert.equal(adapter.sent.length, 3, 'a successful prompt does not echo the user text')
  void supervisor
  await instance.dispose()
})

test('a settled run pushes its answer; an aborted or crashed one does not', async (t) => {
  const adapter = fakeAdapter()
  const { instance, supervisor } = service(t, adapter)
  await instance.save(FEISHU)
  await instance.initialize()
  ;(instance as unknown as { matchesBinding: () => Promise<boolean> }).matchesBinding = async () => true
  const emit = (event: Record<string, unknown>) => supervisor.emit('event', { ownerId: 'C:/project/session.jsonl', event })

  emit({ type: 'agent_end', messages: [{ role: 'assistant', content: 'the answer', timestamp: 1 }] })
  emit({ type: 'agent_settled', aborted: false })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.ok(adapter.sent.some((text) => text.includes('the answer')))

  adapter.sent.length = 0
  emit({ type: 'agent_end', messages: [{ role: 'assistant', content: 'aborted answer', timestamp: 2 }] })
  emit({ type: 'agent_settled', aborted: true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(adapter.sent.length, 0)

  adapter.sent.length = 0
  emit({ type: 'extension_ui_request', method: 'confirm', title: 'Delete the file?' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(adapter.sent.at(-1)!, /需要确认/)
  await instance.dispose()
})

test('Feishu stop() closes WSClient and blocks late inbound events from stale sockets', async () => {
  let closeCalls = 0
  let closedForce = false
  let registeredHandler: ((data: unknown) => void) | undefined
  const routed: string[] = []
  const adapter = createFeishuAdapter(
    FEISHU,
    {
      router: async (_id, text) => { routed.push(text) },
      onState: () => {}
    },
    {
      createClient: () => ({ sendText: async () => {} }),
      createWsClient: () => ({
        async start(onMessage) {
          registeredHandler = onMessage
        },
        close(params) {
          closeCalls += 1
          closedForce = params?.force === true
        }
      })
    }
  )

  await adapter.start()
  registeredHandler?.({
    message: { message_id: 'm1', message_type: 'text', chat_id: 'oc_chat', content: JSON.stringify({ text: 'hello' }) }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(routed, ['hello'])

  await adapter.stop()
  assert.equal(closeCalls, 1)
  assert.equal(closedForce, true)

  // A stale socket firing after stop() must not invoke the router.
  registeredHandler?.({
    message: { message_id: 'm2', message_type: 'text', chat_id: 'oc_chat', content: JSON.stringify({ text: 'stale' }) }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(routed, ['hello'])
})

test('multipart parser enforces MAX_FIELDS, skips files, and uses a null-prototype map', () => {
  const boundary = '----piBoundary'
  const part = (name: string, value: string, filename?: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}\r\n\r\n${value}\r\n`
  const okBody = Buffer.from(`${part('type', 'text')}${part('file', 'binary', 'a.png')}--${boundary}--\r\n`)
  const parsed = parseMultipartTextFields(`multipart/form-data; boundary=${boundary}`, okBody)
  assert.equal(Object.getPrototypeOf(parsed), null)
  assert.equal(parsed.type, 'text')
  assert.equal(parsed.file, undefined)

  let tooMany = ''
  for (let i = 0; i < 21; i += 1) tooMany += part(`f${i}`, 'v')
  tooMany += `--${boundary}--\r\n`
  assert.throws(
    () => parseMultipartTextFields(`multipart/form-data; boundary=${boundary}`, Buffer.from(tooMany)),
    /field limit/
  )
})

test('WeChat adapter uses redirect:error, timeout signal, bounded reads, and scrubs bridge tokens from errors', async () => {
  assert.equal(WECHAT_HTTP_LIMITS.maxConnections, 64)
  assert.ok(WECHAT_HTTP_LIMITS.headersTimeoutMs > 0 && WECHAT_HTTP_LIMITS.requestTimeoutMs > 0)
  const seenInit: RequestInit[] = []
  const token = 'secret-bridge-token-999'
  const channel: ImChannelConfig = {
    id: 'wx-1',
    kind: 'wechat',
    enabled: true,
    binding: { workspaceId: 'ws-1', sessionId: 's-1' },
    wechat: {
      bridgeUrl: 'http://127.0.0.1:3001',
      bridgeToken: token,
      listenPort: 19876,
      receiveToken: 'recv-token',
      sendTo: 'Alice',
      sendToIsRoom: false
    }
  }
  const adapter = buildWechatAdapter(
    channel,
    { router: async () => {}, onState: () => {}, onBridgeHealth: () => {} },
    {
      fetcher: async (url, init) => {
        seenInit.push(init ?? {})
        throw new Error(`connect ECONNREFUSED ${String(url)}`)
      }
    }
  )
  const probed = await adapter.test()
  assert.equal(probed.ok, false)
  assert.equal(probed.error?.includes(token), false, 'bridgeToken must never leak into test errors')
  assert.equal(seenInit[0]?.redirect, 'error')
  assert.ok(seenInit[0]?.signal)

  await assert.rejects(
    () => adapter.send('hi'),
    (error: Error) => !error.message.includes(token)
  )
  assert.equal(seenInit[1]?.redirect, 'error')
  assert.ok(seenInit[1]?.signal)
})

test('IM /new prompts real text (not "/new"), crash settles notify, a fifth channel is refused, and transient workspace loss preserves channels', async (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-im-channels-reg-'))
  t.after(() => rmSync(userData, { recursive: true, force: true }))
  const adapters = new Map<string, FakeAdapter>()
  const calls = { ensures: [] as Record<string, unknown>[], requests: [] as unknown[][] }
  let workspaces = [
    { id: 'ws-1', name: 'Project 1', path: 'C:/project-1' },
    { id: 'ws-2', name: 'Project 2', path: 'C:/project-2' }
  ]
  const supervisor = Object.assign(new EventEmitter(), {
    sessionInfo: () => ({ running: false, waitingForInput: false, cwd: 'C:/project-1', externalContext: false }),
    ensure: async (options: Record<string, unknown>) => { calls.ensures.push(options); return { ok: true } },
    request: async (...args: unknown[]) => { calls.requests.push(args); return {} },
    stop: async () => {},
    respondUi: () => {}
  }) as EventEmitter & Record<string, unknown>
  const instance = new ImChannelService({
    userData,
    settings: { get: () => ({ workspaces }), getRegisteredWorkspaces: () => workspaces } as never,
    supervisor: supervisor as never,
    customInstructions: () => undefined,
    createAdapter: (channel, context) => {
      const a = fakeAdapter()
      a.contexts.push(context)
      adapters.set(channel.id, a)
      return a
    }
  })

  await instance.initialize()
  await instance.save(FEISHU)
  const adapter1 = adapters.get('channel-1')!
  const router = adapter1.contexts[0].router

  // Bare /new must not send "/new" to Pi; the next message starts the draft.
  await router('channel-1', '/new')
  assert.equal(calls.requests.length, 0)
  assert.match(adapter1.sent.at(-1)!, /新对话/)

  // Failed ensure must not leak rekey listeners.
  supervisor.ensure = async () => ({ ok: false, error: 'boot failed' })
  await router('channel-1', 'first real prompt')
  assert.equal(supervisor.listenerCount('rekey'), 1, 'only the service onRuntimeRekey listener should remain')

  // /new <prompt> sends only <prompt>, not "/new <prompt>".
  supervisor.ensure = async (options: Record<string, unknown>) => { calls.ensures.push(options); return { ok: true } }
  supervisor.request = async (...args: unknown[]) => {
    calls.requests.push(args)
    const draftKey = args[0] as string
    setImmediate(() => supervisor.emit('rekey', { from: draftKey, to: 'C:/project-1/new.jsonl' }))
    return {}
  }
  await router('channel-1', '/new refactor parser')
  assert.deepEqual(calls.requests.at(-1)?.[2], { message: 'refactor parser', streamingBehavior: 'steer' })

  // A mid-run crash without agent_end must still push a failure notice.
  adapter1.sent.length = 0
  ;(instance as unknown as { matchesBinding: () => Promise<boolean> }).matchesBinding = async () => true
  supervisor.emit('event', { ownerId: 'C:/project-1/session.jsonl', event: { type: 'agent_settled', aborted: false, crashed: true } })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.match(adapter1.sent.at(-1) ?? '', /任务失败/)

  // Transiently missing workspace for channel-1 must NOT wipe it when channel-2 is saved.
  workspaces = [{ id: 'ws-2', name: 'Project 2', path: 'C:/project-2' }]
  await instance.save({ ...FEISHU, id: 'channel-2', binding: { workspaceId: 'ws-2', sessionId: 's-2' } })
  assert.equal(instance.storedChannels().some((c) => c.id === 'channel-1'), true)

  // A fifth channel is refused rather than evicting channel-1: silently dropping
  // a binding deletes its credentials and takes its bot offline with no notice.
  await instance.save({ ...FEISHU, id: 'channel-3', binding: { workspaceId: 'ws-2', sessionId: 's-3' } })
  await instance.save({ ...FEISHU, id: 'channel-4', binding: { workspaceId: 'ws-2', sessionId: 's-4' } })
  await assert.rejects(
    () => instance.save({ ...FEISHU, id: 'channel-5', binding: { workspaceId: 'ws-2', sessionId: 's-5' } }),
    /At most 4 channels can be bound/
  )
  assert.equal(instance.storedChannels().some((c) => c.id === 'channel-1'), true)
  assert.equal(instance.hasRuntime('channel-1'), true)
  assert.equal(adapter1.stopped, false, 'a refused add must not stop another channel')
  await instance.dispose()
})

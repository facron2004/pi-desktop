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

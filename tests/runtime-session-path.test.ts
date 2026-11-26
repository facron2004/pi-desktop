import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { app, ipcMain } from 'electron'
import type { PiEvent, PiState } from '@shared/types'
import { registerIpc } from '../src/main/ipc'
import type { IpcContext } from '../src/main/ipc'
import { findBundledCli } from '../src/main/pi/locate'
import { RETRY_FLOOR } from '../src/main/pi/retry-policy'
import { PiRuntime } from '../src/main/pi/runtime'
import { SessionSupervisor } from '../src/main/pi/supervisor'

test('runtime IPC blocks direct switch_session RPCs before they reach Pi', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const requests: { key: string; command: string; payload: Record<string, unknown> }[] = []
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    registerIpc({
      supervisor: {
        request: async (key: string, command: string, payload: Record<string, unknown>) => {
          requests.push({ key, command, payload })
          return { success: true }
        }
      },
      settings: { get: () => ({ workspaces: [] }) },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const handler = handlers.get('runtime:request')
    assert.ok(handler, 'runtime:request handler was registered')
    await assert.rejects(
      handler({}, 'switch_session', { sessionPath: 'C:/outside/session.jsonl' }, undefined, undefined, 'conversation'),
      /runtime:start\/ensure/
    )
    assert.deepEqual(requests, [], 'a blocked switch_session must never reach the Pi supervisor')

    for (const command of ['new_session', 'fork', 'clone']) {
      await handler({}, command, {}, undefined, undefined, 'conversation')
    }
    assert.deepEqual(
      requests.map(({ key, command, payload }) => ({ key, command, payload })),
      ['new_session', 'fork', 'clone'].map((command) => ({ key: 'conversation', command, payload: {} }))
    )
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
  }
})

test('runtime rejects a session file outside the session root before launch', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-runtime-session-path-'))
  const root = path.join(parent, 'sessions')
  const workspace = path.join(root, '--C--project--')
  const outside = path.join(parent, 'outside.jsonl')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(outside, '{"type":"session","id":"outside"}\n')

  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const runtime = new PiRuntime()
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    const result = await runtime.start({ cwd: workspace, sessionFile: outside })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'Conversation file changed before Pi could reopen it.')
    assert.equal(runtime.currentStatus.phase, 'error')
  } finally {
    await runtime.stop()
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    rmSync(parent, { recursive: true, force: true })
  }
})

test('runtime refuses a missing session file instead of silently starting a blank chat', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-runtime-session-deleted-'))
  const root = path.join(parent, 'sessions')
  const workspace = path.join(root, '--C--project--')
  const missing = path.join(workspace, 'deleted.jsonl')
  mkdirSync(workspace, { recursive: true })

  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const runtime = new PiRuntime()
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    const result = await runtime.start({ cwd: workspace, sessionFile: missing })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'Conversation file changed before Pi could reopen it.')
    assert.equal(runtime.currentStatus.phase, 'error')
  } finally {
    await runtime.stop()
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a normal conversation launch uses its options without replacing newer Pi defaults', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-runtime-defaults-'))
  const sessions = path.join(directory, 'sessions')
  const previousAgent = process.env.PI_CODING_AGENT_DIR
  const previousTrace = process.env.PI_DESKTOP_RPC_TRACE
  process.env.PI_CODING_AGENT_DIR = directory
  process.env.PI_DESKTOP_RPC_TRACE = '0'
  t.mock.method(app, 'getPath', () => directory)
  const runtime = new PiRuntime({ getSessionDir: () => sessions })
  t.after(async () => {
    await runtime.stop()
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgent
    if (previousTrace === undefined) delete process.env.PI_DESKTOP_RPC_TRACE
    else process.env.PI_DESKTOP_RPC_TRACE = previousTrace
    rmSync(directory, { recursive: true, force: true })
  })

  mkdirSync(sessions)
  writeFileSync(path.join(directory, 'models.json'), JSON.stringify({ providers: { fixture: {
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'local-test',
    models: ['captured', 'saved'].map((id) => ({
      id, reasoning: true, input: ['text'], contextWindow: 32000, maxTokens: 1024
    }))
  } } }))
  const settingsFile = path.join(directory, 'settings.json')
  const saved = { defaultProvider: 'fixture', defaultModel: 'saved', defaultThinkingLevel: 'high' }
  writeFileSync(settingsFile, JSON.stringify(saved))

  const older = await runtime.start({ cwd: directory, model: 'fixture/captured', thinkingLevel: 'low' })
  assert.equal(older.ok, true, older.error)
  const olderState = await runtime.request<PiState>('get_state')
  assert.equal(olderState.model?.id, 'captured')
  assert.equal(olderState.thinkingLevel, 'low')
  assert.deepEqual(JSON.parse(readFileSync(settingsFile, 'utf8')), {
    ...saved, retry: { enabled: true, ...RETRY_FLOOR }
  })

  const next = await runtime.start({ cwd: directory })
  assert.equal(next.ok, true, next.error)
  const nextState = await runtime.request<PiState>('get_state')
  assert.equal(nextState.model?.id, 'saved')
  assert.equal(nextState.thinkingLevel, 'high')

  await t.test('a live registry is refreshed before selecting a newly added provider', async () => {
    const modelsFile = path.join(directory, 'models.json')
    const config = JSON.parse(readFileSync(modelsFile, 'utf8'))
    config.providers.added = { ...config.providers.fixture }
    writeFileSync(modelsFile, JSON.stringify(config))

    const selection = { provider: 'added', modelId: 'saved' }
    await assert.rejects(runtime.request('set_model', selection), /Model not found/)
    assert.deepEqual(await runtime.request('prompt', { message: '/desktop-refresh-models' }), { disposition: 'handled' })
    const confirmed = await runtime.request<NonNullable<PiState['model']>>('set_model', selection)
    assert.equal(confirmed.provider, 'added')
    assert.equal(confirmed.id, 'saved')
    assert.equal((await runtime.request<PiState>('get_state')).model?.provider, 'added')
  })
})

test('bundled Pi delivers a side follow-up in the active run and rejects one after settle', { timeout: 30_000 }, async (t) => {
  const cli = findBundledCli()
  assert.ok(cli)
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-runtime-follow-up-'))
  const sessions = path.join(directory, 'sessions')
  const previousAgent = process.env.PI_CODING_AGENT_DIR
  const previousTrace = process.env.PI_DESKTOP_RPC_TRACE
  process.env.PI_CODING_AGENT_DIR = directory
  process.env.PI_DESKTOP_RPC_TRACE = '0'
  t.mock.method(app, 'getPath', () => directory)
  const supervisor = new SessionSupervisor(() => new PiRuntime({ customPiPath: cli, getSessionDir: () => sessions }))
  const firstRequest = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  let requests = 0
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Read the whole request before replying. */ }
    if (++requests === 1) {
      firstRequest.resolve()
      await releaseFirst.promise
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const [delta, finish_reason] of [[{ role: 'assistant', content: 'Reply' }, null], [{}, 'stop']]) {
      const event = {
        id: 'follow-up-fixture', object: 'chat.completion.chunk', created: 1, model: 'test',
        choices: [{ index: 0, delta, finish_reason }]
      }
      response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    response.end('data: [DONE]\n\n')
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    mkdirSync(sessions)
    writeFileSync(path.join(directory, 'models.json'), JSON.stringify({ providers: { fixture: {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-test',
      models: [{ id: 'test', input: ['text'], contextWindow: 32000, maxTokens: 1024 }]
    } } }))

    const key = 'draft:follow-up-test'
    const settled = Promise.withResolvers<void>()
    const events: PiEvent[] = []
    supervisor.on('event', ({ event }: { event: PiEvent }) => {
      events.push(event)
      if (event.type === 'agent_settled') settled.resolve()
    })
    const started = await supervisor.ensure({ sessionKey: key, cwd: directory, model: 'fixture/test' })
    assert.equal(started.ok, true, started.error)
    assert.deepEqual(await supervisor.request(key, 'prompt', { message: 'First task' }), { disposition: 'started' })
    await firstRequest.promise
    assert.deepEqual(await supervisor.request(key, 'follow_up', { message: 'Review the result' }), { disposition: 'queued' })
    releaseFirst.resolve()
    await settled.promise
    assert.equal(requests, 2)
    assert.equal(events.filter((event) => event.type === 'agent_start').length, 1)

    assert.deepEqual(await supervisor.request(key, 'follow_up', { message: 'Too late' }), {
      disposition: 'handled', cancelled: true
    })
    const state = await supervisor.request<PiState>(key, 'get_state')
    assert.equal(state.isStreaming, false)
    assert.equal(state.pendingMessageCount, 0)
  } finally {
    releaseFirst.resolve()
    try {
      await supervisor.stop()
    } finally {
      server.close()
      server.closeAllConnections()
      if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgent
      if (previousTrace === undefined) delete process.env.PI_DESKTOP_RPC_TRACE
      else process.env.PI_DESKTOP_RPC_TRACE = previousTrace
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

test('runtime requests reserve their command and id fields for the RPC client', async () => {
  const runtime = new PiRuntime()
  const requests: { type: string; id?: string; [key: string]: unknown }[] = []
  const client = {
    running: true,
    request: async <T>(request: { type: string; id?: string; [key: string]: unknown }): Promise<T> => {
      requests.push(request)
      return {} as T
    }
  }
  ;(runtime as unknown as { client: typeof client }).client = client

  await runtime.request('get_tree', {
    type: 'extension_ui_response',
    id: 'pi-owned-dialog-id',
    sessionFile: 'session.jsonl'
  })

  assert.deepEqual(requests, [{ type: 'get_tree', sessionFile: 'session.jsonl' }])
  await assert.rejects(
    runtime.request('extension_ui_response', { id: 'pi-owned-dialog-id', confirmed: true }),
    /runtime:respondUi/
  )
  assert.equal(requests.length, 1)
})

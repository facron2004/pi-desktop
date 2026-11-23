import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { RemoteAccessService } from '../src/main/remote-access'
import { encodeWorkspaceDir } from '../src/main/sessions'

const accessToken = 'b'.repeat(32)
const device = { id: 'phone-1', name: 'Phone', pairedAt: 1, tokenHash: createHash('sha256').update(accessToken).digest('hex') }

interface Harness {
  service: RemoteAccessService
  internals: {
    server: object | null
    enabled: boolean
    devices: typeof device[]
    pendingDialogs: Map<string, { id: string }>
    handleRequest: (request: unknown, response: unknown) => Promise<void>
    onUiResponded: (payload: { ownerId: string; id: string }) => void
  }
  supervisor: EventEmitter & Record<string, unknown>
  workspacePath: string
  sessionId: string
  sessionFile: string
  post: (path: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>
  cleanup: () => Promise<void>
}

function harness(t: { after: (fn: () => Promise<void> | void) => void }): Harness {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-control-'))
  const sessionRoot = path.join(userData, 'sessions')
  const workspacePath = path.join(userData, 'workspace')
  const prior = process.env.PI_CODING_AGENT_SESSION_DIR
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionRoot
  mkdirSync(workspacePath, { recursive: true })
  const workspaceSessions = path.join(sessionRoot, encodeWorkspaceDir(workspacePath))
  mkdirSync(workspaceSessions, { recursive: true })
  const sessionId = 'session-1'
  const sessionFile = path.join(workspaceSessions, `${sessionId}.jsonl`)
  writeFileSync(sessionFile, JSON.stringify({
    type: 'session', version: 3, id: sessionId, cwd: workspacePath,
    timestamp: new Date(1_700_000_000_000).toISOString()
  }) + '\n')
  writeFileSync(path.join(userData, 'remote-access.json'), JSON.stringify({ enabled: true, devices: [device] }))

  const supervisor = Object.assign(new EventEmitter(), {
    sessionInfo: () => ({ cwd: workspacePath, externalContext: false, running: false }),
    ensure: async () => ({ ok: true }),
    stop: async () => {},
    request: async () => ({}),
    respondUi: () => {}
  }) as EventEmitter & Record<string, unknown>
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => ({ workspaces: [{ id: 'workspace-1', path: workspacePath }] }) } as never,
    supervisor: supervisor as never,
    customInstructions: () => undefined
  })
  const internals = service as unknown as Harness['internals']
  internals.server = {}
  internals.enabled = true
  internals.devices = [device]

  const post = async (urlPath: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
    let status = 0
    let payload = ''
    try {
      await internals.handleRequest({
      method: 'POST',
      url: urlPath,
      headers: { host: '127.0.0.1', authorization: `Bearer ${accessToken}`, origin: 'http://127.0.0.1', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      [Symbol.asyncIterator]: async function* () { yield JSON.stringify(body) }
    }, {
      headersSent: false,
      setHeader: () => {},
      writeHead: (code: number) => { status = code },
      end: (value?: string) => { payload = value ?? '' }
    })
    } catch (error) {
      status = (error as { status?: number }).status ?? 500
      if (!payload) payload = JSON.stringify({ error: (error as Error).message })
    }
    return { status, body: JSON.parse(payload || '{}') as Record<string, unknown> }
  }

  const cleanup = async (): Promise<void> => {
    internals.server = null
    await service.dispose()
    if (prior === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = prior
    rmSync(userData, { recursive: true, force: true })
  }
  t.after(cleanup)
  return { service, internals, supervisor, workspacePath, sessionId, sessionFile, post, cleanup }
}

test('POST /api/stop stops the bound conversation run', async (t) => {
  const h = harness(t)
  let stoppedKey = ''
  h.supervisor.stop = async (key: string) => { stoppedKey = key }
  const result = await h.post('/api/stop', { workspaceId: 'workspace-1', sessionId: h.sessionId })
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { ok: true })
  assert.equal(stoppedKey, h.sessionFile)
})

test('POST /api/dialog answers a pending dialog and broadcasts close on ui-responded', async (t) => {
  const h = harness(t)
  const resolved = await (h.internals as unknown as {
    resolveSession: (w: string, s: string) => Promise<{ file: string }>
  }).resolveSession('workspace-1', h.sessionId)
  const actualFileKey = process.platform === 'win32' ? path.resolve(resolved.file).toLowerCase() : path.resolve(resolved.file)
  h.internals.pendingDialogs.set(actualFileKey, { id: 'dlg-1' } as never)
  let answered: unknown[] = []
  h.supervisor.respondUi = (...args: unknown[]) => { answered = args }

  const result = await h.post('/api/dialog', {
    workspaceId: 'workspace-1', sessionId: h.sessionId, id: 'dlg-1',
    response: { value: 'x'.repeat(40_000), confirmed: true, extra: 'ignored' }
  })
  assert.equal(result.status, 200, JSON.stringify(result))
  assert.equal(answered[0], h.sessionFile)
  assert.equal(answered[1], 'dlg-1')
  assert.equal((answered[2] as { value: string }).value.length, 32_000)
  assert.equal((answered[2] as { confirmed: boolean }).confirmed, true)
  assert.equal((answered[2] as { extra?: string }).extra, undefined)

  // A dialog the desktop answered closes the phone's copy through the
  // supervisor's broadcast, even though the phone never posted /api/dialog.
  const fileKey = process.platform === 'win32' ? path.resolve(resolved.file).toLowerCase() : path.resolve(resolved.file)
  h.internals.pendingDialogs.set(fileKey, { id: 'dlg-2' } as never)
  const writes: string[] = []
  const heartbeat = setInterval(() => {}, 60_000)
  const internals = h.internals as unknown as {
    streams: Set<{ fileKey: string; deviceId: string; workspaceId: string; sessionId: string; response: { write: (data: string) => boolean; end: () => void }; heartbeat: ReturnType<typeof setInterval> }>
    sessionRefs: Map<string, { workspaceId: string; sessionId: string; cwd: string; file: string }>
  }
  internals.sessionRefs.set(fileKey, { workspaceId: 'workspace-1', sessionId: h.sessionId, cwd: h.workspacePath, file: resolved.file })
  internals.streams.add({
    fileKey, deviceId: device.id, workspaceId: 'workspace-1', sessionId: h.sessionId,
    response: { write: (data) => { writes.push(data); return true }, end: () => {} }, heartbeat
  })
  try {
    h.internals.onUiResponded({ ownerId: resolved.file, id: 'dlg-2' })
    assert.equal(writes.length, 1)
    assert.match(writes[0], /remote_dialog_closed/)
    assert.ok(writes[0].includes('dlg-2'))
    assert.equal(h.internals.pendingDialogs.size, 0)
  } finally {
    clearInterval(heartbeat)
  }

  // A stale id is rejected; a dialog already answered by the desktop likewise
  // cannot be answered again from the phone.
  const stale = await h.post('/api/dialog', { workspaceId: 'workspace-1', sessionId: h.sessionId, id: 'dlg-2', response: { confirmed: true } })
  assert.equal(stale.status, 409)
})

test('POST /api/message with no sessionId starts a draft and returns the rekeyed session', async (t) => {
  const h = harness(t)
  const ensures: Array<Record<string, unknown>> = []
  const requests: Array<Record<string, unknown>> = []
  h.supervisor.ensure = async (options: Record<string, unknown>) => { ensures.push(options); return { ok: true } }
  h.supervisor.request = async (...args: unknown[]) => {
    requests.push({ key: args[0], command: args[1], payload: args[2], trace: args[4] })
    const draftKey = args[0] as string
    setImmediate(() => h.supervisor.emit('rekey', { from: draftKey, to: h.sessionFile }))
    return {}
  }
  const result = await h.post('/api/message', { workspaceId: 'workspace-1', message: 'hello new chat' })
  assert.equal(result.status, 200)
  assert.equal(result.body.sessionId, h.sessionId)
  assert.match(String(ensures[0].sessionKey), /^draft:/)
  assert.equal(ensures[0].sessionFile, undefined, 'a new conversation has no persisted session file yet')
  assert.equal(ensures[0].cwd, h.workspacePath)
  assert.equal(requests[0].command, 'prompt')
  assert.deepEqual(requests[0].payload, { message: 'hello new chat', streamingBehavior: 'steer' })
  assert.equal((requests[0].trace as { sourceAction: string }).sourceAction, 'remote-send')
})

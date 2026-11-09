import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import path from 'node:path'
import {
  awaitRemoteDeviceAuthorization,
  configureRemoteHttpServer,
  hasRemoteEventStreamCapacity,
  isPrivateClient,
  MAX_PAIR_ATTEMPT_SOURCES,
  MAX_REMOTE_EVENT_STREAMS,
  MAX_REMOTE_MESSAGE_BODY_BYTES,
  recordPairAttempt,
  RemoteAccessService,
  safeRemoteValue
} from '../src/main/remote-access'
import { MAX_REMOTE_MESSAGE_CHARS } from '../src/shared/types'

function attachOpenTestStream(
  service: RemoteAccessService,
  device: { id: string; name: string; pairedAt: number; tokenHash: string },
  workspace: { id: string; path: string }
) {
  const file = path.join(workspace.path, 'session.jsonl')
  const fileKey = process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
  let ended = 0
  const writes: string[] = []
  const heartbeat = setInterval(() => {}, 60_000)
  const internals = service as unknown as {
    server: object | null
    sessionRefs: Map<string, { workspaceId: string; sessionId: string; cwd: string; file: string }>
    streams: Set<{
      deviceId: string
      workspaceId: string
      sessionId: string
      fileKey: string
      response: { write: (data: string) => boolean; end: () => void }
      heartbeat: ReturnType<typeof setInterval>
    }>
    onRuntimeEvent: (payload: { ownerId: string; event: never }) => void
  }
  internals.server = {}
  internals.sessionRefs.set(fileKey, {
    workspaceId: workspace.id, sessionId: 'session-1', cwd: workspace.path, file
  })
  internals.streams.add({
    deviceId: device.id,
    workspaceId: workspace.id,
    sessionId: 'session-1',
    fileKey,
    response: { write: (data) => { writes.push(data); return true }, end: () => { ended += 1 } },
    heartbeat
  })
  return {
    writes,
    get ended() { return ended },
    get size() { return internals.streams.size },
    emit() { internals.onRuntimeEvent({ ownerId: file, event: { type: 'agent_start' } as never }) },
    async dispose() {
      clearInterval(heartbeat)
      internals.server = null
      await service.dispose()
    }
  }
}

test('remote access accepts loopback clients consistently with its localhost Host routes', () => {
  assert.equal(isPrivateClient('127.0.0.1'), true)
  assert.equal(isPrivateClient('127.42.0.9'), true)
  assert.equal(isPrivateClient('::1'), true)
  assert.equal(isPrivateClient('192.168.1.20'), true)
  assert.equal(isPrivateClient('8.8.8.8'), false)
})

test('remote authorization is checked again after an asynchronous action completes', async () => {
  let authorized = true
  let finish!: (value: string) => void
  const result = new Promise<string>((resolve) => {
    finish = resolve
  })
  const action = awaitRemoteDeviceAuthorization(() => authorized, () => result)

  authorized = false
  finish('private session data')

  await assert.rejects(action, /no longer paired/)
})

test('a revoked remote device cannot start a new asynchronous action', async () => {
  let called = false
  await assert.rejects(
    awaitRemoteDeviceAuthorization(() => false, async () => {
      called = true
      return 'private session data'
    }),
    /no longer paired/
  )
  assert.equal(called, false)
})

test('remote workspace metadata is not returned if another process revokes the device during listing', async (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-workspace-list-revoke-'))
  const stateFile = path.join(userData, 'remote-access.json')
  const accessToken = 'a'.repeat(32)
  const device = {
    id: 'phone-1',
    name: 'Phone',
    pairedAt: 1,
    tokenHash: createHash('sha256').update(accessToken).digest('hex')
  }
  writeFileSync(stateFile, JSON.stringify({ enabled: true, devices: [device] }))
  let revoked = false
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: {
      get: () => {
        if (!revoked) {
          revoked = true
          writeFileSync(stateFile, JSON.stringify({ enabled: true, devices: [] }))
        }
        return { workspaces: [{ id: 'workspace-1', name: 'Private project' }] }
      }
    } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const internals = service as unknown as {
    server: object | null
    handleRequest: (request: unknown, response: unknown) => Promise<void>
  }
  internals.server = {}
  const response = {
    headersSent: false,
    setHeader: () => {},
    writeHead: () => { response.headersSent = true },
    end: () => {}
  }
  const request = {
    method: 'GET',
    url: '/api/workspaces',
    headers: { host: '127.0.0.1', authorization: `Bearer ${accessToken}` },
    socket: { remoteAddress: '127.0.0.1' }
  }

  try {
    await assert.rejects(internals.handleRequest(request, response), /no longer paired/)
    assert.equal(response.headersSent, false)
  } finally {
    internals.server = null
    await service.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a remote session action is rejected if its workspace is removed while awaiting', async (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-workspace-revoke-'))
  const device = { id: 'phone-1', name: 'Phone', pairedAt: 1, tokenHash: 'a'.repeat(64) }
  writeFileSync(path.join(userData, 'remote-access.json'), JSON.stringify({ enabled: true, devices: [device] }))
  const settings = { workspaces: [{ id: 'workspace-1', path: 'C:/workspace' }] }
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => settings } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const internals = service as unknown as {
    server: object | null
    awaitSessionAction: <T>(
      deviceId: string,
      ref: { workspaceId: string; sessionId: string; cwd: string; file: string },
      action: () => Promise<T>
    ) => Promise<T>
  }
  internals.server = {}
  t.after(async () => {
    internals.server = null
    await service.dispose()
    rmSync(userData, { recursive: true, force: true })
  })

  let finish!: (value: string) => void
  const action = internals.awaitSessionAction('phone-1', {
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    cwd: 'C:/workspace',
    file: 'C:/workspace/session.jsonl'
  }, () => new Promise<string>((resolve) => { finish = resolve }))

  settings.workspaces = []
  finish('private session data')
  await assert.rejects(action, /project is no longer registered/)
})

test('a remote prompt queued in Pi is reauthorized immediately before dispatch', async (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-queued-send-'))
  const stateFile = path.join(userData, 'remote-access.json')
  const device = { id: 'phone-1', name: 'Phone', pairedAt: 1, tokenHash: 'a'.repeat(64) }
  writeFileSync(stateFile, JSON.stringify({ enabled: true, devices: [device] }))

  const supervisor = new EventEmitter()
  let promptStarted!: () => void
  const promptRequest = new Promise<void>((resolve) => { promptStarted = resolve })
  let beforeDispatch!: () => void
  let rejectPrompt!: (error: Error) => void
  const remoteSupervisor = supervisor as unknown as {
    ensure: () => Promise<{ ok: boolean }>
    request: (...args: unknown[]) => Promise<void>
  }
  remoteSupervisor.ensure = async () => ({ ok: true })
  remoteSupervisor.request = (...args) => {
    beforeDispatch = args[5] as () => void
    promptStarted()
    return new Promise<void>((_resolve, reject) => { rejectPrompt = reject })
  }

  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => ({ workspaces: [{ id: 'workspace', path: 'C:/workspace' }] }) } as never,
    supervisor: supervisor as never,
    customInstructions: () => undefined
  })
  const internals = service as unknown as {
    server: object | null
    enabled: boolean
    devices: typeof device[]
    resolveSession: (workspaceId: string, sessionId: string) => Promise<{
      workspaceId: string
      sessionId: string
      cwd: string
      file: string
    }>
    sendMessage: (request: unknown, response: unknown, deviceId: string) => Promise<void>
  }
  internals.server = {}
  internals.enabled = true
  internals.devices = [device]
  internals.resolveSession = async (workspaceId, sessionId) => ({
    workspaceId,
    sessionId,
    cwd: 'C:/workspace',
    file: 'C:/workspace/session.jsonl'
  })
  t.after(async () => {
    internals.server = null
    await service.dispose()
    rmSync(userData, { recursive: true, force: true })
  })

  let responded = false
  const request = Object.assign(
    Readable.from([JSON.stringify({ workspaceId: 'workspace', sessionId: 'session', message: 'run this' })]),
    { headers: {} }
  )
  const response = { writeHead: () => response, end: () => { responded = true } }
  const sending = internals.sendMessage(request, response, device.id)
  await promptRequest

  writeFileSync(stateFile, JSON.stringify({ enabled: true, devices: [] }))
  assert.equal(typeof beforeDispatch, 'function')
  let authorizationError: Error | undefined
  try {
    beforeDispatch()
  } catch (error) {
    authorizationError = error as Error
  }
  assert.match(authorizationError?.message ?? '', /no longer paired/)
  rejectPrompt(authorizationError ?? new Error('authorization check did not reject'))

  await assert.rejects(sending, /no longer paired/)
  assert.equal(responded, false)
})

test('a device revoked in one process is rejected and disconnected in another', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-cross-process-revoke-'))
  const stateFile = path.join(userData, 'remote-access.json')
  const device = { id: 'phone-1', name: 'Phone', pairedAt: 1, tokenHash: 'a'.repeat(64) }
  writeFileSync(stateFile, JSON.stringify({ enabled: true, devices: [device] }))
  const makeService = () => new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => ({ workspaces: [] }) } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const first = makeService()
  const second = makeService()
  type ServiceInternals = {
    enabled: boolean
    server: object | null
    devices: typeof device[]
    streams: Set<{
      deviceId: string
      heartbeat: ReturnType<typeof setInterval>
      response: { end: () => void }
    }>
    isDeviceAuthorized: (id: string) => boolean
    persistState: (update: (current: { enabled: boolean; devices: typeof device[] }) => {
      enabled: boolean
      devices: typeof device[]
    }) => Promise<boolean>
  }
  const firstInternals = first as unknown as ServiceInternals
  const secondInternals = second as unknown as ServiceInternals
  const fakeServer = {
    close: (callback: () => void) => callback(),
    closeAllConnections: () => {}
  }
  firstInternals.enabled = true
  firstInternals.server = fakeServer
  firstInternals.devices = [device]
  secondInternals.enabled = true
  secondInternals.server = fakeServer
  secondInternals.devices = [device]
  let ended = 0
  const heartbeat = setInterval(() => {}, 60_000)
  secondInternals.streams.add({
    deviceId: device.id,
    heartbeat,
    response: { end: () => { ended += 1 } }
  })

  try {
    await first.revokeDevice(device.id)
    assert.equal(secondInternals.isDeviceAuthorized(device.id), false)
    assert.equal(ended, 1)
    assert.deepEqual(secondInternals.devices, [])
    await first.setEnabled(false)
    assert.equal(secondInternals.isDeviceAuthorized(device.id), false)
    assert.equal(secondInternals.enabled, false)
    assert.equal(secondInternals.server, null)
    assert.equal(
      await secondInternals.persistState((current) => ({ ...current })),
      true,
      'a fresh state update preserves the revoked device removal'
    )
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')).devices, [])
  } finally {
    clearInterval(heartbeat)
    firstInternals.server = null
    secondInternals.server = null
    await Promise.all([first.dispose(), second.dispose()])
    rmSync(userData, { recursive: true, force: true })
  }
})

test('a device revoked in another process receives no later events on its open stream', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-stream-revoke-'))
  const stateFile = path.join(userData, 'remote-access.json')
  const device = { id: 'phone-1', name: 'Phone', pairedAt: 1, tokenHash: 'a'.repeat(64) }
  writeFileSync(stateFile, JSON.stringify({ enabled: true, devices: [device] }))
  const workspacePath = path.join(userData, 'workspace')
  const workspace = { id: 'workspace-1', path: workspacePath }
  const settings = { workspaces: [workspace] }
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => settings } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const stream = attachOpenTestStream(service, device, workspace)

  try {
    writeFileSync(stateFile, JSON.stringify({ enabled: true, devices: [] }))
    stream.emit()
    assert.equal(stream.ended, 1)
    assert.deepEqual(stream.writes, [])
    assert.equal(stream.size, 0)
  } finally {
    await stream.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('an open event stream closes when its workspace is removed', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-stream-workspace-'))
  const stateFile = path.join(userData, 'remote-access.json')
  const device = { id: 'phone-1', name: 'Phone', pairedAt: 1, tokenHash: 'a'.repeat(64) }
  writeFileSync(stateFile, JSON.stringify({ enabled: true, devices: [device] }))
  const workspacePath = path.join(userData, 'workspace')
  const workspace = { id: 'workspace-1', path: workspacePath }
  const settings = { workspaces: [workspace] }
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => settings } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const stream = attachOpenTestStream(service, device, workspace)

  try {
    settings.workspaces = []
    stream.emit()
    assert.equal(stream.ended, 1)
    assert.deepEqual(stream.writes, [])
    assert.equal(stream.size, 0)
  } finally {
    await stream.dispose()
    rmSync(userData, { recursive: true, force: true })
  }
})

test('remote access serializes concurrent enable and disable transitions', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-lifecycle-'))
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => ({ workspaces: [] }) } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const internals = service as unknown as {
    startServer: () => Promise<void>
    stopServer: () => Promise<void>
    enabled: boolean
    server: object | null
    port: number | undefined
  }
  let releaseStart!: () => void
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve })
  let starts = 0
  let stops = 0
  internals.startServer = async () => {
    starts += 1
    await startGate
    internals.server = {}
    internals.port = 1234
    internals.enabled = true
  }
  internals.stopServer = async () => {
    stops += 1
    internals.server = null
    internals.port = undefined
  }

  try {
    const firstEnable = service.setEnabled(true)
    const secondEnable = service.setEnabled(true)
    const disable = service.setEnabled(false)
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(starts, 1, 'a second enable waits for the first startup')
    assert.equal(stops, 0, 'disable waits for the pending startup before stopping it')

    releaseStart()
    const [first, second, final] = await Promise.all([firstEnable, secondEnable, disable])
    assert.equal(first.enabled, true, JSON.stringify(first))
    assert.equal(second.enabled, true, JSON.stringify(second))
    assert.equal(final.enabled, false)
    assert.equal(starts, 1)
    assert.equal(stops, 1)
    assert.equal(internals.server, null)
  } finally {
    releaseStart()
    await service.dispose().catch(() => {})
    rmSync(userData, { recursive: true, force: true })
  }
})

test('startup persistence failure closes the listener it already started', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-startup-'))
  writeFileSync(path.join(userData, 'remote-access.json'), JSON.stringify({ enabled: true, devices: [] }))
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => ({ workspaces: [] }) } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const internals = service as unknown as {
    enabled: boolean
    server: object | null
    port: number | undefined
    startServer: () => Promise<void>
    stopServer: () => Promise<void>
    writeState: () => void
  }
  let stops = 0
  internals.startServer = async () => {
    internals.enabled = true
    internals.server = {}
    internals.port = 1234
  }
  internals.stopServer = async () => {
    stops += 1
    internals.server = null
    internals.port = undefined
  }
  internals.writeState = () => { throw new Error('disk full') }

  try {
    const status = await service.initialize()
    assert.equal(status.enabled, false)
    assert.match(status.error ?? '', /settings could not be saved/)
    assert.equal(stops, 1)
    assert.equal(internals.server, null)
    assert.equal(internals.enabled, false)
    assert.deepEqual(JSON.parse(readFileSync(path.join(userData, 'remote-access.json'), 'utf8')), {
      enabled: false,
      devices: []
    })
  } finally {
    await service.dispose().catch(() => {})
    rmSync(userData, { recursive: true, force: true })
  }
})

test('remote shutdown force-closes connections before waiting for the server to drain', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-close-'))
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => ({ workspaces: [] }) } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const internals = service as unknown as {
    stopServer: () => Promise<void>
    server: object | null
    port: number | undefined
  }
  let closeListener!: (error?: Error) => void
  let stoppedAccepting = false
  let closedConnections = false
  internals.server = {
    close: (callback: (error?: Error) => void) => {
      stoppedAccepting = true
      closeListener = callback
    },
    closeAllConnections: () => {
      closedConnections = true
      closeListener()
    }
  }
  internals.port = 1234

  try {
    await internals.stopServer()
    assert.equal(stoppedAccepting, true)
    assert.equal(closedConnections, true)
    assert.equal(internals.server, null)
  } finally {
    await service.dispose().catch(() => {})
    rmSync(userData, { recursive: true, force: true })
  }
})

test('remote disable stays disabled across restart when saving settings fails', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-disable-'))
  writeFileSync(path.join(userData, 'remote-access.json'), JSON.stringify({
    enabled: true,
    devices: [{ id: 'phone-1', name: 'Phone', pairedAt: 1, tokenHash: 'a'.repeat(64) }]
  }))
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => ({ workspaces: [] }) } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const internals = service as unknown as {
    writeState: () => void
    stopServer: () => Promise<void>
    enabled: boolean
    server: object | null
    port: number | undefined
    devices: { id: string; name: string; pairedAt: number; tokenHash: string }[]
  }
  let stops = 0
  internals.enabled = true
  internals.server = {}
  internals.port = 1234
  internals.devices = [{ id: 'phone-1', name: 'Phone', pairedAt: 1, tokenHash: 'a'.repeat(64) }]
  internals.stopServer = async () => {
    stops += 1
    internals.server = null
    internals.port = undefined
  }
  internals.writeState = () => { throw new Error('disk full') }

  try {
    const status = await service.setEnabled(false)
    assert.equal(status.enabled, false)
    assert.match(status.error ?? '', /settings could not be saved/)
    assert.equal(stops, 1)
    assert.equal(internals.server, null)
    assert.equal(internals.enabled, false)
    assert.deepEqual(JSON.parse(readFileSync(path.join(userData, 'remote-access.json'), 'utf8')), {
      enabled: false,
      devices: []
    })

    const restarted = new RemoteAccessService({
      userData,
      uiDirectory: userData,
      settings: { get: () => ({ workspaces: [] }) } as never,
      supervisor: new EventEmitter() as never,
      customInstructions: () => undefined
    })
    assert.equal((await restarted.initialize()).enabled, false)
    await restarted.dispose()
  } finally {
    await service.dispose().catch(() => {})
    rmSync(userData, { recursive: true, force: true })
  }
})

test('failed device revocation still closes its live event streams', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-revoke-'))
  const stateFile = path.join(userData, 'remote-access.json')
  writeFileSync(stateFile, JSON.stringify({
    enabled: true,
    devices: [{ id: 'phone-1', name: 'Phone', pairedAt: 1, tokenHash: 'a'.repeat(64) }]
  }))
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => ({ workspaces: [] }) } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const internals = service as unknown as {
    devices: { id: string; name: string; pairedAt: number; tokenHash: string }[]
    enabled: boolean
    server: object | null
    port: number | undefined
    streams: Set<{
      deviceId: string
      heartbeat: ReturnType<typeof setInterval>
      response: { end: () => void }
    }>
    writeState: () => void
  }
  internals.devices = [{ id: 'phone-1', name: 'Phone', pairedAt: Date.now(), tokenHash: 'a'.repeat(64) }]
  internals.enabled = true
  internals.server = {
    close: (callback: () => void) => callback(),
    closeAllConnections: () => {}
  }
  internals.port = 1234
  let ended = 0
  const heartbeat = setInterval(() => {}, 60_000)
  internals.streams.add({
    deviceId: 'phone-1',
    heartbeat,
    response: { end: () => { ended += 1 } }
  })
  internals.writeState = () => { throw new Error('disk full') }

  try {
    const status = await service.revokeDevice('phone-1')
    assert.equal(status.enabled, false)
    assert.match(status.error ?? '', /settings could not be saved/)
    assert.equal(ended, 1)
    assert.equal(internals.streams.size, 0)
    assert.equal(internals.devices.length, 0)
    assert.equal(internals.server, null)
    assert.deepEqual(JSON.parse(readFileSync(stateFile, 'utf8')), { enabled: false, devices: [] })

    const restarted = new RemoteAccessService({
      userData,
      uiDirectory: userData,
      settings: { get: () => ({ workspaces: [] }) } as never,
      supervisor: new EventEmitter() as never,
      customInstructions: () => undefined
    })
    const restartedStatus = await restarted.initialize()
    assert.equal(restartedStatus.enabled, false)
    assert.deepEqual(restartedStatus.devices, [])
    await restarted.dispose()
  } finally {
    await service.dispose().catch(() => {})
    rmSync(userData, { recursive: true, force: true })
  }
})

test('the remote request byte limit can carry the maximum prompt including JSON escaping', () => {
  const message = '\u0000'.repeat(MAX_REMOTE_MESSAGE_CHARS)
  const body = JSON.stringify({ workspaceId: 'workspace', sessionId: 'session', message })
  assert.equal(message.length, MAX_REMOTE_MESSAGE_CHARS)
  assert.ok(Buffer.byteLength(body) <= MAX_REMOTE_MESSAGE_BODY_BYTES)
})

test('remote event streams have a fixed upper bound', () => {
  assert.equal(hasRemoteEventStreamCapacity(MAX_REMOTE_EVENT_STREAMS - 1), true)
  assert.equal(hasRemoteEventStreamCapacity(MAX_REMOTE_EVENT_STREAMS), false)
})

test('remote HTTP listener bounds open connections and slow request intake', () => {
  const server = createServer()
  configureRemoteHttpServer(server)
  assert.equal(server.maxConnections, 64)
  assert.equal(server.headersTimeout, 15_000)
  assert.equal(server.requestTimeout, 120_000)
})

test('pairing attempts expire and remain bounded across changing source addresses', () => {
  const attempts = new Map<string, { count: number; resetsAt: number }>()
  for (let index = 0; index < 8; index += 1) {
    assert.equal(recordPairAttempt(attempts, '192.168.1.5', index), true)
  }
  assert.equal(recordPairAttempt(attempts, '192.168.1.5', 9), false)

  for (let index = 0; index < MAX_PAIR_ATTEMPT_SOURCES * 2; index += 1) {
    assert.equal(recordPairAttempt(attempts, `source-${index}`, 10), true)
  }
  assert.equal(attempts.size, MAX_PAIR_ATTEMPT_SOURCES)

  assert.equal(recordPairAttempt(attempts, '192.168.1.5', 61_000), true)
  assert.equal(attempts.size, 1, 'expired source buckets are discarded when the next request arrives')
})

test('a pairing code can authorize only one concurrent device', async (t) => {
  const userData = mkdtempSync(path.join(tmpdir(), 'pi-remote-pair-race-'))
  const stateFile = path.join(userData, 'remote-access.json')
  writeFileSync(stateFile, JSON.stringify({ enabled: true, devices: [] }))
  const service = new RemoteAccessService({
    userData,
    uiDirectory: userData,
    settings: { get: () => ({ workspaces: [] }) } as never,
    supervisor: new EventEmitter() as never,
    customInstructions: () => undefined
  })
  const internals = service as unknown as {
    enabled: boolean
    server: object | null
    pairing: { secret: string; expiresAt: number } | undefined
    persistState: (update: (current: { enabled: boolean; devices: { id: string }[] }) => {
      enabled: boolean
      devices: { id: string }[]
    }) => Promise<boolean>
    pairDevice: (request: unknown, response: unknown) => Promise<void>
  }
  internals.enabled = true
  internals.server = {}
  internals.pairing = { secret: 'one-time-code', expiresAt: Date.now() + 60_000 }
  const persistState = internals.persistState.bind(service)
  let beginPersist!: () => void
  let finishPersist!: () => void
  const persistStarted = new Promise<void>((resolve) => { beginPersist = resolve })
  const persistGate = new Promise<void>((resolve) => { finishPersist = resolve })
  let persistCalls = 0
  internals.persistState = async (update) => {
    persistCalls += 1
    if (persistCalls === 1) {
      beginPersist()
      await persistGate
    }
    return persistState(update)
  }
  t.after(async () => {
    internals.server = null
    await service.dispose().catch(() => {})
    rmSync(userData, { recursive: true, force: true })
  })

  const request = (deviceName: string) => Object.assign(
    Readable.from([JSON.stringify({ secret: 'one-time-code', deviceName })]),
    { headers: {}, socket: { remoteAddress: '192.168.1.10' } }
  )
  const response = () => ({
    statusCode: undefined as number | undefined,
    body: undefined as string | undefined,
    writeHead(status: number) { this.statusCode = status; return this },
    end(body?: string) { this.body = body }
  })
  const firstResponse = response()
  const firstPairing = internals.pairDevice(request('First phone'), firstResponse)
  await persistStarted

  const secondResponse = response()
  try {
    await assert.rejects(
      internals.pairDevice(request('Second phone'), secondResponse),
      /expired or was already used/
    )
  } finally {
    finishPersist()
  }
  await firstPairing

  assert.equal(firstResponse.statusCode, 200)
  assert.equal(secondResponse.body, undefined)
  assert.equal(persistCalls, 1)
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).devices.length, 1)
})

test('safeRemoteValue omits deep payloads instead of bypassing mobile redaction and limits', () => {
  let value: unknown = {
    cwd: 'C:/private/project',
    sessionFile: 'C:/private/sessions/chat.jsonl',
    type: 'image',
    data: 'A'.repeat(1_000_000)
  }
  for (let depth = 0; depth < 14; depth += 1) value = { nested: value }

  const serialized = JSON.stringify(safeRemoteValue(value))
  assert.equal(serialized.includes('C:/private'), false)
  assert.equal(serialized.includes('A'.repeat(100)), false)
  assert.ok(serialized.length < 250)
})

test('safeRemoteValue bounds wide nested payloads across the whole value', () => {
  const longText = 'x'.repeat(16_000)
  const nestedText = Array.from({ length: 100 }, () =>
    Array.from({ length: 100 }, () => longText)
  )
  const textResult = JSON.stringify(safeRemoteValue(nestedText))
  assert.ok(textResult.length < 500_000)
  assert.ok(textResult.includes('[Content omitted on mobile]'))

  const nestedNumbers = Array.from({ length: 100 }, () =>
    Array.from({ length: 100 }, (_, index) => index)
  )
  assert.ok(JSON.stringify(safeRemoteValue(nestedNumbers)).length < 20_000)
})

test('safeRemoteValue still redacts and replaces shallow sensitive values', () => {
  assert.deepEqual(
    safeRemoteValue({
      cwd: 'C:/private/project',
      sessionFile: 'C:/private/sessions/chat.jsonl',
      content: [{ type: 'image', data: 'image bytes' }],
      details: { image: { data: 'A'.repeat(20_000), mimeType: 'image/png' } },
      toolCall: {
        arguments: {
          path: 'C:/private/project/src/app.ts',
          filePath: 'C:/private/project/src/app.ts',
          absolutePath: 'C:/private/project/src/app.ts'
        }
      }
    }),
    {
      content: [{ type: 'text', text: '[Image omitted on mobile]' }],
      details: { image: { type: 'text', text: '[Image omitted on mobile]' } },
      toolCall: { arguments: {} }
    }
  )
})

test('safeRemoteValue strips hidden reasoning from snapshots and live deltas', () => {
  const snapshot = safeRemoteValue({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'private reasoning', thinkingSignature: 'private signature' },
      { type: 'text', text: 'visible answer' }
    ]
  }) as { content: Array<Record<string, unknown>> }
  const delta = safeRemoteValue({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'thinking_delta',
      contentIndex: 0,
      delta: 'private streamed reasoning'
    }
  }) as { assistantMessageEvent: Record<string, unknown> }
  const end = safeRemoteValue({
    type: 'thinking_end',
    content: 'private completed reasoning'
  }) as Record<string, unknown>

  const serialized = JSON.stringify({ snapshot, delta, end })
  assert.equal(serialized.includes('private reasoning'), false)
  assert.equal(serialized.includes('private signature'), false)
  assert.equal(serialized.includes('private streamed reasoning'), false)
  assert.equal(serialized.includes('private completed reasoning'), false)
  assert.equal(snapshot.content[0]?.type, 'thinking')
  assert.equal(snapshot.content[1]?.text, 'visible answer')
  assert.equal(delta.assistantMessageEvent.contentIndex, 0)
})

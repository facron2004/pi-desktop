import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { app, ipcMain } from 'electron'
import { registerIpc } from '../src/main/ipc'
import type { IpcContext } from '../src/main/ipc'
import type { RuntimeEnsureOptions } from '../src/shared/types'

test('runtime ensure reuses a live draft before Pi has flushed its session file', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-runtime-ensure-'))
  const otherWorkspace = path.join(root, 'other')
  mkdirSync(root, { recursive: true })
  mkdirSync(otherWorkspace)
  const sessionFile = path.join(root, 'not-yet-written.jsonl')
  const originalSessionRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const ensureCalls: RuntimeEnsureOptions[] = []
  const liveKeys = new Set([sessionFile])
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    registerIpc({
      supervisor: {
        has: (key: string) => liveKeys.has(key),
        sessionInfo: (key: string) => liveKeys.has(key) ? { cwd: root } : undefined,
        ensure: async (options: RuntimeEnsureOptions) => {
          ensureCalls.push(options)
          return { ok: true }
        }
      },
      settings: {
        get: () => ({
          activeWorkspaceId: 'workspace',
          workspaces: [
            { id: 'workspace', path: root },
            { id: 'other', path: otherWorkspace }
          ]
        })
      },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const invoke = async (options: RuntimeEnsureOptions) => {
      const handler = handlers.get('runtime:ensure')
      assert.ok(handler, 'runtime:ensure handler was registered')
      return await handler({}, options) as { ok: boolean; error?: string }
    }

    const reused = await invoke({ sessionKey: sessionFile, cwd: root, sessionFile })
    assert.equal(reused.ok, true)
    assert.equal(ensureCalls.length, 1)
    assert.equal(ensureCalls[0]?.sessionFile, undefined)

    const wrongCwd = await invoke({ sessionKey: sessionFile, cwd: otherWorkspace, sessionFile })
    assert.equal(wrongCwd.ok, false)
    assert.equal(wrongCwd.error, 'Conversation belongs to a different working folder.')
    assert.equal(ensureCalls.length, 1, 'a live session must not be reused from another workspace')

    const draftKey = 'draft:reused'
    liveKeys.add(draftKey)
    const wrongDraftCwd = await invoke({ sessionKey: draftKey, cwd: otherWorkspace })
    assert.equal(wrongDraftCwd.ok, false)
    assert.equal(wrongDraftCwd.error, 'Conversation belongs to a different working folder.')
    assert.equal(ensureCalls.length, 1, 'a live draft cannot be rebound without a session file')

    liveKeys.clear()
    const rejected = await invoke({ sessionKey: sessionFile, cwd: root, sessionFile })
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error, "Conversation file is not in Pi's session store.")
    assert.equal(ensureCalls.length, 1, 'an unknown path never reaches the supervisor')
  } finally {
    if (originalSessionRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = originalSessionRoot
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime start and ensure reject a workspace removed during path validation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-runtime-workspace-remove-'))
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const ensureCalls: RuntimeEnsureOptions[] = []
  let workspaces = [{ id: 'workspace', path: root }]
  let settingsReads = 0
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    registerIpc({
      supervisor: {
        ensure: async (options: RuntimeEnsureOptions) => {
          ensureCalls.push(options)
          return { ok: true }
        }
      },
      settings: {
        get: () => {
          settingsReads += 1
          return { workspaces }
        }
      },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const cases: [string, RuntimeEnsureOptions][] = [
      ['runtime:start', { cwd: root }],
      ['runtime:ensure', { sessionKey: 'draft:removed', cwd: root }]
    ]
    for (const [channel, options] of cases) {
      workspaces = [{ id: 'workspace', path: root }]
      const handler = handlers.get(channel)
      assert.ok(handler, `${channel} handler was registered`)
      const readsBefore = settingsReads
      const pending = handler({}, options)
      assert.equal(settingsReads, readsBefore + 1, 'the workspace is authorized before async path checks')
      workspaces = []
      assert.deepEqual(await pending, {
        ok: false,
        error: 'Working folder is no longer an available workspace.'
      })
    }

    assert.deepEqual(ensureCalls, [], 'a removed workspace must never reach the supervisor')
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(root, { recursive: true, force: true })
  }
})

test('runtime stop requires a conversation id and cannot stop every runtime', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const stopped: unknown[] = []
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    registerIpc({
      supervisor: { stop: async (key: string) => { stopped.push(key) } },
      settings: { get: () => ({ workspaces: [] }) },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const handler = handlers.get('runtime:stop')
    assert.ok(handler, 'runtime:stop handler was registered')
    await handler({}, undefined)
    await handler({}, null)
    await handler({}, '   ')
    assert.deepEqual(stopped, [])

    await handler({}, 'conversation-a')
    assert.deepEqual(stopped, ['conversation-a'])
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
  }
})

test('runtime stopCwd is limited to an exact registered project root', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'runtime-stop-scope-'))
  const workspace = path.join(parent, 'workspace')
  mkdirSync(workspace)
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const operations: string[] = []
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    registerIpc({
      supervisor: {
        stopCwd: async (cwd: string, afterStop?: () => void) => {
          operations.push(`stop:${cwd}`)
          afterStop?.()
        }
      },
      settings: {
        get: () => ({
          activeWorkspaceId: 'workspace',
          workspaces: [{ id: 'workspace', path: workspace }]
        }),
        removeWorkspace: () => {
          operations.push('remove')
          return { activeWorkspaceId: null, workspaces: [] }
        }
      },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const stopCwd = handlers.get('runtime:stopCwd')
    const removeWorkspace = handlers.get('workspaces:remove')
    assert.ok(stopCwd, 'runtime:stopCwd handler was registered')
    assert.ok(removeWorkspace, 'workspaces:remove handler was registered')

    await stopCwd({}, parent)
    await stopCwd({}, null)
    assert.deepEqual(operations, [], 'an unregistered parent path cannot stop project runtimes')

    await stopCwd({}, workspace)
    assert.deepEqual(operations, [`stop:${workspace}`])

    operations.length = 0
    await removeWorkspace({}, 'workspace')
    assert.deepEqual(operations, [`stop:${workspace}`, 'remove'])
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    rmSync(parent, { recursive: true, force: true })
  }
})

test('a packaged build cannot install the Pi CLI into its app directory', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const packagedDescriptor = Object.getOwnPropertyDescriptor(app, 'isPackaged')
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })
  Object.defineProperty(app, 'isPackaged', { configurable: true, value: true })

  try {
    registerIpc({
      supervisor: {},
      settings: { get: () => ({ workspaces: [] }) },
      getWindow: () => null,
      terminals: { create: () => ({}) },
      memory: { promptFor: () => '' }
    } as unknown as IpcContext)

    const upgrade = handlers.get('app:upgradePiCli')
    assert.ok(upgrade, 'app:upgradePiCli handler was registered')
    assert.deepEqual(await upgrade({}), {
      success: false,
      error: 'The bundled Pi CLI is updated with Pi Desktop releases.'
    })
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
    if (packagedDescriptor) Object.defineProperty(app, 'isPackaged', packagedDescriptor)
    else delete (app as unknown as { isPackaged?: unknown }).isPackaged
  }
})

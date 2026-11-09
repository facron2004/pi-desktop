import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ipcMain } from 'electron'
import { registerIpc } from '../src/main/ipc'
import type { IpcContext } from '../src/main/ipc'
import type { RuntimeEnsureOptions } from '../src/shared/types'

test('runtime ensure reuses a live draft before Pi has flushed its session file', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-runtime-ensure-'))
  mkdirSync(root, { recursive: true })
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
        ensure: async (options: RuntimeEnsureOptions) => {
          ensureCalls.push(options)
          return { ok: true }
        }
      },
      settings: {
        get: () => ({ activeWorkspaceId: null, workspaces: [] })
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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ipcMain } from 'electron'
import { registerIpc } from '../src/main/ipc'
import type { IpcContext } from '../src/main/ipc'

test('a full-window layer disables the native window controls until it unmounts', async () => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
  const handleDescriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  const calls: Array<[string, boolean]> = []
  const window = {
    isDestroyed: () => false,
    setClosable: (value: boolean) => calls.push(['closable', value]),
    setMinimizable: (value: boolean) => calls.push(['minimizable', value]),
    setMaximizable: (value: boolean) => calls.push(['maximizable', value])
  }
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: unknown) => {
      handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown)
    }
  })

  try {
    registerIpc({
      getWindow: () => window,
      settings: { get: () => ({}) },
      supervisor: {},
      terminals: {},
      memory: {}
    } as unknown as IpcContext)

    const handler = handlers.get('app:setWindowControlsEnabled')
    assert.ok(handler, 'app:setWindowControlsEnabled handler was registered')

    // A modal or lightbox covers the window: maximize/minimize/close must not
    // act on the window behind the scrim.
    await handler({}, false)
    assert.deepEqual(calls, [
      ['closable', false],
      ['minimizable', false],
      ['maximizable', false]
    ])

    calls.length = 0
    await handler({}, true)
    assert.deepEqual(calls, [
      ['closable', true],
      ['minimizable', true],
      ['maximizable', true]
    ])
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ipcMain } from 'electron'
import { registerIpc } from '../src/main/ipc'
import type { IpcContext } from '../src/main/ipc'

test('a full-window layer gates only the close button, never minimize or maximize', async () => {
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

    const handler = handlers.get('app:setWindowClosable')
    assert.ok(handler, 'app:setWindowClosable handler was registered')

    // A modal or lightbox covers the window and waits on an answer: hiding the
    // window behind it would take away the only surface that can answer.
    await handler({}, false)
    assert.deepEqual(calls, [['closable', false]], 'only close is gated while a layer is up')

    calls.length = 0
    await handler({}, true)
    assert.deepEqual(calls, [['closable', true]], 'close returns when the layer unmounts')

    // The window must stay minimizable and maximizable throughout: a reader who
    // opens a settings page still has to be able to move the window aside. Touch
    // the two methods so a future change that greys them out again fails here.
    calls.length = 0
    await handler({}, false)
    assert.equal(calls.some(([name]) => name === 'minimizable'), false)
    assert.equal(calls.some(([name]) => name === 'maximizable'), false)
  } finally {
    if (handleDescriptor) Object.defineProperty(ipcMain, 'handle', handleDescriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
  }
})

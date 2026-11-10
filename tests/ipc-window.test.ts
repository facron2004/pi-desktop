import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sendToWindow } from '../src/main/ipc'

test('sendToWindow checks the actual window and webContents before delivery', () => {
  let sent = 0
  let destroyedWindowContentsReads = 0
  const destroyedWindow = Object.defineProperties(
    { isDestroyed: () => true },
    {
      webContents: {
        get() {
          destroyedWindowContentsReads += 1
          throw new Error('destroyed window contents must not be accessed')
        }
      }
    }
  )

  sendToWindow(destroyedWindow as unknown as Parameters<typeof sendToWindow>[0], 'test', {})
  assert.equal(destroyedWindowContentsReads, 0)

  const destroyedContentsWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => true,
      send: () => { sent += 1 }
    }
  }
  sendToWindow(destroyedContentsWindow as unknown as Parameters<typeof sendToWindow>[0], 'test', {})
  assert.equal(sent, 0)

  const liveWindow = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: () => { sent += 1 }
    }
  }
  sendToWindow(liveWindow as unknown as Parameters<typeof sendToWindow>[0], 'test', {})
  assert.equal(sent, 1)
})

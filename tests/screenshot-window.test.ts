import assert from 'node:assert/strict'
import { app } from 'electron'
import { test } from 'node:test'
import type { CaptureContext } from '../src/main/screenshot'
import { scheduleCapture, scheduleWindowClose } from '../src/main/screenshot'

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('screenshot mode exits when its initial webContents is already destroyed', () => {
  const restoreScreenshot = restoreEnv('PI_DESKTOP_SCREENSHOT')
  const originalExit = app.exit
  let exitCalls = 0
  app.exit = (() => { exitCalls += 1 }) as typeof app.exit
  process.env.PI_DESKTOP_SCREENSHOT = 'not-written.png'
  try {
    scheduleCapture({
      window: {
        isDestroyed: () => false,
        webContents: { isDestroyed: () => true }
      } as unknown as CaptureContext['window']
    })
    assert.equal(exitCalls, 1)
  } finally {
    app.exit = originalExit
    restoreScreenshot()
  }
})

function restoreEnv(name: string): () => void {
  const previous = process.env[name]
  return () => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

test('scheduled screenshot does not start Pi after its window closes', async () => {
  const restoreScreenshot = restoreEnv('PI_DESKTOP_SCREENSHOT')
  const restorePrompt = restoreEnv('PI_DESKTOP_PROMPT')
  const restoreWorkspace = restoreEnv('PI_DESKTOP_WORKSPACE')
  let destroyed = false
  let ensureCalls = 0
  let contentsReadsAfterClose = 0
  const contents = { isDestroyed: () => false, on: () => {} }
  const window = Object.defineProperties(
    {
      isDestroyed: () => destroyed,
      isVisible: () => true,
      show: () => {},
      focus: () => {}
    },
    {
      webContents: {
        get() {
          if (destroyed) {
            contentsReadsAfterClose += 1
            throw new Error('closed window contents must not be accessed')
          }
          return contents
        }
      }
    }
  )

  process.env.PI_DESKTOP_SCREENSHOT = 'not-written.png'
  process.env.PI_DESKTOP_PROMPT = 'must not start after close'
  process.env.PI_DESKTOP_WORKSPACE = process.cwd()
  try {
    scheduleCapture({
      window: window as unknown as CaptureContext['window'],
      supervisor: {
        runningKeys: () => [],
        ensure: async () => {
          ensureCalls += 1
          return { ok: true }
        }
      } as unknown as CaptureContext['supervisor']
    })
    destroyed = true
    await pause(1_650)
    assert.equal(ensureCalls, 0)
    assert.equal(contentsReadsAfterClose, 0)
  } finally {
    restoreScreenshot()
    restorePrompt()
    restoreWorkspace()
  }
})

test('screenshot capture stops if the window closes during its settle delay', async () => {
  const restoreScreenshot = restoreEnv('PI_DESKTOP_SCREENSHOT')
  const restoreDelay = restoreEnv('PI_DESKTOP_SCREENSHOT_DELAY')
  const restorePrompt = restoreEnv('PI_DESKTOP_PROMPT')
  let destroyed = false
  let captureCalls = 0
  let contentsReadsAfterClose = 0
  const contents = {
    isDestroyed: () => false,
    on: () => {},
    capturePage: async () => {
      captureCalls += 1
      return { toPNG: () => Buffer.from('png') }
    }
  }
  const window = Object.defineProperties(
    {
      isDestroyed: () => destroyed,
      isVisible: () => true,
      show: () => {},
      focus: () => { destroyed = true }
    },
    {
      webContents: {
        get() {
          if (destroyed) {
            contentsReadsAfterClose += 1
            throw new Error('closed window contents must not be accessed')
          }
          return contents
        }
      }
    }
  )

  process.env.PI_DESKTOP_SCREENSHOT = 'not-written.png'
  process.env.PI_DESKTOP_SCREENSHOT_DELAY = '0'
  delete process.env.PI_DESKTOP_PROMPT
  try {
    scheduleCapture({ window: window as unknown as CaptureContext['window'] })
    await pause(2_100)
    assert.equal(contentsReadsAfterClose, 0)
    assert.equal(captureCalls, 0)
  } finally {
    restoreScreenshot()
    restoreDelay()
    restorePrompt()
  }
})

test('scheduled close ignores a window the user already closed', async () => {
  const restoreCloseAfter = restoreEnv('PI_DESKTOP_CLOSE_AFTER_MS')
  let destroyed = false
  let closeCalls = 0
  process.env.PI_DESKTOP_CLOSE_AFTER_MS = '10'
  try {
    scheduleWindowClose({
      window: {
        isDestroyed: () => destroyed,
        close: () => { closeCalls += 1 }
      } as unknown as CaptureContext['window']
    })
    destroyed = true
    await pause(30)
    assert.equal(closeCalls, 0)
  } finally {
    restoreCloseAfter()
  }
})

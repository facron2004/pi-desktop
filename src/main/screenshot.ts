import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PiRuntime } from './pi/runtime'

export interface CaptureContext {
  window: BrowserWindow
  runtime: PiRuntime
}

/**
 * Development helper: capture the running window to a PNG and exit.
 *
 * Enabled only when PI_DESKTOP_SCREENSHOT is set, so it never affects
 * normal runs or packaged builds.
 *
 * Environment:
 *   PI_DESKTOP_SCREENSHOT        target PNG path
 *   PI_DESKTOP_SCREENSHOT_DELAY  ms to wait before the capture (default 4000)
 *   PI_DESKTOP_PROMPT            optional prompt to send once Pi is ready
 *   PI_DESKTOP_EVAL              JS to run in the renderer just before the
 *                                capture, used to drive transient UI
 *   PI_DESKTOP_EVAL_DELAY        ms to wait after the eval (default 400)
 */
export function scheduleCapture(context: CaptureContext): void {
  const target = process.env.PI_DESKTOP_SCREENSHOT
  if (!target) return

  const delay = Number(process.env.PI_DESKTOP_SCREENSHOT_DELAY ?? 4000)
  const prompt = process.env.PI_DESKTOP_PROMPT
  const evalScript = process.env.PI_DESKTOP_EVAL
  const evalDelay = Number(process.env.PI_DESKTOP_EVAL_DELAY ?? 400)

  const capture = async () => {
    try {
      if (!context.window.isVisible()) context.window.show()
      context.window.focus()
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (evalScript) {
        try {
          const result = await context.window.webContents.executeJavaScript(evalScript, true)
          console.log('[pi-desktop] eval result:', JSON.stringify(result))
        } catch (error) {
          console.error('[pi-desktop] eval failed:', error)
        }
        // Give React a frame to settle before the pixels are read.
        await new Promise((resolve) => setTimeout(resolve, evalDelay))
      }
      const image = await context.window.webContents.capturePage()
      mkdirSync(path.dirname(path.resolve(target)), { recursive: true })
      writeFileSync(path.resolve(target), image.toPNG())
      console.log(`[pi-desktop] screenshot written to ${target}`)
    } catch (error) {
      console.error('[pi-desktop] screenshot failed:', error)
    }
    app.exit(0)
  }

  const waitForReady = async () => {
    if (context.runtime.currentStatus.phase === 'ready') {
      if (prompt) {
        // Not awaited: a prompt that opens a dialog (an extension asking for
        // input) never resolves until the user answers, and the capture delay
        // has to run alongside it.
        void context.runtime
          .request('prompt', { message: prompt })
          .then(() => console.log('[pi-desktop] prompt accepted'))
          .catch((error: unknown) => {
            console.error('[pi-desktop] prompt failed:', error)
          })
      }
      setTimeout(() => void capture(), delay)
      return
    }
    if (context.runtime.currentStatus.phase === 'error') {
      setTimeout(() => void capture(), 1500)
      return
    }
    setTimeout(() => void waitForReady(), 300)
  }

  setTimeout(() => void waitForReady(), 1500)
}

/**
 * Development helper: close the window while Pi is still working.
 *
 * This reproduces the case that used to crash the main process with
 * "Object has been destroyed" when late protocol records reached a window
 * that was already closing.
 *
 * Environment:
 *   PI_DESKTOP_CLOSE_AFTER_MS  ms after start at which the window closes
 */
export function scheduleWindowClose(context: CaptureContext): void {
  const closeAfter = Number(process.env.PI_DESKTOP_CLOSE_AFTER_MS ?? 0)
  if (closeAfter <= 0) return
  setTimeout(() => {
    console.log('[pi-desktop] closing the window on purpose')
    context.window.close()
  }, closeAfter)

  // Keep the process alive after the window is gone so Pi keeps streaming
  // into a window that no longer exists. That is the case that used to
  // throw "Object has been destroyed".
  const exitAfter = Number(process.env.PI_DESKTOP_EXIT_AFTER_MS ?? 0)
  if (exitAfter > 0) {
    setTimeout(() => {
      console.log('[pi-desktop] exiting after the close test')
      app.exit(0)
    }, exitAfter)
  }
}

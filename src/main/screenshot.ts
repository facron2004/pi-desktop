import { app, type BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SessionSupervisor } from './pi/supervisor'

export interface CaptureContext {
  window: BrowserWindow
  supervisor?: SessionSupervisor
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
  const window = context.window
  if (window.isDestroyed()) {
    app.exit(0)
    return
  }
  const initialContents = window.webContents
  if (!initialContents || initialContents.isDestroyed()) {
    app.exit(0)
    return
  }

  // Warnings and errors from the renderer are worth seeing while looking at
  // a screenshot — a React key warning shows up as a broken layout.
  initialContents.on('console-message', (details) => {
    if (details.level === 'warning' || details.level === 'error') {
      console.error(`[pi-desktop] renderer ${details.level}: ${details.message}`)
    }
  })

  const delay = Number(process.env.PI_DESKTOP_SCREENSHOT_DELAY ?? 4000)
  const prompt = process.env.PI_DESKTOP_PROMPT
  const evalScript = process.env.PI_DESKTOP_EVAL
  const evalDelay = Number(process.env.PI_DESKTOP_EVAL_DELAY ?? 400)

  const capture = async () => {
    try {
      if (window.isDestroyed()) return
      if (!window.isVisible()) window.show()
      window.focus()
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (window.isDestroyed()) return
      if (evalScript) {
        try {
          const contents = window.webContents
          if (contents.isDestroyed()) return
          const result = await contents.executeJavaScript(evalScript, true)
          console.log('[pi-desktop] eval result:', JSON.stringify(result))
        } catch (error) {
          console.error('[pi-desktop] eval failed:', error)
        }
        // Give React a frame to settle before the pixels are read.
        await new Promise((resolve) => setTimeout(resolve, evalDelay))
      }
      if (window.isDestroyed()) return
      const contents = window.webContents
      if (contents.isDestroyed()) return
      const image = await contents.capturePage()
      mkdirSync(path.dirname(path.resolve(target)), { recursive: true })
      writeFileSync(path.resolve(target), image.toPNG())
      console.log(`[pi-desktop] screenshot written to ${target}`)
    } catch (error) {
      console.error('[pi-desktop] screenshot failed:', error)
    } finally {
      app.exit(0)
    }
  }

  let booting = false
  const waitForReady = async () => {
    if (window.isDestroyed()) {
      app.exit(0)
      return
    }
    const hot = context.supervisor?.runningKeys() ?? []
    if (prompt && hot.length === 0 && !booting && context.supervisor && process.env.PI_DESKTOP_WORKSPACE) {
      booting = true
      const started = await context.supervisor.ensure({
        sessionKey: 'draft:screenshot',
        cwd: process.env.PI_DESKTOP_WORKSPACE,
        trace: { sourceAction: 'screenshot' }
      })
      booting = false
      if (window.isDestroyed()) {
        app.exit(0)
        return
      }
      if (!started.ok) {
        setTimeout(() => void capture(), 1500)
        return
      }
    }
    const ready = context.supervisor?.runningKeys() ?? []
    if (!prompt || ready.length > 0) {
      if (prompt && ready[0]) {
        // Not awaited: a prompt that opens a dialog never resolves until the
        // user answers, and the capture delay has to run alongside it.
        void context.supervisor
          ?.request(ready[0], 'prompt', { message: prompt }, undefined, { sourceAction: 'screenshot' })
          .then(() => console.log('[pi-desktop] prompt accepted'))
          .catch((error: unknown) => {
            console.error('[pi-desktop] prompt failed:', error)
          })
      }
      setTimeout(() => void capture(), delay)
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
export function scheduleWindowClose(context: { window: BrowserWindow }): void {
  const closeAfter = Number(process.env.PI_DESKTOP_CLOSE_AFTER_MS ?? 0)
  if (closeAfter <= 0) return
  setTimeout(() => {
    if (context.window.isDestroyed()) return
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

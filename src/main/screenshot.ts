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
 */
export function scheduleCapture(context: CaptureContext): void {
  const target = process.env.PI_DESKTOP_SCREENSHOT
  if (!target) return

  const delay = Number(process.env.PI_DESKTOP_SCREENSHOT_DELAY ?? 4000)
  const prompt = process.env.PI_DESKTOP_PROMPT

  const capture = async () => {
    try {
      if (!context.window.isVisible()) context.window.show()
      context.window.focus()
      await new Promise((resolve) => setTimeout(resolve, 400))
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
        try {
          await context.runtime.request('prompt', { message: prompt })
          console.log('[pi-desktop] prompt sent')
        } catch (error) {
          console.error('[pi-desktop] prompt failed:', error)
        }
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

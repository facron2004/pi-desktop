import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Pi's built-in retry is 3 attempts at 2s, 4s and 8s. That is shorter than a
 * per-minute rate-limit window, so a 429 ends the turn while the limit is
 * still in force. These floors keep the same abortable retry, but wait long
 * enough for the window to pass and try more than once per minute.
 *
 * Missing values count as Pi's defaults, which are below the floor. A higher
 * value the user already chose is left alone, and `enabled` is never forced.
 */
export const RETRY_FLOOR = {
  maxRetries: 8,
  baseDelayMs: 20_000,
  maxAgentDelayMs: 120_000
} as const

export function raiseRetryBudget(settings: Record<string, unknown>): {
  settings: Record<string, unknown>
  changed: boolean
} {
  const current =
    settings.retry && typeof settings.retry === 'object' && !Array.isArray(settings.retry)
      ? { ...(settings.retry as Record<string, unknown>) }
      : {}
  let changed = false
  for (const [key, floor] of Object.entries(RETRY_FLOOR)) {
    const value = current[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < floor) {
      current[key] = floor
      changed = true
    }
  }
  if (!changed) return { settings, changed: false }
  return { settings: { ...settings, retry: current }, changed: true }
}

/** Settings file Pi reads for the agent directory this process will launch. */
export function agentSettingsPath(): string {
  const env = process.env.PI_CODING_AGENT_DIR
  const dir = env && env.trim() ? path.resolve(env.trim()) : path.join(os.homedir(), '.pi', 'agent')
  return path.join(dir, 'settings.json')
}

/**
 * Raise the retry budget in Pi's settings before the runtime starts.
 *
 * The child reads this file once, at launch. A file that cannot be parsed is
 * left untouched — a broken settings file is worse than a short retry.
 */
export function ensurePatientRetrySettings(file = agentSettingsPath()): void {
  let settings: Record<string, unknown> = {}
  if (existsSync(file)) {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    settings = parsed as Record<string, unknown>
  }
  const raised = raiseRetryBudget(settings)
  if (!raised.changed && existsSync(file)) return
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(raised.settings, null, 2)}\n`, 'utf8')
}

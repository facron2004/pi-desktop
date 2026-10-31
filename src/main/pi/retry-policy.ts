import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Pi's built-in retry is 3 attempts at 2s, 4s and 8s. That is shorter than a
 * per-minute rate-limit window, so a 429 ends the turn while the limit is
 * still in force. These floors keep the same abortable retry, but give a
 * full per-minute window time to clear before the first retry.
 *
 * Missing values count as Pi's defaults, which are below the floor. A higher
 * value the user already chose is left alone. Retry itself stays on: with it
 * off, a 429 ends the turn at once instead of waiting out the rate window.
 */
export const RETRY_FLOOR = {
  maxRetries: 8,
  baseDelayMs: 60_000,
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
  if (current.enabled !== true) {
    current.enabled = true
    changed = true
  }
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
function readSettings(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return {}
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}

export function ensurePatientRetrySettings(file = agentSettingsPath()): void {
  // A file Pi cannot parse is left untouched. Replacing it would also drop
  // defaultProvider and defaultModel, which is how the next launch loses the model.
  const current = readSettings(file)
  if (!current) return
  if (!raiseRetryBudget(current).changed && existsSync(file)) return
  // Read again at the write. Pi may have saved defaultProvider since the first read.
  const latest = readSettings(file)
  if (!latest) return
  const raised = raiseRetryBudget(latest)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(raised.settings, null, 2)}\n`, 'utf8')
}

/** `provider/modelId`. A provider id has no slash; a model id may. */
export function splitModelSpec(spec: string | undefined): { provider: string; model: string } | undefined {
  const raw = spec?.trim()
  if (!raw) return undefined
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash >= raw.length - 1) return undefined
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
}

/**
 * Pi uses these two keys when a launch does not pass `--model`.
 * Choosing a model in the desktop app used to update only the app's own
 * settings, so the next Pi process fell through to whichever model was first.
 * A file that cannot be parsed is left untouched.
 */
export function rememberDefaultModel(spec: string | undefined, file = agentSettingsPath()): void {
  const parsed = splitModelSpec(spec)
  if (!parsed) return
  const current = readSettings(file)
  if (!current) return
  if (current.defaultProvider === parsed.provider && current.defaultModel === parsed.model) return
  const latest = readSettings(file)
  if (!latest) return
  if (latest.defaultProvider === parsed.provider && latest.defaultModel === parsed.model) return
  latest.defaultProvider = parsed.provider
  latest.defaultModel = parsed.model
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(latest, null, 2)}\n`, 'utf8')
}

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Pi reads `defaultThinkingLevel` once, at launch. The desktop slider used to
 * change only the running session, so the next conversation fell back to medium.
 * A file that cannot be parsed is left untouched.
 */
export function rememberDefaultThinkingLevel(level: string | undefined, file = agentSettingsPath()): void {
  const value = level?.trim().toLowerCase()
  if (!value || !THINKING_LEVELS.has(value)) return
  const current = readSettings(file)
  if (!current) return
  if (current.defaultThinkingLevel === value) return
  const latest = readSettings(file)
  if (!latest) return
  if (latest.defaultThinkingLevel === value) return
  latest.defaultThinkingLevel = value
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(latest, null, 2)}\n`, 'utf8')
}

/** Drop Pi's startup model after the desktop selection was cleared. */
export function forgetDefaultModel(file = agentSettingsPath()): void {
  const current = readSettings(file)
  if (!current) return
  if (!('defaultProvider' in current) && !('defaultModel' in current)) return
  const latest = readSettings(file)
  if (!latest) return
  delete latest.defaultProvider
  delete latest.defaultModel
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(latest, null, 2)}\n`, 'utf8')
}

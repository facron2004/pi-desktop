/** Client-observed timing samples kept outside Pi's session transcript. */
export interface SessionTimingRecord {
  modelDurationsMs: Record<string, number>
  /** Samples from versions that used a wall clock instead of a monotonic clock. */
  legacyModelDurationsMs: Record<string, number>
  ttftDurationsMs: Record<string, number>
  toolDurationsMs: Record<string, number>
  /** Keyed by the user's message timestamp, which survives transcript hydration. */
  runDurationsMs: Record<string, number>
  /** Generation window keyed by the user's message timestamp, for restored TPS. */
  generationWindowMs: Record<string, number>
}

const STORAGE_PREFIX = 'pi-desktop:session-timing:v1:'
const MODEL_TIMING_VERSION = 2

/** Use an elapsed-time clock for durations; wall-clock changes must not affect them. */
export function monotonicNow(): number {
  const clock = globalThis.performance
  return typeof clock?.now === 'function' ? clock.now() : Date.now()
}

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

function storageKey(sessionKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(sessionKey)}`
}

function durationsOf(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const durations: Record<string, number> = {}
  for (const [id, duration] of Object.entries(value)) {
    if (id && typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) {
      durations[id] = duration
    }
  }
  return durations
}

function recordOf(value: unknown): SessionTimingRecord {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const currentModelTiming = raw.modelTimingVersion === MODEL_TIMING_VERSION
  return {
    modelDurationsMs: currentModelTiming ? durationsOf(raw.modelDurationsMs) : {},
    legacyModelDurationsMs: currentModelTiming
      ? durationsOf(raw.legacyModelDurationsMs)
      : durationsOf(raw.modelDurationsMs),
    ttftDurationsMs: durationsOf(raw.ttftDurationsMs),
    toolDurationsMs: durationsOf(raw.toolDurationsMs),
    runDurationsMs: durationsOf(raw.runDurationsMs),
    generationWindowMs: durationsOf(raw.generationWindowMs)
  }
}

function writeRecord(store: Storage, key: string, record: SessionTimingRecord): void {
  store.setItem(key, JSON.stringify({ ...record, modelTimingVersion: MODEL_TIMING_VERSION }))
}

export function readSessionTiming(sessionKey: string | undefined): SessionTimingRecord {
  if (!sessionKey) return recordOf(undefined)
  try {
    const raw = storage()?.getItem(storageKey(sessionKey))
    return recordOf(raw ? JSON.parse(raw) : undefined)
  } catch {
    return recordOf(undefined)
  }
}

function recordDuration(
  sessionKey: string | undefined,
  field: keyof SessionTimingRecord,
  id: string | undefined,
  durationMs: number
): void {
  if (!sessionKey || !id || !Number.isFinite(durationMs) || durationMs < 0) return
  const store = storage()
  if (!store) return
  const record = readSessionTiming(sessionKey)
  if (record[field][id] !== undefined) return
  record[field][id] = durationMs
  try {
    writeRecord(store, storageKey(sessionKey), record)
  } catch {
    // A timing sample must never interrupt a conversation if storage is full.
  }
}

export function recordModelDuration(
  sessionKey: string | undefined,
  turnId: string | undefined,
  durationMs: number
): void {
  recordDuration(sessionKey, 'modelDurationsMs', turnId, durationMs)
}

export function recordTtftDuration(
  sessionKey: string | undefined,
  runId: string | undefined,
  durationMs: number
): void {
  recordDuration(sessionKey, 'ttftDurationsMs', runId, durationMs)
}

export function recordToolDuration(
  sessionKey: string | undefined,
  toolCallId: string | undefined,
  durationMs: number
): void {
  recordDuration(sessionKey, 'toolDurationsMs', toolCallId, durationMs)
}

export function recordRunDuration(
  sessionKey: string | undefined,
  userTimestamp: number | undefined,
  durationMs: number
): void {
  recordDuration(
    sessionKey,
    'runDurationsMs',
    userTimestamp === undefined ? undefined : String(userTimestamp),
    durationMs
  )
}

export function recordGenerationWindow(
  sessionKey: string | undefined,
  userTimestamp: number | undefined,
  durationMs: number
): void {
  recordDuration(
    sessionKey,
    'generationWindowMs',
    userTimestamp === undefined ? undefined : String(userTimestamp),
    durationMs
  )
}

/** Drop the samples of a conversation the user deleted. */
export function forgetSessionTiming(sessionKey: string | undefined): void {
  if (!sessionKey) return
  const store = storage()
  if (!store) return
  try {
    store.removeItem(storageKey(sessionKey))
  } catch {
    // A disabled storage is not a reason to fail the deletion.
  }
}

export function migrateSessionTiming(from: string, to: string): void {
  if (!from || !to || from === to) return
  const store = storage()
  if (!store) return
  try {
    const sourceKey = storageKey(from)
    const targetKey = storageKey(to)
    const source = readSessionTiming(from)
    const target = readSessionTiming(to)
    const merged: SessionTimingRecord = {
      modelDurationsMs: { ...source.modelDurationsMs, ...target.modelDurationsMs },
      legacyModelDurationsMs: { ...source.legacyModelDurationsMs, ...target.legacyModelDurationsMs },
      ttftDurationsMs: { ...source.ttftDurationsMs, ...target.ttftDurationsMs },
      toolDurationsMs: { ...source.toolDurationsMs, ...target.toolDurationsMs },
      runDurationsMs: { ...source.runDurationsMs, ...target.runDurationsMs },
      generationWindowMs: { ...source.generationWindowMs, ...target.generationWindowMs }
    }
    if (
      Object.keys(merged.modelDurationsMs).length ||
      Object.keys(merged.legacyModelDurationsMs).length ||
      Object.keys(merged.ttftDurationsMs).length ||
      Object.keys(merged.toolDurationsMs).length ||
      Object.keys(merged.runDurationsMs).length ||
      Object.keys(merged.generationWindowMs).length
    ) {
      writeRecord(store, targetKey, merged)
    }
    store.removeItem(sourceKey)
  } catch {
    // Migration is best effort; it does not affect the Pi session itself.
  }
}

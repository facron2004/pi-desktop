/** Client-observed timing samples kept outside Pi's session transcript. */
export interface SessionTimingRecord {
  modelDurationsMs: Record<string, number>
  ttftDurationsMs: Record<string, number>
  toolDurationsMs: Record<string, number>
}

const STORAGE_PREFIX = 'pi-desktop:session-timing:v1:'

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
  return {
    modelDurationsMs: durationsOf(raw.modelDurationsMs),
    ttftDurationsMs: durationsOf(raw.ttftDurationsMs),
    toolDurationsMs: durationsOf(raw.toolDurationsMs)
  }
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
    store.setItem(storageKey(sessionKey), JSON.stringify(record))
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
      ttftDurationsMs: { ...source.ttftDurationsMs, ...target.ttftDurationsMs },
      toolDurationsMs: { ...source.toolDurationsMs, ...target.toolDurationsMs }
    }
    if (
      Object.keys(merged.modelDurationsMs).length ||
      Object.keys(merged.ttftDurationsMs).length ||
      Object.keys(merged.toolDurationsMs).length
    ) {
      store.setItem(targetKey, JSON.stringify(merged))
    }
    store.removeItem(sourceKey)
  } catch {
    // Migration is best effort; it does not affect the Pi session itself.
  }
}

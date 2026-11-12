/** Client-observed timing samples kept outside Pi's session transcript. */
export interface SessionTimingRecord {
  modelDurationsMs: Record<string, number>
  /** Prompt-to-first-text TTFT keyed by the client-minted run id. */
  ttftDurationsMs: Record<string, number>
  toolDurationsMs: Record<string, number>
  /** Keyed by user ordinal and timestamp; unique samples recover across transcript tails. */
  runDurationsMs: Record<string, number>
  /** Generation windows use the same stable timestamp fallback for restored TPS. */
  generationWindowMs: Record<string, number>
}

const STORAGE_PREFIX = 'pi-desktop:session-timing:v1:'
const MODEL_TIMING_VERSION = 9
const MAX_JOURNAL_SAMPLES = 128
const SAMPLE_MARKER = ':sample:'
const JOURNAL_MARKER = ':journal:'
const TIMING_FIELDS = [
  'modelDurationsMs',
  'ttftDurationsMs',
  'toolDurationsMs',
  'runDurationsMs',
  'generationWindowMs'
] as const satisfies readonly (keyof SessionTimingRecord)[]
type TimingField = typeof TIMING_FIELDS[number]

/**
 * Parsed records, kept in memory for the conversations the reader moves
 * between.
 *
 * The usage line reads this record while the transcript streams, so a
 * `localStorage.getItem` and `JSON.parse` on every animation frame would be
 * repeated work for a value that only changes when a sample is recorded. The
 * bound keeps a long-lived window from holding every conversation at once.
 */
const MEMORY_LIMIT = 40
const memoryRecords = new Map<string, SessionTimingRecord>()
const memoryVersions = new Map<string, number>()
const userTimingIndexes = new WeakMap<Record<string, number>, Map<string, number | null>>()

function rememberRecord(sessionKey: string, record: SessionTimingRecord, version: number): void {
  if (memoryRecords.size >= MEMORY_LIMIT && !memoryRecords.has(sessionKey)) {
    const oldest = memoryRecords.keys().next().value
    if (oldest !== undefined) {
      memoryRecords.delete(oldest)
      memoryVersions.delete(oldest)
    }
  }
  memoryRecords.set(sessionKey, record)
  memoryVersions.set(sessionKey, version)
}

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

function legacySamplePrefix(key: string): string {
  return `${key}${SAMPLE_MARKER}`
}

function journalPrefix(key: string): string {
  return `${key}${JOURNAL_MARKER}`
}

function journalCountKey(key: string): string {
  return `${journalPrefix(key)}count`
}

function journalSampleKey(key: string, index: number): string {
  return `${journalPrefix(key)}${index}`
}

function compactJournal(store: Storage, key: string, record: SessionTimingRecord, count: number): void {
  writeRecord(store, key, record)
  for (let index = 0; index < count; index += 1) {
    store.removeItem(journalSampleKey(key, index))
  }
  store.removeItem(journalCountKey(key))
}

function removeLegacySampleRecords(store: Storage, key: string): void {
  const prefix = legacySamplePrefix(key)
  for (let index = store.length - 1; index >= 0; index -= 1) {
    const candidate = store.key(index)
    if (candidate?.startsWith(prefix)) store.removeItem(candidate)
  }
}

function removeSampleRecords(store: Storage, key: string): void {
  const legacyPrefix = legacySamplePrefix(key)
  const journalKeyPrefix = journalPrefix(key)
  for (let index = store.length - 1; index >= 0; index -= 1) {
    const candidate = store.key(index)
    if (candidate?.startsWith(legacyPrefix) || candidate?.startsWith(journalKeyPrefix)) {
      store.removeItem(candidate)
    }
  }
}

function applySample(record: SessionTimingRecord, value: string | null): void {
  if (value === null) return
  let sample: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    sample = parsed as Record<string, unknown>
  } catch {
    return
  }
  const field = sample.field
  const id = sample.id
  const duration = sample.duration
  if (
    typeof field !== 'string' || !TIMING_FIELDS.includes(field as TimingField) ||
    typeof id !== 'string' || !id || typeof duration !== 'number' ||
    !Number.isFinite(duration) || duration < 0
  ) return
  const timingField = field as TimingField
  if (record[timingField][id] === undefined) record[timingField][id] = duration
}

function readJournalSamples(store: Storage, key: string, record: SessionTimingRecord): void {
  const rawCount = store.getItem(journalCountKey(key))
  const count = rawCount === null ? 0 : Number(rawCount)
  let index = 0
  const maxPossibleCount = Math.max(0, store.length - 2)
  const boundedCount = Number.isSafeInteger(count) && count >= 0 && count <= maxPossibleCount ? count : 0
  for (; index < boundedCount; index += 1) {
    applySample(record, store.getItem(journalSampleKey(key, index)))
  }
  // A sample is written before its count. If the app exits between those two
  // writes, recover the contiguous trailing sample instead of losing it.
  while (index < store.length) {
    const value = store.getItem(journalSampleKey(key, index))
    if (value === null) break
    applySample(record, value)
    index += 1
  }
}

function readLegacySamples(store: Storage, key: string, record: SessionTimingRecord): void {
  const prefix = legacySamplePrefix(key)
  for (let index = 0; index < store.length; index += 1) {
    const candidate = store.key(index)
    if (!candidate?.startsWith(prefix)) continue
    const sample = candidate.slice(prefix.length)
    const separator = sample.indexOf(':')
    if (separator < 0) continue
    const field = sample.slice(0, separator)
    if (!TIMING_FIELDS.includes(field as TimingField)) continue
    let id: string
    try {
      id = decodeURIComponent(sample.slice(separator + 1))
    } catch {
      continue
    }
    if (!id) continue
    const text = store.getItem(candidate)
    if (text === null) continue
    const duration = Number(text)
    if (!Number.isFinite(duration) || duration < 0) continue
    const timingField = field as TimingField
    if (record[timingField][id] === undefined) record[timingField][id] = duration
  }
}

function storedVersion(raw: string | null): number {
  if (!raw) return 1
  try {
    const value = JSON.parse(raw) as { modelTimingVersion?: unknown }
    return typeof value.modelTimingVersion === 'number' ? value.modelTimingVersion : 1
  } catch {
    return 1
  }
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
  // Version 1 measured model time against the wall clock. Version 2 switched
  // model timing to a monotonic clock, but TTFT, run, generation and fallback
  // tool durations still used Date.now until version 4. Their source cannot
  // be distinguished from Pi-reported tool durations, so all pre-v4 samples
  // in those fields are dropped rather than carried forward.
  // Versions 5 and 6 measure turn/request timing to the first content delta.
  // Version 7 measures run-start to first text, so older samples are dropped.
  // Versions 8 and 9 keep the same measurements; v8 used enumerated keys and
  // v9 uses a per-session indexed journal.
  const version = typeof raw.modelTimingVersion === 'number' ? raw.modelTimingVersion : 1
  return {
    modelDurationsMs: version >= 2 ? durationsOf(raw.modelDurationsMs) : {},
    ttftDurationsMs: version >= 7 ? durationsOf(raw.ttftDurationsMs) : {},
    toolDurationsMs: version >= 4 ? durationsOf(raw.toolDurationsMs) : {},
    runDurationsMs: version >= 4 ? durationsOf(raw.runDurationsMs) : {},
    generationWindowMs: version >= 4 ? durationsOf(raw.generationWindowMs) : {}
  }
}

function writeRecord(store: Storage, key: string, record: SessionTimingRecord): void {
  store.setItem(key, JSON.stringify({ ...record, modelTimingVersion: MODEL_TIMING_VERSION }))
}

function readStoredRecord(store: Storage, key: string, raw: string | null): SessionTimingRecord {
  let record: SessionTimingRecord
  try {
    record = recordOf(raw ? JSON.parse(raw) : undefined)
  } catch {
    record = recordOf(undefined)
  }

  if (!raw) return record
  try {
    const version = storedVersion(raw)
    if (version >= MODEL_TIMING_VERSION) readJournalSamples(store, key, record)
    else if (version >= 8) readLegacySamples(store, key, record)
  } catch {
    // A readable snapshot remains useful if the browser cannot enumerate keys.
  }
  return record
}

export function readSessionTiming(sessionKey: string | undefined): SessionTimingRecord {
  if (!sessionKey) return recordOf(undefined)
  const cached = memoryRecords.get(sessionKey)
  if (cached) return cached
  const store = storage()
  if (!store) return recordOf(undefined)
  let record: SessionTimingRecord
  let version = 1
  try {
    const key = storageKey(sessionKey)
    const raw = store.getItem(key)
    version = storedVersion(raw)
    record = readStoredRecord(store, key, raw)
  } catch {
    record = recordOf(undefined)
  }
  rememberRecord(sessionKey, record, version)
  return record
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
  if (field === 'runDurationsMs' || field === 'generationWindowMs') {
    userTimingIndexes.delete(record[field])
  }
  try {
    const key = storageKey(sessionKey)
    const version = memoryVersions.get(sessionKey) ?? storedVersion(store.getItem(key))
    if (version < MODEL_TIMING_VERSION) {
      // Fold legacy samples into the snapshot once. Later samples use the
      // indexed journal so recording a duration does not rewrite history.
      writeRecord(store, key, record)
      if (version >= 8) removeLegacySampleRecords(store, key)
      memoryVersions.set(sessionKey, MODEL_TIMING_VERSION)
    } else {
      const countKey = journalCountKey(key)
      const rawCount = store.getItem(countKey)
      const parsedCount = rawCount === null ? 0 : Number(rawCount)
      const maxPossibleCount = Math.max(0, store.length - (rawCount === null ? 1 : 2))
      let index = Number.isSafeInteger(parsedCount) && parsedCount >= 0 && parsedCount <= maxPossibleCount
        ? parsedCount
        : 0
      while (index < store.length && store.getItem(journalSampleKey(key, index)) !== null) index += 1
      store.setItem(journalSampleKey(key, index), JSON.stringify({ field, id, duration: durationMs }))
      const nextCount = index + 1
      store.setItem(countKey, String(nextCount))
      if (nextCount >= MAX_JOURNAL_SAMPLES) compactJournal(store, key, record, nextCount)
    }
  } catch {
    // A timing sample must never interrupt a conversation if storage is full.
  }
}

export function recordModelDuration(
  sessionKey: string | undefined,
  turnId: string | undefined,
  durationMs: number,
  messageTimestamp?: number
): void {
  recordDuration(sessionKey, 'modelDurationsMs', turnId, durationMs)
  if (typeof messageTimestamp === 'number' && Number.isFinite(messageTimestamp)) {
    const messageId = turnId
      ? `assistant:${messageTimestamp}:${turnId}`
      : `assistant:${messageTimestamp}`
    recordDuration(sessionKey, 'modelDurationsMs', messageId, durationMs)
  }
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
  durationMs: number,
  userOrdinal?: number
): void {
  recordDuration(
    sessionKey,
    'runDurationsMs',
    userTimingKey(userTimestamp, userOrdinal),
    durationMs
  )
}

export function recordGenerationWindow(
  sessionKey: string | undefined,
  userTimestamp: number | undefined,
  durationMs: number,
  userOrdinal?: number
): void {
  recordDuration(
    sessionKey,
    'generationWindowMs',
    userTimingKey(userTimestamp, userOrdinal),
    durationMs
  )
}

function userTimingKey(userTimestamp: number | undefined, userOrdinal?: number): string | undefined {
  if (userTimestamp === undefined) return undefined
  if (typeof userOrdinal === 'number' && Number.isInteger(userOrdinal) && userOrdinal >= 0) {
    return `user:${userOrdinal}:${userTimestamp}`
  }
  return String(userTimestamp)
}

/** Prefer collision-safe samples and fall back to records written by older versions. */
export function userTimingDuration(
  durations: Record<string, number>,
  userTimestamp: number | undefined,
  userOrdinal: number | undefined,
  timestampOccurrences: number
): number | undefined {
  if (userTimestamp === undefined) return undefined
  const key = userTimingKey(userTimestamp, userOrdinal)
  if (!key) return undefined
  const exact = durations[key]
  if (exact !== undefined) return exact
  if (timestampOccurrences !== 1) return undefined

  const timestampKey = String(userTimestamp)
  const indexed = userTimingIndex(durations).get(timestampKey)
  if (indexed === null) return undefined
  return indexed ?? durations[timestampKey]
}

/**
 * Long session transcripts are read from a bounded tail, so their visible
 * user ordinals can change after reopening. Recover a single matching sample
 * by timestamp only when that timestamp occurs once in the loaded transcript.
 * Colliding timestamps remain unresolved unless their ordinal matches exactly.
 */
function userTimingIndex(durations: Record<string, number>): Map<string, number | null> {
  const cached = userTimingIndexes.get(durations)
  if (cached) return cached

  const index = new Map<string, number | null>()
  for (const [key, duration] of Object.entries(durations)) {
    if (!key.startsWith('user:')) continue
    const separator = key.lastIndexOf(':')
    if (separator <= 5 || !/^\d+$/.test(key.slice(5, separator))) continue
    const timestamp = key.slice(separator + 1)
    if (index.has(timestamp)) index.set(timestamp, null)
    else index.set(timestamp, duration)
  }
  userTimingIndexes.set(durations, index)
  return index
}

/** Drop the samples of a conversation the user deleted. */
export function forgetSessionTiming(sessionKey: string | undefined): void {
  if (!sessionKey) return
  memoryRecords.delete(sessionKey)
  memoryVersions.delete(sessionKey)
  let key: string
  try {
    key = storageKey(sessionKey)
  } catch {
    return
  }
  const store = storage()
  if (!store) return
  try {
    store.removeItem(key)
    removeSampleRecords(store, key)
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
      ttftDurationsMs: { ...source.ttftDurationsMs, ...target.ttftDurationsMs },
      toolDurationsMs: { ...source.toolDurationsMs, ...target.toolDurationsMs },
      runDurationsMs: { ...source.runDurationsMs, ...target.runDurationsMs },
      generationWindowMs: { ...source.generationWindowMs, ...target.generationWindowMs }
    }
    if (
      Object.keys(merged.modelDurationsMs).length ||
      Object.keys(merged.ttftDurationsMs).length ||
      Object.keys(merged.toolDurationsMs).length ||
      Object.keys(merged.runDurationsMs).length ||
      Object.keys(merged.generationWindowMs).length
    ) {
      writeRecord(store, targetKey, merged)
      removeSampleRecords(store, targetKey)
      rememberRecord(to, merged, MODEL_TIMING_VERSION)
    } else {
      memoryRecords.delete(to)
      memoryVersions.delete(to)
    }
    store.removeItem(sourceKey)
    removeSampleRecords(store, sourceKey)
    memoryRecords.delete(from)
    memoryVersions.delete(from)
  } catch {
    // Migration is best effort; it does not affect the Pi session itself.
  }
}

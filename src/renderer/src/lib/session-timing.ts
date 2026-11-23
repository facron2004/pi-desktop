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
const MODEL_TIMING_VERSION = 10
const SOFT_JOURNAL_COMPACT_SAMPLES = 64
const MAX_JOURNAL_SAMPLES = 128
/** Maximum persisted session-timing records retained in localStorage before sweeping old entries. */
export const MAX_STORED_TIMING_SESSIONS = 100
const STORAGE_SWEEP_THRESHOLD = 180
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

interface MemoryTimingEntry {
  record: SessionTimingRecord
  version: number
  journalCount: number
}

/**
 * Parsed records, kept in memory per Storage host for the conversations the
 * reader moves between.
 *
 * The usage line reads this record while the transcript streams, so a
 * `localStorage.getItem` and `JSON.parse` on every animation frame would be
 * repeated work for a value that only changes when a sample is recorded.
 */
const MEMORY_LIMIT = 40
const memoryByStorage = new WeakMap<Storage, Map<string, MemoryTimingEntry>>()
const userTimingIndexes = new WeakMap<Record<string, number>, Map<string, number | null>>()
const roundTimingIndexes = new WeakMap<Record<string, number>, Map<string, number | null>>()
const fieldRevisions = new WeakMap<Record<string, number>, number>()
const idleCompactions = new WeakMap<Storage, Map<string, number>>()

/** Monotonic revision of one timing map so caches detect in-place sample inserts. */
export function timingFieldRevision(durations: Record<string, number> | undefined): number {
  return durations ? (fieldRevisions.get(durations) ?? 0) : 0
}

function bumpFieldRevision(durations: Record<string, number>): void {
  fieldRevisions.set(durations, (fieldRevisions.get(durations) ?? 0) + 1)
}

function entriesForStorage(store: Storage): Map<string, MemoryTimingEntry> {
  let map = memoryByStorage.get(store)
  if (!map) {
    map = new Map()
    memoryByStorage.set(store, map)
  }
  return map
}

function cancelIdleCompaction(store: Storage, key: string): void {
  const handles = idleCompactions.get(store)
  const handle = handles?.get(key)
  if (handle === undefined) return
  handles?.delete(key)
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(handle)
}

function scheduleIdleCompaction(
  store: Storage,
  sessionKey: string,
  key: string,
  entry: MemoryTimingEntry
): void {
  if (typeof requestIdleCallback !== 'function') return
  let handles = idleCompactions.get(store)
  if (handles?.has(key)) return
  if (!handles) {
    handles = new Map()
    idleCompactions.set(store, handles)
  }
  const handle = requestIdleCallback(() => {
    idleCompactions.get(store)?.delete(key)
    const current = entriesForStorage(store).get(sessionKey)
    if (!current || current !== entry || current.journalCount === 0) return
    try {
      compactJournal(store, key, current.record, current.journalCount)
      current.journalCount = 0
    } catch {
      // Compaction is best effort; recording remains crash-safe in the journal.
    }
  })
  handles.set(key, handle)
}

function rememberEntry(store: Storage, sessionKey: string, entry: MemoryTimingEntry): void {
  const entries = entriesForStorage(store)
  if (entries.size >= MEMORY_LIMIT && !entries.has(sessionKey)) {
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
  entries.set(sessionKey, entry)
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

function readJournalSamples(store: Storage, key: string, record: SessionTimingRecord): number {
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
  return index
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
  // v9 uses a per-session indexed journal. Versions 7-9 still started the
  // clock at agent_start, so a run's tool calls and retries ended up inside
  // its TTFT (4m29s for a first token). Version 10 measures one model request
  // at a time, so every pre-v10 TTFT sample is dropped as untrustworthy.
  const version = typeof raw.modelTimingVersion === 'number' ? raw.modelTimingVersion : 1
  return {
    modelDurationsMs: version >= 2 ? durationsOf(raw.modelDurationsMs) : {},
    ttftDurationsMs: version >= 10 ? durationsOf(raw.ttftDurationsMs) : {},
    toolDurationsMs: version >= 4 ? durationsOf(raw.toolDurationsMs) : {},
    runDurationsMs: version >= 4 ? durationsOf(raw.runDurationsMs) : {},
    generationWindowMs: version >= 4 ? durationsOf(raw.generationWindowMs) : {}
  }
}

function isTimingBaseKey(key: string): boolean {
  return (
    key.startsWith(STORAGE_PREFIX) &&
    !key.includes(JOURNAL_MARKER) &&
    !key.includes(SAMPLE_MARKER)
  )
}

/**
 * Evict excess per-session timing records from localStorage so long-lived
 * profiles do not exhaust browser storage quota. Active in-memory sessions
 * (and an optional protected storage key) are kept first.
 */
export function pruneSessionTimingStorage(
  maxSessions = MAX_STORED_TIMING_SESSIONS,
  protectKey?: string,
  store = storage()
): number {
  if (!store || typeof store.key !== 'function') return 0
  const baseKeys: string[] = []
  const companionsByBase = new Map<string, string[]>()
  for (let index = 0; index < store.length; index += 1) {
    const candidate = store.key(index)
    if (!candidate || !candidate.startsWith(STORAGE_PREFIX)) continue
    const journalIndex = candidate.indexOf(JOURNAL_MARKER, STORAGE_PREFIX.length)
    const sampleIndex = candidate.indexOf(SAMPLE_MARKER, STORAGE_PREFIX.length)
    const subIndex =
      journalIndex >= 0 && sampleIndex >= 0
        ? Math.min(journalIndex, sampleIndex)
        : Math.max(journalIndex, sampleIndex)
    if (subIndex >= 0) {
      const base = candidate.slice(0, subIndex)
      let list = companionsByBase.get(base)
      if (!list) {
        list = []
        companionsByBase.set(base, list)
      }
      list.push(candidate)
    } else if (isTimingBaseKey(candidate)) {
      baseKeys.push(candidate)
    }
  }
  const limit = Math.max(1, maxSessions)
  if (baseKeys.length <= limit) return 0

  const hotKeys = new Set<string>()
  if (protectKey) hotKeys.add(protectKey)
  for (const sessionKey of entriesForStorage(store).keys()) {
    try {
      hotKeys.add(storageKey(sessionKey))
    } catch {
      /* ignore */
    }
  }

  let excess = baseKeys.length - limit
  let removed = 0
  const evict = (base: string) => {
    cancelIdleCompaction(store, base)
    store.removeItem(base)
    const companions = companionsByBase.get(base)
    if (companions) {
      for (const subkey of companions) store.removeItem(subkey)
    }
    removed += 1
    excess -= 1
  }

  for (const base of baseKeys) {
    if (excess <= 0) break
    if (!hotKeys.has(base)) evict(base)
  }
  for (const base of baseKeys) {
    if (excess <= 0) break
    if (base !== protectKey) evict(base)
  }
  return removed
}

function writeRecord(store: Storage, key: string, record: SessionTimingRecord): void {
  if (store.length > STORAGE_SWEEP_THRESHOLD) {
    try {
      pruneSessionTimingStorage(MAX_STORED_TIMING_SESSIONS, key, store)
    } catch {
      /* ignore sweep failures */
    }
  }
  const payload = JSON.stringify({ ...record, modelTimingVersion: MODEL_TIMING_VERSION })
  try {
    store.setItem(key, payload)
  } catch (error) {
    if (pruneSessionTimingStorage(Math.min(20, MAX_STORED_TIMING_SESSIONS), key, store) > 0) {
      store.setItem(key, payload)
      return
    }
    throw error
  }
}

function readStoredRecord(
  store: Storage,
  key: string,
  raw: string | null
): { record: SessionTimingRecord; journalCount: number } {
  let record: SessionTimingRecord
  try {
    record = recordOf(raw ? JSON.parse(raw) : undefined)
  } catch {
    record = recordOf(undefined)
  }

  let journalCount = 0
  if (!raw) return { record, journalCount }
  try {
    const version = storedVersion(raw)
    // v9 already wrote the indexed journal, so its samples have to be folded
    // into the snapshot before they can be discarded with the upgrade.
    if (version >= 9) journalCount = readJournalSamples(store, key, record)
    else if (version >= 8) readLegacySamples(store, key, record)
    if (version < MODEL_TIMING_VERSION) record.ttftDurationsMs = {}
  } catch {
    // A readable snapshot remains useful if the browser cannot enumerate keys.
  }
  return { record, journalCount }
}

function readTimingEntry(store: Storage, sessionKey: string): MemoryTimingEntry {
  const cached = entriesForStorage(store).get(sessionKey)
  if (cached) return cached
  let record: SessionTimingRecord
  let version = 1
  let journalCount = 0
  try {
    const key = storageKey(sessionKey)
    const raw = store.getItem(key)
    version = storedVersion(raw)
    const loaded = readStoredRecord(store, key, raw)
    record = loaded.record
    journalCount = loaded.journalCount
  } catch {
    record = recordOf(undefined)
  }
  const entry: MemoryTimingEntry = { record, version, journalCount }
  rememberEntry(store, sessionKey, entry)
  return entry
}

export function readSessionTiming(sessionKey: string | undefined): SessionTimingRecord {
  if (!sessionKey) return recordOf(undefined)
  const store = storage()
  if (!store) return recordOf(undefined)
  return readTimingEntry(store, sessionKey).record
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
  const entry = readTimingEntry(store, sessionKey)
  const record = entry.record
  if (record[field][id] !== undefined) return
  record[field][id] = durationMs
  bumpFieldRevision(record[field])
  if (field === 'runDurationsMs' || field === 'generationWindowMs') {
    userTimingIndexes.delete(record[field])
    roundTimingIndexes.delete(record[field])
  }
  try {
    const key = storageKey(sessionKey)
    if (entry.version < MODEL_TIMING_VERSION) {
      // Fold legacy samples into the snapshot once. Later samples use the
      // indexed journal so recording a duration does not rewrite history.
      // The v9 journal is folded too, then removed: its TTFT entries are the
      // run-level readings version 10 replaces.
      cancelIdleCompaction(store, key)
      writeRecord(store, key, record)
      if (entry.version >= 8) removeSampleRecords(store, key)
      entry.version = MODEL_TIMING_VERSION
      entry.journalCount = 0
    } else {
      const index = entry.journalCount
      store.setItem(journalSampleKey(key, index), JSON.stringify({ field, id, duration: durationMs }))
      const nextCount = index + 1
      entry.journalCount = nextCount
      store.setItem(journalCountKey(key), String(nextCount))
      if (nextCount >= MAX_JOURNAL_SAMPLES) {
        cancelIdleCompaction(store, key)
        compactJournal(store, key, record, nextCount)
        entry.journalCount = 0
      } else if (nextCount >= SOFT_JOURNAL_COMPACT_SAMPLES) {
        scheduleIdleCompaction(store, sessionKey, key, entry)
      }
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
    indexedTimingKey('user:', userTimestamp, userOrdinal, ''),
    durationMs
  )
}

export function recordRoundDuration(
  sessionKey: string | undefined,
  roundTimestamp: number | undefined,
  durationMs: number,
  roundOrdinal?: number
): void {
  recordDuration(
    sessionKey,
    'runDurationsMs',
    indexedTimingKey('round:', roundTimestamp, roundOrdinal, 'round:'),
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
    indexedTimingKey('user:', userTimestamp, userOrdinal, ''),
    durationMs
  )
}

function indexedTimingKey(
  prefix: string,
  timestamp: number | undefined,
  ordinal: number | undefined,
  fallbackPrefix: string
): string | undefined {
  if (timestamp === undefined) return undefined
  if (typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal >= 0) {
    return `${prefix}${ordinal}:${timestamp}`
  }
  return `${fallbackPrefix}${timestamp}`
}

/** Prefer collision-safe samples and fall back to records written by older versions. */
export function userTimingDuration(
  durations: Record<string, number>,
  userTimestamp: number | undefined,
  userOrdinal: number | undefined,
  timestampOccurrences: number
): number | undefined {
  return indexedTimingDuration(
    userTimingIndexes,
    'user:',
    '',
    durations,
    userTimestamp,
    userOrdinal,
    timestampOccurrences
  )
}

/** Look up a Goal Mode continuation round's recorded duration by ordinal and timestamp. */
export function roundTimingDuration(
  durations: Record<string, number>,
  roundTimestamp: number | undefined,
  roundOrdinal: number | undefined,
  timestampOccurrences: number
): number | undefined {
  return indexedTimingDuration(
    roundTimingIndexes,
    'round:',
    'round:',
    durations,
    roundTimestamp,
    roundOrdinal,
    timestampOccurrences
  )
}

function indexedTimingDuration(
  indexes: WeakMap<Record<string, number>, Map<string, number | null>>,
  prefix: string,
  fallbackPrefix: string,
  durations: Record<string, number>,
  timestamp: number | undefined,
  ordinal: number | undefined,
  timestampOccurrences: number
): number | undefined {
  if (timestamp === undefined) return undefined
  const key = indexedTimingKey(prefix, timestamp, ordinal, fallbackPrefix)
  if (!key) return undefined
  const exact = durations[key]
  if (exact !== undefined) return exact
  if (timestampOccurrences !== 1) return undefined

  const timestampKey = String(timestamp)
  const indexed = prefixTimingIndex(indexes, prefix, durations).get(timestampKey)
  if (indexed === null) return undefined
  return indexed ?? durations[`${fallbackPrefix}${timestampKey}`]
}

/**
 * Long session transcripts are read from a bounded tail, so their visible
 * ordinals can change after reopening. Recover a single matching sample
 * by timestamp only when that timestamp occurs once in the loaded transcript.
 * Colliding timestamps remain unresolved unless their ordinal matches exactly.
 */
function prefixTimingIndex(
  indexes: WeakMap<Record<string, number>, Map<string, number | null>>,
  prefix: string,
  durations: Record<string, number>
): Map<string, number | null> {
  const cached = indexes.get(durations)
  if (cached) return cached

  const index = new Map<string, number | null>()
  for (const [key, duration] of Object.entries(durations)) {
    if (!key.startsWith(prefix)) continue
    const separator = key.lastIndexOf(':')
    if (separator <= prefix.length || !/^\d+$/.test(key.slice(prefix.length, separator))) continue
    const timestamp = key.slice(separator + 1)
    if (index.has(timestamp)) index.set(timestamp, null)
    else index.set(timestamp, duration)
  }
  indexes.set(durations, index)
  return index
}

/** Drop the samples of a conversation the user deleted. */
export function forgetSessionTiming(sessionKey: string | undefined): void {
  if (!sessionKey) return
  const store = storage()
  let key: string
  try {
    key = storageKey(sessionKey)
  } catch {
    return
  }
  if (!store) return
  entriesForStorage(store).delete(sessionKey)
  cancelIdleCompaction(store, key)
  try {
    store.removeItem(key)
    removeSampleRecords(store, key)
  } catch {
    // A disabled storage is not a reason to fail the deletion.
  }
}

function hasTimingSamples(record: SessionTimingRecord | undefined): boolean {
  if (!record) return false
  return Boolean(
    Object.keys(record.modelDurationsMs).length ||
      Object.keys(record.ttftDurationsMs).length ||
      Object.keys(record.toolDurationsMs).length ||
      Object.keys(record.runDurationsMs).length ||
      Object.keys(record.generationWindowMs).length
  )
}

export function migrateSessionTiming(from: string, to: string): void {
  if (!from || !to || from === to) return
  const store = storage()
  if (!store) return
  const entries = entriesForStorage(store)
  try {
    const sourceKey = storageKey(from)
    // Brand-new drafts rarely record timing samples before promotion; avoid a
    // full `localStorage.key()` enumeration when there is nothing to move.
    const cachedSource = entries.get(from)?.record
    if (
      !hasTimingSamples(cachedSource) &&
      store.getItem(sourceKey) === null &&
      store.getItem(journalCountKey(sourceKey)) === null &&
      store.getItem(journalSampleKey(sourceKey, 0)) === null
    ) {
      entries.delete(from)
      cancelIdleCompaction(store, sourceKey)
      return
    }
    const targetKey = storageKey(to)
    cancelIdleCompaction(store, sourceKey)
    cancelIdleCompaction(store, targetKey)
    const source = readSessionTiming(from)
    const target = readSessionTiming(to)
    const merged: SessionTimingRecord = {
      modelDurationsMs: { ...source.modelDurationsMs, ...target.modelDurationsMs },
      ttftDurationsMs: { ...source.ttftDurationsMs, ...target.ttftDurationsMs },
      toolDurationsMs: { ...source.toolDurationsMs, ...target.toolDurationsMs },
      runDurationsMs: { ...source.runDurationsMs, ...target.runDurationsMs },
      generationWindowMs: { ...source.generationWindowMs, ...target.generationWindowMs }
    }
    if (hasTimingSamples(merged)) {
      writeRecord(store, targetKey, merged)
      removeSampleRecords(store, targetKey)
      rememberEntry(store, to, { record: merged, version: MODEL_TIMING_VERSION, journalCount: 0 })
    } else {
      entries.delete(to)
    }
    store.removeItem(sourceKey)
    removeSampleRecords(store, sourceKey)
    entries.delete(from)
  } catch {
    // Migration is best effort; it does not affect the Pi session itself.
  }
}

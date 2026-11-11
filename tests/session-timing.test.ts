import test from 'node:test'
import assert from 'node:assert/strict'
import {
  forgetSessionTiming,
  migrateSessionTiming,
  recordGenerationWindow,
  readSessionTiming,
  recordModelDuration,
  recordRunDuration,
  recordToolDuration,
  recordTtftDuration,
  userTimingDuration
} from '../src/renderer/src/lib/session-timing'

function installStorage(): () => void {
  const values = new Map<string, string>()
  const original = (globalThis as unknown as { window?: unknown }).window
  const localStorage = {
    get length() { return values.size },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage }
  })
  return () => {
    if (original === undefined) delete (globalThis as unknown as { window?: unknown }).window
    else Object.defineProperty(globalThis, 'window', { configurable: true, value: original })
  }
}

test('timing samples are deduplicated and migrate from a draft to its session file', () => {
  const restore = installStorage()
  try {
    recordModelDuration('draft:1', 'turn-1', 1_200)
    recordModelDuration('draft:1', 'turn-1', 9_000)
    recordTtftDuration('draft:1', 'run-1', 650)
    recordToolDuration('draft:1', 'call-1', 300)
    recordGenerationWindow('draft:1', 1_700_000_000_000, 2_500)

    migrateSessionTiming('draft:1', 'C:/sessions/session.jsonl')

    assert.deepEqual(readSessionTiming('draft:1'), {
      modelDurationsMs: {},
      ttftDurationsMs: {},
      toolDurationsMs: {},
      runDurationsMs: {},
      generationWindowMs: {}
    })
    assert.deepEqual(readSessionTiming('C:/sessions/session.jsonl'), {
      modelDurationsMs: { 'turn-1': 1_200 },
      ttftDurationsMs: { 'run-1': 650 },
      toolDurationsMs: { 'call-1': 300 },
      runDurationsMs: {},
      generationWindowMs: { '1700000000000': 2_500 }
    })
  } finally {
    restore()
  }
})

test('pre-v4 timing records drop duration samples measured against the wall clock', () => {
  const restore = installStorage()
  const sessionKey = 'C:/sessions/legacy.jsonl'
  const storageKey = `pi-desktop:session-timing:v1:${encodeURIComponent(sessionKey)}`
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    store.setItem(storageKey, JSON.stringify({
      modelDurationsMs: { oldTurn: 19_882_000 },
      ttftDurationsMs: { oldRun: 1_200 },
      toolDurationsMs: { oldCall: 300 }
    }))

    // Version 1 measured model time against the wall clock. Every field in
    // this record was also wall-clock measured before v4.
    assert.deepEqual(readSessionTiming(sessionKey), {
      modelDurationsMs: {},
      ttftDurationsMs: {},
      toolDurationsMs: {},
      runDurationsMs: {},
      generationWindowMs: {}
    })

    // Version 3 kept monotonic model timing, but other duration fields still
    // used Date.now and are discarded during the v4 migration.
    forgetSessionTiming(sessionKey)
    store.setItem(storageKey, JSON.stringify({
      modelTimingVersion: 3,
      modelDurationsMs: { keptTurn: 1_200 },
      legacyModelDurationsMs: { oldTurn: 19_882_000 },
      ttftDurationsMs: { oldRun: 1_200 },
      toolDurationsMs: { oldCall: 300 },
      runDurationsMs: { '1': 800 },
      generationWindowMs: { '1': 600 }
    }))
    assert.deepEqual(readSessionTiming(sessionKey), {
      modelDurationsMs: { keptTurn: 1_200 },
      ttftDurationsMs: {},
      toolDurationsMs: {},
      runDurationsMs: {},
      generationWindowMs: {}
    })

    recordModelDuration(sessionKey, 'newTurn', 800)
    const saved = JSON.parse(store.getItem(storageKey)!) as Record<string, unknown>
    assert.equal(saved.modelTimingVersion, 9)
    assert.equal(saved.legacyModelDurationsMs, undefined)
    assert.deepEqual(readSessionTiming(sessionKey).modelDurationsMs, {
      keptTurn: 1_200,
      newTurn: 800
    })
  } finally {
    restore()
  }
})

test('v6 TTFT samples are dropped while other monotonic timings survive migration', () => {
  const restore = installStorage()
  const sessionKey = 'C:/sessions/old-text-ttft.jsonl'
  const storageKey = `pi-desktop:session-timing:v1:${encodeURIComponent(sessionKey)}`
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    store.setItem(storageKey, JSON.stringify({
      modelTimingVersion: 6,
      modelDurationsMs: { turn1: 530_000 },
      ttftDurationsMs: { run1: 526_000 },
      toolDurationsMs: { call1: 12_000 },
      runDurationsMs: { '1': 540_000 },
      generationWindowMs: { '1': 510_000 }
    }))
    assert.deepEqual(readSessionTiming(sessionKey), {
      modelDurationsMs: { turn1: 530_000 },
      ttftDurationsMs: {},
      toolDurationsMs: { call1: 12_000 },
      runDurationsMs: { '1': 540_000 },
      generationWindowMs: { '1': 510_000 }
    })
    recordTtftDuration(sessionKey, 'run2', 250)
    assert.deepEqual(JSON.parse(store.getItem(storageKey)!).ttftDurationsMs, { run2: 250 })
    assert.equal(JSON.parse(store.getItem(storageKey)!).modelTimingVersion, 9)
  } finally {
    forgetSessionTiming(sessionKey)
    restore()
  }
})

test('a new session does not enumerate timing keys before its first snapshot', () => {
  const restore = installStorage()
  const sessionKey = 'C:/sessions/first-sample.jsonl'
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    let keyReads = 0
    const originalKey = store.key.bind(store)
    store.key = (index: number) => {
      keyReads += 1
      return originalKey(index)
    }

    recordModelDuration(sessionKey, 'turn-1', 1_200)

    assert.equal(keyReads, 0, 'an empty session has no appended samples to discover')
    assert.equal(store.length, 1, 'the first sample creates the versioned snapshot')
  } finally {
    forgetSessionTiming(sessionKey)
    restore()
  }
})

test('timing reads are served from memory while the transcript streams', () => {
  const restore = installStorage()
  const sessionKey = 'C:/sessions/streaming.jsonl'
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    let reads = 0
    const originalGet = store.getItem.bind(store)
    store.getItem = (key: string) => {
      reads += 1
      return originalGet(key)
    }
    recordRunDuration(sessionKey, 1_700_000_000_000, 1_200)
    assert.equal(reads, 1, 'the first sample reads the stored record once')

    assert.deepEqual(readSessionTiming(sessionKey).runDurationsMs, {
      '1700000000000': 1_200
    })
    readSessionTiming(sessionKey)
    assert.equal(reads, 1, 'later reads come from memory, not localStorage')
  } finally {
    restore()
  }
})

test('restores a unique timing sample when a long-session tail shifts its user ordinal', () => {
  const durations = { 'user:42:1700000000000': 1_200 }
  assert.equal(userTimingDuration(durations, 1_700_000_000_000, 0, 1), 1_200)
})

test('does not guess between timing samples with the same timestamp', () => {
  const durations = {
    'user:42:1700000000000': 1_200,
    'user:43:1700000000000': 1_500
  }
  assert.equal(userTimingDuration(durations, 1_700_000_000_000, 0, 2), undefined)
  assert.equal(userTimingDuration(durations, 1_700_000_000_000, 43, 2), 1_500)
})

test('does not apply one saved sample to another user message with the same timestamp', () => {
  const durations = { 'user:42:1700000000000': 1_200 }
  assert.equal(userTimingDuration(durations, 1_700_000_000_000, 43, 2), undefined)
})

test('new timing samples append without rewriting the full session snapshot', () => {
  const restore = installStorage()
  const sessionKey = 'C:/sessions/long-running.jsonl'
  const storageKey = `pi-desktop:session-timing:v1:${encodeURIComponent(sessionKey)}`
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    recordModelDuration(sessionKey, 'turn-1', 1_200)
    const snapshot = store.getItem(storageKey)
    assert.ok(snapshot)

    recordModelDuration(sessionKey, 'turn-2', 1_400)

    assert.equal(store.getItem(storageKey), snapshot, 'later samples do not serialize the growing record again')
    assert.equal(store.length, 3, 'the additional duration uses one indexed sample and its count')
    assert.deepEqual(readSessionTiming(sessionKey).modelDurationsMs, {
      'turn-1': 1_200,
      'turn-2': 1_400
    })
    recordModelDuration(sessionKey, 'turn-3', 1_600)
    assert.equal(JSON.parse(store.getItem(storageKey)!).modelTimingVersion, 9)
    assert.equal(store.getItem(`${storageKey}:sample:modelDurationsMs:turn-2`), null)
    assert.deepEqual(readSessionTiming(sessionKey).modelDurationsMs, {
      'turn-1': 1_200,
      'turn-2': 1_400,
      'turn-3': 1_600
    })
  } finally {
    restore()
  }
})

test('timing journals compact into snapshots instead of growing without bound', () => {
  const restore = installStorage()
  const sessionKey = 'C:/sessions/compacted.jsonl'
  const storageKey = `pi-desktop:session-timing:v1:${encodeURIComponent(sessionKey)}`
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    for (let index = 0; index < 257; index += 1) {
      recordModelDuration(sessionKey, `turn-${index}`, 1_000 + index)
    }

    const saved = JSON.parse(store.getItem(storageKey)!) as { modelDurationsMs: Record<string, number> }
    assert.equal(Object.keys(saved.modelDurationsMs).length, 257, 'compaction preserves every timing sample')
    assert.equal(store.length, 1, 'compaction folds the journal into the session snapshot')
    assert.equal(store.getItem(`${storageKey}:journal:count`), null)
  } finally {
    forgetSessionTiming(sessionKey)
    restore()
  }
})

test('an indexed sample survives an interrupted count update', () => {
  const restore = installStorage()
  const sessionKey = 'C:/sessions/journal-interrupted.jsonl'
  const key = `pi-desktop:session-timing:v1:${encodeURIComponent(sessionKey)}`
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    store.setItem(key, JSON.stringify({ modelTimingVersion: 9 }))
    store.setItem(`${key}:journal:count`, '0')
    store.setItem(`${key}:journal:0`, JSON.stringify({
      field: 'modelDurationsMs',
      id: 'turn-1',
      duration: 1_200
    }))

    assert.deepEqual(readSessionTiming(sessionKey).modelDurationsMs, { 'turn-1': 1_200 })
    recordModelDuration(sessionKey, 'turn-2', 1_400)
    assert.deepEqual(readSessionTiming(sessionKey).modelDurationsMs, {
      'turn-1': 1_200,
      'turn-2': 1_400
    })
  } finally {
    restore()
  }
})

test('timing reads merge appended samples with a saved session snapshot', () => {
  const restore = installStorage()
  const invalidSessionKey = 'C:/sessions/reopened-invalid.jsonl'
  const invalidStorageKey = `pi-desktop:session-timing:v1:${encodeURIComponent(invalidSessionKey)}`
  const sessionKey = 'C:/sessions/reopened.jsonl'
  const storageKey = `pi-desktop:session-timing:v1:${encodeURIComponent(sessionKey)}`
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    store.setItem(invalidStorageKey, JSON.stringify({
      modelTimingVersion: 8,
      modelDurationsMs: { 'turn-1': 1_200 }
    }))
    store.setItem(`${invalidStorageKey}:sample:modelDurationsMs:turn-2`, '1,400')
    store.setItem(storageKey, JSON.stringify({
      modelTimingVersion: 8,
      modelDurationsMs: { 'turn-1': 1_200 }
    }))
    store.setItem(`${storageKey}:sample:modelDurationsMs:turn-2`, '1400')

    assert.deepEqual(readSessionTiming(invalidSessionKey).modelDurationsMs, {
      'turn-1': 1_200
    }, 'invalid numeric data is ignored')
    assert.deepEqual(readSessionTiming(sessionKey).modelDurationsMs, {
      'turn-1': 1_200,
      'turn-2': 1_400
    })
  } finally {
    restore()
  }
})

test('timing journals reload evicted conversations without enumerating storage keys', () => {
  const restore = installStorage()
  const sessions = Array.from({ length: 41 }, (_, index) => `C:/sessions/index-${index}.jsonl`)
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    for (const [index, sessionKey] of sessions.entries()) {
      const key = `pi-desktop:session-timing:v1:${encodeURIComponent(sessionKey)}`
      store.setItem(key, JSON.stringify({ modelTimingVersion: 9 }))
      store.setItem(`${key}:journal:count`, '1')
      store.setItem(`${key}:journal:0`, JSON.stringify({
        field: 'modelDurationsMs',
        id: `turn-${index}`,
        duration: index + 1
      }))
    }
    let keyReads = 0
    const originalKey = store.key.bind(store)
    store.key = (index: number) => {
      keyReads += 1
      return originalKey(index)
    }

    for (const sessionKey of sessions) readSessionTiming(sessionKey)
    assert.deepEqual(readSessionTiming(sessions[0]).modelDurationsMs, { 'turn-0': 1 })
    assert.equal(keyReads, 0, 'indexed journals load by session keys instead of scanning all localStorage keys')
  } finally {
    restore()
  }
})

test('forgetting a deleted conversation drops its timing record', () => {
  const restore = installStorage()
  const sessionKey = 'C:/sessions/deleted.jsonl'
  const storageKey = `pi-desktop:session-timing:v1:${encodeURIComponent(sessionKey)}`
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    recordRunDuration(sessionKey, 1_700_000_000_000, 1_500)
    recordRunDuration(sessionKey, 1_700_000_000_001, 1_000)
    assert.ok(store.getItem(storageKey), 'the record exists before deletion')
    assert.equal(store.length, 3, 'a later sample is stored separately with the journal count')

    forgetSessionTiming(sessionKey)
    assert.equal(store.getItem(storageKey), null)
    assert.equal(store.length, 0, 'deleting a conversation also drops appended sample keys')
    assert.deepEqual(readSessionTiming(sessionKey), {
      modelDurationsMs: {},
      ttftDurationsMs: {},
      toolDurationsMs: {},
      runDurationsMs: {},
      generationWindowMs: {}
    })
  } finally {
    restore()
  }
})

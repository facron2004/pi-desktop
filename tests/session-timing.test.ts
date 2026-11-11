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
  recordTtftDuration
} from '../src/renderer/src/lib/session-timing'

function installStorage(): () => void {
  const values = new Map<string, string>()
  const original = (globalThis as unknown as { window?: unknown }).window
  const localStorage = {
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
    assert.equal(saved.modelTimingVersion, 5)
    assert.equal(saved.legacyModelDurationsMs, undefined)
    assert.deepEqual(readSessionTiming(sessionKey).modelDurationsMs, {
      keptTurn: 1_200,
      newTurn: 800
    })
  } finally {
    restore()
  }
})

test('v4 TTFT samples are dropped while other monotonic timings survive migration', () => {
  const restore = installStorage()
  const sessionKey = 'C:/sessions/old-text-ttft.jsonl'
  const storageKey = `pi-desktop:session-timing:v1:${encodeURIComponent(sessionKey)}`
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    store.setItem(storageKey, JSON.stringify({
      modelTimingVersion: 4,
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
    recordTtftDuration(sessionKey, 'turn2', 250)
    assert.deepEqual(JSON.parse(store.getItem(storageKey)!).ttftDurationsMs, { turn2: 250 })
    assert.equal(JSON.parse(store.getItem(storageKey)!).modelTimingVersion, 5)
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

test('forgetting a deleted conversation drops its timing record', () => {
  const restore = installStorage()
  const sessionKey = 'C:/sessions/deleted.jsonl'
  const storageKey = `pi-desktop:session-timing:v1:${encodeURIComponent(sessionKey)}`
  try {
    const store = (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage
    recordRunDuration(sessionKey, 1_700_000_000_000, 1_500)
    assert.ok(store.getItem(storageKey), 'the record exists before deletion')

    forgetSessionTiming(sessionKey)
    assert.equal(store.getItem(storageKey), null)
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

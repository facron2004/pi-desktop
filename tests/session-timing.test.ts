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
      legacyModelDurationsMs: {},
      ttftDurationsMs: {},
      toolDurationsMs: {},
      runDurationsMs: {},
      generationWindowMs: {}
    })
    assert.deepEqual(readSessionTiming('C:/sessions/session.jsonl'), {
      modelDurationsMs: { 'turn-1': 1_200 },
      legacyModelDurationsMs: {},
      ttftDurationsMs: { 'run-1': 650 },
      toolDurationsMs: { 'call-1': 300 },
      runDurationsMs: {},
      generationWindowMs: { '1700000000000': 2_500 }
    })
  } finally {
    restore()
  }
})

test('legacy wall-clock model samples are retained for existing session statistics', () => {
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

    assert.deepEqual(readSessionTiming(sessionKey), {
      modelDurationsMs: {},
      legacyModelDurationsMs: { oldTurn: 19_882_000 },
      ttftDurationsMs: { oldRun: 1_200 },
      toolDurationsMs: { oldCall: 300 },
      runDurationsMs: {},
      generationWindowMs: {}
    })

    recordModelDuration(sessionKey, 'newTurn', 800)
    const saved = JSON.parse(store.getItem(storageKey)!) as Record<string, unknown>
    assert.equal(saved.modelTimingVersion, 2)
    assert.deepEqual(saved.legacyModelDurationsMs, { oldTurn: 19_882_000 })
    assert.deepEqual(readSessionTiming(sessionKey).modelDurationsMs, { newTurn: 800 })
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
      legacyModelDurationsMs: {},
      ttftDurationsMs: {},
      toolDurationsMs: {},
      runDurationsMs: {},
      generationWindowMs: {}
    })
  } finally {
    restore()
  }
})

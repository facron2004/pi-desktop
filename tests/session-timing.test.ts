import test from 'node:test'
import assert from 'node:assert/strict'
import {
  migrateSessionTiming,
  readSessionTiming,
  recordModelDuration,
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

    migrateSessionTiming('draft:1', 'C:/sessions/session.jsonl')

    assert.deepEqual(readSessionTiming('draft:1'), {
      modelDurationsMs: {},
      ttftDurationsMs: {},
      toolDurationsMs: {}
    })
    assert.deepEqual(readSessionTiming('C:/sessions/session.jsonl'), {
      modelDurationsMs: { 'turn-1': 1_200 },
      ttftDurationsMs: { 'run-1': 650 },
      toolDurationsMs: { 'call-1': 300 }
    })
  } finally {
    restore()
  }
})

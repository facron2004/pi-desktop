import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPACTION_ALREADY_MESSAGE,
  COMPACTION_CANCELLED_MESSAGE,
  COMPACTION_EXTENSION_MANAGED_MESSAGE,
  COMPACTION_FAILED_MESSAGE,
  COMPACTION_NO_HISTORY_MESSAGE,
  COMPACTION_TIMEOUT_MESSAGE,
  compactionOwnedByExtension,
  describeCompactionFailure
} from '../src/renderer/src/lib/compaction-error'
import { translate } from '../src/renderer/src/lib/i18n'
import {
  normalizePiEvent,
  resetStreamState,
  type StreamContext
} from '../src/renderer/src/lib/stream-events'

const context: StreamContext = { sessionKey: 'thread-a', runId: 'run-1', turnId: 'turn-1' }

test('a client-side compact timeout is a real failure', () => {
  assert.deepEqual(
    describeCompactionFailure('Timed out waiting for "compact" response'),
    { message: COMPACTION_TIMEOUT_MESSAGE, benign: false }
  )
})

test('nothing to compact is a benign answer, with or without Pi\'s prefix', () => {
  for (const raw of [
    'Nothing to compact (session too small)',
    'Compaction failed: Nothing to compact (session too small)'
  ]) {
    assert.deepEqual(describeCompactionFailure(raw), {
      message: COMPACTION_NO_HISTORY_MESSAGE,
      benign: true
    })
  }
})

test('an already-compacted branch is a benign answer', () => {
  assert.deepEqual(describeCompactionFailure('Compaction failed: Already compacted'), {
    message: COMPACTION_ALREADY_MESSAGE,
    benign: true
  })
})

test('a cancelled compaction is not reported as a provider failure', () => {
  for (const raw of ['Compaction cancelled', 'Compaction aborted']) {
    assert.deepEqual(describeCompactionFailure(raw), {
      message: COMPACTION_CANCELLED_MESSAGE,
      benign: true
    })
  }
})

test('a cancelled compaction keeps its meaning through the IPC wrapper', () => {
  // This is the exact string `ipcRenderer.invoke` rejects with; it used to be
  // shown as a red thread banner because the classifier compared it whole.
  for (const raw of [
    "Error invoking remote method 'runtime:request': Error: Compaction cancelled",
    'Error: Compaction aborted'
  ]) {
    assert.deepEqual(describeCompactionFailure(raw), {
      message: COMPACTION_CANCELLED_MESSAGE,
      benign: true
    })
  }
  assert.equal(
    translate(COMPACTION_CANCELLED_MESSAGE, 'zh-CN'),
    '上下文压缩已取消。'
  )
})

test('the IPC wrapper is peeled from a real failure detail too', () => {
  assert.deepEqual(
    describeCompactionFailure("Error invoking remote method 'runtime:request': Error: 429 overloaded"),
    { message: 'Context compaction failed: 429 overloaded', benign: false }
  )
})

test('a provider failure keeps its real detail instead of a generic guess', () => {
  assert.deepEqual(describeCompactionFailure('Compaction failed: 429 overloaded'), {
    message: 'Context compaction failed: 429 overloaded',
    benign: false
  })
  assert.deepEqual(describeCompactionFailure('Auto-compaction failed: fetch failed'), {
    message: 'Context compaction failed: fetch failed',
    benign: false
  })
})

test('a provider payload is collapsed and capped before it reaches the UI', () => {
  const raw = `Compaction failed: ${'{"error":"x"} '.repeat(100)}`
  const result = describeCompactionFailure(raw)
  assert.equal(result.benign, false)
  assert.ok(result.message.length < 280)
  assert.ok(result.message.startsWith('Context compaction failed: '))
  assert.ok(!result.message.includes('\n'))
})

test('an empty error falls back to the generic failure', () => {
  assert.deepEqual(describeCompactionFailure('   '), {
    message: COMPACTION_FAILED_MESSAGE,
    benign: false
  })
})

test('a process that registered /acp owns compaction, one without it does not', () => {
  // The live command list decides: an extension that failed to load owns nothing.
  assert.equal(
    compactionOwnedByExtension([
      { name: 'compact', source: 'app' },
      { name: 'acp', source: 'extension' },
      { name: 'acp-subagents', source: 'extension' }
    ]),
    true
  )
  assert.equal(
    compactionOwnedByExtension([{ name: 'compact', source: 'app' }, { name: 'export', source: 'extension' }]),
    false
  )
  // The app's own commands can never be the marker, whatever they are named.
  assert.equal(compactionOwnedByExtension([{ name: 'acp', source: 'app' }]), false)
  assert.equal(compactionOwnedByExtension(undefined), false)
  // The guidance is localised for the warning toast.
  assert.equal(
    translate(COMPACTION_EXTENSION_MANAGED_MESSAGE, 'zh-CN'),
    '上下文压缩由已安装的扩展接管（如 Billion-Context）。请直接对 Pi 说「压缩上下文」，或使用扩展自己的命令（如 /acp）。'
  )
})

test('the transcript notice uses the same classification', () => {
  resetStreamState()
  const event = normalizePiEvent(
    {
      type: 'compaction_end',
      reason: 'manual',
      aborted: false,
      errorMessage: 'Compaction failed: Nothing to compact (session too small)'
    },
    context
  )
  assert.ok(event)
  assert.equal(event.type, 'notice')
  assert.equal(event.type === 'notice' && event.level, 'warn')
  assert.equal(event.type === 'notice' && event.text, COMPACTION_NO_HISTORY_MESSAGE)
})

test('Chinese keeps the failure detail and localises the benign answers', () => {
  assert.equal(
    translate('Context compaction failed: 429 overloaded', 'zh-CN'),
    '上下文压缩失败：429 overloaded'
  )
  assert.equal(
    translate('Compaction failed: Nothing to compact (session too small)', 'zh-CN'),
    '上下文压缩失败：对话太短，没有可压缩的历史记录'
  )
  assert.equal(
    translate(COMPACTION_NO_HISTORY_MESSAGE, 'zh-CN'),
    '当前对话还没有可压缩的历史记录。'
  )
  assert.equal(translate('Context compaction failed: 429 overloaded', 'en'), 'Context compaction failed: 429 overloaded')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  allowlistedEnv,
  callerFrames,
  describeCommand,
  readTraceHint,
  redactArgv,
  rpcTraceEnabled,
  sessionObservation,
  shouldProbeState
} from '../src/main/pi/trace'

test('trace is on in development, off when packaged, and the env flag wins', () => {
  assert.equal(rpcTraceEnabled({}, false), true)
  assert.equal(rpcTraceEnabled({}, true), false)
  assert.equal(rpcTraceEnabled({ PI_DESKTOP_RPC_TRACE: '1' }, true), true)
  assert.equal(rpcTraceEnabled({ PI_DESKTOP_RPC_TRACE: '0' }, false), false)
})

test('boot argv keeps the rpc shape and drops secret values', () => {
  const argv = redactArgv([
    '--mode',
    'rpc',
    '--session',
    'C:/sessions/a.jsonl',
    '--api-key',
    'sk-live',
    'TOKEN=abc',
    '--approve'
  ])
  assert.deepEqual(argv, [
    '--mode',
    'rpc',
    '--session',
    'C:/sessions/a.jsonl',
    '--api-key',
    '[redacted]',
    'TOKEN=[redacted]',
    '--approve'
  ])
})

test('command traces keep the session path and never the prompt', () => {
  const described = describeCommand('prompt', {
    id: 'pi-1',
    type: 'prompt',
    message: 'do not log this',
    images: [{ data: 'secret' }],
    streamingBehavior: 'steer'
  })
  const encoded = JSON.stringify(described)
  assert.equal(encoded.includes('do not log this'), false)
  assert.equal(encoded.includes('secret'), false)
  assert.deepEqual(described.payloadKeys, ['images', 'message', 'streamingBehavior'])
  assert.equal(
    describeCommand('switch_session', { sessionPath: 'C:/sessions/b.jsonl' }).targetSessionPath,
    'C:/sessions/b.jsonl'
  )
})

test('environment allowlist ignores credentials', () => {
  assert.deepEqual(
    allowlistedEnv({
      PI_CODING_AGENT_SESSION_DIR: 'C:/sessions',
      OPENAI_API_KEY: 'sk-live',
      PI_CODING_AGENT_DIR: 'C:/pi'
    }),
    {
      PI_CODING_AGENT_SESSION_DIR: 'C:/sessions',
      PI_CODING_AGENT_DIR: 'C:/pi'
    }
  )
})

test('state probes read identity only, and only session mutations ask for one', () => {
  assert.deepEqual(
    sessionObservation({
      sessionId: 'pi-1',
      sessionFile: 'C:/a.jsonl',
      isStreaming: true,
      sessionName: 'private title',
      model: { id: 'x' }
    }),
    { sessionId: 'pi-1', sessionFile: 'C:/a.jsonl', isStreaming: true }
  )
  assert.equal(shouldProbeState('switch_session'), true)
  assert.equal(shouldProbeState('prompt'), false)
  assert.equal(shouldProbeState('get_state'), false)
})

test('a trace hint has to be a short action name', () => {
  assert.deepEqual(readTraceHint({ sourceAction: 'sidebar-select', uiSessionId: 'C:/a.jsonl' }), {
    sourceAction: 'sidebar-select',
    uiSessionId: 'C:/a.jsonl'
  })
  assert.equal(readTraceHint({ sourceAction: 'has spaces' }), undefined)
  assert.equal(readTraceHint({ sourceAction: '' }), undefined)
  assert.equal(readTraceHint('sidebar-select'), undefined)
})

test('caller frames drop dependencies and internals', () => {
  const frames = callerFrames(
    [
      'Error',
      '    at PiRuntime.request (src/main/pi/runtime.ts:10:1)',
      '    at node:internal/process/task_queues:1:1',
      '    at wrapped (node_modules/electron/something.js:1:1)'
    ].join('\n')
  )
  assert.deepEqual(frames, ['at PiRuntime.request (src/main/pi/runtime.ts:10:1)'])
})

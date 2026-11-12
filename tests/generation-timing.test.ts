import test from 'node:test'
import assert from 'node:assert/strict'
import { generationTimingExtension } from '../src/main/pi/generation-timing'
import { GENERATION_TIMING_STATUS_KEY } from '../src/shared/types'

function fixture() {
  type Event = { assistantMessageEvent?: { type: string; delta?: string } }
  type Context = { ui: { setStatus: (key: string, text: string) => void } }
  const handlers = new Map<string, (event: Event, ctx: Context) => void>()
  const samples: number[] = []
  let now = 0
  const register = new Function('performance', generationTimingExtension().replace('export default function', 'return function'))({ now: () => now })
  register({ on: (type: string, handler: (event: Event, ctx: Context) => void) => handlers.set(type, handler) })
  const ctx = { ui: { setStatus: (key: string, text: string) => {
    assert.equal(key, GENERATION_TIMING_STATUS_KEY)
    samples.push((JSON.parse(text) as { ttftMs: number }).ttftMs)
  } } }
  return {
    samples,
    at: (value: number) => { now = value },
    emit: (type: string, event: Event = {}) => handlers.get(type)?.(event, ctx)
  }
}

const text = (delta = 'Hello') => ({ assistantMessageEvent: { type: 'text_delta', delta } })

test('TTFT starts at the model request, not at agent_start', () => {
  const f = fixture()
  f.emit('agent_start')
  f.at(26_000)
  f.emit('before_provider_request')
  f.at(26_100)
  f.emit('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'Reasoning' } })
  f.at(26_250)
  f.emit('message_update', { assistantMessageEvent: { type: 'toolcall_delta', delta: '{' } })
  assert.deepEqual(f.samples, [])
  f.at(26_500)
  f.emit('message_update', text('Final answer'))
  assert.deepEqual(f.samples, [500])
})

test('turn_start is the fallback when a transport has no provider hook', () => {
  const f = fixture()
  f.emit('agent_start')
  f.emit('turn_start')
  f.at(26_500)
  f.emit('message_update', text())
  assert.deepEqual(f.samples, [26_500])
})

test('tool execution and retry backoff between turns stay out of TTFT', () => {
  const f = fixture()
  f.emit('agent_start')
  f.emit('turn_start')
  f.at(400)
  f.emit('message_update', { assistantMessageEvent: { type: 'toolcall_delta', delta: '{' } })
  f.emit('turn_end')
  // Four minutes of tool work and retry backoff happen between the requests.
  f.at(240_000)
  f.emit('turn_start')
  f.emit('before_provider_request')
  f.at(240_300)
  f.emit('message_update', text('Retried'))
  assert.deepEqual(f.samples, [300])
})

test('a stalled request is dropped and a later request can still be measured', () => {
  const f = fixture()
  f.emit('agent_start')
  f.emit('before_provider_request')
  f.at(180_000)
  f.emit('message_update', text('Very late'))
  assert.deepEqual(f.samples, [])
  f.at(181_000)
  f.emit('before_provider_request')
  f.at(181_500)
  f.emit('message_update', text('Next answer'))
  assert.deepEqual(f.samples, [500])
})

test('one sample per run, and nothing outside a run', () => {
  const f = fixture()
  f.emit('agent_start')
  f.emit('before_provider_request')
  f.at(1_200)
  f.emit('message_update', text('First'))
  f.at(1_400)
  f.emit('message_update', text('Still streaming'))
  assert.deepEqual(f.samples, [1_200])
  f.emit('agent_settled')
  f.at(2_000)
  f.emit('message_update', text('Late'))
  assert.deepEqual(f.samples, [1_200])
  f.emit('agent_start')
  f.emit('before_provider_request')
  f.at(2_300)
  f.emit('message_update', text('New run'))
  assert.deepEqual(f.samples, [1_200, 300])
})

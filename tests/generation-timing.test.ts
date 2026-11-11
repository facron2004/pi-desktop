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

test('run TTFT includes preparation and hidden blocks, stopping at the first text delta', () => {
  const f = fixture()
  f.emit('agent_start')
  f.at(26_000)
  f.emit('before_provider_request')
  f.at(26_100)
  f.emit('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'Reasoning' } })
  f.at(26_250)
  f.emit('message_update', { assistantMessageEvent: { type: 'toolcall_delta', delta: '{' } })
  assert.deepEqual(f.samples, [])
  f.at(526_000)
  f.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Final answer' } })
  assert.deepEqual(f.samples, [526_000])
})

test('a slow prompt remains a 26.5-second TTFT sample', () => {
  const f = fixture()
  f.emit('agent_start')
  f.at(26_500)
  f.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } })
  assert.deepEqual(f.samples, [26_500])
})

test('tool calls and retries stay inside one prompt TTFT window until its first text', () => {
  const f = fixture()
  f.emit('agent_start')
  f.at(400)
  f.emit('message_update', { assistantMessageEvent: { type: 'toolcall_delta', delta: '{' } })
  f.emit('turn_end')
  f.at(60_000)
  f.emit('turn_start')
  f.at(60_300)
  f.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Retried' } })
  assert.deepEqual(f.samples, [60_300])
})

test('no text before settle or outside a run creates a timing sample', () => {
  const f = fixture()
  f.emit('before_provider_request')
  f.emit('agent_start')
  f.at(26_500)
  f.emit('message_update', { assistantMessageEvent: { type: 'thinking_delta', delta: 'Hidden' } })
  f.emit('agent_end')
  f.emit('agent_settled')
  f.emit('before_provider_request')
  f.emit('message_update', { assistantMessageEvent: { type: 'text_delta', delta: 'Late' } })
  assert.deepEqual(f.samples, [])
})

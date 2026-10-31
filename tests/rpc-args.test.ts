import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRpcArgs } from '../src/main/pi/rpc-args'

test('rpc launch baseline resumes one session and never switches it', () => {
  const args = buildRpcArgs(
    {
      cwd: 'C:/project',
      sessionFile: 'C:/project/session.jsonl',
      model: 'openai/gpt',
      thinkingLevel: 'medium'
    },
    true,
    'instructions.md',
    'perm.mjs',
    'mode.mjs',
    'provider.mjs'
  )
  assert.deepEqual(args, [
    '--mode',
    'rpc',
    '--extension',
    'provider.mjs',
    '--extension',
    'mode.mjs',
    '--extension',
    'perm.mjs',
    '--session',
    'C:/project/session.jsonl',
    '--model',
    'openai/gpt',
    '--thinking',
    'medium',
    '--append-system-prompt',
    'instructions.md',
    '--approve'
  ])
  assert.equal(args.includes('switch_session'), false)
  assert.equal(args.includes('abort'), false)
})

test('a new conversation is launched without a session file', () => {
  const args = buildRpcArgs({ cwd: 'C:/project' }, false)
  assert.equal(args.includes('--session'), false)
  assert.equal(args.at(-1), '--no-approve')
  assert.equal(args[0], '--mode')
  assert.equal(args[1], 'rpc')
})

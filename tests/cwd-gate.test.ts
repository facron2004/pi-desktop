import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CwdGate } from '../src/main/pi/cwd-gate'

test('one working directory has one writing conversation', () => {
  const gate = new CwdGate()
  assert.equal(gate.claim('C:\\project\\', 'a.jsonl'), true)
  assert.equal(gate.claim('C:/project', 'b.jsonl'), false)
  assert.equal(gate.holder('c:/project'), 'a.jsonl')
  gate.release('C:/project', 'b.jsonl')
  assert.equal(gate.holder('C:/project'), 'a.jsonl')
  gate.release('C:/project', 'a.jsonl')
  assert.equal(gate.claim('C:/project', 'b.jsonl'), true)
})

test('a draft id can be retargeted to its session file', () => {
  const gate = new CwdGate()
  assert.equal(gate.claim('C:/project', 'draft:1'), true)
  gate.retarget('draft:1', 'C:/project/a.jsonl')
  assert.equal(gate.holds('C:/project/a.jsonl'), true)
  assert.equal(gate.claim('C:/project', 'C:/project/a.jsonl'), true)
})

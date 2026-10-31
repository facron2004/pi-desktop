import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readSessionMessages } from '../src/main/sessions'

const fixture = path.join(process.cwd(), 'tests', 'fixtures', 'sessions', 'branch.jsonl')

test('the saved session sample restores the active branch and is not rewritten', async () => {
  const before = readFileSync(fixture)
  const messages = await readSessionMessages(fixture)
  assert.deepEqual(
    messages.map((message) => message.content),
    ['hello', 'hi']
  )
  assert.deepEqual(readFileSync(fixture), before)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runPiCli } from '../src/main/pi/cli'

/**
 * A workspace folder can disappear between listing it and running a Pi CLI
 * command. On Windows spawn reports that as "spawn <exe> ENOENT", which reads
 * like a missing binary and used to make every marketplace install fail. The
 * cwd must fall back to a directory that exists.
 */
test('runPiCli still launches when the requested cwd does not exist', async () => {
  const missing = path.join(os.tmpdir(), `pi-desktop-missing-cwd-${process.pid}`)
  rmSync(missing, { recursive: true, force: true })

  const result = await runPiCli(['--version'], { cwd: missing, timeoutMs: 30_000 })

  assert.equal(result.code, 0, `Pi CLI failed: ${result.stderr}`)
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /\d+\.\d+\.\d+/,
    'The Pi CLI did not report a version, so it never ran'
  )
  assert.doesNotMatch(result.stderr, /ENOENT/, 'A missing cwd must not surface as spawn ENOENT')
})

test('runPiCli uses a valid cwd unchanged', async () => {
  const result = await runPiCli(['--version'], { cwd: process.cwd(), timeoutMs: 30_000 })
  assert.equal(result.code, 0, `Pi CLI failed: ${result.stderr}`)
})

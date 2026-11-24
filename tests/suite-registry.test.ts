import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * `tests/run.mjs` runs a hand-written list, and that list is the gate: a suite
 * that exists but is not listed reads as coverage without being any. Several
 * suites were found orphaned that way (the adversarial and stress runners that
 * used to live behind their own commands). The list therefore has to name every
 * test file, and no entry may point at a file that is gone.
 */

const testsDir = path.resolve(process.cwd(), 'tests')

/** Test files that are deliberately outside the runner (none today). */
const UNREGISTERED_BY_DESIGN = new Set<string>()

function runnerSuites(): string[] {
  const source = readFileSync(path.join(testsDir, 'run.mjs'), 'utf8')
  const start = source.indexOf('const suites = [')
  const end = source.indexOf(']', start)
  assert.ok(start >= 0 && end > start, 'the runner suite list moved; update this test')
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map((match) => match[1])
}

test('every test file is registered with the runner', () => {
  const files = readdirSync(testsDir).filter((name) => /\.test\.(ts|mjs)$/.test(name))
  assert.ok(files.length > 100, `the scan found ${files.length} test files; it is looking at the wrong folder`)
  const listed = new Set(runnerSuites())
  const missing = files.filter((name) => !listed.has(name) && !UNREGISTERED_BY_DESIGN.has(name))
  assert.deepEqual(
    missing,
    [],
    `test files that never run because tests/run.mjs does not list them:\n  ${missing.join('\n  ')}`
  )
})

test('every registered suite exists', () => {
  const files = new Set(readdirSync(testsDir))
  const stale = runnerSuites().filter((name) => !files.has(name))
  assert.deepEqual(stale, [], `tests/run.mjs lists suites that do not exist:\n  ${stale.join('\n  ')}`)
})

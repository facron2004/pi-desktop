import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { terminateProcessTree } from '../scripts/process-tree.mjs'

/**
 * The shutdown path for build and dev commands. It must always settle: a
 * command that leaves a child running keeps the build lock held, and one that
 * waits forever leaves a half-killed tree behind.
 */

const timeout = (ms: number): Promise<never> =>
  new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms).unref())

test('terminating a running child resolves once it is gone', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  await new Promise<void>((resolve) => child.once('spawn', () => resolve()))
  try {
    await Promise.race([terminateProcessTree(child, 1_000), timeout(15_000)])
    assert.ok(
      child.exitCode !== null || child.signalCode !== null || child.killed,
      'the child must not still be running'
    )
  } finally {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
})

test('a child that never got a pid settles immediately', async () => {
  let killed = false
  await Promise.race([
    terminateProcessTree({ pid: undefined, kill: () => { killed = true } }),
    timeout(2_000)
  ])
  assert.equal(killed, true)
})

test('terminating an exited child still resolves', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise<void>((resolve) => child.once('exit', () => resolve()))
  await Promise.race([terminateProcessTree(child, 200), timeout(10_000)])
})

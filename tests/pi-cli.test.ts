import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('runPiCli preserves UTF-8 characters split across stdout and stderr chunks', async () => {
  const target = path.join(os.tmpdir(), `pi-cli-utf8-${process.pid}.js`)
  writeFileSync(target, `
    process.stdout.write(Buffer.from([0xe4]))
    process.stderr.write(Buffer.from([0xe4]))
    setTimeout(() => {
      process.stdout.write(Buffer.from([0xb8, 0xad]))
      process.stderr.write(Buffer.from([0xb8, 0xad]))
    }, 20)
  `)
  try {
    const result = await runPiCli(['emit'], { customPiPath: target, timeoutMs: 30_000 })
    assert.equal(result.code, 0)
    assert.equal(result.stdout, '中')
    assert.equal(result.stderr, '中')
  } finally {
    rmSync(target, { force: true })
  }
})

test('runPiCli caps captured stdout and stderr while draining the process', async () => {
  const target = path.join(os.tmpdir(), `pi-cli-output-${process.pid}.js`)
  writeFileSync(target, `
    const output = 'x'.repeat(2 * 1024 * 1024)
    process.stdout.write(output)
    process.stderr.write(output)
  `)
  try {
    const result = await runPiCli(['emit'], { customPiPath: target, timeoutMs: 30_000 })
    assert.equal(result.code, 0)
    assert.ok(result.stdout.length < 1_100_000, 'stdout capture must stay bounded')
    assert.ok(result.stderr.length < 1_100_000, 'stderr capture must stay bounded')
    assert.match(result.stdout, /Pi CLI output truncated/)
    assert.match(result.stderr, /Pi CLI output truncated/)
  } finally {
    rmSync(target, { force: true })
  }
})

test('runPiCli timeout terminates nested processes', async () => {
  const directory = os.tmpdir()
  const target = path.join(directory, `pi-cli-timeout-${process.pid}.js`)
  const started = path.join(directory, `pi-cli-started-${process.pid}`)
  const descendantStarted = path.join(directory, `pi-cli-descendant-started-${process.pid}`)
  const descendantPid = path.join(directory, `pi-cli-descendant-pid-${process.pid}`)
  writeFileSync(target, `
    require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started')
    const { spawn } = require('node:child_process')
    const descendant = ${JSON.stringify(`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(descendantStarted)}, 'started'); setTimeout(() => {}, 10000)`)}
    const child = spawn(process.execPath, ['-e', descendant], { stdio: 'ignore' })
    require('node:fs').writeFileSync(${JSON.stringify(descendantPid)}, String(child.pid))
    setTimeout(() => {}, 10000)
  `)
  rmSync(started, { force: true })
  rmSync(descendantStarted, { force: true })
  rmSync(descendantPid, { force: true })
  try {
    const result = await runPiCli(['hang'], { customPiPath: target, timeoutMs: 1000 })
    assert.equal(result.code, null)
    assert.equal(existsSync(started), true, 'the test child must start before its timeout')
    assert.equal(existsSync(descendantStarted), true, 'the nested process must start before its parent times out')
    const pid = Number(readFileSync(descendantPid, 'utf8'))
    let descendantAlive = false
    try {
      process.kill(pid, 0)
      descendantAlive = true
    } catch (error) {
      descendantAlive = (error as NodeJS.ErrnoException).code === 'EPERM'
    }
    assert.equal(descendantAlive, false, 'a descendant must not keep running after the CLI times out')
  } finally {
    if (existsSync(descendantPid)) {
      const pid = Number(readFileSync(descendantPid, 'utf8'))
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    rmSync(target, { force: true })
    rmSync(started, { force: true })
    rmSync(descendantStarted, { force: true })
    rmSync(descendantPid, { force: true })
  }
})

test('runPiCli abort terminates nested processes', async () => {
  const directory = os.tmpdir()
  const target = path.join(directory, `pi-cli-abort-${process.pid}.js`)
  const started = path.join(directory, `pi-cli-abort-started-${process.pid}`)
  const descendantStarted = path.join(directory, `pi-cli-abort-descendant-started-${process.pid}`)
  const descendantPid = path.join(directory, `pi-cli-abort-descendant-pid-${process.pid}`)
  writeFileSync(target, `
    require('node:fs').writeFileSync(${JSON.stringify(started)}, 'started')
    const { spawn } = require('node:child_process')
    const descendant = ${JSON.stringify(`const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(descendantStarted)}, 'started'); setTimeout(() => {}, 10000)`) }
    const child = spawn(process.execPath, ['-e', descendant], { stdio: 'ignore' })
    require('node:fs').writeFileSync(${JSON.stringify(descendantPid)}, String(child.pid))
    setTimeout(() => {}, 10000)
  `)
  rmSync(started, { force: true })
  rmSync(descendantStarted, { force: true })
  rmSync(descendantPid, { force: true })
  const controller = new AbortController()
  try {
    const running = runPiCli(['hang'], {
      customPiPath: target,
      timeoutMs: 30_000,
      signal: controller.signal
    })
    const deadline = Date.now() + 5_000
    while (!existsSync(descendantStarted) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.equal(existsSync(started), true, 'the test child must start before abort')
    assert.equal(existsSync(descendantStarted), true, 'the nested process must start before abort')
    const pid = Number(readFileSync(descendantPid, 'utf8'))
    controller.abort()
    const result = await running
    assert.equal(result.code, null)
    assert.match(result.stderr, /Command cancelled/)
    let descendantAlive = false
    try {
      process.kill(pid, 0)
      descendantAlive = true
    } catch (error) {
      descendantAlive = (error as NodeJS.ErrnoException).code === 'EPERM'
    }
    assert.equal(descendantAlive, false, 'a descendant must not keep running after cancellation')
  } finally {
    if (existsSync(descendantPid)) {
      const pid = Number(readFileSync(descendantPid, 'utf8'))
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    rmSync(target, { force: true })
    rmSync(started, { force: true })
    rmSync(descendantStarted, { force: true })
    rmSync(descendantPid, { force: true })
  }
})

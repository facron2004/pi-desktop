import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { terminateProcessTree } from './process-tree.mjs'

const require = createRequire(import.meta.url)
const lockfile = require('proper-lockfile')
const crossSpawn = require('cross-spawn')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lockPath = resolve(root, '.pi-desktop-build')
const action = process.argv[2]
let activeChild = null
let activeChildTermination = Promise.resolve()
let interruptedExitCode = null

function interrupt(exitCode) {
  if (interruptedExitCode !== null) return
  interruptedExitCode = exitCode
  process.exitCode = exitCode
  if (activeChild) activeChildTermination = terminateProcessTree(activeChild, 5000)
}

const onInterrupt = () => interrupt(130)
const onTerminate = () => interrupt(143)

const scripts = {
  build: ['__build'],
  'build:remote': ['__build:remote'],
  dist: ['__dist'],
  'dist:dir': ['__dist:dir'],
  'test:ui': ['__test:ui'],
  'test:e2e': ['__test:e2e'],
  dev: ['__dev'],
  'dev:desktop': ['__dev:desktop'],
  'remote:watch': ['__remote:watch'],
  start: ['__start']
}

if (!scripts[action]) {
  process.stderr.write(`Unknown build action: ${action ?? ''}\n`)
  process.exitCode = 1
} else {
  let release
  try {
    const options = {
      lockfilePath: lockPath,
      // A hard-killed command cannot release its lock; recover within five minutes.
      stale: 5 * 60 * 1000,
      update: 30 * 1000,
      retries: { retries: 3600, factor: 1, minTimeout: 1000, maxTimeout: 1000 }
    }
    if (await lockfile.check(root, options)) {
      process.stderr.write('Another app command is using out/. Waiting for it to finish.\n')
    }
    release = await lockfile.lock(root, options)
    process.on('SIGINT', onInterrupt)
    process.on('SIGTERM', onTerminate)

    for (const script of scripts[action]) {
      if (interruptedExitCode !== null) break
      const args = action === 'dist' || action === 'dist:dir' ? process.argv.slice(3) : []
      const code = await runNpmScript(script, args)
      if (code !== 0) {
        process.exitCode = interruptedExitCode ?? code
        break
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    process.exitCode = 1
  } finally {
    await activeChildTermination
    activeChild = null
    if (release) {
      try {
        await release()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`Could not release the build lock: ${message}\n`)
        process.exitCode = 1
      }
    }
    process.off('SIGINT', onInterrupt)
    process.off('SIGTERM', onTerminate)
    if (interruptedExitCode !== null && process.exitCode === undefined) {
      process.exitCode = interruptedExitCode
    }
  }
}

function runNpmScript(script, args = []) {
  return new Promise((resolveExit) => {
    // Electron-hosted terminals export this for their Node children. It must
    // not reach `electron-vite preview` (npm run start), or Electron starts as
    // plain Node instead of opening the app.
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = crossSpawn('npm', ['run', script, ...(args.length ? ['--', ...args] : [])], {
      cwd: root,
      detached: process.platform !== 'win32',
      stdio: 'inherit',
      windowsHide: true,
      env
    })
    activeChild = child
    let settled = false
    const finish = (code) => {
      if (settled) return
      settled = true
      resolveExit(code)
    }
    child.once('error', (error) => {
      process.stderr.write(`${error.message}\n`)
      finish(1)
    })
    child.once('exit', (code) => finish(code ?? 1))
  })
}

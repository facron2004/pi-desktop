#!/usr/bin/env node
/**
 * Run the Electron binary with a clean environment.
 *
 * A terminal hosted by an Electron app (this app's own integrated terminal, VS
 * Code, and similar) exports `ELECTRON_RUN_AS_NODE=1` for its Node children. If
 * a tool that launches Electron inherits it, Electron starts as plain Node and
 * the script dies on the first `electron.app` access — with no window and no
 * useful error. `scripts/dev.mjs` and `scripts/build-lock.mjs` strip the flag
 * for their children; this is the same guard for one-off electron scripts such
 * as `npm run icon`.
 *
 *   node scripts/run-electron.mjs scripts/make-icon.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// The electron package exports the absolute path of its binary.
const electron = require('electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: false,
  env
})

child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  // A caller that signals this process should stop the app it started, not
  // leave an Electron window behind.
  process.exitCode = code ?? (signal ? 1 : 0)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

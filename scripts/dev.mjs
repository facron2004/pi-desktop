import { createRequire } from 'node:module'
import { terminateProcessTree } from './process-tree.mjs'

// electron-vite reads node_modules/electron/path.txt directly instead of going
// through the electron package's loader, so a skipped or failed postinstall
// surfaces as "Error: Electron uninstall". Requiring the package here runs its
// own install check first and repairs the binary before electron-vite asks.
const require = createRequire(import.meta.url)
require('electron')
const crossSpawn = require('cross-spawn')
// A shell hosted by an Electron app (this app's integrated terminal, VS Code,
// and similar) exports ELECTRON_RUN_AS_NODE=1 for its Node children. If the
// launched Electron inherits it, it starts as plain Node and dies on the first
// `electron.app` access before a window exists.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const options = {
  stdio: 'inherit',
  windowsHide: true,
  detached: process.platform !== 'win32',
  env
}
const children = [
  crossSpawn('npm', ['run', '__dev:desktop'], options),
  crossSpawn('npm', ['run', '__remote:watch'], options)
]

let stopping = false

function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  void Promise.all(children.map((child) => terminateProcessTree(child)))
}

for (const child of children) {
  child.once('error', (error) => {
    process.stderr.write(`${error.message}\n`)
    stop(1)
  })
  child.once('exit', (code) => {
    if (!stopping) stop(code ?? 1)
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

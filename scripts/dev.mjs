import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

// electron-vite reads node_modules/electron/path.txt directly instead of going
// through the electron package's loader, so a skipped or failed postinstall
// surfaces as "Error: Electron uninstall". Requiring the package here runs its
// own install check first and repairs the binary before electron-vite asks.
createRequire(import.meta.url)('electron')

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// A shell hosted by an Electron app (this app's integrated terminal, VS Code,
// and similar) exports ELECTRON_RUN_AS_NODE=1 for its Node children. If the
// launched Electron inherits it, it starts as plain Node and dies on the first
// `electron.app` access before a window exists.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const options = {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env
}
const children = [
  spawn(npm, ['run', 'dev:desktop'], options),
  spawn(npm, ['run', 'remote:watch'], options)
]

let stopping = false

function stop(code = 0) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
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

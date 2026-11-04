import { spawn } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const options = {
  stdio: 'inherit',
  shell: process.platform === 'win32'
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

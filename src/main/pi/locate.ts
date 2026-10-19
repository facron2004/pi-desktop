import { app } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

export type PiSource = 'custom' | 'bundled' | 'path' | 'none'

export interface PiLaunchSpec {
  /** Executable to spawn. */
  command: string
  /** Arguments that always precede the RPC flags. */
  prefixArgs: string[]
  source: PiSource
  /** Human readable description of where the binary came from. */
  display: string
  /** Extra environment for the child process. */
  env: NodeJS.ProcessEnv
}

const CLI_RELATIVE = path.join(
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'bundle',
  'cli.js'
)

/** Pi requires Node.js >= 22.19. */
const MIN_NODE_MAJOR = 22
const MIN_NODE_MINOR = 19

function isScriptFile(target: string): boolean {
  return /\.(c|m)?js$/i.test(target)
}

/**
 * The asar archive hides the real files from `require`, so a bundled CLI that
 * has to be executed from disk has to live in the unpacked archive.
 */
function unpackedPath(): string {
  const appPath = app.getAppPath()
  return appPath.endsWith('app.asar')
    ? appPath.replace(/app\.asar$/, 'app.asar.unpacked')
    : appPath
}

export function findBundledCli(): string | null {
  const candidates = [
    path.join(app.getAppPath(), CLI_RELATIVE),
    path.join(unpackedPath(), CLI_RELATIVE)
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

function findOnPath(executable: string): string | null {
  const pathEnv = process.env.PATH ?? ''
  const exts =
    process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = path.join(dir, executable + ext)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export function currentNodeVersion(): string {
  return process.versions.node
}

function nodeSatisfiesPi(): boolean {
  const [major, minor] = process.versions.node.split('.').map((n) => parseInt(n, 10))
  if (Number.isNaN(major)) return false
  if (major > MIN_NODE_MAJOR) return true
  return major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR
}

/**
 * Resolve how to launch the Pi CLI.
 *
 * Priority:
 *  1. an explicit path from the user settings
 *  2. the CLI bundled with the app
 *  3. a `pi` executable on PATH
 */
export function resolvePiLaunch(customPath?: string): PiLaunchSpec {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // Pi writes protocol records to stdout; keep Node quiet about the bundle.
    NODE_OPTIONS: process.env.NODE_OPTIONS ?? ''
  }

  if (customPath && customPath.trim()) {
    const target = customPath.trim()
    if (isScriptFile(target)) {
      const node = nodeSatisfiesPi() ? process.execPath : findOnPath('node')
      if (node) {
        return {
          command: node,
          prefixArgs: [target],
          source: 'custom',
          display: target,
          env: node === process.execPath ? { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' } : baseEnv
        }
      }
    } else if (existsSync(target)) {
      return {
        command: target,
        prefixArgs: [],
        source: 'custom',
        display: target,
        env: baseEnv
      }
    }
  }

  const bundled = findBundledCli()
  if (bundled) {
    if (nodeSatisfiesPi()) {
      return {
        command: process.execPath,
        prefixArgs: [bundled],
        source: 'bundled',
        display: bundled,
        env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' }
      }
    }
    const systemNode = findOnPath('node')
    if (systemNode) {
      return {
        command: systemNode,
        prefixArgs: [bundled],
        source: 'bundled',
        display: `${systemNode} ${bundled}`,
        env: baseEnv
      }
    }
  }

  const onPath = findOnPath('pi')
  if (onPath) {
    return {
      command: onPath,
      prefixArgs: [],
      source: 'path',
      display: onPath,
      env: baseEnv
    }
  }

  return {
    command: '',
    prefixArgs: [],
    source: 'none',
    display: 'not found',
    env: baseEnv
  }
}

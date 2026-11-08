import { app } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AuthStatus } from '@shared/types'
import { resolvePiLaunch } from './locate'

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

const CLI_TIMEOUT_MS = 10_000
const WINDOWS_CHILD_PROCESS_PRELOAD = `
const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')

for (const method of ['spawn', 'spawnSync']) {
  const original = childProcess[method]
  childProcess[method] = function (...args) {
    const optionsIndex = Array.isArray(args[1]) ? 2 : 1
    const options = args[optionsIndex]
    if (options && typeof options === 'object') {
      args[optionsIndex] = { ...options, windowsHide: true }
    } else {
      args.splice(optionsIndex, 0, { windowsHide: true })
    }
    return Reflect.apply(original, this, args)
  }
}
syncBuiltinESMExports()
`

/**
 * Pi's package manager starts npm and git as child processes of the CLI. The
 * outer process is hidden by `windowsHide`, but Pi does not set that option on
 * its own children during installation, so preload a hook for that CLI run.
 */
function hideNestedWindows(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return env

  // Keep the preload outside app.asar so child Node processes can load it.
  const preloadPath = path.join(app.getPath('userData'), 'windows-hide-child-processes.cjs')
  mkdirSync(path.dirname(preloadPath), { recursive: true })
  if (
    !existsSync(preloadPath) ||
    readFileSync(preloadPath, 'utf8') !== WINDOWS_CHILD_PROCESS_PRELOAD
  ) {
    writeFileSync(preloadPath, WINDOWS_CHILD_PROCESS_PRELOAD, 'utf8')
  }
  const preloadOption = `--require="${preloadPath.replace(/\\/g, '/')}"`
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS?.trim(), preloadOption].filter(Boolean).join(' ')
  }
}

/** Run the Pi CLI once and capture its output. */
export function runPiCli(
  args: string[],
  options: { cwd?: string; customPiPath?: string; timeoutMs?: number; input?: string } = {}
): Promise<CliResult> {
  const launch = resolvePiLaunch(options.customPiPath)
  if (launch.source === 'none') {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: 'Pi CLI not found. Install it or set a custom path in Settings.'
    })
  }
  // A workspace folder can disappear between listing it and running a CLI
  // command. Windows spawn reports that as "spawn <exe> ENOENT", which looks
  // like a missing binary; fall back to a cwd that certainly exists instead.
  const requestedCwd = options.cwd && options.cwd.trim() ? options.cwd.trim() : ''
  const cwd = requestedCwd && existsSync(requestedCwd) ? requestedCwd : process.cwd()
  return new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.prefixArgs, ...args], {
      cwd,
      env: args[0] === 'install' ? hideNestedWindows(launch.env) : launch.env,
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    if (options.input !== undefined) {
      child.stdin?.on('error', () => {
        /* the child may exit before consuming its prompt; close handles it */
      })
      child.stdin?.end(options.input, 'utf8')
    }
    let stdout = ''
    let stderr = ''
    let settled = false

    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      resolve({
        code: null,
        stdout,
        stderr: stderr || `Command timed out after ${options.timeoutMs ?? CLI_TIMEOUT_MS}ms`
      })
    }, options.timeoutMs ?? CLI_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ code: null, stdout, stderr: stderr || error.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
  })
}

/** Check whether credentials for a provider are usable. */
export async function checkAuth(
  provider: string | undefined,
  customPiPath?: string
): Promise<AuthStatus> {
  if (!provider) {
    return { ready: false, state: 'unknown', detail: 'No provider selected' }
  }
  const args = ['auth', 'check', '--provider', provider, '--json']
  const result = await runPiCli(args, { customPiPath })
  const output = `${result.stdout}\n${result.stderr}`.trim()
  if (!output) {
    return { provider, ready: false, state: 'unknown', detail: result.stderr || 'No response' }
  }
  try {
    const parsed = JSON.parse(output) as {
      state?: string
      status?: string
      ready?: boolean
      provider?: string
      detail?: string
      message?: string
    }
    const state = String(parsed.state ?? parsed.status ?? '').toLowerCase()
    const ready = parsed.ready ?? state === 'ready'
    return {
      provider: parsed.provider ?? provider,
      ready,
      state: (state === 'ready' || state === 'not_ready' || state === 'invalid'
        ? state
        : 'unknown') as AuthStatus['state'],
      detail: parsed.detail ?? parsed.message
    }
  } catch {
    const lower = output.toLowerCase()
    const state: AuthStatus['state'] = lower.includes('ready')
      ? 'ready'
      : lower.includes('invalid')
        ? 'invalid'
        : 'not_ready'
    return { provider, ready: state === 'ready', state, detail: output.slice(0, 300) }
  }
}

/** Read the installed Pi version, used for the About panel. */
export async function piVersion(customPiPath?: string): Promise<string | undefined> {
  const result = await runPiCli(['--version'], { customPiPath })
  const value = result.stdout.trim() || result.stderr.trim()
  return value ? value.split('\n')[0] : undefined
}

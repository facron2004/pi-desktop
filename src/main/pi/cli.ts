import { app } from 'electron'
import { execFile, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AuthStatus } from '@shared/types'
import { resolvePiLaunch } from './locate'
import { spawn } from './spawn'

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

const CLI_TIMEOUT_MS = 10_000
const MAX_CLI_OUTPUT_CHARS = 1024 * 1024
const CLI_OUTPUT_TRUNCATION_NOTICE = `\n[Pi CLI output truncated at ${MAX_CLI_OUTPUT_CHARS} characters]`
let activeBundledCommands = 0
let bundledMaintenanceDone: Promise<void> | undefined
let resolveBundledMaintenance: (() => void) | undefined
let resolveBundledCommandsDrained: (() => void) | undefined
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

interface CapturedOutput {
  text: string
  truncated: boolean
}

function appendCliOutput(capture: CapturedOutput, text: string): void {
  if (capture.truncated) return
  const remaining = MAX_CLI_OUTPUT_CHARS - capture.text.length
  if (text.length > remaining) {
    capture.text += text.slice(0, remaining)
    capture.truncated = true
  } else {
    capture.text += text
  }
}

function cliOutput(capture: CapturedOutput): string {
  return capture.truncated ? `${capture.text}${CLI_OUTPUT_TRUNCATION_NOTICE}` : capture.text
}

export function killProcessTree(child: ChildProcess, done: () => void): void {
  const killChild = () => {
    try { child.kill('SIGKILL') } catch { /* the process may already have exited */ }
  }
  const waitForChildClose = (): Promise<void> => {
    const closed =
      (child.exitCode !== null || child.signalCode !== null) &&
      [child.stdin, child.stdout, child.stderr].every((stream) => !stream || stream.destroyed)
    if (closed) return Promise.resolve()
    return new Promise((resolve) => child.once('close', () => resolve()))
  }
  const waitForProcessGroupExit = async (pid: number): Promise<void> => {
    // A process group can keep one member that cannot die (a D-state child or
    // a process stuck in an uninterruptible call). Waiting on it forever would
    // leave the caller — and CLI maintenance — pending for the app's lifetime.
    const deadline = Date.now() + 5_000
    for (;;) {
      try {
        process.kill(-pid, 0)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      }
      if (Date.now() >= deadline) return
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    }
  }
  if (process.platform === 'win32' && child.pid) {
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10_000
    }, () => {
      if (child.exitCode === null && child.signalCode === null) killChild()
      void waitForChildClose().then(done)
    })
    return
  }
  if (!child.pid) {
    killChild()
    done()
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    killChild()
  }
  void Promise.all([waitForProcessGroupExit(child.pid), waitForChildClose()]).then(done)
}

/** Block new bundled CLI processes and wait for existing one-shot commands to exit. */
export async function beginBundledPiCliMaintenance(): Promise<() => void> {
  if (bundledMaintenanceDone) throw new Error('Pi CLI maintenance is already in progress.')
  bundledMaintenanceDone = new Promise<void>((resolve) => {
    resolveBundledMaintenance = resolve
  })
  if (activeBundledCommands > 0) {
    await new Promise<void>((resolve) => {
      resolveBundledCommandsDrained = resolve
    })
  }

  let finished = false
  return () => {
    if (finished) return
    finished = true
    const resolve = resolveBundledMaintenance
    resolveBundledMaintenance = undefined
    resolveBundledCommandsDrained = undefined
    bundledMaintenanceDone = undefined
    resolve?.()
  }
}

export function isBundledPiCliMaintenanceInProgress(): boolean {
  return bundledMaintenanceDone !== undefined
}

function releaseBundledCommand(): void {
  activeBundledCommands -= 1
  if (activeBundledCommands !== 0) return
  const resolve = resolveBundledCommandsDrained
  resolveBundledCommandsDrained = undefined
  resolve?.()
}

/** Hold the bundled CLI package in place while a direct Pi child is running. */
export async function acquireBundledPiCliCommand(): Promise<() => void> {
  while (bundledMaintenanceDone) await bundledMaintenanceDone
  activeBundledCommands += 1
  let released = false
  return () => {
    if (released) return
    released = true
    releaseBundledCommand()
  }
}

function waitForBundledMaintenance(maintenance: Promise<void>, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const onAbort = (): void => finish(false)
    if (signal?.aborted) {
      finish(false)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    void maintenance.then(() => finish(true))
  })
}

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
  options: {
    cwd?: string
    customPiPath?: string
    timeoutMs?: number
    input?: string
    signal?: AbortSignal
    allowDuringMaintenance?: boolean
  } = {}
): Promise<CliResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({ code: null, stdout: '', stderr: 'Command cancelled' })
  }
  const launch = resolvePiLaunch(options.customPiPath)
  if (bundledMaintenanceDone && launch.source !== 'custom' && !options.allowDuringMaintenance) {
    const maintenance = bundledMaintenanceDone
    return waitForBundledMaintenance(maintenance, options.signal).then((ready) =>
      ready ? runPiCli(args, options) : { code: null, stdout: '', stderr: 'Command cancelled' }
    )
  }
  if (launch.source === 'none') {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: 'Pi CLI not found. Install it or set a custom path in Settings.'
    })
  }
  const trackBundledCommand = launch.source === 'bundled' && !options.allowDuringMaintenance
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
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    if (trackBundledCommand) activeBundledCommands += 1
    if (options.input !== undefined) {
      child.stdin?.on('error', () => {
        /* the child may exit before consuming its prompt; close handles it */
      })
      child.stdin?.end(options.input, 'utf8')
    }
    const stdout: CapturedOutput = { text: '', truncated: false }
    const stderr: CapturedOutput = { text: '', truncated: false }
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let settled = false
    let activeCommandReleased = false
    let outputFinalized = false
    const releaseActiveCommand = (): void => {
      if (!trackBundledCommand || activeCommandReleased) return
      activeCommandReleased = true
      releaseBundledCommand()
    }
    const finishOutput = () => {
      if (outputFinalized) return
      outputFinalized = true
      appendCliOutput(stdout, stdoutDecoder.end())
      appendCliOutput(stderr, stderrDecoder.end())
    }
    const result = (code: number | null, stderrFallback = ''): CliResult => ({
      code,
      stdout: cliOutput(stdout),
      stderr: cliOutput(stderr) || stderrFallback
    })

    let timeout: NodeJS.Timeout
    let onAbort: (() => void) | undefined
    const cleanup = () => {
      clearTimeout(timeout)
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
    }
    const terminate = (reason: string) => {
      if (settled) return
      settled = true
      cleanup()
      killProcessTree(child, () => {
        finishOutput()
        releaseActiveCommand()
        resolve(result(null, reason))
      })
    }
    timeout = setTimeout(
      () => terminate(`Command timed out after ${options.timeoutMs ?? CLI_TIMEOUT_MS}ms`),
      options.timeoutMs ?? CLI_TIMEOUT_MS
    )

    child.stdout?.on('data', (chunk: Buffer) => {
      appendCliOutput(stdout, stdoutDecoder.write(chunk))
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      appendCliOutput(stderr, stderrDecoder.write(chunk))
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      cleanup()
      finishOutput()
      releaseActiveCommand()
      resolve(result(null, error.message))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      cleanup()
      finishOutput()
      releaseActiveCommand()
      resolve(result(code))
    })
    if (options.signal) {
      onAbort = () => terminate('Command cancelled')
      options.signal.addEventListener('abort', onAbort, { once: true })
      if (options.signal.aborted) onAbort()
    }
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
export async function piVersion(
  customPiPath?: string,
  options: { allowDuringMaintenance?: boolean } = {}
): Promise<string | undefined> {
  const result = await runPiCli(['--version'], { customPiPath, ...options })
  const value = result.stdout.trim() || result.stderr.trim()
  return value ? value.split('\n')[0] : undefined
}

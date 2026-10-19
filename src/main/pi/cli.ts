import { spawn } from 'node:child_process'
import type { AuthStatus } from '@shared/types'
import { resolvePiLaunch } from './locate'

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Run the Pi CLI once and capture its output. */
export function runPiCli(
  args: string[],
  options: { cwd?: string; customPiPath?: string } = {}
): Promise<CliResult> {
  const launch = resolvePiLaunch(options.customPiPath)
  if (launch.source === 'none') {
    return Promise.resolve({
      code: null,
      stdout: '',
      stderr: 'Pi CLI not found. Install it or set a custom path in Settings.'
    })
  }
  return new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.prefixArgs, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env: launch.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      resolve({ code: null, stdout, stderr: stderr || error.message })
    })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
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

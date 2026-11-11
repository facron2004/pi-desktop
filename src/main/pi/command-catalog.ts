import type { PiCommand } from '@shared/types'
import { acquireBundledPiCliCommand, isBundledPiCliMaintenanceInProgress } from './cli'
import { PiRpcClient } from './rpc-client'
import { resolvePiLaunch } from './locate'

/**
 * Discover Pi's Skills for a cold composer without starting its conversation
 * runtime. The temporary RPC process loads Pi's local resources, with network
 * access and extensions disabled; it sends no prompt and writes no session.
 */
export async function discoverSkillCommands(
  cwd: string,
  customPiPath?: string,
  trustProject = false
): Promise<PiCommand[]> {
  let launch = resolvePiLaunch(customPiPath)
  const needsBundledGate = launch.source === 'bundled' ||
    (launch.source !== 'custom' && isBundledPiCliMaintenanceInProgress())
  if (launch.source === 'none' && !needsBundledGate) return []
  const releaseCli = needsBundledGate
    ? await acquireBundledPiCliCommand()
    : () => {}
  try {
    // Resolve again after acquiring the gate so a waiting default lookup uses
    // the bundled executable that is present once an update has finished.
    if (needsBundledGate) launch = resolvePiLaunch(customPiPath)
    if (launch.source === 'none') return []

    const client = new PiRpcClient({
      command: launch.command,
      args: [
        ...launch.prefixArgs,
        '--mode',
        'rpc',
        '--offline',
        '--no-extensions',
        trustProject ? '--approve' : '--no-approve'
      ],
      cwd,
      env: launch.env
    })

    try {
      client.start()
      await client.request({ type: 'get_state' }, 30_000)
      const data = await client.request<{ commands?: PiCommand[] }>({ type: 'get_commands' }, 30_000)
      return (data?.commands ?? []).filter((command) => command.source === 'skill')
    } finally {
      await client.stop()
    }
  } finally {
    releaseCli()
  }
}

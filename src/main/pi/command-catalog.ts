import type { PiCommand } from '@shared/types'
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
  trustProject = true
): Promise<PiCommand[]> {
  const launch = resolvePiLaunch(customPiPath)
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
}

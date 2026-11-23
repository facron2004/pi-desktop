import { existsSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { PiCommand } from '@shared/types'
import { acquireBundledPiCliCommand, isBundledPiCliMaintenanceInProgress } from './cli'
import { PiRpcClient } from './rpc-client'
import { resolvePiLaunch } from './locate'

const SKILL_CACHE_TTL_MS = 30_000
const SKILL_CACHE_MAX_ENTRIES = 24

interface SkillCacheEntry {
  fingerprint: string
  expiresAt: number
  commands: PiCommand[]
}

const skillCache = new Map<string, SkillCacheEntry>()
const inFlightDiscoveries = new Map<string, Promise<PiCommand[]>>()

export function invalidateSkillCommandsCache(): void {
  skillCache.clear()
}

function agentDirectory(): string {
  const env = process.env.PI_CODING_AGENT_DIR
  return env && env.trim() ? path.resolve(env.trim()) : path.join(os.homedir(), '.pi', 'agent')
}

function statToken(target: string): string {
  try {
    const st = statSync(target, { bigint: true })
    return `${st.mtimeNs}:${st.size}`
  } catch {
    return '-'
  }
}

function skillSourceFingerprint(cwd: string): string {
  const agentDir = agentDirectory()
  return [
    statToken(path.join(agentDir, 'skills')),
    statToken(path.join(agentDir, 'settings.json')),
    statToken(path.join(os.homedir(), '.agents', 'skills')),
    statToken(path.join(cwd, '.pi', 'skills')),
    statToken(path.join(cwd, '.pi', 'settings.json')),
    statToken(path.join(cwd, '.agents', 'skills'))
  ].join('|')
}

async function runDiscoverSkillCommands(
  cwd: string,
  customPiPath: string | undefined,
  trustProject: boolean
): Promise<{ commands: PiCommand[]; cacheable: boolean }> {
  let launch = resolvePiLaunch(customPiPath)
  const needsBundledGate = launch.source === 'bundled' ||
    (launch.source !== 'custom' && isBundledPiCliMaintenanceInProgress())
  if (launch.source === 'none' && !needsBundledGate) return { commands: [], cacheable: false }
  const releaseCli = needsBundledGate
    ? await acquireBundledPiCliCommand()
    : () => {}
  try {
    // Resolve again after acquiring the gate so a waiting default lookup uses
    // the bundled executable that is present once an update has finished.
    if (needsBundledGate) launch = resolvePiLaunch(customPiPath)
    if (launch.source === 'none') return { commands: [], cacheable: false }

    const safeCwd = existsSync(cwd) ? cwd : process.cwd()
    const client = new PiRpcClient({
      command: launch.command,
      args: [
        ...launch.prefixArgs,
        '--mode',
        'rpc',
        '--no-session',
        '--offline',
        '--no-extensions',
        trustProject ? '--approve' : '--no-approve'
      ],
      cwd: safeCwd,
      env: launch.env
    })

    try {
      client.start()
      await client.request({ type: 'get_state' }, 30_000)
      const data = await client.request<{ commands?: PiCommand[] }>({ type: 'get_commands' }, 30_000)
      return {
        commands: (data?.commands ?? []).filter((command) => command.source === 'skill'),
        cacheable: true
      }
    } finally {
      await client.stop()
    }
  } finally {
    releaseCli()
  }
}

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
  const key = `${cwd}\0${customPiPath?.trim() ?? ''}\0${trustProject ? '1' : '0'}`
  const fingerprint = skillSourceFingerprint(cwd)
  const now = Date.now()
  const cached = skillCache.get(key)
  if (cached && cached.expiresAt > now && cached.fingerprint === fingerprint) {
    skillCache.delete(key)
    skillCache.set(key, cached)
    return cached.commands.map((command) => ({ ...command }))
  }

  const inflightKey = `${key}\0${fingerprint}`
  const existing = inFlightDiscoveries.get(inflightKey)
  if (existing) {
    return (await existing).map((command) => ({ ...command }))
  }

  const task = runDiscoverSkillCommands(cwd, customPiPath, trustProject)
    .then(({ commands, cacheable }) => {
      if (cacheable) {
        if (skillCache.size >= SKILL_CACHE_MAX_ENTRIES) {
          const oldest = skillCache.keys().next().value
          if (oldest !== undefined) skillCache.delete(oldest)
        }
        skillCache.set(key, {
          fingerprint,
          expiresAt: Date.now() + SKILL_CACHE_TTL_MS,
          commands
        })
      }
      return commands
    })
    .finally(() => {
      inFlightDiscoveries.delete(inflightKey)
    })

  inFlightDiscoveries.set(inflightKey, task)
  return (await task).map((command) => ({ ...command }))
}

import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { McpConfig, McpServerInfo } from '@shared/types'

const MAX_CONFIG_BYTES = 1024 * 1024

interface RawEntry {
  command?: unknown
  args?: unknown
  url?: unknown
  type?: unknown
  description?: unknown
  enabled?: unknown
  timeout?: unknown
  env?: unknown
  headers?: unknown
}

interface ParsedFile {
  entries: Map<string, RawEntry>
  error?: string
}

function readConfigFile(file: string): ParsedFile {
  const parsed: ParsedFile = { entries: new Map() }
  if (!file || !existsSync(file)) return parsed
  try {
    if (statSync(file).size > MAX_CONFIG_BYTES) {
      parsed.error = `${file}: the file is too large to read.`
      return parsed
    }
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown
    if (!raw || typeof raw !== 'object') {
      parsed.error = `${file}: the file does not contain an object.`
      return parsed
    }
    const servers = (raw as { mcpServers?: unknown }).mcpServers
    if (!servers || typeof servers !== 'object') return parsed
    for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') {
        parsed.error = `${file}: “${name}” is not a server entry.`
        continue
      }
      parsed.entries.set(name, value as RawEntry)
    }
  } catch (error) {
    parsed.error = `${file}: ${
      error instanceof Error ? error.message : 'the file could not be read.'
    }`
  }
  return parsed
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function keysOf(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  return Object.keys(value as Record<string, unknown>).sort((a, b) => a.localeCompare(b))
}

/**
 * Turn one configuration entry into the shape the dialog shows.
 *
 * `user` supplies the parts a project override leaves out (command, url, env),
 * the same way Pi merges the two files.
 */
function describe(
  name: string,
  entry: RawEntry,
  user: RawEntry | undefined,
  scope: McpServerInfo['scope'],
  overrideOnly: boolean
): McpServerInfo {
  const source = overrideOnly && user ? { ...user, ...entry } : entry
  const command = stringValue(source.command)
  const url = stringValue(source.url)
  const declared = stringValue(source.type)
  const transport: McpServerInfo['transport'] =
    declared === 'http' || declared === 'streamable-http' || (!command && url)
      ? 'http'
      : command
        ? 'stdio'
        : 'unknown'

  return {
    name,
    scope,
    transport,
    enabled: entry.enabled !== false,
    description: stringValue(source.description),
    command,
    args: Array.isArray(source.args)
      ? source.args.filter((arg): arg is string => typeof arg === 'string')
      : undefined,
    url,
    timeout: typeof source.timeout === 'number' ? source.timeout : undefined,
    envKeys: keysOf(source.env),
    headerKeys: keysOf(source.headers),
    overrideOnly: overrideOnly || undefined
  }
}

/**
 * Read the MCP configuration of a project, without connecting to anything.
 *
 * The files can contain credentials in `env` and `headers`; only the names of
 * those keys leave this module, never the values.
 */
export function readMcpConfig(workspacePath: string, trusted: boolean): McpConfig {
  const userPath = path.join(os.homedir(), '.pi', 'agent', 'mcp.json')
  const projectPath = workspacePath ? path.join(workspacePath, '.pi', 'mcp.json') : ''
  const user = readConfigFile(userPath)
  const projectExists = Boolean(projectPath) && existsSync(projectPath)
  const project: ParsedFile = projectExists
    ? readConfigFile(projectPath)
    : { entries: new Map<string, RawEntry>() }
  const projectIgnored = projectExists && !trusted

  const errors: string[] = []
  if (user.error) errors.push(user.error)
  if (project.error) errors.push(project.error)

  const servers: McpServerInfo[] = []
  const names = new Set<string>([...user.entries.keys()])
  if (!projectIgnored) for (const name of project.entries.keys()) names.add(name)

  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const fromUser = user.entries.get(name)
    const fromProject = projectIgnored ? undefined : project.entries.get(name)

    if (fromUser && fromProject) {
      const overrideOnly = !fromProject.command && !fromProject.url && !fromProject.type
      servers.push(describe(name, fromProject, fromUser, 'both', overrideOnly))
      continue
    }
    if (fromProject) {
      servers.push(describe(name, fromProject, undefined, 'project', false))
      continue
    }
    if (fromUser) {
      servers.push(describe(name, fromUser, undefined, 'user', false))
    }
  }

  return {
    userPath,
    projectPath,
    userExists: existsSync(userPath),
    projectExists,
    projectIgnored,
    servers,
    errors
  }
}

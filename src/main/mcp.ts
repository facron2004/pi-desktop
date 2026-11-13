import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MarketplaceActionResult } from '@shared/marketplace'
import type { McpConfig, McpServerInfo } from '@shared/types'
import { properLockfile } from './proper-lockfile'

const MAX_CONFIG_BYTES = 1024 * 1024
const configLockWait = new Int32Array(new SharedArrayBuffer(4))

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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

interface ConfigDocument {
  document: Record<string, unknown> | null
  error?: string
}

/** Read a whole mcp.json, keeping every top-level key so a rewrite preserves
 *  values this module does not understand. */
function readConfigDocument(file: string): ConfigDocument {
  if (!file || !existsSync(file)) return { document: null }
  try {
    if (statSync(file).size > MAX_CONFIG_BYTES) {
      return { document: null, error: `${file}: the file is too large to read.` }
    }
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const document = recordValue(parsed)
    if (!document) return { document: null, error: `${file}: the file does not contain an object.` }
    return { document }
  } catch (error) {
    return {
      document: null,
      error: `${file}: ${error instanceof Error ? error.message : 'the file could not be read.'}`
    }
  }
}

function writeConfigDocument(file: string, document: Record<string, unknown>): void {
  const target = realpathSync(file)
  const temporary = `${target}.${randomUUID()}.tmp`
  const mode = statSync(target).mode & 0o7777
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2), { encoding: 'utf8', mode })
    renameSync(temporary, target)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* the temporary file may not exist */ }
    throw error
  }
}

function withConfigFileLock<T>(file: string, operation: () => T): T {
  let release: () => void
  let lockedRetries = 0
  let permissionRetries = 0
  for (;;) {
    try {
      release = properLockfile.lockSync(file, { retries: 0 })
      break
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined
      if (code === 'ELOCKED' && lockedRetries < 49) lockedRetries += 1
      else if (process.platform === 'win32' && code === 'EPERM' && permissionRetries < 5) permissionRetries += 1
      else throw error
      Atomics.wait(configLockWait, 0, 0, 10)
    }
  }
  try {
    return operation()
  } finally {
    try {
      release()
    } catch (error) {
      console.error('[pi-desktop] could not release MCP config lock:', error)
    }
  }
}

function mutateConfigFile(
  file: string,
  mutate: (document: Record<string, unknown>) => boolean | string
): { updated: boolean; error?: string } {
  if (!existsSync(file)) return { updated: false }
  try {
    return withConfigFileLock(file, () => {
      if (!existsSync(file)) return { updated: false }
      const read = readConfigDocument(file)
      if (!read.document) return { updated: false, ...(read.error ? { error: read.error } : {}) }
      const changed = mutate(read.document)
      if (typeof changed === 'string') return { updated: false, error: changed }
      if (!changed) return { updated: false }
      writeConfigDocument(file, read.document)
      return { updated: true }
    })
  } catch (error) {
    return { updated: false, error: `${file}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** User config first, then the project config of the open workspace. */
function mcpConfigFiles(workspacePath: string): string[] {
  const files = [path.join(os.homedir(), '.pi', 'agent', 'mcp.json')]
  const workspace = workspacePath && workspacePath.trim() ? path.resolve(workspacePath.trim()) : ''
  if (workspace) files.push(path.join(workspace, '.pi', 'mcp.json'))
  return files
}

export function sanitizeUrl(rawUrl?: string): string | undefined {
  if (!rawUrl) return undefined
  if (typeof rawUrl !== 'string') return undefined

  // Pre-mask Basic Auth credentials before URL parsing.
  // WHATWG URL parser terminates authority parsing on '#' or '?' before '@',
  // which causes passwords starting with digits or containing '#' to be misinterpreted
  // as host:port + hash fragment, leaking the password in plaintext.
  const basicAuthRegex =
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)?([^\s/:@]*):([^\s/]*)@((\[[a-fA-F0-9:.]+\]|[^\s/:?#@]*)(?::\d+)?(?:[/?#].*|$))/

  let sanitized = rawUrl
  const authMatch = sanitized.match(basicAuthRegex)
  if (authMatch) {
    const proto = authMatch[1] || ''
    const user = authMatch[2]
    const hostAndRest = authMatch[4]
    sanitized = `${proto}${user}:***@${hostAndRest}`
  }

  const isSensitiveParamName = (name: string): boolean => {
    let decoded = name
    try {
      decoded = decodeURIComponent(name.replace(/\+/g, ' '))
    } catch {
      /* Keep checking the raw key when it contains malformed encoding. */
    }
    const normalized = decoded.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    return /(?:^|[._-])(?:token|access[-_.]?token|refresh[-_.]?token|secret|client[-_.]?secret|api[-_.]?key|key|auth(?:orization)?|password|passwd|pwd|credential|credentials|signature|sig|bearer|jwt)(?:$|[._-])/i.test(normalized)
  }
  const sensitiveQueryRegex = /([?&])([^=&#]+)=([^&#]*)/gi

  try {
    const parsed = new URL(sanitized)
    if (parsed.password) {
      parsed.password = '***'
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isSensitiveParamName(key)) {
        parsed.searchParams.set(key, '***')
      }
    }
    return parsed.toString()
  } catch {
    return sanitized.replace(sensitiveQueryRegex, (match, separator: string, key: string) =>
      isSensitiveParamName(key) ? `${separator}${key}=***` : match
    )
  }
}

const SENSITIVE_FLAG_REGEX =
  /^--?(?:[a-z0-9_.-]*-)?(?:token|secret|key|api[-_]?key|password|passwd|pwd|auth|credential|credentials)$/i

const SENSITIVE_KEY_VALUE_REGEX =
  /^(--?[a-z0-9_.-]*(?:token|secret|key|api[-_]?key|password|passwd|pwd|auth|credential|credentials)[a-z0-9_.-]*=)(.+)$/i

export function sanitizeArgs(args?: unknown): string[] | undefined {
  if (!args || !Array.isArray(args)) return undefined

  const sanitized: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (typeof arg !== 'string') continue

    // Mask value following a sensitive flag (e.g. ['--token', 'secret123'])
    const prevArg = i > 0 ? args[i - 1] : ''
    if (typeof prevArg === 'string' && SENSITIVE_FLAG_REGEX.test(prevArg)) {
      sanitized.push('***')
      continue
    }

    // Mask sensitive key=value flags (e.g. '--api-key=secret123')
    if (SENSITIVE_KEY_VALUE_REGEX.test(arg)) {
      sanitized.push(arg.replace(SENSITIVE_KEY_VALUE_REGEX, '$1***'))
      continue
    }

    // Mask embedded URLs (e.g. postgresql://user:pass@host/db)
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      sanitized.push(sanitizeUrl(arg) ?? arg)
      continue
    }

    // Mask connection strings (e.g. Pwd=... or Password=...)
    if (/(?:pwd|password)=/i.test(arg)) {
      sanitized.push(arg.replace(/((?:pwd|password)=)[^;]*/gi, '$1***'))
      continue
    }

    sanitized.push(arg)
  }
  return sanitized
}

export function sanitizeCommand(rawCommand?: unknown): string | undefined {
  if (!rawCommand || typeof rawCommand !== 'string') return undefined
  let sanitized = rawCommand.replace(
    /[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi,
    (url) => sanitizeUrl(url) ?? url
  )
  sanitized = sanitized.replace(
    /(--?[a-z0-9_.-]*(?:token|secret|key|api[-_]?key|password|passwd|pwd|auth|credential|credentials)[a-z0-9_.-]*=)[^\s"']+/gi,
    '$1***'
  )
  sanitized = sanitized.replace(/((?:pwd|password)=)[^;'"\s]*/gi, '$1***')
  return sanitized
}

function keysOf(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
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
  const rawCommand = stringValue(source.command)
  const command = sanitizeCommand(rawCommand)
  const rawUrl = stringValue(source.url)
  const url = sanitizeUrl(rawUrl)
  const declared = stringValue(source.type)
  const transport: McpServerInfo['transport'] =
    declared === 'http' || declared === 'streamable-http' || (!command && rawUrl)
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
    args: sanitizeArgs(source.args),
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

/**
 * Enable or disable one MCP server in every config file that declares it.
 * Other servers, command arguments and credentials are preserved as-is; only
 * `mcpServers[name].enabled` changes.
 */
export async function setMcpServerEnabled(
  name: string,
  enabled: boolean,
  workspacePath = ''
): Promise<MarketplaceActionResult> {
  const serverName = typeof name === 'string' ? name.trim() : ''
  if (!serverName) return { ok: false, output: 'Invalid MCP server name.' }
  if (typeof enabled !== 'boolean') return { ok: false, output: 'Invalid MCP enabled state.' }

  const updated: string[] = []
  const errors: string[] = []
  for (const file of mcpConfigFiles(workspacePath)) {
    const result = mutateConfigFile(file, document => {
      const servers = recordValue(document.mcpServers)
      if (!servers) return document.mcpServers === undefined ? false : `${file}: mcpServers is not an object.`
      if (!Object.hasOwn(servers, serverName)) return false
      const entry = recordValue(servers[serverName])
      if (!entry) return false
      entry.enabled = enabled
      return true
    })
    if (result.error) errors.push(result.error)
    if (result.updated) updated.push(file)
  }

  if (errors.length) return { ok: false, output: errors.join('\n') }
  if (!updated.length) return { ok: false, output: `MCP server "${serverName}" was not found.` }
  return {
    ok: true,
    output: `${enabled ? 'Enabled' : 'Disabled'} MCP server "${serverName}" in ${updated.length} file(s).`
  }
}

/** Remove one MCP server from every config file that declares it. */
export async function removeMcpServer(
  name: string,
  workspacePath = ''
): Promise<MarketplaceActionResult> {
  const serverName = typeof name === 'string' ? name.trim() : ''
  if (!serverName) return { ok: false, output: 'Invalid MCP server name.' }

  const removed: string[] = []
  const errors: string[] = []
  for (const file of mcpConfigFiles(workspacePath)) {
    const result = mutateConfigFile(file, document => {
      const servers = recordValue(document.mcpServers)
      if (!servers || !Object.hasOwn(servers, serverName)) return false
      delete servers[serverName]
      return true
    })
    if (result.error) errors.push(result.error)
    if (result.updated) removed.push(file)
  }

  if (errors.length) return { ok: false, output: errors.join('\n') }
  if (!removed.length) return { ok: false, output: `MCP server "${serverName}" was not found.` }
  return { ok: true, output: `Removed MCP server "${serverName}" from ${removed.length} file(s).` }
}

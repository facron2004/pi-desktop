import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { MarketplaceActionResult } from '@shared/marketplace'
import type { McpConfig, McpServerInfo } from '@shared/types'
import { properLockfile } from './proper-lockfile'
import { openWorkspaceFile, resolveWorkspacePath } from './workspace-files'

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

function isPathWithin(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

function resolveTrustedProjectMcpSync(workspacePath: string, projectPath: string): string | null {
  try {
    const realRoot = realpathSync(workspacePath)
    const realTarget = realpathSync(projectPath)
    return isPathWithin(realRoot, realTarget) ? realTarget : null
  } catch {
    return null
  }
}

async function readWorkspaceConfigDocument(
  workspacePath: string,
  relative: string,
  displayPath: string
): Promise<{ target: string; document: Record<string, unknown> | null; error?: string } | null> {
  const opened = await openWorkspaceFile(workspacePath, relative)
  if (!opened) {
    try {
      lstatSync(path.join(workspacePath, relative))
      return {
        target: '',
        document: null,
        error: `${displayPath}: project MCP config escapes the workspace.`
      }
    } catch {
      return null
    }
  }
  try {
    const stats = await opened.handle.stat()
    if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) {
      return { target: opened.target, document: null, error: `${displayPath}: the file is too large to read.` }
    }
    const chunks: Buffer[] = []
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let size = 0
    while (size <= MAX_CONFIG_BYTES) {
      const length = Math.min(buffer.length, MAX_CONFIG_BYTES + 1 - size)
      const { bytesRead } = await opened.handle.read(buffer, 0, length, null)
      if (bytesRead === 0) break
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)))
      size += bytesRead
    }
    if (size > MAX_CONFIG_BYTES) {
      return { target: opened.target, document: null, error: `${displayPath}: the file is too large to read.` }
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8').replace(/^\uFEFF/, ''))
    const document = recordValue(parsed)
    if (!document) {
      return { target: opened.target, document: null, error: `${displayPath}: the file does not contain an object.` }
    }
    return { target: opened.target, document }
  } catch (error) {
    return {
      target: opened.target,
      document: null,
      error: `${displayPath}: ${error instanceof Error ? error.message : 'the file could not be read.'}`
    }
  } finally {
    await opened.handle.close().catch(() => {})
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

async function writeWorkspaceConfigDocument(
  workspacePath: string,
  relative: string,
  target: string,
  document: Record<string, unknown>
): Promise<void> {
  const currentTarget = await resolveWorkspacePath(workspacePath, relative)
  if (currentTarget !== target) {
    throw new Error('The project MCP config changed while it was being updated.')
  }
  const temporary = `${target}.${randomUUID()}.tmp`
  const mode = statSync(target).mode & 0o7777
  try {
    writeFileSync(temporary, JSON.stringify(document, null, 2), { encoding: 'utf8', mode })
    const latestTarget = await resolveWorkspacePath(workspacePath, relative)
    if (latestTarget !== target) {
      throw new Error('The project MCP config changed while it was being updated.')
    }
    renameSync(temporary, target)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* the temporary file may not exist */ }
    throw error
  }
}

async function withConfigFileLock<T>(file: string, operation: () => Promise<T> | T): Promise<T> {
  let release: (() => Promise<void>) | undefined
  let permissionRetries = 0
  for (;;) {
    try {
      release = await properLockfile.lock(file, {
        retries: { retries: 10, minTimeout: 10, maxTimeout: 40, factor: 2 }
      })
      break
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined
      if (process.platform === 'win32' && code === 'EPERM' && permissionRetries < 5) {
        permissionRetries += 1
        await new Promise((resolve) => setTimeout(resolve, 10))
        continue
      }
      throw error
    }
  }
  try {
    return await operation()
  } finally {
    try {
      await release()
    } catch (error) {
      console.error('[pi-desktop] could not release MCP config lock:', error)
    }
  }
}

async function mutateUserConfigFile(
  file: string,
  mutate: (document: Record<string, unknown>) => boolean | string
): Promise<{ updated: boolean; error?: string }> {
  if (!existsSync(file)) return { updated: false }
  try {
    return await withConfigFileLock(file, () => {
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

async function mutateProjectConfigFile(
  workspacePath: string,
  mutate: (document: Record<string, unknown>) => boolean | string
): Promise<{ updated: boolean; error?: string }> {
  const workspace = workspacePath.trim() ? path.resolve(workspacePath.trim()) : ''
  if (!workspace) return { updated: false }
  const relative = '.pi/mcp.json'
  const displayPath = path.join(workspace, '.pi', 'mcp.json')
  try {
    const initial = await readWorkspaceConfigDocument(workspace, relative, displayPath)
    if (!initial) return { updated: false }
    if (!initial.document || !initial.target) {
      return { updated: false, ...(initial.error ? { error: initial.error } : {}) }
    }
    return await withConfigFileLock(initial.target, async () => {
      const current = await readWorkspaceConfigDocument(workspace, relative, displayPath)
      if (!current) return { updated: false }
      if (!current.document || current.target !== initial.target) {
        return { updated: false, error: current.error ?? `${displayPath}: project MCP config changed.` }
      }
      const changed = mutate(current.document)
      if (typeof changed === 'string') return { updated: false, error: changed }
      if (!changed) return { updated: false }
      await writeWorkspaceConfigDocument(workspace, relative, initial.target, current.document)
      return { updated: true }
    })
  } catch (error) {
    return { updated: false, error: `${displayPath}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function userMcpConfigFile(override?: string): string {
  return override ?? path.join(os.homedir(), '.pi', 'agent', 'mcp.json')
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

const SENSITIVE_FLAG_SOURCE = String.raw`--?(?:[a-z0-9_.-]*-)?(?:token|secret|key|api[-_]?key|password|passwd|pwd|auth|credential|credentials)`
const SENSITIVE_FLAG_REGEX = new RegExp(`^${SENSITIVE_FLAG_SOURCE}$`, 'i')
// The value can be quoted or contain escaped whitespace. Matching those forms
// explicitly avoids both leaking a quoted secret and splitting it into pieces.
const SENSITIVE_FLAG_SPACE_VALUE_REGEX = new RegExp(
  String.raw`(^|\s)(${SENSITIVE_FLAG_SOURCE})(\s+)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:\\.|[^\s])+)`,
  'gi'
)

const SENSITIVE_KEY_VALUE_REGEX =
  /^(--?[a-z0-9_.-]*(?:token|secret|key|api[-_]?key|password|passwd|pwd|auth|credential|credentials)[a-z0-9_.-]*=)(.+)$/i

const SENSITIVE_ENV_KEY_VALUE_REGEX =
  /^((?:[A-Za-z_][A-Za-z0-9_.-]*[_-])?(?:token|secret|api[_-]?key|access[_-]?key(?:[_-]?id)?|private[_-]?key|password|passwd|pwd|auth(?:[_-]?token)?|credential(?:s)?)(?:[_-][A-Za-z0-9_.-]*)?=)(.+?)(;?)$/i

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

    // Mask bare environment assignments (e.g. 'OPENAI_API_KEY=sk-123'). A
    // trailing `;` is a connection-string delimiter rather than part of the
    // secret, so it survives the mask and the redacted string still reads as one.
    if (SENSITIVE_ENV_KEY_VALUE_REGEX.test(arg)) {
      sanitized.push(arg.replace(SENSITIVE_ENV_KEY_VALUE_REGEX, '$1***$3'))
      continue
    }

    // Mask embedded URLs (e.g. postgresql://user:pass@host/db)
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) {
      sanitized.push(sanitizeUrl(arg) ?? arg)
      continue
    }

    // Mask Bearer tokens (e.g. '-H', 'Authorization: Bearer sk-123')
    if (/(?:^|\s)Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(arg)) {
      sanitized.push(arg.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'))
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
    /(--?[a-z0-9_.-]*(?:token|secret|key|api[-_]?key|password|passwd|pwd|auth|credential|credentials)[a-z0-9_.-]*=)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"']+)/gi,
    '$1***'
  )
  sanitized = sanitized.replace(
    /(^|\s)((?:[A-Za-z_][A-Za-z0-9_.-]*[_-])?(?:token|secret|api[_-]?key|access[_-]?key(?:[_-]?id)?|private[_-]?key|password|passwd|pwd|auth(?:[_-]?token)?|credential(?:s)?)(?:[_-][A-Za-z0-9_.-]*)?=)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s"';]+(;?))/gi,
    '$1$2***$3'
  )
  sanitized = sanitized.replace(SENSITIVE_FLAG_SPACE_VALUE_REGEX, '$1$2$3***')
  sanitized = sanitized.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***')
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
export function readMcpConfig(
  workspacePath: string,
  trusted: boolean,
  paths?: { userPath: string; projectPath: string }
): McpConfig {
  const userPath = paths?.userPath ?? path.join(os.homedir(), '.pi', 'agent', 'mcp.json')
  const projectPath = paths?.projectPath ?? (workspacePath ? path.join(workspacePath, '.pi', 'mcp.json') : '')
  const user = readConfigFile(userPath)
  let projectExists = false
  if (projectPath) {
    try {
      lstatSync(projectPath)
      projectExists = true
    } catch {
      projectExists = false
    }
  }
  const projectIgnored = projectExists && !trusted
  let project: ParsedFile = { entries: new Map<string, RawEntry>() }
  if (projectExists && trusted) {
    if (paths?.projectPath) {
      project = readConfigFile(projectPath)
    } else {
      const resolvedProject = resolveTrustedProjectMcpSync(workspacePath, projectPath)
      if (resolvedProject) {
        project = readConfigFile(resolvedProject)
      } else {
        project.error = `${projectPath}: project MCP config escapes the workspace.`
      }
    }
  }

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
  workspacePath = '',
  trusted = false,
  paths?: { userPath?: string }
): Promise<MarketplaceActionResult> {
  const serverName = typeof name === 'string' ? name.trim() : ''
  if (!serverName) return { ok: false, output: 'Invalid MCP server name.' }
  if (typeof enabled !== 'boolean') return { ok: false, output: 'Invalid MCP enabled state.' }

  const mutate = (file: string) => (document: Record<string, unknown>): boolean | string => {
    const servers = recordValue(document.mcpServers)
    if (!servers) return document.mcpServers === undefined ? false : `${file}: mcpServers is not an object.`
    if (!Object.hasOwn(servers, serverName)) return false
    const entry = recordValue(servers[serverName])
    if (!entry) return false
    entry.enabled = enabled
    return true
  }

  const updated: string[] = []
  const errors: string[] = []
  const userFile = userMcpConfigFile(paths?.userPath)
  const userResult = await mutateUserConfigFile(userFile, mutate(userFile))
  if (userResult.error) errors.push(userResult.error)
  if (userResult.updated) updated.push(userFile)

  if (trusted && workspacePath && workspacePath.trim()) {
    const projectFile = path.join(path.resolve(workspacePath.trim()), '.pi', 'mcp.json')
    const projectResult = await mutateProjectConfigFile(workspacePath, mutate(projectFile))
    if (projectResult.error) errors.push(projectResult.error)
    if (projectResult.updated) updated.push(projectFile)
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
  workspacePath = '',
  trusted = false,
  paths?: { userPath?: string }
): Promise<MarketplaceActionResult> {
  const serverName = typeof name === 'string' ? name.trim() : ''
  if (!serverName) return { ok: false, output: 'Invalid MCP server name.' }

  const mutate = (document: Record<string, unknown>): boolean => {
    const servers = recordValue(document.mcpServers)
    if (!servers || !Object.hasOwn(servers, serverName)) return false
    delete servers[serverName]
    return true
  }

  const removed: string[] = []
  const errors: string[] = []
  const userFile = userMcpConfigFile(paths?.userPath)
  const userResult = await mutateUserConfigFile(userFile, mutate)
  if (userResult.error) errors.push(userResult.error)
  if (userResult.updated) removed.push(userFile)

  if (trusted && workspacePath && workspacePath.trim()) {
    const projectFile = path.join(path.resolve(workspacePath.trim()), '.pi', 'mcp.json')
    const projectResult = await mutateProjectConfigFile(workspacePath, mutate)
    if (projectResult.error) errors.push(projectResult.error)
    if (projectResult.updated) removed.push(projectFile)
  }

  if (errors.length) return { ok: false, output: errors.join('\n') }
  if (!removed.length) return { ok: false, output: `MCP server "${serverName}" was not found.` }
  return { ok: true, output: `Removed MCP server "${serverName}" from ${removed.length} file(s).` }
}

/**
 * Development traces for the four session chains.
 *
 * Boot traces are emitted at the real `spawn` boundary. Command traces are
 * emitted at the stdin write, which is the only place a Pi command can leave
 * the app. Neither record may carry a prompt, a tool argument, an approval
 * answer, or an environment value that was not explicitly allowlisted.
 *
 * Off in a packaged build unless `PI_DESKTOP_RPC_TRACE=1`. `=0` silences it
 * even in development. The traces do not change which command is sent.
 */

const ENV_ALLOWLIST = ['PI_CODING_AGENT_SESSION_DIR', 'PI_CODING_AGENT_DIR'] as const

/** Commands that replace or stop the shared Pi session. Probed after they return. */
const SESSION_MUTATIONS = new Set([
  'switch_session',
  'new_session',
  'abort',
  'abort_retry',
  'fork',
  'clone'
])

const SECRET_FLAG = /^(?:--)?(?:api[-_]?key|token|password|secret|authorization|credential)$/i

export interface RpcOutboundMeta {
  sourceAction?: string
  uiSessionId?: string
  beforePiSessionId?: string
  beforePiSessionFile?: string
  runtimeEpoch?: number
  caller?: string[]
}

export interface RuntimeBootTrace {
  kind: 'boot'
  at: number
  runtimeEpoch: number
  pid?: number
  executablePath: string
  argv: string[]
  cwd: string
  envKeyAllowlist: Record<string, string | undefined>
  uiSessionId?: string
  requestedSessionPath?: string
  sourceAction?: string
}

export interface RpcCommandTrace {
  kind: 'command'
  at: number
  traceId: string
  requestId?: string
  commandType: string
  sourceAction?: string
  uiSessionId?: string
  targetSessionPath?: string
  /** Names of the fields on the command. Values are not copied. */
  payloadKeys: string[]
  beforePiSessionId?: string
  beforePiSessionFile?: string
  runtimeEpoch: number
  pid?: number
  caller?: string[]
  delivered: boolean
}

export interface RpcStateProbe {
  kind: 'state_probe'
  at: number
  afterCommand: string
  runtimeEpoch: number
  pid?: number
  sessionId?: string
  sessionFile?: string
  isStreaming?: boolean
  ok: boolean
  error?: string
}

export function rpcTraceEnabled(env: NodeJS.ProcessEnv, packaged: boolean): boolean {
  if (env.PI_DESKTOP_RPC_TRACE === '0') return false
  if (env.PI_DESKTOP_RPC_TRACE === '1') return true
  return !packaged
}

export function shouldProbeState(command: string): boolean {
  return SESSION_MUTATIONS.has(command)
}

export function allowlistedEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const key of ENV_ALLOWLIST) {
    if (env[key] !== undefined) out[key] = env[key]
  }
  return out
}

/** Drop secret flag values. Everything else on the Pi argv is a path or a mode. */
export function redactArgv(argv: string[]): string[] {
  const out: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? ''
    const eq = arg.indexOf('=')
    if (eq > 0 && SECRET_FLAG.test(arg.slice(0, eq).replace(/^-+/, ''))) {
      out.push(`${arg.slice(0, eq)}=[redacted]`)
      continue
    }
    if (SECRET_FLAG.test(arg)) {
      out.push(arg, '[redacted]')
      index += 1
      continue
    }
    out.push(arg)
  }
  return out
}

/**
 * Identity fields only.
 *
 * `sessionPath` is the RPC target, so it is kept. Message text, names, bash
 * commands and approval answers stay out — a key list is enough to see that
 * a prompt was sent.
 */
export function describeCommand(
  type: string,
  fields: Record<string, unknown>
): { commandType: string; targetSessionPath?: string; payloadKeys: string[] } {
  const sessionPath = fields.sessionPath
  const target =
    typeof sessionPath === 'string' && sessionPath.length > 0 && sessionPath.length <= 1024
      ? sessionPath
      : undefined
  return {
    commandType: type,
    ...(target ? { targetSessionPath: target } : {}),
    payloadKeys: Object.keys(fields)
      .filter((key) => key !== 'id' && key !== 'type')
      .sort()
  }
}

export function sessionObservation(state: unknown): {
  sessionId?: string
  sessionFile?: string
  isStreaming?: boolean
} {
  if (!state || typeof state !== 'object') return {}
  const record = state as Record<string, unknown>
  return {
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
    ...(typeof record.sessionFile === 'string' ? { sessionFile: record.sessionFile } : {}),
    ...(typeof record.isStreaming === 'boolean' ? { isStreaming: record.isStreaming } : {})
  }
}

/** Renderer-supplied label. Reject anything that is not a short action name. */
export function readTraceHint(value: unknown): { sourceAction: string; uiSessionId?: string } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = (value as { sourceAction?: unknown }).sourceAction
  const ui = (value as { uiSessionId?: unknown }).uiSessionId
  if (typeof source !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,79}$/i.test(source)) return undefined
  if (ui !== undefined && (typeof ui !== 'string' || ui.length > 1024)) return undefined
  return { sourceAction: source, ...(typeof ui === 'string' && ui.length > 0 ? { uiSessionId: ui } : {}) }
}

export function callerFrames(stack: string | undefined, limit = 8): string[] {
  if (!stack) return []
  return stack
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .filter((line) => !line.includes('node_modules') && !line.includes('node:internal'))
    .slice(0, limit)
}

export function emitTrace(record: RuntimeBootTrace | RpcCommandTrace | RpcStateProbe | object): void {
  console.info(`[pi-desktop:trace] ${JSON.stringify(record)}`)
}

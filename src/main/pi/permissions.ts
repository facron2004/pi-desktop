import { lstatSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ToolApproval } from '@shared/types'

/** Resolve existing ancestors too, so a new file beneath a symlink cannot escape. */
function realPath(target: string): string {
  const missing: string[] = []
  while (!lstatSync(target, { throwIfNoEntry: false })) {
    const parent = path.dirname(target)
    if (parent === target) throw new Error('No existing ancestor')
    missing.unshift(path.basename(target))
    target = parent
  }
  return path.join(realpathSync(target), ...missing)
}

function huggingFaceCredentialPaths(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const resolveConfigPath = (value: string) => {
    const expanded = value.replace(/^~(?=$|[\\/])/, homedir())
    return path.resolve(cwd, expanded)
  }
  const cacheHome = env.HF_HOME
    ? resolveConfigPath(env.HF_HOME)
    : path.join(env.XDG_CACHE_HOME ? resolveConfigPath(env.XDG_CACHE_HOME) : path.join(homedir(), '.cache'), 'huggingface')
  return [
    env.HF_TOKEN_PATH ? resolveConfigPath(env.HF_TOKEN_PATH) : path.join(cacheHome, 'token'),
    path.join(cacheHome, 'stored_tokens')
  ]
}

export function canAutoApprove(approval: ToolApproval, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (approval.toolSource !== 'builtin' || !['read', 'write', 'edit'].includes(approval.toolName)) return false
  const raw = approval.input.path
  if (typeof raw !== 'string' || !raw || /^[@~]|^file:/i.test(raw)) return false
  // Pi expands these spellings before using them. Ambiguous paths need approval.
  if (/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(raw)) return false
  if (process.platform === 'win32' && (raw.startsWith('/') || raw.replace(/^[a-z]:/i, '').includes(':'))) return false
  try {
    const workingDirectory = approval.cwd ?? cwd
    const target = path.resolve(workingDirectory, raw)
    const sessionRoot = realpathSync(cwd)
    const root = realpathSync(workingDirectory)
    const inside = (relative: string) => relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    if (!inside(path.relative(sessionRoot, root))) return false
    const lexical = path.relative(workingDirectory, target)
    const realTarget = realPath(target)
    const resolved = path.relative(root, realTarget)
    if (!inside(lexical) || !inside(resolved)) return false
    const configuredHfCredentials = huggingFaceCredentialPaths(workingDirectory, env).map(realPath)
    if (configuredHfCredentials.some((credential) => [target, realTarget].some((candidate) => inside(path.relative(credential, candidate))))) return false
    const absolute = path.relative(path.parse(root).root, realTarget)
    const file = statSync(target, { throwIfNoEntry: false })
    if (file?.isFile() && file.nlink > 1) return false
    const protectedPath = /^(?:\.git|\.pi|\.agents|node_modules|\.ssh|\.aws|\.docker|\.azure|\.kube|\.gnupg|\.env(?:\..*)?|\.envrc|\.npmrc|\.netrc|\.pypirc|\.git-credentials|auth\.json|application_default_credentials\.json|credentials(?:\.(?:json|ya?ml|toml|ini))?|service[-_]account(?:\.[^.]+)?|secrets?(?:\.(?:json|ya?ml|toml|ini))?|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i
    return ![absolute, lexical, resolved].some((relative) => {
      const parts = relative.split(path.sep).map((part) => part.replace(/[ .]+$/, ''))
      return parts.some((part) => protectedPath.test(part)) ||
        parts.some((part, index) =>
          part.toLowerCase() === '.config' && ['gcloud', 'gh'].includes(parts[index + 1]?.toLowerCase())
        ) ||
        parts.some((part, index) =>
          part.toLowerCase() === '.cache' &&
          parts[index + 1]?.toLowerCase() === 'huggingface' &&
          ['token', 'stored_tokens'].includes(parts[index + 2]?.toLowerCase())
        )
    })
  } catch {
    return false
  }
}

/** A private dialog title keeps ordinary extension confirmations out of this gate. */
export function permissionExtension(title: string, exemptDesktopTools = true): string {
  const exemptTools = exemptDesktopTools
    ? ['desktop_goal_finish', 'exit_plan_mode', 'desktop_todo', 'computer']
    : []
  return `export default function (pi) {
    let pending = Promise.resolve();
    const exemptTools = new Set(${JSON.stringify(exemptTools)});
    function freeze(value, seen = new WeakSet()) {
      if (!value || typeof value !== 'object' || seen.has(value)) return;
      seen.add(value);
      for (const child of Object.values(value)) freeze(child, seen);
      if (!Object.isFrozen(value)) Object.freeze(value);
    }
    pi.on('session_start', (_event, ctx) => ctx.ui.setStatus(${JSON.stringify(title)}, 'ready'));
    pi.on('tool_call', (event, ctx) => {
      // Mode tools record session state or run their own approval.
      // exit_plan_mode asks through its own dialog. desktop_todo only records
      // the checklist in the session, so asking on every update would stop the
      // agent for a bookkeeping step. computer is only offered after the user
      // turns it on in Settings, and a per-click dialog would make the
      // observe/act loop unusable, so that switch is the approval.
      if (exemptTools.has(event.toolName)) return;
      const decide = async () => {
        if (ctx.signal?.aborted || !ctx.hasUI) return { block: true, reason: 'Tool approval is unavailable', terminate: true };
        try {
          const tool = pi.getAllTools().find(tool => tool.name === event.toolName);
          const toolSource = tool?.sourceInfo?.source;
          const approval = {toolName:event.toolName,input:event.input,cwd:ctx.cwd};
          if (typeof toolSource === 'string') approval.toolSource = toolSource;
          const allowed = await ctx.ui.confirm(${JSON.stringify(title)}, JSON.stringify(approval));
          if (allowed && !ctx.signal?.aborted) {
            // Later extension hooks run after this approval and can mutate tool inputs.
            freeze(event.input);
            Object.freeze(event);
            return;
          }
        } catch {}
        return { block: true, reason: 'The user did not approve this tool operation', terminate: true };
      };
      const result = pending.then(decide);
      pending = result.then(() => {}, () => {});
      return result;
    });
  }`
}

export function parseToolApproval(message?: string): ToolApproval | undefined {
  try {
    const value: unknown = JSON.parse(message ?? '')
    if (!value || typeof value !== 'object') return
    const { toolName, input, toolSource, cwd } = value as Record<string, unknown>
    if (typeof toolName !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) return
    if (toolSource !== undefined && typeof toolSource !== 'string') return
    if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd))) return
    return {
      toolName,
      input: input as Record<string, unknown>,
      ...(typeof toolSource === 'string' ? { toolSource } : {}),
      ...(typeof cwd === 'string' ? { cwd } : {})
    }
  } catch {
    return undefined
  }
}

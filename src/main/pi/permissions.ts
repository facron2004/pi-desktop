import { lstatSync, realpathSync, statSync } from 'node:fs'
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

export function canAutoApprove(approval: ToolApproval, cwd: string): boolean {
  if (!['read', 'write', 'edit'].includes(approval.toolName)) return false
  const raw = approval.input.path
  if (typeof raw !== 'string' || !raw || /^[@~]|^file:/i.test(raw)) return false
  // Pi expands these spellings before using them. Ambiguous paths need approval.
  if (/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/.test(raw)) return false
  if (process.platform === 'win32' && (raw.startsWith('/') || raw.replace(/^[a-z]:/i, '').includes(':'))) return false
  try {
    const target = path.resolve(cwd, raw)
    const root = realpathSync(cwd)
    const lexical = path.relative(cwd, target)
    const resolved = path.relative(root, realPath(target))
    const inside = (relative: string) => relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    if (!inside(lexical) || !inside(resolved)) return false
    const file = statSync(target, { throwIfNoEntry: false })
    if (file?.isFile() && file.nlink > 1) return false
    const protectedPath = /^(?:\.git|\.pi|\.agents|node_modules|\.ssh|\.aws|\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|auth\.json)$|\.(?:pem|key)$/i
    return ![lexical, resolved].some((relative) =>
      relative.split(path.sep).some((part) => protectedPath.test(part.replace(/[ .]+$/, '')))
    )
  } catch {
    return false
  }
}

/** A private dialog title keeps ordinary extension confirmations out of this gate. */
export function permissionExtension(title: string): string {
  return `export default function (pi) {
    let pending = Promise.resolve();
    pi.on('session_start', (_event, ctx) => ctx.ui.setStatus(${JSON.stringify(title)}, 'ready'));
    pi.on('tool_call', (event, ctx) => {
      // This tool only records goal completion in Pi's own session metadata.
      if (event.toolName === 'desktop_goal_finish') return;
      const decide = async () => {
        if (ctx.signal?.aborted || !ctx.hasUI) return { block: true, reason: 'Tool approval is unavailable', terminate: true };
        try {
          const allowed = await ctx.ui.confirm(${JSON.stringify(title)}, JSON.stringify({toolName:event.toolName,input:event.input}));
          if (allowed && !ctx.signal?.aborted) return;
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
    const { toolName, input } = value as Record<string, unknown>
    if (typeof toolName !== 'string' || !input || typeof input !== 'object' || Array.isArray(input)) return
    return { toolName, input: input as Record<string, unknown> }
  } catch {
    return undefined
  }
}

import type { RuntimeStartOptions } from '@shared/types'

export interface RpcExtraLaunchOptions {
  sideChatFile?: string
  tools?: readonly string[]
  excludeTools?: readonly string[]
  noMcp?: boolean
}

/**
 * CLI flags for one Pi RPC process.
 *
 * This is the launch baseline for a single conversation. It never contains
 * `switch_session`: that command replaces the process's current session and
 * aborts whatever it was running. A second conversation is a second process.
 */
export function buildRpcArgs(
  options: RuntimeStartOptions,
  trustProject = false,
  customInstructionsFile?: string,
  permissionFile?: string,
  modeFile?: string,
  providerFile?: string,
  subagentFile?: string,
  computerFile?: string,
  contextBreakdownFile?: string,
  generationTimingFile?: string,
  mermaidFile?: string,
  imageFile?: string,
  swarmFile?: string,
  extra?: RpcExtraLaunchOptions
): string[] {
  const args = ['--mode', 'rpc']
  if (providerFile) args.push('--extension', providerFile)
  if (modeFile) args.push('--extension', modeFile)
  if (extra?.sideChatFile) args.push('--extension', extra.sideChatFile)
  if (permissionFile) args.push('--extension', permissionFile)
  if (subagentFile) args.push('--extension', subagentFile)
  if (swarmFile) args.push('--extension', swarmFile)
  if (computerFile) args.push('--extension', computerFile)
  if (contextBreakdownFile) args.push('--extension', contextBreakdownFile)
  if (generationTimingFile) args.push('--extension', generationTimingFile)
  if (mermaidFile) args.push('--extension', mermaidFile)
  if (imageFile) args.push('--extension', imageFile)
  if (extra?.noMcp) {
    args.push('--no-mcp')
  }
  if (extra?.tools && extra.tools.length > 0) {
    args.push('--tools', extra.tools.join(','))
  }
  if (extra?.excludeTools && extra.excludeTools.length > 0) {
    args.push('--exclude-tools', extra.excludeTools.join(','))
  }
  if (options.sessionFile) {
    args.push('--session', options.sessionFile)
  }
  if (options.model) {
    args.push('--model', options.model)
  }
  if (options.thinkingLevel) {
    args.push('--thinking', options.thinkingLevel)
  }
  if (customInstructionsFile) {
    args.push('--append-system-prompt', customInstructionsFile)
  }
  // Project-local extensions, skills and settings are trust-gated. RPC mode
  // has nobody to ask, so the choice has to be made up front.
  args.push(trustProject ? '--approve' : '--no-approve')
  return args
}

import type { RuntimeStartOptions } from '@shared/types'

/**
 * CLI flags for one Pi RPC process.
 *
 * This is the launch baseline for a single conversation. It never contains
 * `switch_session`: that command replaces the process's current session and
 * aborts whatever it was running. A second conversation is a second process.
 */
export function buildRpcArgs(
  options: RuntimeStartOptions,
  trustProject = true,
  customInstructionsFile?: string,
  permissionFile?: string,
  modeFile?: string,
  providerFile?: string
): string[] {
  const args = ['--mode', 'rpc']
  if (providerFile) args.push('--extension', providerFile)
  if (modeFile) args.push('--extension', modeFile)
  if (permissionFile) args.push('--extension', permissionFile)
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

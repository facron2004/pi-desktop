/** Pure argument and environment helpers for the setup / updater entry point. */

export interface SetupArgs {
  silent: boolean
  uninstall: boolean
  updated: boolean
  forceRun: boolean
  installDir?: string
}

const SETUP_ENV_KEYS = [
  'PORTABLE_EXECUTABLE_FILE',
  'PORTABLE_EXECUTABLE_DIR',
  'PORTABLE_EXECUTABLE_APP_FILENAME',
  'PI_SETUP',
  'PI_SETUP_SOURCE'
] as const

export function parseSetupArgs(argv: string[]): SetupArgs {
  const hasFlag = (flag: string) => argv.some((arg) => arg.toLowerCase() === flag.toLowerCase())
  const uninstall = hasFlag('--uninstall')
  const updated = hasFlag('--updated')
  const forceRun = hasFlag('--force-run')
  // In-app updates (--updated / --force-run) always run headlessly without
  // creating or displaying the setup window, even if /S was omitted or stripped.
  const silent = hasFlag('/s') || hasFlag('--silent') || updated || forceRun
  const rawInstallDir = argv
    .find((arg) => arg.toLowerCase().startsWith('--install-dir='))
    ?.slice('--install-dir='.length)
  const installDir = rawInstallDir?.trim().replace(/^"+|"+$/g, '') || undefined

  return {
    silent,
    uninstall,
    updated,
    forceRun,
    ...(installDir ? { installDir } : {})
  }
}

/**
 * Strip portable self-extractor and setup harness markers before launching the
 * installed app so `src/main/index.ts` enters the normal desktop app instead of
 * re-entering setup mode.
 */
export function cleanAppEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of SETUP_ENV_KEYS) {
    delete env[key]
  }
  return env
}

/** The contract between the setup window and the installer process. */

export type SetupMode = 'install' | 'uninstall'

export interface SetupInfo {
  mode: SetupMode
  version: string
  targetDir: string
  existing: boolean
  installedVersion?: string | null
}

export type SetupPhase = 'copying' | 'shortcuts' | 'registry' | 'finishing' | 'done'

export interface SetupProgress {
  phase: SetupPhase
  /** 0-100; stays 0 while the installer is still counting files. */
  percent: number
  detail?: string
}

export interface SetupResult {
  success: boolean
  error?: string
  /** The folder the app really landed in, after the Pi Desktop subfolder rule. */
  targetDir?: string
}

export interface SetupBridge {
  info(): Promise<SetupInfo>
  browse(): Promise<string | null>
  install(targetDir: string, launchAfterInstall: boolean): Promise<SetupResult>
  uninstall(removeUserData: boolean): Promise<SetupResult>
  onProgress(handler: (progress: SetupProgress) => void): () => void
  minimize(): void
  close(): void
  launch(targetDir: string): Promise<void>
  reveal(targetDir: string): Promise<void>
}

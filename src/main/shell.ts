import { existsSync } from 'node:fs'

export interface ShellSpec {
  file: string
  args: string[]
  label: string
}

/**
 * The shell the user picked in Settings.
 *
 * The labels are what the terminal header shows; the executable is resolved
 * here because the renderer never touches the filesystem or the process list.
 */
export function resolveShellSpec(value: string | undefined): ShellSpec {
  switch (value) {
    case 'cmd':
      return { file: process.env.ComSpec || 'cmd.exe', args: [], label: 'Command Prompt' }
    case 'gitbash': {
      const candidates = [
        'C:\\Program Files\\Git\\bin\\bash.exe',
        'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
        'C:\\Program Files (x86)\\Git\\bin\\bash.exe'
      ]
      const found = candidates.find((candidate) => existsSync(candidate))
      return { file: found ?? 'bash.exe', args: ['-i'], label: 'Git Bash' }
    }
    case 'wsl':
      return { file: 'wsl.exe', args: [], label: 'WSL' }
    default:
      return { file: 'powershell.exe', args: ['-NoLogo'], label: 'PowerShell' }
  }
}

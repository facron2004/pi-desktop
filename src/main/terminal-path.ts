import { existsSync, statSync } from 'node:fs'

export function assertTerminalWorkingDirectory(cwd: string): void {
  if (!existsSync(cwd)) {
    throw new Error(`Terminal working directory does not exist or is inaccessible: ${cwd}`)
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Terminal working directory is not a directory: ${cwd}`)
  }
}

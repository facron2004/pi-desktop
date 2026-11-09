import { createRequire } from 'node:module'
import path from 'node:path'
import { app } from 'electron'

export interface ProperLockfileOptions {
  realpath?: boolean
  retries?: number | {
    retries?: number
    minTimeout?: number
    maxTimeout?: number
    factor?: number
    randomize?: boolean
  }
  stale?: number
  update?: number
  lockfilePath?: string
  onCompromised?: (error: Error) => void
}

interface ProperLockfileModule {
  lock(file: string, options?: ProperLockfileOptions): Promise<() => Promise<void>>
  lockSync(file: string, options?: ProperLockfileOptions): () => void
  checkSync(
    file: string,
    options?: Pick<ProperLockfileOptions, 'realpath' | 'stale' | 'lockfilePath'>
  ): boolean
}

export const properLockfile = createRequire(path.join(app.getAppPath(), 'package.json'))(
  'proper-lockfile'
) as ProperLockfileModule

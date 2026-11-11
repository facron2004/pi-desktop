import { createRequire } from 'node:module'
import type { spawn as nodeSpawn } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'

export const spawn = createRequire(path.join(app.getAppPath(), 'package.json'))(
  'cross-spawn'
) as typeof nodeSpawn

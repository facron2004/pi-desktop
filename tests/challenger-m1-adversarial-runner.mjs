import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const out = mkdtempSync(path.join(tmpdir(), 'pi-desktop-challenger-m1-adv-'))
const mockElectron = path.join(out, 'mock-electron.mjs')
writeFileSync(
  mockElectron,
  `export const app = { getPath: () => "C:/tmp", isPackaged: false, getVersion: () => "0.7.3", setAppUserModelId: () => {}, whenReady: () => Promise.resolve(), on: () => {} };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true, filePath: undefined }) };
export const BrowserWindow = class { static getAllWindows() { return [] } isDestroyed() { return false } };
export const ipcMain = { handle: () => {}, on: () => {} };
export const shell = { showItemInFolder: () => {}, trashItem: async () => {} };
export const Notification = class { show() {} };
`
)

try {
  const outfile = path.join(out, 'challenger-m1-adversarial.bundled.mjs')
  await esbuild.build({
    entryPoints: [path.join(here, 'challenger-m1-adversarial.test.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile,
    logLevel: 'warning',
    alias: {
      '@shared': path.resolve(here, '..', 'src', 'shared'),
      electron: mockElectron
    }
  })

  execFileSync(process.execPath, ['--test', outfile], {
    stdio: 'inherit'
  })
} finally {
  rmSync(out, { recursive: true, force: true })
}

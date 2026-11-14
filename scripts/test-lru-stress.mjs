import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const out = mkdtempSync(path.join(tmpdir(), 'pi-desktop-stress-'))
const mockElectron = path.join(out, 'mock-electron.mjs')
writeFileSync(
  mockElectron,
  `export const app = { getPath: () => "C:/tmp", getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => "0.7.3", setAppUserModelId: () => {}, whenReady: () => Promise.resolve(), on: () => {}, exit: () => {} };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true, filePath: undefined }) };
export const BrowserWindow = class { static getAllWindows() { return [] } isDestroyed() { return false } };
export const ipcMain = { handle: () => {}, on: () => {} };
export const shell = { showItemInFolder: () => {}, trashItem: async () => {} };
export const Notification = class { show() {} };
export const nativeTheme = { shouldUseDarkColors: false };
export const nativeImage = { createFromPath: () => ({ isEmpty: () => true, resize: () => ({}) }), createFromBuffer: () => ({ isEmpty: () => true, resize: () => ({}) }) };
export const screen = { getDisplayMatching: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1280, height: 720 } }) };
`
)

try {
  const bundle = path.join(out, 'session-supervisor-lru-stress.mjs')
  await esbuild.build({
    entryPoints: [path.join(root, 'tests', 'session-supervisor-lru-stress.test.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: bundle,
    logLevel: 'warning',
    alias: {
      '@shared': path.resolve(root, 'src', 'shared'),
      electron: mockElectron
    }
  })
  execFileSync(process.execPath, ['--test', bundle], { stdio: 'inherit' })
} finally {
  rmSync(out, { recursive: true, force: true })
}

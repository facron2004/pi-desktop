import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const out = mkdtempSync(path.join(tmpdir(), 'pi-desktop-challenger-m1-c2-'))
const mockElectron = path.join(out, 'mock-electron.mjs')
writeFileSync(
  mockElectron,
  `const handlers = new Map();
export const app = {
  getPath: () => "C:/tmp",
  getAppPath: () => "C:/tmp",
  isPackaged: false,
  getVersion: () => "0.7.2",
  setAppUserModelId: () => {},
  whenReady: () => Promise.resolve(),
  on: () => {}
};
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true, filePath: undefined })
};
export const BrowserWindow = class {
  static getAllWindows() { return [] }
  isDestroyed() { return false }
};
export const ipcMain = {
  handle: (channel, handler) => { handlers.set(channel, handler); },
  on: () => {},
  _invoke: async (channel, event, ...args) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error("No handler registered for " + channel);
    return handler(event, ...args);
  },
  _reset: () => handlers.clear()
};
export const shell = { showItemInFolder: () => {}, trashItem: async () => {} };
export const Notification = class { show() {} };
`
)

try {
  const outfile = path.join(out, 'challenger-m1-c2.bundled.mjs')
  await esbuild.build({
    entryPoints: [path.join(here, 'challenger-m1-c2.test.ts')],
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

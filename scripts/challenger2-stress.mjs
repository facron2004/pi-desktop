import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const testsDir = path.join(root, 'tests')

const out = path.join(root, 'node_modules', '.cache', 'challenger2')
mkdirSync(out, { recursive: true })
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
  const bundlePath = path.join(out, 'adversarial-stress-m2.mjs')
  console.log('Bundling tests/adversarial-stress-m2.test.ts with esbuild...')
  await esbuild.build({
    entryPoints: [path.join(testsDir, 'adversarial-stress-m2.test.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    outfile: bundlePath,
    logLevel: 'warning',
    external: ['react', 'react-dom', 'react-dom/server', 'react/jsx-runtime'],
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);"
    },
    alias: {
      '@shared': path.resolve(root, 'src', 'shared'),
      electron: mockElectron
    }
  })

  console.log('Executing tests with node --test...')
  execFileSync(process.execPath, ['--test', bundlePath], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_PATH: path.join(root, 'node_modules')
    }
  })
  console.log('\n>>> ALL CHALLENGER 2 EMPIRICAL STRESS TESTS PASSED SUCCESSFULLY! <<<')
} finally {
  rmSync(out, { recursive: true, force: true })
}

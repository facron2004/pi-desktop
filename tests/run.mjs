/**
 * Unit tests for the conversation reducer and the thread view model.
 *
 * They run against the real Pi event shapes observed on the wire: RPC
 * `message_update` is delta-only, `tool_execution_update.partialResult` is
 * a snapshot rather than an increment, and parallel tools finish in
 * completion order rather than in call order.
 *
 *   node tests/run.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

// The tests are TypeScript, so they are bundled to plain JS first. esbuild
// ships with electron-vite, so this adds no dependency to the project.
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

/**
 * Every suite, bundled and run in one `node --test` invocation.
 *
 * `thread.test.ts` covers the reducer, which is where the transcript is
 * projected; `run-state.test.ts` covers the run phase, which the store
 * decides from the same events. Both matter for the conversation, so both
 * run here rather than in separate commands nobody remembers to call.
 */
const suites = [
  'thread.test.ts',
  'run-state.test.ts',
  'projects.test.ts',
  'settings.test.ts',
  'shortcuts.test.ts',
  'user-data.test.ts',
  'app-updates.test.ts',
  'pi-cli.test.ts',
  'session-metrics.test.ts',
  'session-timing.test.ts',
  'generation-timing.test.ts',
  'context-reading.test.ts',
  'git-status.test.ts',
  'diff-fold.test.ts',
  'permissions.test.ts',
  'task-modes.test.ts',
  'computer-use.test.ts',
  'subagent.test.ts',
  'subagent-tree.test.ts',
  'title-subagents.test.ts',
  'file-status.test.ts',
  'fonts.test.ts',
  'font-scale.test.ts',
  'providers.test.ts',
  'model-catalog.test.ts',
  'retry-policy.test.ts',
  'rpc-trace.test.ts',
  'cwd-gate.test.ts',
  'session-scope.test.ts',
  'sessions-cache.test.ts',
  'session-remove.test.ts',
  'sessions-targeted.test.ts',
  'rpc-args.test.ts',
  'session-fixture.test.ts',
  'supervisor.test.ts',
  'runtime-ensure.test.ts',
  'runtime-session-path.test.ts',
  'navigation-policy.test.ts',
  'webview-policy.test.ts',
  'session-concurrency.test.ts',
  'rpc-client.test.ts',
  'extension-dialog-protocol.test.ts',
  'stream-events.test.ts',
  'streaming-markdown.test.ts',
  'scroll-memory.test.ts',
  'conversation-helpers.test.ts',
  'turns.test.ts',
  'changes.test.ts',
  'thinking.test.ts',
  'terminal-shell.test.ts',
  'terminal-startup.test.ts',
  'view-state.test.ts',
  'live-sessions.test.ts',
  'git-branches.test.ts',
  'mcp.test.ts',
  'remote-access.test.ts',
  'remote-session-state.test.ts',
  'fs-read.test.ts',
  'ipc-window.test.ts',
  'ipc-stream-coalescing.test.ts',
  'screenshot-window.test.ts',
  'search-cancel.test.ts',
  'workspace-panel.test.ts',
  'task-panel.test.ts',
  'scheduled-tasks.test.ts',
  'session-tree.test.ts',
  'renderer-utils.test.ts',
  'i18n.test.ts',
  'compaction-error.test.ts',
  'extension-notices.test.ts',
  'highlight-cache.test.ts',
  'marketplace.test.ts',
  'pi-catalog.test.ts',
  'memory.test.ts',
  'auto-title.test.ts',
  'branch-menu-worktree.test.ts',
  'title-sync.test.ts',
  'agents.test.ts',
  'subagent-usage.test.ts',
  'subagent-worktree.test.ts',
  'mermaid-plugin.test.ts',
  'mermaid-renderer.test.ts',
  'mermaid-policy.test.ts',
  'pm-toolkit.test.ts',
  'pm-connectors.test.ts',
  'pm-feedback.test.ts',
  'pm-competitor.test.ts',
  'pm-pricing.test.ts',
  'image-generation.test.ts',
  'image-tool.test.ts',
  'multi-rpc-stress.test.ts'
]
const debug = process.argv[2] === '--debug'

const out = mkdtempSync(path.join(tmpdir(), 'pi-desktop-tests-'))
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
  const built = []
  for (const suite of suites) {
    const bundle = `${suite.replace(/\.ts$/, '')}.mjs`
    await esbuild.build({
      entryPoints: [path.join(here, suite)],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: path.join(out, bundle),
      logLevel: 'warning',
      // The renderer's own aliases, so the test imports the module the same
      // way the app does.
      alias: {
        '@shared': path.resolve(here, '..', 'src', 'shared'),
        '@renderer': path.resolve(here, '..', 'src', 'renderer', 'src'),
        electron: mockElectron
      }
    })
    built.push(path.join(out, bundle))
  }
  if (debug) {
    execFileSync(process.execPath, [built[0]], { stdio: 'inherit' })
  } else {
    // Bound child-process tests so Windows startup probes do not starve each other.
    execFileSync(process.execPath, ['--test', '--test-concurrency=4', ...built], {
      stdio: 'inherit'
    })
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

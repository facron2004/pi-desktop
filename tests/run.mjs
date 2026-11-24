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
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  'setup-args.test.ts',
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
  'swarm.test.ts',
  'subagent-tree.test.ts',
  'title-subagents.test.ts',
  'file-status.test.ts',
  'fonts.test.ts',
  'ui-font.test.ts',
  'font-scale.test.ts',
  'theme-presets.test.ts',
  'accent-ink.test.ts',
  'update-notice.test.ts',
  'goal-display.test.ts',
  'message-text.test.ts',
  'project-order.test.ts',
  'cli-version.test.ts',
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
  'window-controls.test.ts',
  'sidebar-view.test.ts',
  'sidebar-fold.test.ts',
  'navigation-policy.test.ts',
  'webview-policy.test.ts',
  'session-concurrency.test.ts',
  'rpc-client.test.ts',
  'extension-dialog-protocol.test.ts',
  'stream-events.test.ts',
  'hydration-merge.test.ts',
  'streaming-markdown.test.ts',
  'streaming-reveal.test.ts',
  'scroll-memory.test.ts',
  'conversation-helpers.test.ts',
  'turns.test.ts',
  'changes.test.ts',
  'thinking.test.ts',
  'terminal-shell.test.ts',
  'terminal-startup.test.ts',
  'view-state.test.ts',
  'live-sessions.test.ts',
  'tray-conversations.test.ts',
  'tray-placement.test.ts',
  'url-link.test.ts',
  'image-echo.test.ts',
  'setup-install.test.ts',
  'git-branches.test.ts',
  'mcp.test.ts',
  'remote-access.test.ts',
  'remote-control.test.ts',
  'remote-session-state.test.ts',
  'im-channels.test.ts',
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
  'highlight-languages.test.ts',
  'hover-tip.test.ts',
  'sidebar-tip.test.ts',
  'wordmark.test.ts',
  'marketplace.test.ts',
  'pi-catalog.test.ts',
  'composer-files.test.ts',
  'memory.test.ts',
  'memory-fold.test.ts',
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
  'multi-rpc-stress.test.ts',
  // Adversarial and stress suites that used to live behind their own runners.
  // A suite nothing invokes is worse than no suite: it reads as coverage and
  // cannot fail. They run here, with the shared electron mock.
  'adversarial-ipc-stress.test.ts',
  'challenger-m1-adversarial.test.ts',
  'challenger-m1-v2-stress.test.ts',
  'challenger-m2-ux-lifecycle-stress.test.ts',
  'session-supervisor-lru-stress.test.ts'
]
const debug = process.argv[2] === '--debug'

/**
 * The temp root every suite runs against, in canonical long form.
 *
 * A Windows CI runner hands its temp folder out as an 8.3 short name
 * (`C:\Users\RUNNER~1\AppData\Local\Temp`), while every path the app resolves
 * comes back long (`C:\Users\runneradmin\AppData\Local\Temp`). Suites that
 * compare a `tmpdir()`-derived path with a `realpath()`-derived one then fail on
 * nothing but spelling, which is how the first release workflow run failed ten
 * path tests. Canonicalising once here — and handing the same root to the test
 * process — makes the two spellings agree on any machine.
 */
const tempRoot = (() => {
  const raw = tmpdir()
  try {
    return realpathSync.native(raw)
  } catch {
    return raw
  }
})()

const out = mkdtempSync(path.join(tempRoot, 'pi-desktop-tests-'))
const mockElectron = path.join(out, 'mock-electron.mjs')
writeFileSync(
  mockElectron,
  `export const app = { getPath: () => "C:/tmp", getAppPath: () => process.cwd(), isPackaged: false, getVersion: () => "0.7.3", setAppUserModelId: () => {}, whenReady: () => Promise.resolve(), on: () => {}, exit: () => {} };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true, filePath: undefined }) };
export const BrowserWindow = class { static getAllWindows() { return [] } isDestroyed() { return false } };
export const Menu = { buildFromTemplate: () => ({}) };
export const Tray = class { setContextMenu() {} setImage() {} setToolTip() {} on() {} destroy() {} isDestroyed() { return false } };
export const ipcMain = { handle: () => {}, on: () => {}, removeHandler: () => {} };
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
  // The suites create their scratch folders through `os.tmpdir()`, so the child
  // process is handed the canonical root. Without this a runner whose `%TEMP%`
  // is an 8.3 alias makes `tmpdir()` and `realpath()` disagree about the same
  // folder.
  const childEnv = { ...process.env, TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot }
  if (debug) {
    execFileSync(process.execPath, [built[0]], { stdio: 'inherit', env: childEnv })
  } else {
    // Bound child-process tests so Windows startup probes do not starve each other.
    // The per-test timeout is what turns a hung suite into one failing test instead
    // of a process that never returns; the outer timeout is the last resort.
    execFileSync(process.execPath, ['--test', '--test-concurrency=4', '--test-timeout=180000', ...built], {
      stdio: 'inherit',
      env: childEnv,
      timeout: 15 * 60_000
    })
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

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
import { mkdtempSync, rmSync } from 'node:fs'
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
const suites = ['thread.test.ts', 'run-state.test.ts', 'projects.test.ts', 'git-status.test.ts', 'diff-fold.test.ts', 'permissions.test.ts', 'task-modes.test.ts', 'fonts.test.ts', 'providers.test.ts', 'retry-policy.test.ts']
const debug = process.argv[2] === '--debug'

const out = mkdtempSync(path.join(tmpdir(), 'pi-desktop-tests-'))
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
      alias: { '@shared': path.resolve(here, '..', 'src', 'shared') }
    })
    built.push(path.join(out, bundle))
  }
  if (debug) {
    execFileSync(process.execPath, [built[0]], { stdio: 'inherit' })
  } else {
    execFileSync(process.execPath, ['--test', ...built], {
      stdio: 'inherit'
    })
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

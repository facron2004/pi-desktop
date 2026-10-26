/**
 * Capture the delivery-evidence screenshots.
 *
 * Each entry runs the built app once with the self-capture harness and a
 * distinct scenario. Kept as a file rather than a shell one-liner because the
 * env block is long and a mistake here silently captures the wrong screen.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const repo = process.cwd()
const electron = join(repo, 'node_modules', 'electron', 'dist', 'electron.exe')
const shots = join(repo, 'output', 'shots')
mkdirSync(shots, { recursive: true })

/** A session with real tool calls in it, for the replay evidence. */
const session =
  'C:\\Users\\Facron\\.pi\\agent\\sessions\\--E--Program-Pi Desktop--\\2026-10-26T05-51-47-329Z_01a176c3-d281-70e4-9a3e-057656947b17.jsonl'

const runs = [
  { name: '02-replay-tools-dark', theme: 'dark', session },
  { name: '03-replay-tools-light', theme: 'light', session },
  { name: '04-replay-narrow', theme: 'dark', session, eval: 'window.resizeTo(760, 900)' },
  { name: '05-empty-light', theme: 'light' }
]

for (const run of runs) {
  const target = join(shots, `${run.name}.png`)
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    PI_DESKTOP_SCREENSHOT: target,
    PI_DESKTOP_WORKSPACE: repo,
    PI_DESKTOP_THEME: run.theme,
    PI_DESKTOP_SCREENSHOT_DELAY: '9000',
    PI_DESKTOP_CLOSE_AFTER_MS: '14000',
    PI_DESKTOP_USER_DATA: join(shots, `profile-${run.name}`)
  }
  if (run.session) env.PI_DESKTOP_SESSION = run.session
  if (run.eval) env.PI_DESKTOP_EVAL = run.eval

  await new Promise((resolve) => {
    const child = spawn(electron, ['.'], { env, stdio: 'ignore', cwd: repo })
    child.on('exit', resolve)
  })
  console.log(`${run.name}: ${existsSync(target) ? 'captured' : 'MISSING'}`)
}

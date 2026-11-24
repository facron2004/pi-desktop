/**
 * Verify the update button in a real packaged build.
 *
 *   npm run dist:dir          # release/win-unpacked must be the running version
 *   node scripts/verify-update-icon.mjs
 *
 * Only a packaged Windows install may offer "restart and install", so the
 * development entry point cannot show that state at all — it correctly keeps
 * pointing at the download page instead. This harness copies the unpacked
 * build out of the repository, writes the `install.json` an installed copy
 * carries, and runs it twice, each time with a user-data folder that already
 * holds what an earlier run left behind:
 *
 *   idle   update-state.json only — a release was found, nothing downloaded.
 *          The button must be a filled circle with an empty ring.
 *   ready  the same reading plus updates/installer.exe + installer.json.
 *          The button offers restart and install with the progress ring removed.
 *
 * No network is involved: both states are restored from disk at startup, which
 * is the point of keeping them. The settings dialog is closed before the
 * capture, because it is a full-window layer whose scrim dims the sidebar and
 * the accent colour has to be seen as it really is.
 */
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'output', 'verify-update-icon')
const unpacked = path.join(root, 'release', 'win-unpacked')
const executable = path.join(unpacked, 'Pi Desktop.exe')

if (!existsSync(executable)) throw new Error('先运行 npm run dist:dir：release/win-unpacked 不存在')

const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version
const nextVersion = bumpPatch(version)
const probeScript = readFileSync(path.join(root, 'scripts', 'verify-update', 'probe.js'), 'utf8')
  .replace('__MANUAL_CHECK__', 'false')
  .replace('__CLOSE_SETTINGS__', 'true')

const log = (message) => console.log(message)

function bumpPatch(value) {
  const [major, minor, patch] = value.split('.').map((part) => Number.parseInt(part, 10))
  return `${major}.${minor}.${patch + 1}`
}

mkdirSync(output, { recursive: true })
// One copy serves both launches; only the profile changes between them.
const appCopy = mkdtempSync(path.join(output, 'app-'))
cpSync(unpacked, appCopy, { recursive: true })
// What an installed copy carries; without it a portable folder is not allowed
// to replace itself.
writeFileSync(path.join(appCopy, 'install.json'), '{}', 'utf8')

const installer = Buffer.from('MZ fixture installer; the harness never runs it')

/** A profile holding the reading a check left behind (and maybe an installer). */
function writeProfile(name, withInstaller) {
  const profile = mkdtempSync(path.join(output, `${name}-`))
  mkdirSync(path.join(profile, 'workspace'), { recursive: true })
  writeFileSync(
    path.join(profile, 'update-state.json'),
    JSON.stringify({
      app: { current: version, latest: nextVersion, hasUpdate: true, installerBytes: installer.length },
      checkedAt: Date.now()
    }),
    'utf8'
  )
  if (withInstaller) {
    const updates = path.join(profile, 'updates')
    mkdirSync(updates, { recursive: true })
    writeFileSync(path.join(updates, 'installer.exe'), installer)
    writeFileSync(
      path.join(updates, 'installer.json'),
      JSON.stringify({ version: nextVersion, bytes: installer.length, downloadedAt: Date.now() }),
      'utf8'
    )
  }
  return profile
}

async function run(name, profile) {
  const shot = path.join(output, `${name}.png`)
  const result = await promisify(execFile)(path.join(appCopy, 'Pi Desktop.exe'), [], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      NODE_OPTIONS: undefined,
      PI_DESKTOP_USER_DATA: profile,
      PI_DESKTOP_WORKSPACE: path.join(profile, 'workspace'),
      PI_CODING_AGENT_DIR: path.join(profile, 'home', '.pi', 'agent'),
      PI_CODING_AGENT_SESSION_DIR: path.join(profile, 'home', '.pi', 'agent', 'sessions'),
      PI_DESKTOP_RPC_TRACE: '0',
      PI_DESKTOP_SCREENSHOT: shot,
      PI_DESKTOP_SCREENSHOT_DELAY: '11000',
      PI_DESKTOP_EVAL: probeScript,
      PI_DESKTOP_EVAL_DELAY: '1000'
    },
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024
  })
  const match = /\[pi-desktop\] eval result: (.*)/.exec(result.stdout + result.stderr)
  if (!match) throw new Error(`没有读到 ${name} 的页面状态，完整输出:\n${(result.stdout + result.stderr).slice(-4000)}`)
  return { shot, probe: JSON.parse(match[1]) }
}

const failures = []
function check(condition, message) {
  if (!condition) failures.push(message)
}

try {
  log(`使用的构建: 打包版 ${version}（复制到 ${appCopy}）`)

  // ---- idle: a release is known, nothing downloaded ---------------------
  const idleProfile = writeProfile('idle', false)
  const idle = await run('idle', idleProfile)
  const idleBadge = idle.probe.sidebarBadge || {}
  const emptyRing = idleBadge.hasRing === true && Number(idleBadge.ringOffset) > 1
  log(`空闲状态: state=${idleBadge.state} aria=${idleBadge.aria} ringOffset=${idleBadge.ringOffset} → ${idle.shot}`)
  check(idleBadge.exists === true, '空闲状态没有更新按钮')
  check(idleBadge.state === 'idle', '空闲状态的 data-state 不是 idle')
  check(/download update|下载更新/i.test(idleBadge.aria || ''), '空闲状态的 aria-label 不是“下载更新”')
  check(emptyRing, '空闲状态的进度环不是空的')
  check(idle.probe.aboutHasAutoCheck === true, '“关于”页没有“自动检查更新”开关')
  if (process.env.PI_DESKTOP_VERIFY_KEEP !== '1') rmSync(idleProfile, { recursive: true, force: true })

  // ---- ready: the verified installer is on disk -------------------------
  const readyProfile = writeProfile('ready', true)
  const ready = await run('ready', readyProfile)
  const readyBadge = ready.probe.sidebarBadge || {}
  log(`就绪状态: state=${readyBadge.state} aria=${readyBadge.aria} hasRing=${readyBadge.hasRing} → ${ready.shot}`)
  check(readyBadge.state === 'ready', '下载完成后按钮没有进入 ready 状态')
  check(/restart and install|重启并安装/i.test(readyBadge.aria || ''), 'ready 状态的 aria-label 没有说明点击会重启安装')
  check(readyBadge.hasRing === false, 'ready 状态仍显示进度环')
  check(ready.probe.aboutHasVersion === true, '“关于”页没有显示已下载的新版本')
  check(ready.probe.updateButtonShown === true, '侧栏的更新按钮没有出现')
  if (process.env.PI_DESKTOP_VERIFY_KEEP !== '1') rmSync(readyProfile, { recursive: true, force: true })

  if (failures.length > 0) throw new Error('验证失败:\n- ' + failures.join('\n- '))
  log('=== 验证通过 ===')
} finally {
  rmSync(appCopy, { recursive: true, force: true })
}

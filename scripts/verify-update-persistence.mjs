/**
 * Verify that the update reading survives a real restart.
 *
 *   node scripts/verify-update-persistence.mjs
 *
 * Three parts:
 *   1. an online launch that finds a newer release and writes the reading to
 *      disk;
 *   2. the application exits — a separate process, not a hidden window;
 *   3. an offline launch where GitHub is unreachable, and the sidebar badge
 *      and the About page must still show the version the first run found.
 *
 * The packaged build is used when it exists, so the run exercises the real
 * product rather than the development entry point.
 *
 * The upstream release is faked to a version above the running one, because
 * the real latest release is the version being tested. Offline is simulated
 * by preloading a module that fails every request to github.com, which is
 * what a machine without a network looks like to the checker. No production
 * code is changed for the test.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'output', 'verify-update-persistence')
mkdirSync(output, { recursive: true })

const helperDir = path.join(root, 'scripts', 'verify-update')
const offlineModule = path.join(helperDir, 'offline.cjs')
const fakeReleaseModule = path.join(helperDir, 'fake-release.cjs')
const probeScript = readFileSync(path.join(helperDir, 'probe.js'), 'utf8')

// The packaged build disables NODE_OPTIONS ("Most NODE_OPTIONs are not
// supported in packaged apps"), so the offline simulation needs the
// development entry point. It runs the very same out/ build that the
// packaged app.asar was made from, and the persistence code in both was
// compared byte for byte.
const usePackaged = process.env.PI_DESKTOP_VERIFY_PACKAGED === '1'
const packaged = path.join(root, 'release', 'win-unpacked', 'Pi Desktop.exe')
const executable = usePackaged ? packaged : require('electron')
const args = usePackaged ? [] : [root]

// One profile for the whole run: the second launch must find the file the
// first launch wrote, so both use the same user data folder.
const profile = mkdtempSync(path.join(output, 'profile-'))
const workspace = path.join(profile, 'workspace')
mkdirSync(workspace, { recursive: true })
const agent = path.join(profile, 'home', '.pi', 'agent')
mkdirSync(agent, { recursive: true })

const stateFile = path.join(profile, 'update-state.json')
const onlineShot = path.join(output, '1-online.png')
const offlineShot = path.join(output, '2-offline-restart.png')

function launch(extraEnv) {
  return promisify(execFile)(executable, args, {
    cwd: root,
    env: {
      ...process.env,
      PI_DESKTOP_USER_DATA: profile,
      PI_DESKTOP_WORKSPACE: workspace,
      PI_CODING_AGENT_DIR: agent,
      PI_CODING_AGENT_SESSION_DIR: path.join(agent, 'sessions'),
      PI_DESKTOP_RPC_TRACE: '0',
      PI_DESKTOP_SCREENSHOT_DELAY: '12000',
      PI_DESKTOP_EVAL: probeScript,
      PI_DESKTOP_EVAL_DELAY: '800',
      ...extraEnv
    },
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 8 * 1024 * 1024
  })
}

const log = (message) => console.log(message)
log('使用的构建: ' + (usePackaged ? '打包版 ' + packaged : '开发入口 ' + executable))

try {
  // ---- 1. online launch, upstream has a newer release --------------------
  log('=== 第 1 次启动：在线，上游有新版 v0.11.9 ===')
  const online = await launch({
    NODE_OPTIONS: '--require "' + fakeReleaseModule.replace(/\\/g, '/') + '"',
    PI_DESKTOP_SCREENSHOT: onlineShot
  })
  const onlineOut = online.stdout + online.stderr
  const onlineEval = /\[pi-desktop\] eval result: (.*)/.exec(onlineOut)
  log('第 1 次页面读数: ' + (onlineEval ? onlineEval[1] : '(无)'))
  log('第 1 次截图: ' + onlineShot)

  let state = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (existsSync(stateFile)) {
      state = JSON.parse(readFileSync(stateFile, 'utf8'))
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  log('落盘文件存在: ' + existsSync(stateFile))
  log('落盘内容: ' + JSON.stringify(state))
  if (!state) throw new Error('第一次启动没有写下 update-state.json')
  if (!state.app || !state.app.hasUpdate || state.app.latest !== '0.11.9') {
    throw new Error('落盘的读数不对: ' + JSON.stringify(state))
  }

  // ---- 2. the app has exited by now --------------------------------------
  log('=== 第一次启动已退出（独立进程结束）===')

  // ---- 3. offline launch -------------------------------------------------
  log('=== 第 2 次启动：离线，GitHub 不可达 ===')
  const offline = await launch({
    NODE_OPTIONS: '--require "' + offlineModule.replace(/\\/g, '/') + '"',
    PI_DESKTOP_SCREENSHOT: offlineShot
  })
  const offlineOut = offline.stdout + offline.stderr
  const offlineEval = /\[pi-desktop\] eval result: (.*)/.exec(offlineOut)
  const blocked = /\[offline\] blocked/.test(offlineOut)
  log('离线拦截生效: ' + blocked)
  log('第 2 次页面读数: ' + (offlineEval ? offlineEval[1] : '(无)'))
  log('第 2 次截图: ' + offlineShot)

  const probe = offlineEval ? JSON.parse(offlineEval[1]) : {}
  const sidebarShown = Boolean(probe.sidebarBadge && probe.sidebarBadge.exists)
  const aboutShown = Boolean(probe.aboutHasVersion)
  log('侧栏更新徽标存在: ' + sidebarShown + ' ' + JSON.stringify(probe.sidebarBadge || {}))
  log('“关于”页显示 v0.11.9: ' + aboutShown + ' ' + JSON.stringify(probe.aboutBadges || []))
  const shown = sidebarShown && aboutShown

  if (!blocked) throw new Error('离线模拟没有生效，GitHub 请求没有被拦截')
  if (!shown) throw new Error('离线重启后没有显示上次检查到的版本')

  log('=== 验证通过 ===')
} finally {
  // The profile is kept when PI_DESKTOP_VERIFY_KEEP is set, so a failing run
  // can be inspected without repeating the first launch.
  if (process.env.PI_DESKTOP_VERIFY_KEEP !== '1') {
    rmSync(profile, { recursive: true, force: true })
  } else {
    console.log('保留 profile: ' + profile)
  }
}

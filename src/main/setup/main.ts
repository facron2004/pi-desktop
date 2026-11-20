import { app, BrowserWindow, dialog, ipcMain, nativeTheme } from 'electron'
import { existsSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { SetupInfo, SetupProgress, SetupResult } from '@shared/setup'
import { parseSetupArgs } from './args'
import {
  defaultInstallDir,
  existingInstallDir,
  installApp,
  installTargetFor,
  launchInstalled,
  readInstalledVersion,
  revealFolder,
  uninstallApp,
  validateTarget
} from './install'

const parsed = parseSetupArgs(process.argv.slice(1))
const { silent, uninstall: uninstallMode, updated, forceRun, installDir: installDirArg } = parsed

const LIGHT_BG = '#F5F2EB'
const DARK_BG = '#131418'

// The setup process shares an executable name with the installed app. Give it
// its own scratch data directory so its cache never fights the running app's.
app.setPath('userData', path.join(os.tmpdir(), 'pi-desktop-setup'))

let window: BrowserWindow | null = null
let installing = false

function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG
}

function setupIcon(): string | undefined {
  const candidates = [
    path.join(process.resourcesPath, 'icon-geometric.ico'),
    path.join(app.getAppPath(), 'build', 'icon-geometric.ico')
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

async function targetForMode(): Promise<string> {
  if (uninstallMode) {
    return path.dirname(process.execPath)
  }
  return installDirArg || (await existingInstallDir()) || defaultInstallDir()
}

async function logSilentFailure(error: unknown): Promise<void> {
  try {
    const file = path.join(os.tmpdir(), 'pi-desktop-setup-error.log')
    await appendFile(
      file,
      `[${new Date().toISOString()}] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
      'utf8'
    )
  } catch {
    /* nothing else can be done in a silent run */
  }
}

async function runSilent(): Promise<void> {
  try {
    const target = await targetForMode()
    if (uninstallMode) {
      await uninstallApp(target, false)
      app.exit(0)
      return
    }
    await installApp({
      targetDir: updated || forceRun ? target : installTargetFor(target),
      launchAfterInstall: false
    })
    if (forceRun || updated) launchInstalled(target, updated ? ['--updated'] : [])
    app.exit(0)
  } catch (error) {
    await logSilentFailure(error)
    app.exit(1)
  }
}

function sendProgress(progress: SetupProgress): void {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return
  window.webContents.send('setup:progress', progress)
}

function createWindow(): void {
  const forcedTheme = process.env.PI_SETUP_THEME
  nativeTheme.themeSource =
    forcedTheme === 'dark' || forcedTheme === 'light' ? forcedTheme : 'system'

  window = new BrowserWindow({
    width: 660,
    height: 460,
    frame: false,
    roundedCorners: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: windowBackgroundColor(),
    icon: setupIcon(),
    webPreferences: {
      // The setup code is bundled into a shared chunk, so __dirname is not the
      // app root. Resolve from the packaged/dev root instead.
      preload: path.join(app.getAppPath(), 'out', 'preload', 'setup.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const syncThemeBackground = (): void => {
    if (!window || window.isDestroyed()) return
    window.setBackgroundColor(windowBackgroundColor())
  }
  nativeTheme.on('updated', syncThemeBackground)

  window.setMenu(null)
  window.once('ready-to-show', () => {
    if (!window || window.isDestroyed()) return
    window.show()
    window.focus()
  })
  window.on('closed', () => {
    nativeTheme.removeListener('updated', syncThemeBackground)
    window = null
    app.quit()
  })
  window.on('close', (event) => {
    if (installing) event.preventDefault()
  })
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  void window.loadFile(path.join(app.getAppPath(), 'setup', 'index.html'))
}

function registerIpc(): void {
  ipcMain.handle('setup:info', async (): Promise<SetupInfo> => {
    const targetDir = await targetForMode()
    const existing = existsSync(path.join(targetDir, 'Pi Desktop.exe'))
    return {
      mode: uninstallMode ? 'uninstall' : 'install',
      version: app.getVersion(),
      targetDir,
      existing,
      installedVersion: existing ? readInstalledVersion(targetDir) : null
    }
  })

  ipcMain.handle('setup:browse', async (): Promise<string | null> => {
    const options: Electron.OpenDialogOptions = {
      title: '选择安装位置',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: await targetForMode()
    }
    const result = window && !window.isDestroyed()
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('setup:install', async (_event, targetDir: string, launchAfterInstall: boolean): Promise<SetupResult> => {
    if (installing) return { success: false, error: '安装正在进行中。' }
    if (typeof targetDir !== 'string') return { success: false, error: '安装位置无效。' }
    const target = installTargetFor(targetDir)
    const problem = validateTarget(target)
    if (problem) return { success: false, error: problem }
    installing = true
    try {
      // Launching happens once when the user confirms Finish so the finish-page
      // toggle is respected and the app is never started twice.
      await installApp({ targetDir: target, launchAfterInstall: Boolean(launchAfterInstall), onProgress: sendProgress })
      return { success: true, targetDir: target }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      installing = false
    }
  })

  ipcMain.handle('setup:uninstall', async (_event, removeUserData: boolean): Promise<SetupResult> => {
    if (installing) return { success: false, error: '卸载正在进行中。' }
    installing = true
    try {
      const target = await targetForMode()
      await uninstallApp(target, Boolean(removeUserData))
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      installing = false
    }
  })

  ipcMain.handle('setup:launch', async (_event, targetDir: string): Promise<void> => {
    if (typeof targetDir === 'string') launchInstalled(targetDir)
  })

  ipcMain.handle('setup:reveal', async (_event, targetDir: string): Promise<void> => {
    if (typeof targetDir === 'string') await revealFolder(targetDir)
  })

  ipcMain.on('setup:minimize', () => {
    if (window && !window.isDestroyed()) window.minimize()
  })
  ipcMain.on('setup:close', () => {
    if (!installing && window && !window.isDestroyed()) window.close()
  })
}

app.whenReady().then(async () => {
  app.setAppUserModelId('dev.pi.desktop.v3')
  if (silent) {
    await runSilent()
    return
  }
  registerIpc()
  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

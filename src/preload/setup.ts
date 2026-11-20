import { contextBridge, ipcRenderer } from 'electron'
import type { SetupBridge, SetupProgress } from '@shared/setup'

const bridge: SetupBridge = {
  info: () => ipcRenderer.invoke('setup:info'),
  browse: () => ipcRenderer.invoke('setup:browse'),
  install: (targetDir, launchAfterInstall) =>
    ipcRenderer.invoke('setup:install', targetDir, launchAfterInstall),
  uninstall: (removeUserData) => ipcRenderer.invoke('setup:uninstall', removeUserData),
  onProgress: (handler: (progress: SetupProgress) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: SetupProgress) => handler(progress)
    ipcRenderer.on('setup:progress', listener)
    return () => {
      ipcRenderer.removeListener('setup:progress', listener)
    }
  },
  minimize: () => ipcRenderer.send('setup:minimize'),
  close: () => ipcRenderer.send('setup:close'),
  launch: (targetDir: string) => ipcRenderer.invoke('setup:launch', targetDir),
  reveal: (targetDir: string) => ipcRenderer.invoke('setup:reveal', targetDir)
}

contextBridge.exposeInMainWorld('setup', bridge)

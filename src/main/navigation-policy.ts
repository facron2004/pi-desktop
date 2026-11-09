import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function resolveRendererEntry(
  isPackaged: boolean,
  developmentUrl: string | undefined,
  entryFile: string
): { developmentUrl?: string; trustedUrl: string } {
  const activeDevelopmentUrl = isPackaged ? undefined : developmentUrl
  return {
    developmentUrl: activeDevelopmentUrl,
    trustedUrl: activeDevelopmentUrl ?? pathToFileURL(entryFile).toString()
  }
}

export function isTrustedRendererNavigation(navigationUrl: string, appUrl: string): boolean {
  try {
    const target = new URL(navigationUrl)
    const app = new URL(appUrl)
    if (app.protocol === 'file:') {
      if (target.protocol !== 'file:') return false
      const targetPath = path.resolve(fileURLToPath(target))
      const appPath = path.resolve(fileURLToPath(app))
      return process.platform === 'win32'
        ? targetPath.toLowerCase() === appPath.toLowerCase()
        : targetPath === appPath
    }
    return (app.protocol === 'http:' || app.protocol === 'https:') && target.origin === app.origin
  } catch {
    return false
  }
}

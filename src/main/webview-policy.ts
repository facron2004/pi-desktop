export function isAllowedWebviewUrl(raw: string): boolean {
  try {
    const protocol = new URL(raw).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** Prevent untrusted pages from creating windows outside the webview policy. */
export function denyWebviewPopups(
  contents: Pick<Electron.WebContents, 'setWindowOpenHandler'>
): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

export function hardenWebviewPreferences(preferences: Electron.WebPreferences): void {
  delete preferences.preload
  preferences.nodeIntegration = false
  preferences.nodeIntegrationInWorker = false
  preferences.nodeIntegrationInSubFrames = false
  preferences.contextIsolation = true
  preferences.sandbox = true
  preferences.webviewTag = false
  preferences.webSecurity = true
  preferences.allowRunningInsecureContent = false
}

/** Where a mouse side button or a browser app-command should move the page. */
export type BrowserHistoryDirection = 'back' | 'forward'

/**
 * The DOM button for a mouse's side keys. Button 3 is back and button 4 is
 * forward — the same numbers a normal browser uses for those keys.
 */
export function browserMouseDirection(button: unknown): BrowserHistoryDirection | null {
  if (button === 3) return 'back'
  if (button === 4) return 'forward'
  return null
}

/**
 * Windows and Linux deliver the same keys as an app command (`WM_APPCOMMAND`
 * on Windows) instead of, or as well as, a DOM mouse button.
 */
export function browserHistoryCommand(command: unknown): BrowserHistoryDirection | null {
  if (command === 'browser-backward') return 'back'
  if (command === 'browser-forward') return 'forward'
  return null
}

/**
 * A side-button press often arrives twice: once as a mouse button inside the
 * page and once as an app command on the window. The second one must not walk
 * history again.
 */
export function claimBrowserHistoryNav(now: number, lastAt: number, gap = 300): boolean {
  return now - lastAt >= gap
}

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

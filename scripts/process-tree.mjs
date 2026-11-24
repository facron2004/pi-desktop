import { execFile } from 'node:child_process'

/** Stop a child and any of its descendants before releasing shared build files. */
export function terminateProcessTree(child, graceMs = 1000) {
  if (!child?.pid) {
    try { child?.kill('SIGKILL') } catch {}
    return Promise.resolve()
  }

  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        timeout: 10_000
      }, (error) => {
        if (error) {
          try { child.kill('SIGKILL') } catch {}
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve()
        } else {
          child.once('close', resolve)
        }
      })
    })
  }

  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal)
    } catch {
      try { child.kill(signal) } catch {}
    }
  }

  const wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))
  const groupExists = () => {
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (error) {
      if (error?.code === 'ESRCH') return false
      if (error?.code === 'EPERM') return true
      // An unexpected errno is not evidence that the group is gone, but it is
      // not worth an unhandled rejection in a shutdown path either: treat it as
      // gone and let the bounded wait below finish.
      return false
    }
  }

  return (async () => {
    signalGroup('SIGTERM')
    const deadline = Date.now() + Math.max(0, graceMs)
    while (groupExists() && Date.now() < deadline) {
      await wait(Math.min(50, deadline - Date.now()))
    }
    if (!groupExists()) return

    signalGroup('SIGKILL')
    // A process that cannot be reaped (a zombie, or one stuck in the kernel)
    // must not hang the shutdown that is waiting for it: give the kill a few
    // seconds and then let the caller go.
    const killDeadline = Date.now() + 5_000
    while (groupExists() && Date.now() < killDeadline) await wait(50)
  })()
}

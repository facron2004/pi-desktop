import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface EditorLaunchSpec {
  executable: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

/** Resolve the app and CLI entrypoint from a Windows editor's standard .cmd wrapper. */
export function windowsEditorLaunchSpec(wrapperPath: string, target: string): EditorLaunchSpec | null {
  try {
    const source = readFileSync(wrapperPath, 'utf8')
    const launch = source.match(/"([^"\r\n]+\.exe)"\s+"([^"\r\n]+\.js)"/i)
    if (!launch?.[1] || !launch[2]) return null

    const expand = (reference: string): string | null => {
      if (reference.includes('%') && !/^%~dp0/i.test(reference)) return null
      const relative = reference.replace(/^%~dp0/i, '')
      return path.resolve(path.dirname(wrapperPath), relative)
    }
    const executable = expand(launch[1])
    const cli = expand(launch[2])
    if (!executable || !cli || !existsSync(executable) || !existsSync(cli)) return null

    return {
      executable,
      args: [cli, target],
      env: { ...process.env, VSCODE_DEV: '', ELECTRON_RUN_AS_NODE: '1' }
    }
  } catch {
    return null
  }
}

/** Resolve a configured editor without asking a shell to parse the file path. */
export function editorLaunchSpec(opener: string, target: string): EditorLaunchSpec | null {
  const command = opener === 'vscode' ? 'code' : opener
  if (process.platform !== 'win32') return { executable: command, args: [target] }

  let candidates: string[]
  try {
    candidates = execFileSync('where.exe', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
      .split(/\r?\n/)
      .map((candidate) => candidate.trim())
      .filter(Boolean)
  } catch {
    return null
  }

  for (const candidate of candidates) {
    const extension = path.extname(candidate).toLowerCase()
    if (extension === '.exe') return { executable: candidate, args: [target] }
    if (extension === '.cmd' || extension === '.bat') {
      const wrapped = windowsEditorLaunchSpec(candidate, target)
      if (wrapped) return wrapped
    }
  }
  return null
}

/** Start a detached process with shell parsing disabled. */
export async function spawnEditor(spec: EditorLaunchSpec): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(spec.executable, spec.args, {
        detached: true,
        env: spec.env ?? process.env,
        shell: false,
        stdio: 'ignore',
        windowsHide: true
      })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })
}

/** Start a configured editor, reporting whether its process launched. */
export async function launchEditor(opener: string, target: string): Promise<boolean> {
  const spec = editorLaunchSpec(opener, target)
  return spec ? await spawnEditor(spec) : false
}

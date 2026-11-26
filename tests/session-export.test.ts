import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { dialog, ipcMain } from 'electron'
import { registerIpc, type IpcContext } from '../src/main/ipc'

type Handler = (event: unknown, ...args: unknown[]) => unknown

/** Capture the handlers `registerIpc` installs, then put the module back. */
function captureHandlers(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const descriptor = Object.getOwnPropertyDescriptor(ipcMain, 'handle')
  Object.defineProperty(ipcMain, 'handle', {
    configurable: true,
    value: (channel: string, listener: Handler) => handlers.set(channel, listener)
  })
  try {
    registerIpc({
      getWindow: () => undefined,
      settings: { get: () => ({}) },
      supervisor: {},
      terminals: {},
      memory: {}
    } as unknown as IpcContext)
  } finally {
    if (descriptor) Object.defineProperty(ipcMain, 'handle', descriptor)
    else delete (ipcMain as unknown as { handle?: unknown }).handle
  }
  return handlers
}

function exportHandler(): Handler {
  const handler = captureHandlers().get('sessions:exportMarkdown')
  assert.ok(handler, 'sessions:exportMarkdown handler was registered')
  return handler
}

const realSaveDialog = dialog.showSaveDialog

test('a Markdown export writes the transcript to the file the reader picked', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-markdown-export-'))
  t.after(() => {
    dialog.showSaveDialog = realSaveDialog
    rmSync(root, { recursive: true, force: true })
  })
  const target = path.join(root, 'conversation.md')
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: target })) as typeof dialog.showSaveDialog

  const result = await exportHandler()({}, 'session.jsonl', '# Release notes\n\n## You\n\nShip it\n')

  assert.deepEqual(result, { cancelled: false, path: target })
  assert.equal(readFileSync(target, 'utf8'), '# Release notes\n\n## You\n\nShip it\n')
  // The staging file beside the destination is gone, not left next to it.
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith('.tmp')),
    []
  )
})

test('a cancelled Markdown export writes nothing', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-markdown-cancel-'))
  t.after(() => {
    dialog.showSaveDialog = realSaveDialog
    rmSync(root, { recursive: true, force: true })
  })
  dialog.showSaveDialog = (async () => ({ canceled: true, filePath: undefined })) as typeof dialog.showSaveDialog
  const result = await exportHandler()({}, 'session.jsonl', '# Hi\n')
  assert.deepEqual(result, { cancelled: true })
  assert.deepEqual(readdirSync(root), [])
})

test('a Markdown export refuses empty content and a non-Markdown destination', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-markdown-invalid-'))
  t.after(() => {
    dialog.showSaveDialog = realSaveDialog
    rmSync(root, { recursive: true, force: true })
  })
  let asked = 0
  dialog.showSaveDialog = (async () => {
    asked += 1
    return { canceled: false, filePath: path.join(root, 'notes.txt') }
  }) as typeof dialog.showSaveDialog

  const handler = exportHandler()
  await assert.rejects(() => handler({}, 'session.jsonl', '   '), /nothing to export/i)
  assert.equal(asked, 0, 'an empty export must not open the save dialog')

  await assert.rejects(() => handler({}, 'session.jsonl', '# Hi\n'), /Markdown file/i)
  assert.equal(existsSync(path.join(root, 'notes.txt')), false)
})

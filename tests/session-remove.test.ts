import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import { test } from 'node:test'
import { removeSessionFile } from '../src/main/ipc'
import type { SessionSupervisor } from '../src/main/pi/supervisor'

test('session removal refuses a different file substituted while acquiring its mutation lock', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-session-remove-race-'))
  const root = path.join(parent, 'sessions')
  const workspace = path.join(root, '--C--project--')
  const file = path.join(workspace, 'chat.jsonl')
  const replacement = path.join(workspace, 'replacement.jsonl')
  const moved = path.join(workspace, 'original.jsonl')
  const originalContents = '{"type":"session","id":"original"}\n'
  const replacementContents = '{"type":"session","id":"replacement"}\n'
  mkdirSync(workspace, { recursive: true })
  writeFileSync(file, originalContents)
  writeFileSync(replacement, replacementContents)

  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const originalTrashItem = shell.trashItem
  let trashed: string | undefined
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    shell.trashItem = async (target: string) => { trashed = target }

    const supervisor = {
      withSessionFileMutation: async (_target: string, action: () => Promise<boolean>) => {
        renameSync(file, moved)
        renameSync(replacement, file)
        return action()
      }
    } as Pick<SessionSupervisor, 'withSessionFileMutation'>

    assert.equal(await removeSessionFile(file, supervisor), false)
    assert.equal(trashed, undefined)
    assert.equal(readFileSync(moved, 'utf8'), originalContents)
    assert.equal(readFileSync(file, 'utf8'), replacementContents)
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    shell.trashItem = originalTrashItem
    rmSync(parent, { recursive: true, force: true })
  }
})

test('session removal trashes the verified file when its identity is unchanged', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'pi-session-remove-'))
  const root = path.join(parent, 'sessions')
  const workspace = path.join(root, '--C--project--')
  const file = path.join(workspace, 'chat.jsonl')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(file, '{"type":"session","id":"chat"}\n')

  const previousRoot = process.env.PI_CODING_AGENT_SESSION_DIR
  const originalTrashItem = shell.trashItem
  let trashed: string | undefined
  try {
    process.env.PI_CODING_AGENT_SESSION_DIR = root
    shell.trashItem = async (target: string) => { trashed = target }
    const supervisor = {
      withSessionFileMutation: async (_target: string, action: () => Promise<boolean>) => action()
    } as Pick<SessionSupervisor, 'withSessionFileMutation'>

    assert.equal(await removeSessionFile(file, supervisor), true)
    assert.equal(trashed, file)
  } finally {
    if (previousRoot === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
    else process.env.PI_CODING_AGENT_SESSION_DIR = previousRoot
    shell.trashItem = originalTrashItem
    rmSync(parent, { recursive: true, force: true })
  }
})

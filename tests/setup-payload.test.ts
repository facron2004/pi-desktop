import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { removeTree, statPayloadFile, verifyPayload, type SourceEntry } from '../src/main/setup/payload'

/**
 * The installer copies into a staging folder and swaps it in only when every
 * payload file arrived whole. Before that it wrote over the installed folder and
 * started the app regardless, so a copy that ran out of disk launched a mix of
 * the new executable and the old archive.
 */

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'pi-setup-payload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const entries: SourceEntry[] = [
  { relative: 'Pi Desktop.exe', size: 6 },
  { relative: path.join('resources', 'app.asar'), size: 0 },
  { relative: path.join('locales', 'en-US.pak'), size: 7 }
]

function writeTree(root: string): void {
  mkdirSync(path.join(root, 'resources'), { recursive: true })
  mkdirSync(path.join(root, 'locales'), { recursive: true })
  writeFileSync(path.join(root, 'Pi Desktop.exe'), 'launch')
  writeFileSync(path.join(root, path.join('resources', 'app.asar')), 'archive')
  writeFileSync(path.join(root, 'locales', 'en-US.pak'), 'english')
}

test('a complete copy matches every payload entry', (t) => {
  const root = scratch(t)
  writeTree(root)
  assert.deepEqual(verifyPayload(root, entries), [])
})

test('a missing or truncated file is reported with what was found', (t) => {
  const root = scratch(t)
  writeTree(root)
  writeFileSync(path.join(root, 'Pi Desktop.exe'), 'launch!') // 7 bytes, not 6
  rmSync(path.join(root, 'locales', 'en-US.pak'))

  const mismatches = verifyPayload(root, entries)
  assert.deepEqual(mismatches.map((entry) => entry.relative).sort(), [
    'Pi Desktop.exe',
    path.join('locales', 'en-US.pak')
  ])
  const exe = mismatches.find((entry) => entry.relative === 'Pi Desktop.exe')
  assert.deepEqual(exe, { relative: 'Pi Desktop.exe', expected: 6, actual: 7 })
  const pak = mismatches.find((entry) => entry.relative === path.join('locales', 'en-US.pak'))
  assert.equal(pak?.actual, null)
})

test('an archive only has to be a non-empty file', (t) => {
  const root = scratch(t)
  writeTree(root)
  const asar = path.join(root, 'resources', 'app.asar')
  // The listing cannot know an archive's size; an empty file still means the
  // copy failed to deliver it.
  writeFileSync(asar, '')
  assert.deepEqual(verifyPayload(root, entries).map((entry) => entry.relative), [path.join('resources', 'app.asar')])
})

test('an archive whose length is known is checked like any other file', (t) => {
  const root = scratch(t)
  writeTree(root)
  const known: SourceEntry[] = [
    { relative: 'Pi Desktop.exe', size: 6 },
    { relative: path.join('resources', 'app.asar'), size: 7 },
    { relative: path.join('locales', 'en-US.pak'), size: 7 }
  ]
  assert.deepEqual(verifyPayload(root, known), [])

  writeFileSync(path.join(root, 'resources', 'app.asar'), 'arch')
  assert.deepEqual(verifyPayload(root, known), [
    { relative: path.join('resources', 'app.asar'), expected: 7, actual: 4 }
  ])
})

test('a payload file is measured as the file it is, whatever it is called', (t) => {
  const root = scratch(t)
  writeTree(root)
  const asar = path.join(root, 'resources', 'app.asar')
  // Electron's patched `fs` parses this path as an archive and answers with a
  // virtual directory (or throws "Invalid package"); the copy is made by
  // robocopy, which sees a file, so the check has to see the same thing.
  assert.equal(statPayloadFile(asar), 7)
  assert.equal(statPayloadFile(path.join(root, 'locales', 'en-US.pak')), 7)
  assert.equal(statPayloadFile(path.join(root, 'missing.bin')), null)
  assert.equal(statPayloadFile(path.join(root, 'resources')), null)
})

test('a copy holding an archive is removed whole, and the switch is put back', (t) => {
  const root = scratch(t)
  writeTree(root)
  const staging = path.join(root, 'staging')
  mkdirSync(path.join(staging, 'resources'), { recursive: true })
  writeFileSync(path.join(staging, 'resources', 'app.asar'), 'archive')
  writeFileSync(path.join(staging, 'Pi Desktop.exe'), 'launch')

  const before = process.noAsar
  removeTree(staging)
  // A half-deleted staging copy is what piled up next to the install: Electron
  // would not unlink the archive, so the delete stopped on it.
  assert.equal(existsSync(staging), false)
  assert.equal(process.noAsar, before)
})


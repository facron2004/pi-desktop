import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseWindowsUserSid,
  secureUserDataDirectory,
  SettingsStore,
  windowsUserDataAclCommands,
  dedupeWorkspaces
} from '../src/main/settings'
import type { Workspace } from '../src/shared/types'

const workspace = (id: string, path: string, lastOpenedAt: number): Workspace => ({
  id,
  path,
  name: id,
  lastOpenedAt
})

test('user data directory permissions are restricted on POSIX', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-user-data-permissions-'))
  try {
    if (process.platform === 'win32') return
    chmodSync(directory, 0o755)
    assert.equal(secureUserDataDirectory(directory), true)
    assert.equal(statSync(directory).mode & 0o777, 0o700)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('user data directory restriction reports an unusable path on POSIX', () => {
  if (process.platform === 'win32') return
  const root = mkdtempSync(path.join(tmpdir(), 'pi-user-data-invalid-'))
  const file = path.join(root, 'not-a-directory')
  try {
    writeFileSync(file, 'data')
    assert.equal(secureUserDataDirectory(file), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('user data security refuses a filesystem root', () => {
  assert.equal(secureUserDataDirectory(path.parse(path.resolve('/')).root), false)
})

test('Windows user SID parsing uses the stable CSV SID field', () => {
  assert.equal(
    parseWindowsUserSid('"DOMAIN\\user,name","S-1-5-21-123-456-789-1001"\r\n'),
    'S-1-5-21-123-456-789-1001'
  )
  assert.equal(parseWindowsUserSid('unexpected output'), undefined)
})

test('Windows user-data ACL plan secures existing content and future children', () => {
  const directory = 'C:\\Users\\user\\AppData\\Roaming\\Pi Desktop'
  const commands = windowsUserDataAclCommands(directory, 'S-1-5-21-123-456-789-1001', true)
  assert.deepEqual(commands, [
    [directory, '/reset', '/Q', '/L'],
    [directory, '/inheritance:r', '/Q', '/L'],
    [
      directory,
      '/grant:r',
      '*S-1-5-21-123-456-789-1001:(OI)(CI)F',
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
      '/Q',
      '/L'
    ],
    [path.win32.join(directory, '*'), '/reset', '/T', '/C', '/L', '/Q']
  ])
  assert.equal(windowsUserDataAclCommands(directory, 'S-1-5-21-123-456-789-1001', false).length, 3)
})

test('project trust defaults off and legacy trust is re-enabled only after an explicit choice', () => {
  const fileName = `settings-project-trust-${process.pid}.json`
  const file = path.join('C:/tmp', fileName)
  try {
    writeFileSync(file, JSON.stringify({ trustProject: true, theme: 'light' }), 'utf8')
    const migrated = new SettingsStore(fileName)
    assert.equal(migrated.get().trustProject, false)
    assert.equal('projectTrustReviewed' in migrated.get(), false)

    migrated.patch({ language: 'zh' })
    assert.equal(new SettingsStore(fileName).get().trustProject, false)

    migrated.patch({ trustProject: true })
    assert.equal(new SettingsStore(fileName).get().trustProject, true)
  } finally {
    rmSync(file, { force: true })
  }
})

test('workspace order follows the list, not last use', () => {
  const alpha = workspace('alpha', 'C:/alpha', 100)
  const beta = workspace('beta', 'C:/beta', 9000)
  const gamma = workspace('gamma', 'C:/gamma', 500)

  assert.deepEqual(
    dedupeWorkspaces([alpha, beta, gamma]).map((item) => item.id),
    ['alpha', 'beta', 'gamma']
  )
})

test('a duplicate replaces its entry without moving it', () => {
  const alphaPath = path.resolve(tmpdir(), 'alpha')
  const original = workspace('alpha', alphaPath, 100)
  const newer = workspace('alpha-new', `${alphaPath}${path.sep}`, 9000)
  const beta = workspace('beta', path.resolve(tmpdir(), 'beta'), 100)

  const result = dedupeWorkspaces([original, beta, newer])

  assert.deepEqual(result.map((item) => item.id), ['alpha-new', 'beta'])
})

test('workspace identity preserves case-sensitive paths outside Windows', () => {
  const lower = workspace('lower', path.resolve(tmpdir(), 'Pi Desktop'), 100)
  const upper = workspace('upper', path.resolve(tmpdir(), 'pi desktop'), 200)
  const result = dedupeWorkspaces([lower, upper])

  if (process.platform === 'win32') {
    assert.deepEqual(result.map((item) => item.id), ['upper'])
  } else {
    assert.deepEqual(result.map((item) => item.id), ['lower', 'upper'])
  }
})

test('a workspace added later joins at the end', () => {
  const alpha = workspace('alpha', 'C:/alpha', 9000)
  const beta = workspace('beta', 'C:/beta', 100)
  const gamma = workspace('gamma', 'C:/gamma', 50)

  assert.deepEqual(
    dedupeWorkspaces([alpha, beta, gamma]).map((item) => item.id),
    ['alpha', 'beta', 'gamma']
  )
})

test('an unrelated settings save keeps the workspace order', () => {
  const fileName = `settings-order-${process.pid}.json`
  const store = new SettingsStore(fileName)
  try {
    store.patch({
      workspaces: [
        workspace('alpha', 'C:/alpha', 100),
        workspace('beta', 'C:/beta', 9000),
        workspace('gamma', 'C:/gamma', 500)
      ]
    })
    store.patch({ theme: 'light' })

    assert.deepEqual(
      store.get().workspaces.map((item) => item.id),
      ['alpha', 'beta', 'gamma']
    )
    // A restart reads the same order back; nothing re-sorts it on load.
    assert.deepEqual(
      new SettingsStore(fileName).get().workspaces.map((item) => item.id),
      ['alpha', 'beta', 'gamma']
    )
  } finally {
    rmSync(path.join('C:/tmp', fileName), { force: true })
  }
})

test('workspace authorization sees a removal persisted by another settings store', () => {
  const fileName = `settings-workspace-auth-${process.pid}.json`
  const file = path.join('C:/tmp', fileName)
  const first = new SettingsStore(fileName)
  try {
    first.patch({ workspaces: [workspace('alpha', 'C:/workspace', 100)] })
    assert.equal(first.getRegisteredWorkspaces().some((item) => item.id === 'alpha'), true)

    const second = new SettingsStore(fileName)
    second.removeWorkspace('alpha')

    assert.equal(first.get().workspaces.length, 0, 'the first process refreshes its settings view')
    assert.equal(first.getRegisteredWorkspaces().some((item) => item.id === 'alpha'), false)
  } finally {
    rmSync(file, { force: true })
  }
})

test('independent settings stores merge partial updates against the latest file', () => {
  const fileName = `settings-cross-process-patch-${process.pid}.json`
  const file = path.join('C:/tmp', fileName)
  const first = new SettingsStore(fileName)
  const second = new SettingsStore(fileName)
  try {
    first.patch({ theme: 'light' })
    second.patch({ language: 'zh' })

    const saved = new SettingsStore(fileName).get()
    assert.equal(saved.theme, 'light')
    assert.equal(saved.language, 'zh')
    assert.equal(first.get().language, 'zh')
  } finally {
    rmSync(file, { force: true })
  }
})

test('workspace mutations from independent settings stores retain both folders', () => {
  const fileName = `settings-cross-process-workspaces-${process.pid}.json`
  const file = path.join('C:/tmp', fileName)
  const first = new SettingsStore(fileName)
  const second = new SettingsStore(fileName)
  try {
    first.addWorkspace(workspace('alpha', 'C:/alpha', 100))
    second.addWorkspace(workspace('beta', 'C:/beta', 200))

    assert.deepEqual(
      new SettingsStore(fileName).get().workspaces.map((item) => item.id),
      ['alpha', 'beta']
    )
  } finally {
    rmSync(file, { force: true })
  }
})

test('stale settings stores keep independent scalar, list and keyed updates', () => {
  const fileName = `settings-cross-process-patch-${process.pid}.json`
  const file = path.join('C:/tmp', fileName)
  const first = new SettingsStore(fileName)
  const second = new SettingsStore(fileName)
  try {
    first.patch({
      theme: 'light',
      pinnedSessions: ['C:/sessions/one.jsonl'],
      lastSessions: { 'C:/alpha': 'one.jsonl' }
    })
    second.patch({
      language: 'zh',
      pinnedSessions: ['C:/sessions/two.jsonl'],
      lastSessions: { 'C:/beta': 'two.jsonl' }
    })

    const saved = new SettingsStore(fileName).get()
    assert.equal(saved.theme, 'light')
    assert.equal(saved.language, 'zh')
    assert.deepEqual(saved.pinnedSessions, ['C:/sessions/one.jsonl', 'C:/sessions/two.jsonl'])
    assert.deepEqual(saved.lastSessions, {
      'C:/alpha': 'one.jsonl',
      'C:/beta': 'two.jsonl'
    })
    assert.equal(first.get().language, 'zh')
  } finally {
    rmSync(file, { force: true })
  }
})

test('stale workspace writes keep new folders and merge separate project edits', () => {
  const fileName = `settings-cross-process-workspaces-${process.pid}.json`
  const file = path.join('C:/tmp', fileName)
  const first = new SettingsStore(fileName)
  const second = new SettingsStore(fileName)
  try {
    first.addWorkspace(workspace('alpha', 'C:/alpha', 100))
    second.patch({ workspaces: [workspace('beta', 'C:/beta', 200)] })

    const editorA = new SettingsStore(fileName)
    const editorB = new SettingsStore(fileName)
    const alpha = editorA.get().workspaces.find((item) => item.id === 'alpha')!
    editorA.patch({ workspaces: [{ ...alpha, name: 'Renamed project' }] })
    editorB.patch({ workspaces: [{ ...alpha, icon: '📦' }] })

    const saved = new SettingsStore(fileName).get()
    assert.deepEqual(saved.workspaces.map((item) => item.id), ['alpha', 'beta'])
    assert.equal(saved.workspaces[0].name, 'Renamed project')
    assert.equal(saved.workspaces[0].icon, '📦')
  } finally {
    rmSync(file, { force: true })
  }
})

test('workspace removal is atomic with hiding and keeps another process addition', () => {
  const fileName = `settings-cross-process-remove-${process.pid}.json`
  const file = path.join('C:/tmp', fileName)
  const first = new SettingsStore(fileName)
  const second = new SettingsStore(fileName)
  try {
    first.addWorkspace(workspace('alpha', 'C:/alpha', 100))
    second.addWorkspace(workspace('beta', 'C:/beta', 200))
    first.patch({ hiddenProjects: ['C:/other'] })

    first.removeWorkspace('alpha', 'C:/alpha')

    const saved = new SettingsStore(fileName).get()
    assert.deepEqual(saved.workspaces.map((item) => item.id), ['beta'])
    assert.deepEqual(saved.hiddenProjects, ['C:/other', 'C:/alpha'])
  } finally {
    rmSync(file, { force: true })
  }
})

test('projectOrder keeps the display order and drops duplicate paths', () => {
  const fileName = `project-order-${process.pid}.json`
  const store = new SettingsStore(fileName)
  const paths = process.platform === 'win32'
    ? ['C:/alpha', 'c:/alpha/', 'C:/beta']
    : ['/tmp/alpha', '/tmp/ALPHA', '/tmp/beta']
  const expected = process.platform === 'win32'
    ? ['C:/alpha', 'C:/beta']
    : ['/tmp/alpha', '/tmp/ALPHA', '/tmp/beta']
  try {
    store.patch({
      projectOrder: paths
    })
    assert.deepEqual(store.get().projectOrder, expected)
    assert.deepEqual(new SettingsStore(fileName).get().projectOrder, expected)
  } finally {
    rmSync(path.join('C:/tmp', fileName), { force: true })
  }
})

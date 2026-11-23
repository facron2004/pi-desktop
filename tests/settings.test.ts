import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  parseWindowsUserSid,
  parseWindowsUserName,
  secureUserDataDirectory,
  SettingsStore,
  windowsUserDataAclCommands,
  windowsUserDataAclSecure,
  windowsUserDataChildAclCommands,
  dedupeWorkspaces
} from '../src/main/settings'
import type { Workspace } from '../src/shared/types'

const workspace = (id: string, path: string, lastOpenedAt: number): Workspace => ({
  id,
  path,
  name: id,
  lastOpenedAt
})

/**
 * The folder the mocked `app.getPath('userData')` points at.
 *
 * It is created rather than assumed: a clean CI runner has no `C:\tmp`, and the
 * settings tests failed there with ENOENT before this. Nothing else depends on
 * the folder existing up front, so creating it is all the tests need.
 */
const SETTINGS_DIRECTORY = 'C:/tmp'
mkdirSync(SETTINGS_DIRECTORY, { recursive: true })

/** A settings file inside {@link SETTINGS_DIRECTORY}. */
const settingsFile = (fileName: string): string => path.join(SETTINGS_DIRECTORY, fileName)

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
  assert.equal(
    parseWindowsUserName('"DOMAIN\\user,name","S-1-5-21-123-456-789-1001"\r\n'),
    'DOMAIN\\user,name'
  )
  assert.equal(parseWindowsUserName('unexpected output'), undefined)
})

test('Windows user-data ACL plan secures the root without walking its children', () => {
  const directory = 'C:\\Users\\user\\AppData\\Roaming\\Pi Desktop'
  const commands = windowsUserDataAclCommands(directory, 'S-1-5-21-123-456-789-1001')
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
    ]
  ])
  // The recursive pass is its own one-time command, not part of every launch.
  assert.deepEqual(windowsUserDataChildAclCommands(directory), [
    [path.win32.join(directory, '*'), '/reset', '/T', '/C', '/L', '/Q']
  ])
})

test('Windows ACL validation allowlists exact principals instead of substring matches', () => {
  const account = 'DOMAIN\\user'
  const sid = 'S-1-5-21-123-456-789-1001'
  const secured = [
    'C:\\data',
    '    DOMAIN\\user:(OI)(CI)(F)',
    '    NT AUTHORITY\\SYSTEM:(OI)(CI)(F)',
    '    BUILTIN\\Administrators:(OI)(CI)(F)'
  ].join('\r\n')
  assert.equal(windowsUserDataAclSecure(secured, account, sid), true)
  assert.equal(windowsUserDataAclSecure(`${secured}\r\n    Everyone:(OI)(CI)(F)`, account, sid), false)
  assert.equal(windowsUserDataAclSecure(`${secured}\r\n    DOMAIN\\user-other:(OI)(CI)(F)`, account, sid), false)
  assert.equal(windowsUserDataAclSecure(`${secured}\r\n    DOMAIN\\other:(OI)(CI)(RX)`, account, sid), false)
  assert.equal(windowsUserDataAclSecure(secured.replace('DOMAIN\\user', 'DOMAIN\\user-other'), account, sid), false)
  assert.equal(windowsUserDataAclSecure(secured.replace('(OI)(CI)(F)', '(I)(OI)(CI)(F)'), account, sid), false)
})

test('Windows user-data ACL repair removes an extra Everyone full-control ACE', () => {
  if (process.platform !== 'win32') return
  const directory = mkdtempSync(path.join(tmpdir(), 'pi-user-data-acl-extra-principal-'))
  try {
    const identity = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' })
    const account = parseWindowsUserName(identity)
    const sid = parseWindowsUserSid(identity)
    assert.ok(account)
    assert.ok(sid)
    execFileSync('icacls', [directory, '/inheritance:r', '/Q', '/L'])
    execFileSync('icacls', [
      directory,
      '/grant:r',
      `*${sid}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
      '*S-1-1-0:(OI)(CI)F',
      '/Q',
      '/L'
    ])
    const before = execFileSync('icacls', [directory, '/L'], { encoding: 'utf8' })
    assert.equal(windowsUserDataAclSecure(before, account, sid, directory), false)

    assert.equal(secureUserDataDirectory(directory), true, 'the unsafe root ACL should be repaired')
    const after = execFileSync('icacls', [directory, '/L'], { encoding: 'utf8' })
    assert.equal(windowsUserDataAclSecure(after, account, sid, directory), true, `unexpected repaired ACL:\n${after}`)
    assert.doesNotMatch(after, /Everyone:\(OI\)\(CI\)\(F\)/i)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('project trust defaults off and legacy trust is re-enabled only after an explicit choice', () => {
  const fileName = `settings-project-trust-${process.pid}.json`
  const file = settingsFile(fileName)
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

test('an invalid settings file is preserved before defaults are written', () => {
  const fileName = `settings-invalid-recovery-${process.pid}.json`
  const file = settingsFile(fileName)
  const original = '{"theme":'
  try {
    writeFileSync(file, original, 'utf8')
    const store = new SettingsStore(fileName)
    store.patch({ theme: 'light' })

    const recoveryName = readdirSync(path.dirname(file)).find((name) =>
      name.startsWith(`${path.basename(file)}.corrupt-`)
    )
    assert.ok(recoveryName, 'saving recovered settings should leave a named copy of the invalid file')
    assert.equal(readFileSync(path.join(path.dirname(file), recoveryName), 'utf8'), original)
    assert.equal(new SettingsStore(fileName).get().theme, 'light')
  } finally {
    rmSync(file, { force: true })
    for (const name of readdirSync(path.dirname(file))) {
      if (name.startsWith(`${path.basename(file)}.corrupt-`)) {
        rmSync(path.join(path.dirname(file), name), { force: true })
      }
    }
  }
})

test('valid JSON with malformed workspace and path settings falls back without crashing', () => {
  const fileName = `settings-malformed-values-${process.pid}.json`
  const file = settingsFile(fileName)
  try {
    writeFileSync(file, JSON.stringify({
      workspaces: [{ id: 'broken', path: { value: 'C:/project' }, name: 'Broken' }],
      externalChatFolder: { trim: false },
      externalChatFolderHistory: ['C:/previous'],
      piPath: { trim: false },
      model: { trim: false },
      customInstructions: { trim: false },
      subagentModel: { trim: false }
    }), 'utf8')

    const store = new SettingsStore(fileName)
    const settings = store.get()
    assert.deepEqual(settings.workspaces, [])
    assert.equal(settings.externalChatFolder, undefined)
    assert.deepEqual(settings.externalChatFolderHistory, ['C:/previous'])
    assert.equal(settings.piPath, undefined)
    assert.equal(settings.model, undefined)
    assert.equal(settings.customInstructions, undefined)
    assert.equal(settings.subagentModel, undefined)
    assert.doesNotThrow(() => store.patch({ language: 'zh' }))
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
    rmSync(settingsFile(fileName), { force: true })
  }
})

test('workspace authorization sees a removal persisted by another settings store', () => {
  const fileName = `settings-workspace-auth-${process.pid}.json`
  const file = settingsFile(fileName)
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
  const file = settingsFile(fileName)
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
  const file = settingsFile(fileName)
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
  const file = settingsFile(fileName)
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
  const file = settingsFile(fileName)
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

test('view-based settings patches preserve concurrent edits after the main cache refreshes', () => {
  const fileName = `settings-view-baseline-${process.pid}.json`
  const file = settingsFile(fileName)
  const local = new SettingsStore(fileName)
  try {
    const a = 'C:/one'
    const b = 'C:/two'
    const c = 'C:/three'
    const seen = local.patch({
      workspaces: [workspace('alpha', a, 100)],
      pinnedSessions: ['C:/sessions/first.jsonl'],
      projectOrder: [a, b],
      lastSessions: { [a]: 'first.jsonl' }
    })
    const peer = new SettingsStore(fileName)
    peer.patch({
      workspaces: [{ ...seen.workspaces[0], name: 'Edited by peer' }],
      pinnedSessions: ['C:/sessions/first.jsonl', 'C:/sessions/peer.jsonl'],
      projectOrder: [b, a],
      lastSessions: { [a]: 'first.jsonl', [b]: 'peer.jsonl' }
    })
    assert.equal(local.get().workspaces[0].name, 'Edited by peer')

    local.patch({
      workspaces: [{ ...seen.workspaces[0], icon: '📦' }],
      pinnedSessions: [],
      projectOrder: [a, b, c],
      lastSessions: { [a]: 'next.jsonl' }
    }, {
      workspaces: seen.workspaces,
      pinnedSessions: seen.pinnedSessions,
      projectOrder: seen.projectOrder,
      lastSessions: seen.lastSessions
    })

    const saved = new SettingsStore(fileName).get()
    assert.deepEqual(saved.pinnedSessions, ['C:/sessions/peer.jsonl'])
    assert.deepEqual(saved.projectOrder, [b, a, c])
    assert.deepEqual(saved.lastSessions, { [a]: 'next.jsonl', [b]: 'peer.jsonl' })
    assert.equal(saved.workspaces[0].name, 'Edited by peer')
    assert.equal(saved.workspaces[0].icon, '📦')
  } finally {
    rmSync(file, { force: true })
  }
})

test('workspace removal is atomic with hiding and keeps another process addition', () => {
  const fileName = `settings-cross-process-remove-${process.pid}.json`
  const file = settingsFile(fileName)
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
    rmSync(settingsFile(fileName), { force: true })
  }
})

test('malformed shortcut patches preserve saved bindings while an empty object clears them', () => {
  const fileName = `settings-shortcut-patch-${process.pid}.json`
  const file = settingsFile(fileName)
  try {
    const store = new SettingsStore(fileName)
    const bindings = { 'new-chat': [['Ctrl', 'N']] }
    store.patch({ shortcutBindings: bindings })
    store.patch({ shortcutBindings: { broken: 'not-an-array' } as unknown as typeof bindings })
    assert.deepEqual(new SettingsStore(fileName).get().shortcutBindings, { 'new-chat': ['Ctrl', 'N'] })
    store.patch({ shortcutBindings: {} })
    assert.equal(new SettingsStore(fileName).get().shortcutBindings, undefined)
  } finally {
    rmSync(file, { force: true })
  }
})

test('shortcutBindings persists multi-chord, legacy, and unbound entries while stripping malformed data', () => {
  const fileName = `settings-shortcuts-${process.pid}.json`
  const file = settingsFile(fileName)
  try {
    writeFileSync(
      file,
      JSON.stringify({
        shortcutBindings: {
          'new-chat': [['Ctrl', 'N'], ['Ctrl', 'Shift', 'O'], []],
          'focus-composer': ['Ctrl', 'Alt', 'K'],
          'toggle-sidebar': [],
          broken: 'not-an-array'
        }
      }),
      'utf8'
    )

    const loaded = new SettingsStore(fileName).get().shortcutBindings
    assert.deepEqual(loaded, {
      'new-chat': [['Ctrl', 'N'], ['Ctrl', 'Shift', 'O']],
      'focus-composer': ['Ctrl', 'Alt', 'K'],
      'toggle-sidebar': []
    })

    const store = new SettingsStore(fileName)
    store.patch({ shortcutBindings: {} })
    assert.equal(new SettingsStore(fileName).get().shortcutBindings, undefined)
  } finally {
    rmSync(file, { force: true })
  }
})

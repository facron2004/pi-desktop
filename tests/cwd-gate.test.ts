import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CwdGate, InterprocessCwdGate } from '../src/main/pi/cwd-gate'

test('shared claims allow concurrent conversations in one folder while exclusive claims serialize', () => {
  const gate = new CwdGate()
  assert.equal(gate.claim('C:\\project\\', 'a.jsonl'), true)
  assert.equal(gate.claim('C:/project', 'b.jsonl', 'shared'), true)
  assert.equal(gate.holds('a.jsonl'), true)
  assert.equal(gate.holds('b.jsonl'), true)
  assert.deepEqual(gate.keysFor('a.jsonl'), [CwdGate.key('C:/project')])
  assert.deepEqual(gate.keysFor('b.jsonl'), [CwdGate.key('C:/project')])

  // No conflict in shared mode, while exclusive mode sees the shared holders.
  assert.equal(gate.holder('c:/project', 'shared'), undefined)
  assert.equal(gate.holder('c:/project', 'exclusive'), 'a.jsonl')
  assert.equal(gate.holderInfo('c:/project', 'exclusive', 'a.jsonl')?.ownerId, 'b.jsonl')
  assert.equal(gate.claim('C:/project', 'operation:1', 'exclusive'), false)

  // Releasing one shared owner keeps the co-holder intact.
  gate.release('C:/project', 'a.jsonl')
  assert.equal(gate.holds('a.jsonl'), false)
  assert.equal(gate.holds('b.jsonl'), true)
  assert.equal(gate.holder('C:/project', 'exclusive'), 'b.jsonl')
  assert.equal(gate.claim('C:/project', 'operation:1', 'exclusive'), false)

  gate.release('C:/project', 'b.jsonl')
  assert.equal(gate.holds('b.jsonl'), false)
  assert.equal(gate.claim('C:/project', 'operation:1', 'exclusive'), true)
  assert.equal(gate.claim('C:/project', 'c.jsonl', 'shared'), false)
  assert.equal(gate.claim('C:/project', 'operation:2', 'exclusive'), false)
  assert.deepEqual(gate.holderInfoResolved(CwdGate.key('C:/project'), 'shared'), {
    ownerId: 'operation:1',
    cwd: CwdGate.key('C:/project'),
    mode: 'exclusive'
  })

  // Re-entrant shared claim by the exclusive owner does not downgrade its exclusivity.
  assert.equal(gate.claim('C:/project', 'operation:1', 'shared'), true)
  assert.equal(gate.claim('C:/project', 'c.jsonl', 'shared'), false)
  gate.release('C:/project', 'operation:1')
  assert.equal(gate.claim('C:/project', 'c.jsonl', 'shared'), true)
})

test('parent and nested working directories share shared access while exclusive conflicts', () => {
  const gate = new CwdGate()
  assert.equal(gate.claim('C:/project', 'parent', 'shared'), true)
  assert.equal(gate.claim('C:/project/packages/app', 'nested', 'shared'), true)
  assert.equal(gate.claim('C:/other', 'sibling', 'shared'), true)

  assert.equal(gate.claim('C:/project', 'operation:root', 'exclusive'), false)
  assert.equal(gate.claim('C:/project/packages/app', 'operation:nested', 'exclusive'), false)
  assert.equal(gate.claim('C:/other', 'operation:sibling', 'exclusive'), false)
  gate.release('C:/other', 'sibling')
  assert.equal(gate.claim('C:/other', 'operation:sibling', 'exclusive'), true)
  gate.release('C:/other', 'operation:sibling')

  gate.release('C:/project', 'parent')
  assert.equal(gate.claim('C:/project', 'operation:root', 'exclusive'), false)
  assert.equal(gate.holderInfo('C:/project', 'exclusive')?.ownerId, 'nested')

  gate.release('C:/project/packages/app', 'nested')
  assert.equal(gate.claim('C:/project', 'operation:root', 'exclusive'), true)
  assert.equal(gate.claim('C:/project/packages/app', 'nested', 'shared'), false)
})

test('re-entrant upgrade from shared to exclusive checks other overlapping holders', () => {
  const gate = new CwdGate()
  assert.equal(gate.claim('C:/project', 'a', 'shared'), true)
  assert.equal(gate.claim('C:/project', 'b', 'shared'), true)
  assert.equal(gate.claim('C:/project', 'a', 'exclusive'), false)
  gate.release('C:/project', 'b')
  assert.equal(gate.claim('C:/project', 'a', 'exclusive'), true)
  assert.equal(gate.claim('C:/project', 'b', 'shared'), false)
})

test('the filesystem root remains a scoped working directory', () => {
  const root = path.parse(path.resolve(process.cwd())).root
  const gate = new CwdGate()
  assert.notEqual(CwdGate.key(root), '')
  assert.equal(gate.claim(root, 'root', 'shared'), true)
  const nested = path.join(root, 'nested')
  assert.equal(gate.claim(nested, 'nested', 'shared'), true)
  assert.equal(gate.claim(nested, 'operation:nested', 'exclusive'), false)
  gate.release(root, 'root')
  gate.release(nested, 'nested')
  assert.equal(gate.claim(root, 'operation:root', 'exclusive'), true)
  assert.equal(gate.claim(nested, 'nested', 'shared'), false)
})

test('working-directory locks resolve paths again after a directory becomes a symlink', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-cwd-gate-path-change-'))
  const target = path.join(root, 'target')
  const missingAlias = path.join(root, 'created-later')
  const replacedAlias = path.join(root, 'replaced')
  mkdirSync(target)
  mkdirSync(replacedAlias)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  CwdGate.key(missingAlias)
  CwdGate.key(replacedAlias)
  rmdirSync(replacedAlias)
  try {
    symlinkSync(target, missingAlias, process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(target, replacedAlias, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`directory links are unavailable (${code})`)
      return
    }
    throw error
  }

  assert.equal(CwdGate.key(missingAlias), CwdGate.key(target))
  assert.equal(CwdGate.key(replacedAlias), CwdGate.key(target))

  const gate = new CwdGate()
  assert.equal(gate.claim(missingAlias, 'alias-shared', 'shared'), true)
  assert.equal(gate.claim(target, 'target-shared', 'shared'), true)
  gate.release(missingAlias, 'alias-shared')
  gate.release(target, 'target-shared')

  assert.equal(gate.claim(missingAlias, 'operation:alias', 'exclusive'), true)
  assert.equal(gate.claim(target, 'target', 'shared'), false)
  gate.release(missingAlias, 'operation:alias')
  assert.equal(gate.claim(target, 'operation:target', 'exclusive'), true)
  assert.equal(gate.claim(replacedAlias, 'replaced', 'shared'), false)
})

test('a draft id can be retargeted to its session file without disturbing co-holders', () => {
  const gate = new CwdGate()
  assert.equal(gate.claim('C:/project', 'draft:1', 'shared'), true)
  assert.equal(gate.claim('C:/project', 'draft:2', 'shared'), true)
  gate.retarget('draft:1', 'C:/project/a.jsonl')
  assert.equal(gate.holds('draft:1'), false)
  assert.equal(gate.holds('C:/project/a.jsonl'), true)
  assert.equal(gate.holds('draft:2'), true)
  assert.equal(gate.claim('C:/project', 'C:/project/a.jsonl', 'shared'), true)
  gate.releaseOwner('C:/project/a.jsonl')
  assert.equal(gate.holds('draft:2'), true)
})

test('independent interprocess gates share overlapping shared leases and serialize exclusive leases', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-cwd-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = new InterprocessCwdGate(root)
  const second = new InterprocessCwdGate(root)

  assert.equal(await first.acquire('C:/project', 'a.jsonl', 'shared'), true)
  assert.equal(await second.acquire('C:/project', 'b.jsonl', 'shared'), true)
  assert.equal(await second.acquire('C:/project/packages/app', 'c.jsonl', 'shared'), true)

  assert.equal(await second.acquire('C:/project', 'operation:1', 'exclusive'), false)
  assert.equal(second.externalHolder('C:/project', 'exclusive')?.mode, 'shared')

  await first.release('C:/project', 'a.jsonl')
  assert.equal(await first.acquire('C:/project', 'operation:2', 'exclusive'), false)

  await second.releaseOwner('b.jsonl')
  await second.releaseOwner('c.jsonl')

  assert.equal(await first.acquire('C:/project', 'operation:2', 'exclusive'), true)
  assert.equal(await second.acquire('C:/project/packages/app', 'd.jsonl', 'shared'), false)
  assert.deepEqual(second.externalHolderResolved(CwdGate.key('C:/project/packages/app'), 'shared'), {
    pid: process.pid,
    cwd: CwdGate.key('C:/project'),
    mode: 'exclusive'
  })
  assert.equal(await second.acquire('C:/project', 'operation:3', 'exclusive'), false)
  assert.equal(await second.acquire('C:/sibling', 'operation:4', 'exclusive'), true)
  await second.release('C:/sibling')

  await first.release('C:/project')
  assert.equal(await second.acquire('C:/project/packages/app', 'd.jsonl', 'shared'), true)
  await second.release('C:/project/packages/app')
})

test('an interprocess lease can be released after its symlink alias is retargeted', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-cwd-gate-retarget-'))
  const firstTarget = path.join(root, 'first-target')
  const secondTarget = path.join(root, 'second-target')
  const alias = path.join(root, 'workspace')
  const oldAlias = path.join(root, 'workspace-old')
  mkdirSync(firstTarget)
  mkdirSync(secondTarget)
  t.after(() => rmSync(root, { recursive: true, force: true }))

  try {
    symlinkSync(firstTarget, alias, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
      t.skip(`directory links are unavailable (${code})`)
      return
    }
    throw error
  }

  const first = new InterprocessCwdGate(root)
  const second = new InterprocessCwdGate(root)
  assert.equal(await first.acquire(alias, 'runtime-a', 'exclusive'), true)

  renameSync(alias, oldAlias)
  symlinkSync(secondTarget, alias, process.platform === 'win32' ? 'junction' : 'dir')
  first.retargetOwner('runtime-a', 'session-a')
  await first.releaseOwner('session-a')

  assert.equal(await second.acquire(firstTarget, 'probe', 'exclusive'), true, 'the old target is no longer leased')
  await second.release(firstTarget)
})

test('re-acquiring during an in-flight async release keeps a fresh lease on disk', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-cwd-gate-reacquire-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = new InterprocessCwdGate(root)
  const second = new InterprocessCwdGate(root)

  assert.equal(first.acquire('C:/reacquire', 'owner-a', 'shared'), true)

  // Start releasing owner-a asynchronously, then immediately re-acquire before release finishes.
  const releasing = first.releaseOwner('owner-a')
  const reacquired = await first.acquireAsync('C:/reacquire', 'owner-a', 'shared')
  await releasing

  assert.equal(reacquired, true)
  // Another gate must still see owner-a's fresh lease on disk and block an exclusive claim.
  assert.equal(await second.acquireAsync('C:/reacquire', 'other', 'exclusive'), false)
  await first.releaseOwner('owner-a')
  assert.equal(await second.acquireAsync('C:/reacquire', 'other', 'exclusive'), true)
  await second.releaseOwner('other')
})

test('corrupt leases.json is quarantined and recovered cleanly without wedging future claims', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-cwd-gate-corrupt-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, 'leases.json'), '{"version":1,"leases":[broken', 'utf8')

  const gate = new InterprocessCwdGate(root)
  assert.equal(await gate.acquireAsync('C:/recovered', 'owner-1', 'exclusive'), true)
  assert.ok(
    readdirSync(root).some((name) => name.startsWith('leases.json.corrupt-')),
    'corrupt registry should be quarantined for diagnostics'
  )
  await gate.releaseOwner('owner-1')
})

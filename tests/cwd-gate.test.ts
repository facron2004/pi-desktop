import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CwdGate, InterprocessCwdGate } from '../src/main/pi/cwd-gate'

test('one working directory has one writing conversation', () => {
  const gate = new CwdGate()
  assert.equal(gate.claim('C:\\project\\', 'a.jsonl'), true)
  assert.equal(gate.claim('C:/project', 'b.jsonl'), false)
  assert.equal(gate.holder('c:/project'), 'a.jsonl')
  gate.release('C:/project', 'b.jsonl')
  assert.equal(gate.holder('C:/project'), 'a.jsonl')
  gate.release('C:/project', 'a.jsonl')
  assert.equal(gate.claim('C:/project', 'b.jsonl'), true)
})

test('parent and nested working directories share the writing gate', () => {
  const gate = new CwdGate()
  assert.equal(gate.claim('C:/project', 'parent'), true)
  assert.equal(gate.claim('C:/project/packages/app', 'nested'), false)
  assert.equal(gate.claim('C:/other', 'sibling'), true)
  gate.release('C:/project', 'parent')
  assert.equal(gate.claim('C:/project/packages/app', 'nested'), true)
  assert.equal(gate.claim('C:/project', 'parent'), false)
})

test('the filesystem root remains a scoped working directory', () => {
  const root = path.parse(path.resolve(process.cwd())).root
  const gate = new CwdGate()
  assert.notEqual(CwdGate.key(root), '')
  assert.equal(gate.claim(root, 'root'), true)
  const nested = path.join(root, 'nested')
  assert.equal(gate.claim(nested, 'nested'), false)
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
  assert.equal(gate.claim(missingAlias, 'alias'), true)
  assert.equal(gate.claim(target, 'target'), false)
  gate.release(missingAlias, 'alias')
  assert.equal(gate.claim(target, 'target'), true)
  assert.equal(gate.claim(replacedAlias, 'replaced'), false)
})

test('a draft id can be retargeted to its session file', () => {
  const gate = new CwdGate()
  assert.equal(gate.claim('C:/project', 'draft:1'), true)
  gate.retarget('draft:1', 'C:/project/a.jsonl')
  assert.equal(gate.holds('C:/project/a.jsonl'), true)
  assert.equal(gate.claim('C:/project', 'C:/project/a.jsonl'), true)
})

test('independent gates serialize overlapping working directories', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'pi-cwd-gate-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const first = new InterprocessCwdGate(root)
  const second = new InterprocessCwdGate(root)

  assert.equal(await first.acquire('C:/project'), true)
  assert.equal(await second.acquire('C:/project/packages/app'), false)
  assert.equal(await second.acquire('C:/sibling'), true)
  await second.release('C:/sibling')
  await first.release('C:/project')
  assert.equal(await second.acquire('C:/project/packages/app'), true)
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
  assert.equal(await first.acquire(alias, 'runtime-a'), true)

  renameSync(alias, oldAlias)
  symlinkSync(secondTarget, alias, process.platform === 'win32' ? 'junction' : 'dir')
  first.retargetOwner('runtime-a', 'session-a')
  await first.releaseOwner('session-a')

  assert.equal(await second.acquire(firstTarget), true, 'the old target is no longer leased')
  await second.release(firstTarget)
})

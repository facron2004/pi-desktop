import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { properLockfile } from '../proper-lockfile'
import { canonicalPath } from './session-file'

export type CwdClaimMode = 'shared' | 'exclusive'
export type InterprocessAcquireResult = 'acquired' | 'conflict' | 'lock_busy'

interface CwdLeaseRecord {
  id: string
  pid: number
  processInstanceId?: string
  cwd: string
  mode?: CwdClaimMode
}

const PROCESS_INSTANCE_ID = randomUUID()

interface CwdLeaseFile {
  version: 1
  leases: CwdLeaseRecord[]
}

/**
 * Working-directory activity gate with shared and exclusive modes.
 *
 * Conversation turns (`prompt`, `bash`) claim `'shared'` access so distinct
 * conversations in the same folder or overlapping parent/child trees run
 * concurrently (while each JSONL session file stays single-writer elsewhere).
 * Desktop operations (`withCwdLock`, e.g. Git writes) claim `'exclusive'`
 * access, conflicting with both `'shared'` and `'exclusive'` holders on
 * overlapping folders. Sibling folders remain independent.
 */
export class CwdGate {
  private holders = new Map<string, Map<string, CwdClaimMode>>()

  static overlaps(left: string, right: string): boolean {
    const inside = (relative: string) =>
      relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    return inside(path.relative(left, right)) || inside(path.relative(right, left))
  }

  static key(cwd: string): string {
    return canonicalPath(cwd)
  }

  private static conflicts(
    leftCwd: string,
    leftMode: CwdClaimMode,
    leftOwner: string,
    rightCwd: string,
    rightMode: CwdClaimMode,
    rightOwner: string
  ): boolean {
    if (leftOwner === rightOwner) return false
    if (!CwdGate.overlaps(leftCwd, rightCwd)) return false
    return leftMode === 'exclusive' || rightMode === 'exclusive'
  }

  holder(cwd: string, mode: CwdClaimMode = 'shared', excludeOwnerId?: string): string | undefined {
    if (!cwd) return undefined
    return this.holderInfoResolved(CwdGate.key(cwd), mode, excludeOwnerId)?.ownerId
  }

  holderInfo(
    cwd: string,
    mode: CwdClaimMode = 'shared',
    excludeOwnerId?: string
  ): { ownerId: string; cwd: string; mode: CwdClaimMode } | undefined {
    if (!cwd) return undefined
    return this.holderInfoResolved(CwdGate.key(cwd), mode, excludeOwnerId)
  }

  holderInfoResolved(
    id: string,
    mode: CwdClaimMode = 'shared',
    excludeOwnerId?: string
  ): { ownerId: string; cwd: string; mode: CwdClaimMode } | undefined {
    if (!id) return undefined
    const exact = this.holders.get(id)
    if (exact) {
      for (const [ownerId, heldMode] of exact) {
        if (excludeOwnerId !== undefined && ownerId === excludeOwnerId) continue
        if (mode === 'exclusive' || heldMode === 'exclusive') {
          return { ownerId, cwd: id, mode: heldMode }
        }
      }
    }
    for (const [heldCwd, owners] of this.holders) {
      if (heldCwd === id || !CwdGate.overlaps(id, heldCwd)) continue
      for (const [ownerId, heldMode] of owners) {
        if (excludeOwnerId !== undefined && ownerId === excludeOwnerId) continue
        if (mode === 'exclusive' || heldMode === 'exclusive') {
          return { ownerId, cwd: heldCwd, mode: heldMode }
        }
      }
    }
    return undefined
  }

  /**
   * Reserve `cwd` for `key` in `'shared'` or `'exclusive'` mode.
   * Same-owner claims are re-entrant (upgrades to `'exclusive'` still check
   * other overlapping owners). Different owners share overlapping folders only
   * when both claims are `'shared'`.
   */
  claim(cwd: string, key: string, mode: CwdClaimMode = 'shared'): boolean {
    if (!cwd) return true
    return this.claimResolved(CwdGate.key(cwd), key, mode)
  }

  claimResolved(id: string, key: string, mode: CwdClaimMode = 'shared'): boolean {
    if (!id) return true
    for (const [heldCwd, owners] of this.holders) {
      for (const [holder, heldMode] of owners) {
        if (CwdGate.conflicts(id, mode, key, heldCwd, heldMode, holder)) return false
      }
    }
    let owners = this.holders.get(id)
    if (!owners) {
      owners = new Map<string, CwdClaimMode>()
      this.holders.set(id, owners)
    }
    const existing = owners.get(key)
    const nextMode: CwdClaimMode = existing === 'exclusive' || mode === 'exclusive' ? 'exclusive' : 'shared'
    owners.set(key, nextMode)
    return true
  }

  modeFor(id: string, key: string): CwdClaimMode | undefined {
    return this.holders.get(id)?.get(key)
  }

  setKeyMode(id: string, key: string, mode: CwdClaimMode): void {
    const owners = this.holders.get(id)
    if (owners?.has(key)) owners.set(key, mode)
  }

  entriesFor(key: string): Array<{ cwd: string; mode: CwdClaimMode }> {
    const entries: Array<{ cwd: string; mode: CwdClaimMode }> = []
    for (const [cwd, owners] of this.holders) {
      const mode = owners.get(key)
      if (mode) entries.push({ cwd, mode })
    }
    return entries
  }

  release(cwd: string, key: string): void {
    if (!cwd) return
    const id = CwdGate.key(cwd)
    this.releaseKey(id, key)
  }

  releaseKey(id: string, key: string): void {
    const owners = this.holders.get(id)
    if (!owners) return
    owners.delete(key)
    if (owners.size === 0) this.holders.delete(id)
  }

  contains(root: string, cwd: string): boolean {
    if (!root || !cwd) return false
    const relative = path.relative(CwdGate.key(root), CwdGate.key(cwd))
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  holds(key: string): boolean {
    for (const owners of this.holders.values()) {
      if (owners.has(key)) return true
    }
    return false
  }

  keysFor(key: string): string[] {
    const keys: string[] = []
    for (const [cwd, owners] of this.holders) {
      if (owners.has(key)) keys.push(cwd)
    }
    return keys
  }

  releaseOwner(key: string): void {
    for (const [cwd, owners] of this.holders) {
      if (!owners.delete(key)) continue
      if (owners.size === 0) this.holders.delete(cwd)
    }
  }

  retarget(from: string, to: string): void {
    if (from === to) return
    for (const owners of this.holders.values()) {
      const mode = owners.get(from)
      if (!mode) continue
      owners.delete(from)
      const existing = owners.get(to)
      owners.set(to, existing === 'exclusive' || mode === 'exclusive' ? 'exclusive' : 'shared')
    }
  }
}

/**
 * Cross-process counterpart to CwdGate. The registry lock makes the check and
 * reservation atomic; a live desktop PID keeps its lease until it releases it.
 * Dead-process records are pruned on the next claim, so a crash cannot strand
 * a project indefinitely.
 */
export class InterprocessCwdGate {
  private readonly root: string
  private readonly stateFile: string
  private readonly held = new Map<string, { ownerId: string; cwd: string; mode: CwdClaimMode }>()
  private readonly releasingIds = new Set<string>()
  private readonly externalConflict = new Map<
    string,
    Partial<Record<CwdClaimMode, { pid: number; cwd: string; mode: CwdClaimMode }>>
  >()
  private stateQueue: Promise<void> = Promise.resolve()
  private dirEnsured = false

  constructor(root: string) {
    this.root = path.resolve(root)
    this.stateFile = path.join(this.root, 'leases.json')
  }

  private ensureRoot(): void {
    if (this.dirEnsured) return
    mkdirSync(this.root, { recursive: true })
    this.dirEnsured = true
  }

  externalHolder(cwd: string, mode?: CwdClaimMode): { pid: number; cwd: string; mode: CwdClaimMode } | undefined {
    if (!cwd) return undefined
    return this.externalHolderResolved(CwdGate.key(cwd), mode)
  }

  externalHolderResolved(
    key: string,
    mode?: CwdClaimMode
  ): { pid: number; cwd: string; mode: CwdClaimMode } | undefined {
    if (!key) return undefined
    const entry = this.externalConflict.get(key)
    if (!entry) return undefined
    if (mode) return entry[mode]
    return entry.shared ?? entry.exclusive
  }

  private setExternalConflict(
    key: string,
    mode: CwdClaimMode,
    conflict: { pid: number; cwd: string; mode: CwdClaimMode }
  ): void {
    const entry = this.externalConflict.get(key) ?? {}
    entry[mode] = conflict
    this.externalConflict.set(key, entry)
  }

  private clearExternalConflict(key: string, mode: CwdClaimMode): void {
    if (mode === 'exclusive') {
      this.externalConflict.delete(key)
      return
    }
    const entry = this.externalConflict.get(key)
    if (!entry) return
    delete entry.shared
    if (!entry.exclusive) this.externalConflict.delete(key)
  }

  private findReusableLease(
    key: string,
    ownerId: string
  ): [string, { ownerId: string; cwd: string; mode: CwdClaimMode }] | undefined {
    for (const entry of this.held.entries()) {
      const [id, lease] = entry
      if (this.releasingIds.has(id)) continue
      if (lease.ownerId === ownerId && lease.cwd === key) return entry
    }
    return undefined
  }

  private acquireUnderLock(key: string, ownerId: string, mode: CwdClaimMode): boolean {
    const existingEntry = this.findReusableLease(key, ownerId)
    const records = this.readRecords()
    const active = records.filter((record) =>
      record.pid === process.pid
        ? record.processInstanceId === PROCESS_INSTANCE_ID
        : processIsAlive(record.pid)
    )
    const isOwnLease = (record: CwdLeaseRecord): boolean => {
      if (record.pid !== process.pid || record.processInstanceId !== PROCESS_INSTANCE_ID) return false
      return this.held.get(record.id)?.ownerId === ownerId
    }
    const overlapping = active.find((record) => {
      if (isOwnLease(record)) return false
      if (!CwdGate.overlaps(key, record.cwd)) return false
      return mode === 'exclusive' || record.mode !== 'shared'
    })
    if (overlapping) {
      if (active.length !== records.length) this.writeRecords(active)
      this.setExternalConflict(key, mode, {
        pid: overlapping.pid,
        cwd: overlapping.cwd,
        mode: overlapping.mode ?? 'exclusive'
      })
      return false
    }

    if (existingEntry) {
      const [existingId, existingLease] = existingEntry
      const upgraded = active.some((record) => record.id === existingId)
      const nextRecords = upgraded
        ? active.map((record) => (record.id === existingId ? { ...record, mode } : record))
        : [...active, { id: existingId, pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, cwd: key, mode }]
      this.writeRecords(nextRecords)
      existingLease.mode = mode
    } else {
      const lease: CwdLeaseRecord = {
        id: randomUUID(),
        pid: process.pid,
        processInstanceId: PROCESS_INSTANCE_ID,
        cwd: key,
        mode
      }
      this.writeRecords([...active, lease])
      this.held.set(lease.id, { ownerId, cwd: key, mode })
    }
    this.clearExternalConflict(key, mode)
    return true
  }

  acquire(cwd: string, ownerId = CwdGate.key(cwd), mode: CwdClaimMode = 'shared'): boolean {
    if (!cwd) return true
    return this.acquireResolved(CwdGate.key(cwd), ownerId, mode)
  }

  acquireResolved(key: string, ownerId: string, mode: CwdClaimMode = 'shared'): boolean {
    return this.tryAcquireResolvedSync(key, ownerId, mode) === 'acquired'
  }

  tryAcquireResolvedSync(
    key: string,
    ownerId: string,
    mode: CwdClaimMode = 'shared'
  ): InterprocessAcquireResult {
    if (!key) return 'acquired'
    const existingEntry = this.findReusableLease(key, ownerId)
    if (existingEntry && (existingEntry[1].mode === 'exclusive' || mode === 'shared')) {
      this.clearExternalConflict(key, mode)
      return 'acquired'
    }
    try {
      return this.withStateLockSync(() => this.acquireUnderLock(key, ownerId, mode)) ? 'acquired' : 'conflict'
    } catch (error) {
      if (errorCode(error) === 'ELOCKED') return 'lock_busy'
      throw error
    }
  }

  async acquireAsync(cwd: string, ownerId = CwdGate.key(cwd), mode: CwdClaimMode = 'shared'): Promise<boolean> {
    if (!cwd) return true
    return this.acquireResolvedAsync(CwdGate.key(cwd), ownerId, mode)
  }

  async acquireResolvedAsync(key: string, ownerId: string, mode: CwdClaimMode = 'shared'): Promise<boolean> {
    if (!key) return true
    const existingEntry = this.findReusableLease(key, ownerId)
    if (existingEntry && (existingEntry[1].mode === 'exclusive' || mode === 'shared')) {
      this.clearExternalConflict(key, mode)
      return true
    }
    try {
      return await this.withStateLock(() => this.acquireUnderLock(key, ownerId, mode))
    } catch (error) {
      if (errorCode(error) === 'ELOCKED') return false
      throw error
    }
  }

  async release(cwd: string, ownerId?: string): Promise<void> {
    if (!cwd) return
    const key = CwdGate.key(cwd)
    const ids = [...this.held.entries()]
      .filter(([, lease]) => lease.cwd === key && (ownerId === undefined || lease.ownerId === ownerId))
      .map(([id]) => id)
    await this.releaseIds(ids)
  }

  async releaseOwner(ownerId: string): Promise<void> {
    const ids = [...this.held.entries()]
      .filter(([, lease]) => lease.ownerId === ownerId)
      .map(([id]) => id)
    await this.releaseIds(ids)
  }

  retargetOwner(from: string, to: string): void {
    for (const lease of this.held.values()) {
      if (lease.ownerId === from) lease.ownerId = to
    }
  }

  private async releaseIds(ids: string[]): Promise<void> {
    if (!ids.length) return
    const releasing = new Set(ids)
    for (const id of ids) this.releasingIds.add(id)
    let releasedOnDisk = false
    try {
      await this.withStateLock(() => {
        const records = this.readRecords()
        const next = records.filter((record) => !releasing.has(record.id))
        if (next.length !== records.length) this.writeRecords(next)
        releasedOnDisk = true
      })
    } finally {
      for (const id of ids) {
        this.releasingIds.delete(id)
        if (releasedOnDisk) this.held.delete(id)
      }
    }
  }

  private withStateLock<T>(action: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      this.ensureRoot()
      let release: (() => Promise<void>) | undefined
      try {
        release = await properLockfile.lock(this.stateFile, {
          realpath: false,
          retries: { retries: 20, minTimeout: 10, maxTimeout: 100 }
        })
      } catch (error) {
        if (errorCode(error) === 'ENOENT') {
          this.dirEnsured = false
          this.ensureRoot()
          release = await properLockfile.lock(this.stateFile, {
            realpath: false,
            retries: { retries: 20, minTimeout: 10, maxTimeout: 100 }
          })
        } else {
          throw error
        }
      }
      try {
        return action()
      } finally {
        await release()
      }
    }
    const queued = this.stateQueue.then(run, run)
    this.stateQueue = queued.then(
      () => undefined,
      () => undefined
    )
    return queued
  }

  private withStateLockSync<T>(action: () => T): T {
    this.ensureRoot()
    let release: () => void
    try {
      release = properLockfile.lockSync(this.stateFile, { realpath: false, retries: 0 })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        this.dirEnsured = false
        this.ensureRoot()
        release = properLockfile.lockSync(this.stateFile, { realpath: false, retries: 0 })
      } else {
        throw error
      }
    }
    try {
      return action()
    } finally {
      release()
    }
  }

  private quarantineCorruptStateFile(reason: string): void {
    const backup = `${this.stateFile}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`
    try {
      renameSync(this.stateFile, backup)
    } catch {
      try {
        rmSync(this.stateFile, { force: true })
      } catch {
        /* ignore */
      }
    }
    console.error(`[pi-desktop] quarantined corrupt cwd-gate lease registry (${reason})`)
  }

  private readRecords(): CwdLeaseRecord[] {
    if (!existsSync(this.stateFile)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      this.quarantineCorruptStateFile('invalid JSON')
      return []
    }
    if (!parsed || typeof parsed !== 'object') {
      this.quarantineCorruptStateFile('non-object payload')
      return []
    }
    const file = parsed as Partial<CwdLeaseFile>
    if (file.version !== 1 || !Array.isArray(file.leases)) {
      this.quarantineCorruptStateFile('unsupported schema')
      return []
    }
    const records: CwdLeaseRecord[] = []
    for (const raw of file.leases) {
      if (
        !raw || typeof raw !== 'object' ||
        typeof raw.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.id) ||
        !Number.isSafeInteger(raw.pid) || raw.pid <= 0 ||
        (raw.processInstanceId !== undefined &&
          (typeof raw.processInstanceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.processInstanceId))) ||
        typeof raw.cwd !== 'string' || !raw.cwd ||
        (raw.mode !== undefined && raw.mode !== 'shared' && raw.mode !== 'exclusive')
      ) {
        this.quarantineCorruptStateFile('malformed lease entry')
        return []
      }
      records.push({
        id: raw.id,
        pid: raw.pid,
        ...(typeof raw.processInstanceId === 'string' ? { processInstanceId: raw.processInstanceId } : {}),
        cwd: raw.cwd,
        ...(raw.mode !== undefined ? { mode: raw.mode } : {})
      })
    }
    return records
  }

  private writeRecords(leases: CwdLeaseRecord[]): void {
    mkdirSync(this.root, { recursive: true })
    const temp = `${this.stateFile}.${randomUUID()}.tmp`
    try {
      writeFileSync(temp, JSON.stringify({ version: 1, leases } satisfies CwdLeaseFile), {
        encoding: 'utf8',
        mode: 0o600
      })
      renameSync(temp, this.stateFile)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

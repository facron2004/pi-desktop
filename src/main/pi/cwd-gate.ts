import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { properLockfile } from '../proper-lockfile'
import { canonicalPath } from './session-file'

interface CwdLeaseRecord {
  id: string
  pid: number
  processInstanceId?: string
  cwd: string
}

const PROCESS_INSTANCE_ID = randomUUID()

interface CwdLeaseFile {
  version: 1
  leases: CwdLeaseRecord[]
}

/**
 * One writing turn per overlapping working-directory tree. A parent folder
 * and a nested folder share files, while sibling folders remain independent.
 *
 * Viewing another conversation does not take the gate. A prompt or a bash
 * command does. The second session waits; it does not abort the holder.
 */
export class CwdGate {
  private holders = new Map<string, string>()

  static overlaps(left: string, right: string): boolean {
    const inside = (relative: string) =>
      relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    return inside(path.relative(left, right)) || inside(path.relative(right, left))
  }

  static key(cwd: string): string {
    return canonicalPath(cwd)
  }

  holder(cwd: string): string | undefined {
    if (!cwd) return undefined
    const id = CwdGate.key(cwd)
    const exact = this.holders.get(id)
    if (exact) return exact
    for (const [heldCwd, holder] of this.holders) {
      if (CwdGate.overlaps(id, heldCwd)) return holder
    }
    return undefined
  }

  /**
   * Reserve `cwd` for `key`.
   * The holder may reserve it again. A different key may not.
   */
  claim(cwd: string, key: string): boolean {
    if (!cwd) return true
    const id = CwdGate.key(cwd)
    for (const [heldCwd, holder] of this.holders) {
      if (CwdGate.overlaps(id, heldCwd) && (heldCwd !== id || holder !== key)) return false
    }
    this.holders.set(id, key)
    return true
  }

  release(cwd: string, key: string): void {
    if (!cwd) return
    const id = CwdGate.key(cwd)
    this.releaseKey(id, key)
  }

  releaseKey(id: string, key: string): void {
    if (this.holders.get(id) === key) this.holders.delete(id)
  }

  contains(root: string, cwd: string): boolean {
    if (!root || !cwd) return false
    const relative = path.relative(CwdGate.key(root), CwdGate.key(cwd))
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  }

  holds(key: string): boolean {
    for (const holder of this.holders.values()) {
      if (holder === key) return true
    }
    return false
  }

  keysFor(key: string): string[] {
    return [...this.holders.entries()]
      .filter(([, holder]) => holder === key)
      .map(([cwd]) => cwd)
  }

  releaseOwner(key: string): void {
    for (const [cwd, holder] of this.holders) {
      if (holder === key) this.holders.delete(cwd)
    }
  }

  retarget(from: string, to: string): void {
    for (const [cwd, holder] of this.holders) {
      if (holder === from) this.holders.set(cwd, to)
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
  private readonly held = new Map<string, { ownerId: string; cwd: string }>()

  constructor(root: string) {
    this.root = path.resolve(root)
    this.stateFile = path.join(this.root, 'leases.json')
  }

  acquire(cwd: string, ownerId = CwdGate.key(cwd)): boolean {
    if (!cwd) return true
    const key = CwdGate.key(cwd)
    if ([...this.held.values()].some((lease) => lease.ownerId === ownerId && lease.cwd === key)) return true
    try {
      return this.withStateLockSync(() => {
        const records = this.readRecords()
        const active = records.filter((record) =>
          record.pid === process.pid
            ? record.processInstanceId === PROCESS_INSTANCE_ID
            : processIsAlive(record.pid)
        )
        if (active.length !== records.length) this.writeRecords(active)
        if (active.some((record) => CwdGate.overlaps(key, record.cwd))) return false

        const lease = { id: randomUUID(), pid: process.pid, processInstanceId: PROCESS_INSTANCE_ID, cwd: key }
        this.writeRecords([...active, lease])
        this.held.set(lease.id, { ownerId, cwd: key })
        return true
      })
    } catch (error) {
      if (errorCode(error) === 'ELOCKED') return false
      throw error
    }
  }

  async release(cwd: string): Promise<void> {
    if (!cwd) return
    const key = CwdGate.key(cwd)
    const ids = [...this.held.entries()]
      .filter(([, lease]) => lease.cwd === key)
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
    await this.withStateLock(() => {
      const records = this.readRecords()
      const next = records.filter((record) => !releasing.has(record.id))
      if (next.length !== records.length) this.writeRecords(next)
    })
    for (const id of ids) this.held.delete(id)
  }

  private async withStateLock<T>(action: () => T): Promise<T> {
    mkdirSync(this.root, { recursive: true })
    const release = await properLockfile.lock(this.stateFile, {
      realpath: false,
      retries: { retries: 20, minTimeout: 10, maxTimeout: 100 }
    })
    try {
      return action()
    } finally {
      await release()
    }
  }

  private withStateLockSync<T>(action: () => T): T {
    mkdirSync(this.root, { recursive: true })
    const release = properLockfile.lockSync(this.stateFile, { realpath: false, retries: 0 })
    try {
      return action()
    } finally {
      release()
    }
  }

  private readRecords(): CwdLeaseRecord[] {
    if (!existsSync(this.stateFile)) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      throw new Error('The project activity lock registry could not be read.')
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('The project activity lock registry is invalid.')
    }
    const file = parsed as Partial<CwdLeaseFile>
    if (file.version !== 1 || !Array.isArray(file.leases)) {
      throw new Error('The project activity lock registry is invalid.')
    }
    const records: CwdLeaseRecord[] = []
    for (const raw of file.leases) {
      if (
        !raw || typeof raw !== 'object' ||
        typeof raw.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.id) ||
        !Number.isSafeInteger(raw.pid) || raw.pid <= 0 ||
        (raw.processInstanceId !== undefined &&
          (typeof raw.processInstanceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(raw.processInstanceId))) ||
        typeof raw.cwd !== 'string' || !raw.cwd
      ) {
        throw new Error('The project activity lock registry is invalid.')
      }
      records.push({
        id: raw.id,
        pid: raw.pid,
        ...(typeof raw.processInstanceId === 'string' ? { processInstanceId: raw.processInstanceId } : {}),
        cwd: raw.cwd
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

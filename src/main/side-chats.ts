import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  SIDE_DRAFT_PREFIX,
  isSideSessionKey,
  mintSideDraftKey,
  type RuntimeRekey
} from '@shared/types'
import { canonicalSessionFile } from './pi/session-file'
import type { SessionSupervisor } from './pi/supervisor'
import { properLockfile } from './proper-lockfile'
import { findSideChatFilesForParent, resolveSessionFilePath, resolveSessionRoots } from './sessions'

export interface SideChatBindingEntry {
  /** Canonical or original parent `.jsonl` path. */
  parentSessionKey: string
  /** Pi session header `id` when known. */
  parentSessionId?: string
  cwd: string
  /** Current active Side `.jsonl` path when persisted. */
  activeSideFile?: string
  /** Deduplicated set of all Side `.jsonl` paths ever bound to this parent. */
  sideFiles: string[]
  updatedAt: number
}

export interface SideChatStoreData {
  version: 1
  bindings: Record<string, SideChatBindingEntry>
}

interface PendingSideBinding {
  parentSessionKey: string
  parentSessionId?: string
  cwd: string
  activeSideKey: string
  activeSideFile?: string
  sideFiles: string[]
  updatedAt: number
}

export interface SideChatBindingServiceOptions {
  userData: string
  supervisor?: SessionSupervisor
  getSessionRoots?: () => readonly string[]
}

const MAX_SIDE_CHAT_STORE_BYTES = 16 * 1024 * 1024

class InvalidSideChatStoreError extends Error {}

function parentLookupKey(sessionKey: string): string {
  return sessionKey.startsWith('draft:') ? sessionKey : canonicalSessionFile(sessionKey)
}

function sideLookupKey(sessionKey: string): string {
  return sessionKey.startsWith('draft:') ? sessionKey : canonicalSessionFile(sessionKey)
}

function deduplicateFiles(files: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const file of files) {
    if (typeof file !== 'string' || !file || file.startsWith('draft:')) continue
    const canon = canonicalSessionFile(file)
    if (seen.has(canon)) continue
    seen.add(canon)
    out.push(file)
  }
  return out
}

function parseStoreData(raw: string): SideChatStoreData {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new InvalidSideChatStoreError('The side chat binding file is invalid JSON.')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidSideChatStoreError('The side chat binding file has an invalid root object.')
  }
  const root = parsed as Record<string, unknown>
  if (root.version !== 1 || !root.bindings || typeof root.bindings !== 'object' || Array.isArray(root.bindings)) {
    throw new InvalidSideChatStoreError('The side chat binding file has an unsupported schema version.')
  }
  const bindings: Record<string, SideChatBindingEntry> = {}
  for (const [, rawEntry] of Object.entries(root.bindings as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue
    const entry = rawEntry as Record<string, unknown>
    if (typeof entry.parentSessionKey !== 'string' || !entry.parentSessionKey || entry.parentSessionKey.startsWith('draft:')) {
      continue
    }
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
    const activeSideFile =
      typeof entry.activeSideFile === 'string' && entry.activeSideFile && !entry.activeSideFile.startsWith('draft:')
        ? entry.activeSideFile
        : undefined
    const rawSideFiles = Array.isArray(entry.sideFiles)
      ? entry.sideFiles.filter((item): item is string => typeof item === 'string')
      : []
    const sideFiles = deduplicateFiles(activeSideFile ? [activeSideFile, ...rawSideFiles] : rawSideFiles)
    const updatedAt = typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now()
    const key = canonicalSessionFile(entry.parentSessionKey)
    bindings[key] = {
      parentSessionKey: entry.parentSessionKey,
      ...(typeof entry.parentSessionId === 'string' && entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
      cwd,
      ...(activeSideFile ? { activeSideFile } : {}),
      sideFiles,
      updatedAt
    }
  }
  return { version: 1, bindings }
}

export class SideChatBindingService {
  readonly file: string
  private supervisor?: SessionSupervisor
  private readonly getSessionRoots: () => readonly string[]
  /** In-memory bindings while either parent or side is still an unflushed `draft:…` key. */
  private readonly pendingDraftBindings = new Map<string, PendingSideBinding>()
  /** Lookup `sideLookupKey(sideKey) -> { parentSessionKey, cwd }` surviving live rekeys. */
  private readonly parentBySide = new Map<string, { parentSessionKey: string; cwd: string }>()
  private fileFingerprint?: string
  private cachedStore: SideChatStoreData = { version: 1, bindings: {} }

  constructor(options: SideChatBindingServiceOptions) {
    this.file = path.join(options.userData, 'side-chats.json')
    this.getSessionRoots = options.getSessionRoots ?? (() => resolveSessionRoots())
    this.refreshFromDisk()
    if (options.supervisor) {
      this.attach(options.supervisor)
    }
  }

  attach(supervisor: SessionSupervisor): void {
    if (this.supervisor === supervisor) return
    this.dispose()
    this.supervisor = supervisor
    supervisor.on('rekey', this.handleRekey)
  }

  dispose(): void {
    if (this.supervisor) {
      this.supervisor.off('rekey', this.handleRekey)
      this.supervisor = undefined
    }
  }

  private storeFingerprint(): string {
    try {
      const stats = statSync(this.file, { bigint: true })
      if (!stats.isFile()) throw new InvalidSideChatStoreError('side-chats.json is not a regular file.')
      if (stats.size > BigInt(MAX_SIDE_CHAT_STORE_BYTES)) {
        throw new InvalidSideChatStoreError('side-chats.json exceeds maximum size.')
      }
      return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      throw error
    }
  }

  private withDataLock<T>(action: () => T): T {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const release = properLockfile.lockSync(this.file, { realpath: false, retries: 0 })
    try {
      return action()
    } finally {
      try {
        release()
      } catch {
        /* best-effort lock cleanup */
      }
    }
  }

  private readFromDiskRaw(): SideChatStoreData {
    const fp = this.storeFingerprint()
    if (fp === 'missing') {
      this.fileFingerprint = 'missing'
      return { version: 1, bindings: {} }
    }
    const parsed = parseStoreData(readFileSync(this.file, 'utf8'))
    this.fileFingerprint = fp
    return parsed
  }

  private quarantineCorruptFile(reason: string): SideChatStoreData {
    try {
      return this.withDataLock(() => {
        const fp = this.storeFingerprint()
        if (fp === 'missing') {
          this.fileFingerprint = 'missing'
          return { version: 1, bindings: {} }
        }
        try {
          return this.readFromDiskRaw()
        } catch (innerError) {
          if (!(innerError instanceof InvalidSideChatStoreError)) throw innerError
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const target = path.join(path.dirname(this.file), `side-chats.corrupt-${stamp}-${randomUUID()}.json`)
          renameSync(this.file, target)
          this.fileFingerprint = 'missing'
          console.error(`[pi-desktop] side-chats.json could not be read (${reason}) and was moved to ${target}`)
          return { version: 1, bindings: {} }
        }
      })
    } catch (error) {
      console.error('[pi-desktop] could not quarantine corrupt side-chats.json:', error)
      return { version: 1, bindings: {} }
    }
  }

  private refreshFromDisk(): SideChatStoreData {
    try {
      const fp = this.storeFingerprint()
      if (fp === this.fileFingerprint) return this.cachedStore
      const next = this.readFromDiskRaw()
      this.cachedStore = next
      for (const entry of Object.values(next.bindings)) {
        for (const sideFile of entry.sideFiles) {
          this.parentBySide.set(sideLookupKey(sideFile), {
            parentSessionKey: entry.parentSessionKey,
            cwd: entry.cwd
          })
        }
      }
      return next
    } catch (error) {
      if (error instanceof InvalidSideChatStoreError) {
        const recovered = this.quarantineCorruptFile(error.message)
        this.cachedStore = recovered
        return recovered
      }
      console.error('[pi-desktop] could not read side-chats.json:', error)
      return this.cachedStore
    }
  }

  private writeDataLocked(data: SideChatStoreData): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      const contents = JSON.stringify(data, null, 2)
      if (Buffer.byteLength(contents, 'utf8') > MAX_SIDE_CHAT_STORE_BYTES) {
        throw new Error('Side chat bindings exceed maximum size.')
      }
      writeFileSync(temp, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      try {
        chmodSync(temp, 0o600)
      } catch {
        /* Windows ACLs ignore POSIX mode bits */
      }
      renameSync(temp, this.file)
      this.cachedStore = data
      try {
        this.fileFingerprint = this.storeFingerprint()
      } catch {
        this.fileFingerprint = undefined
      }
    } catch (error) {
      try {
        unlinkSync(temp)
      } catch {
        /* temp file may not exist */
      }
      throw error
    }
  }

  private mutateStore(mutator: (current: SideChatStoreData) => SideChatStoreData | false | void): SideChatStoreData {
    return this.withDataLock(() => {
      let current: SideChatStoreData
      try {
        current = this.readFromDiskRaw()
      } catch (error) {
        if (error instanceof InvalidSideChatStoreError) {
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const target = path.join(path.dirname(this.file), `side-chats.corrupt-${stamp}-${randomUUID()}.json`)
          try {
            renameSync(this.file, target)
          } catch {
            /* ignore if already moved */
          }
          console.error(`[pi-desktop] side-chats.json was corrupt (${error.message}) and moved to ${target}`)
          current = { version: 1, bindings: {} }
        } else {
          throw error
        }
      }
      const cloned: SideChatStoreData = {
        version: 1,
        bindings: { ...current.bindings }
      }
      const maybeNext = mutator(cloned)
      if (maybeNext === false) {
        this.fileFingerprint = undefined
        return current
      }
      const next = maybeNext ?? cloned
      this.writeDataLocked(next)
      return next
    })
  }

  /** Read a snapshot of persisted bindings (for tests and diagnostics). */
  getPersistedBindings(): Record<string, SideChatBindingEntry> {
    const store = this.refreshFromDisk()
    return { ...store.bindings }
  }

  /** Resolve `sideOwnerId -> { parentSessionKey, cwd }` dynamically across live rekeys. */
  parentOfSide(sideKey: string): { parentSessionKey: string; cwd: string } | undefined {
    if (!sideKey) return undefined
    const liveInfo = this.supervisor?.sessionInfo(sideKey)
    if (liveInfo?.role === 'side' && liveInfo.parentKey) {
      return { parentSessionKey: liveInfo.parentKey, cwd: liveInfo.cwd }
    }
    const direct = this.parentBySide.get(sideLookupKey(sideKey))
    if (direct) return direct
    this.refreshFromDisk()
    return this.parentBySide.get(sideLookupKey(sideKey))
  }

  /** Register an explicit `(sideKey, parentSessionKey, cwd)` association before or during runtime boot. */
  noteSideAssociation(sideKey: string, parentSessionKey: string, cwd: string): void {
    if (!sideKey || !parentSessionKey) return
    this.parentBySide.set(sideLookupKey(sideKey), { parentSessionKey, cwd })
    const pKey = parentLookupKey(parentSessionKey)
    const existingPending = this.pendingDraftBindings.get(pKey)
    if (existingPending) {
      existingPending.cwd = cwd || existingPending.cwd
      existingPending.activeSideKey = sideKey
      if (!sideKey.startsWith('draft:')) {
        existingPending.activeSideFile = sideKey
        existingPending.sideFiles = deduplicateFiles([sideKey, ...existingPending.sideFiles])
      }
      existingPending.updatedAt = Date.now()
    } else if (parentSessionKey.startsWith('draft:') || sideKey.startsWith('draft:')) {
      this.pendingDraftBindings.set(pKey, {
        parentSessionKey,
        cwd,
        activeSideKey: sideKey,
        activeSideFile: sideKey.startsWith('draft:') ? undefined : sideKey,
        sideFiles: sideKey.startsWith('draft:') ? [] : [sideKey],
        updatedAt: Date.now()
      })
    }
  }

  /** Resolve or mint the companion Side Chat key for `parentSessionKey`. */
  async resolve(
    parentSessionKey: string,
    cwd: string,
    sessionRoots: readonly string[] = this.getSessionRoots(),
    parentSessionId?: string
  ): Promise<{ parentSessionKey: string; activeSideKey: string; hasPersistedHistory: boolean }> {
    const pKey = parentLookupKey(parentSessionKey)

    // 1. Check in-memory pending binding first
    const pending = this.pendingDraftBindings.get(pKey)
    if (pending) {
      if (pending.activeSideFile) {
        const verified = await resolveSessionFilePath(pending.activeSideFile, sessionRoots)
        if (verified) {
          pending.activeSideKey = verified
          pending.activeSideFile = verified
          this.parentBySide.set(sideLookupKey(verified), { parentSessionKey, cwd })
          return { parentSessionKey, activeSideKey: verified, hasPersistedHistory: true }
        }
        pending.activeSideFile = undefined
      }
      if (pending.activeSideKey.startsWith(SIDE_DRAFT_PREFIX)) {
        pending.cwd = cwd || pending.cwd
        this.parentBySide.set(sideLookupKey(pending.activeSideKey), { parentSessionKey, cwd: pending.cwd })
        return { parentSessionKey, activeSideKey: pending.activeSideKey, hasPersistedHistory: false }
      }
    }

    // 2. Check persisted ledger (`side-chats.json`) if parent is a persisted `.jsonl`
    if (!parentSessionKey.startsWith('draft:')) {
      const store = this.refreshFromDisk()
      const persisted = store.bindings[pKey]
      if (persisted?.activeSideFile) {
        const checkedFile = persisted.activeSideFile
        const verified = await resolveSessionFilePath(checkedFile, sessionRoots)
        if (this.pendingDraftBindings.get(pKey) !== pending) {
          return this.resolve(parentSessionKey, cwd, sessionRoots, parentSessionId)
        }
        if (verified) {
          if (this.refreshFromDisk().bindings[pKey]?.activeSideFile !== checkedFile) {
            return this.resolve(parentSessionKey, cwd, sessionRoots, parentSessionId)
          }
          this.parentBySide.set(sideLookupKey(verified), { parentSessionKey, cwd: cwd || persisted.cwd })
          return { parentSessionKey, activeSideKey: verified, hasPersistedHistory: true }
        }
        // Prune only if the checked file is still active under the write lock.
        const latest = this.mutateStore((draft) => {
          const entry = draft.bindings[pKey]
          if (entry?.activeSideFile !== checkedFile) return false
          const remaining = entry.sideFiles.filter(
            (f) => canonicalSessionFile(f) !== canonicalSessionFile(checkedFile)
          )
          if (remaining.length === 0) {
            delete draft.bindings[pKey]
          } else {
            draft.bindings[pKey] = {
              ...entry,
              activeSideFile: undefined,
              sideFiles: remaining,
              updatedAt: Date.now()
            }
          }
        })
        if (latest.bindings[pKey]?.activeSideFile) {
          return this.resolve(parentSessionKey, cwd, sessionRoots, parentSessionId)
        }
      } else if (!persisted) {
        // 3. Self-healing fallback: scan `_side-chats/<workspaceDir>` for `pi-desktop-side-chat` custom entries
        const recoveredFiles = await findSideChatFilesForParent(
          parentSessionKey,
          cwd,
          sessionRoots,
          parentSessionId
        )
        if (this.pendingDraftBindings.get(pKey) !== pending || this.refreshFromDisk().bindings[pKey]) {
          return this.resolve(parentSessionKey, cwd, sessionRoots, parentSessionId)
        }
        if (recoveredFiles.length > 0) {
          const activeSideFile = recoveredFiles[0]!
          const recovered: SideChatBindingEntry = {
            parentSessionKey,
            ...(parentSessionId ? { parentSessionId } : {}),
            cwd,
            activeSideFile,
            sideFiles: deduplicateFiles(recoveredFiles),
            updatedAt: Date.now()
          }
          const latest = this.mutateStore((draft) => {
            if (draft.bindings[pKey]) return false
            draft.bindings[pKey] = recovered
          })
          if (latest.bindings[pKey] !== recovered) {
            return this.resolve(parentSessionKey, cwd, sessionRoots, parentSessionId)
          }
          for (const sideFile of recoveredFiles) {
            this.parentBySide.set(sideLookupKey(sideFile), { parentSessionKey, cwd })
          }
          return { parentSessionKey, activeSideKey: activeSideFile, hasPersistedHistory: true }
        }
      }
    }

    // 4. Mint a fresh in-memory `draft:side:<uuid>` without writing anything to disk
    const draftKey = mintSideDraftKey()
    this.pendingDraftBindings.set(pKey, {
      parentSessionKey,
      ...(parentSessionId ? { parentSessionId } : {}),
      cwd,
      activeSideKey: draftKey,
      sideFiles: [],
      updatedAt: Date.now()
    })
    this.parentBySide.set(sideLookupKey(draftKey), { parentSessionKey, cwd })
    return { parentSessionKey, activeSideKey: draftKey, hasPersistedHistory: false }
  }

  readonly handleRekey = (change: RuntimeRekey): void => {
    const { from, to, replace } = change
    if (!from || !to || from === to) return

    // Case 1: A Side Chat runtime rekeyed (`draft:side:<s> -> <side>.jsonl` or startup replace)
    if (isSideSessionKey(from) || isSideSessionKey(to)) {
      const fromSideKey = sideLookupKey(from)
      const toSideKey = sideLookupKey(to)
      const knownAssoc = this.parentBySide.get(fromSideKey)
      const supInfo = this.supervisor?.sessionInfo(to) ?? this.supervisor?.sessionInfo(from)
      const parentSessionKey =
        (supInfo?.role === 'side' ? supInfo.parentKey : undefined) ?? knownAssoc?.parentSessionKey
      const cwd = supInfo?.cwd ?? knownAssoc?.cwd ?? ''

      this.parentBySide.delete(fromSideKey)
      if (!parentSessionKey) return
      this.parentBySide.set(toSideKey, { parentSessionKey, cwd })

      const pKey = parentLookupKey(parentSessionKey)
      const pending = this.pendingDraftBindings.get(pKey)
      if (parentSessionKey.startsWith('draft:')) {
        const updatedSideFiles = deduplicateFiles([to, ...(pending?.sideFiles ?? [])])
        this.pendingDraftBindings.set(pKey, {
          parentSessionKey,
          parentSessionId: pending?.parentSessionId,
          cwd: cwd || pending?.cwd || '',
          activeSideKey: to,
          activeSideFile: to.startsWith('draft:') ? undefined : to,
          sideFiles: updatedSideFiles,
          updatedAt: Date.now()
        })
        return
      }

      // Parent is already a persisted `.jsonl` -> persist binding to `side-chats.json`
      if (pending) this.pendingDraftBindings.delete(pKey)
      if (!to.startsWith('draft:')) {
        try {
          this.mutateStore((draft) => {
            const existing = draft.bindings[pKey]
            const mergedFiles = deduplicateFiles([
              to,
              ...(pending?.sideFiles ?? []),
              ...(existing?.sideFiles ?? [])
            ])
            draft.bindings[pKey] = {
              parentSessionKey: existing?.parentSessionKey ?? parentSessionKey,
              ...(existing?.parentSessionId ?? pending?.parentSessionId
                ? { parentSessionId: existing?.parentSessionId ?? pending?.parentSessionId }
                : {}),
              cwd: cwd || existing?.cwd || pending?.cwd || '',
              activeSideFile: to,
              sideFiles: mergedFiles,
              updatedAt: Date.now()
            }
          })
        } catch (error) {
          console.error('[pi-desktop] could not persist side chat binding on side rekey:', error)
        }
      }
      return
    }

    // Case 2: A Main runtime rekeyed
    const fromParentKey = parentLookupKey(from)
    const toParentKey = parentLookupKey(to)
    if (fromParentKey === toParentKey) return

    const isDraftPromotion = from.startsWith('draft:') && !to.startsWith('draft:')
    const isStartupReplace = replace === true && !from.startsWith('draft:') && !to.startsWith('draft:')

    if (!isDraftPromotion && !isStartupReplace) {
      // `fork` or `clone`: `<oldMain>.jsonl` keeps its existing Side Chat binding,
      // and `<newMain>.jsonl` starts with a clean unbound Side Chat slot!
      this.pendingDraftBindings.delete(toParentKey)
      return
    }

    const pending = this.pendingDraftBindings.get(fromParentKey)
    if (pending) {
      this.pendingDraftBindings.delete(fromParentKey)
    }

    // Update `parentBySide` references pointing at `from`
    for (const [sKey, assoc] of this.parentBySide) {
      if (parentLookupKey(assoc.parentSessionKey) === fromParentKey) {
        this.parentBySide.set(sKey, { parentSessionKey: to, cwd: assoc.cwd })
      }
    }

    if (isStartupReplace) {
      try {
        this.mutateStore((draft) => {
          const oldEntry = draft.bindings[fromParentKey]
          const existingNew = draft.bindings[toParentKey]
          if (!oldEntry && !pending?.activeSideFile && !(pending?.sideFiles.length)) return
          delete draft.bindings[fromParentKey]
          const activeSideFile = pending?.activeSideFile ?? oldEntry?.activeSideFile ?? existingNew?.activeSideFile
          const sideFiles = deduplicateFiles([
            ...(activeSideFile ? [activeSideFile] : []),
            ...(pending?.sideFiles ?? []),
            ...(oldEntry?.sideFiles ?? []),
            ...(existingNew?.sideFiles ?? [])
          ])
          draft.bindings[toParentKey] = {
            parentSessionKey: to,
            ...(oldEntry?.parentSessionId ?? pending?.parentSessionId
              ? { parentSessionId: oldEntry?.parentSessionId ?? pending?.parentSessionId }
              : {}),
            cwd: pending?.cwd || oldEntry?.cwd || existingNew?.cwd || '',
            ...(activeSideFile ? { activeSideFile } : {}),
            sideFiles,
            updatedAt: Date.now()
          }
          for (const sideFile of sideFiles) {
            this.parentBySide.set(sideLookupKey(sideFile), {
              parentSessionKey: to,
              cwd: draft.bindings[toParentKey]!.cwd
            })
          }
        })
      } catch (error) {
        console.error('[pi-desktop] could not migrate side chat binding on startup replace:', error)
      }
      if (pending && pending.activeSideKey.startsWith(SIDE_DRAFT_PREFIX)) {
        this.pendingDraftBindings.set(toParentKey, {
          ...pending,
          parentSessionKey: to,
          updatedAt: Date.now()
        })
      }
      return
    }

    // Draft Main promoted (`draft:<m> -> <main>.jsonl`)
    if (!pending) return
    if (pending.activeSideFile || pending.sideFiles.length > 0) {
      try {
        this.mutateStore((draft) => {
          const existing = draft.bindings[toParentKey]
          const activeSideFile = pending.activeSideFile ?? existing?.activeSideFile
          const sideFiles = deduplicateFiles([
            ...(activeSideFile ? [activeSideFile] : []),
            ...pending.sideFiles,
            ...(existing?.sideFiles ?? [])
          ])
          draft.bindings[toParentKey] = {
            parentSessionKey: to,
            ...(pending.parentSessionId ?? existing?.parentSessionId
              ? { parentSessionId: pending.parentSessionId ?? existing?.parentSessionId }
              : {}),
            cwd: pending.cwd || existing?.cwd || '',
            ...(activeSideFile ? { activeSideFile } : {}),
            sideFiles,
            updatedAt: Date.now()
          }
        })
      } catch (error) {
        console.error('[pi-desktop] could not promote draft side chat binding:', error)
      }
    } else {
      // Side is still a `draft:side:<s>` -> keep in-memory under promoted `<main>.jsonl` key
      this.pendingDraftBindings.set(toParentKey, {
        ...pending,
        parentSessionKey: to,
        updatedAt: Date.now()
      })
    }
  }

  /** Stop any warm or running Side Chat runtime bound to `parentSessionKey` without deleting files. */
  async stopForParent(parentSessionKey: string): Promise<void> {
    if (!parentSessionKey || !this.supervisor) return
    const pKey = parentLookupKey(parentSessionKey)
    const keysToStop = new Set<string>(this.supervisor.sideKeysForParent(parentSessionKey))
    const pending = this.pendingDraftBindings.get(pKey)
    if (pending) {
      keysToStop.add(pending.activeSideKey)
      if (pending.activeSideFile) keysToStop.add(pending.activeSideFile)
    }
    if (!parentSessionKey.startsWith('draft:')) {
      const store = this.refreshFromDisk()
      const entry = store.bindings[pKey]
      if (entry?.activeSideFile) keysToStop.add(entry.activeSideFile)
    }
    await Promise.all(
      [...keysToStop]
        .filter((k) => this.supervisor?.has(k))
        .map((k) => this.supervisor!.stop(k).catch(() => {}))
    )
  }

  /**
   * Reset the active Side Chat for `parentSessionKey`: stop its runtime,
   * permanently delete the active Side `.jsonl`, and mint a fresh `draft:side:…` key.
   */
  async clear(
    parentSessionKey: string,
    cwd: string,
    remover: (file: string, sessionRoots: readonly string[]) => Promise<boolean>,
    sessionRoots: readonly string[] = this.getSessionRoots()
  ): Promise<{ parentSessionKey: string; activeSideKey: string; hasPersistedHistory: boolean }> {
    const pKey = parentLookupKey(parentSessionKey)
    const persistedParent = !parentSessionKey.startsWith('draft:')
    const pendingBeforeStop = this.pendingDraftBindings.get(pKey)
    const savedBeforeStop = persistedParent ? this.refreshFromDisk().bindings[pKey]?.activeSideFile : undefined
    const runtimeKeys = new Set<string>([
      ...(this.supervisor?.sideKeysForParent(parentSessionKey) ?? []),
      ...(pendingBeforeStop ? [pendingBeforeStop.activeSideKey] : []),
      ...(savedBeforeStop ? [savedBeforeStop] : [])
    ])

    const supervisor = this.supervisor
    if (supervisor) await Promise.all([...runtimeKeys].map((key) => supervisor.stop(key)))

    // A draft can acquire its session file while the runtime is stopping.
    const pending = this.pendingDraftBindings.get(pKey)
    let activeSideFile = savedBeforeStop
    if (pendingBeforeStop) {
      activeSideFile = pending
        ? pending.activeSideFile
        : persistedParent
          ? this.refreshFromDisk().bindings[pKey]?.activeSideFile
          : undefined
    }
    if (activeSideFile && !(await remover(activeSideFile, sessionRoots))) {
      throw new Error('Could not clear the side chat.')
    }

    if (persistedParent && activeSideFile) {
      const deletedFile = canonicalSessionFile(activeSideFile)
      this.mutateStore((draft) => {
        const current = draft.bindings[pKey]
        if (!current) return
        const remaining = current.sideFiles.filter((file) => canonicalSessionFile(file) !== deletedFile)
        if (remaining.length === 0) {
          delete draft.bindings[pKey]
        } else {
          draft.bindings[pKey] = {
            ...current,
            activeSideFile:
              current.activeSideFile && canonicalSessionFile(current.activeSideFile) !== deletedFile
                ? current.activeSideFile
                : undefined,
            sideFiles: remaining,
            updatedAt: Date.now()
          }
        }
      })
    }
    if (activeSideFile) this.parentBySide.delete(sideLookupKey(activeSideFile))
    if (pending) this.parentBySide.delete(sideLookupKey(pending.activeSideKey))

    const freshDraftKey = mintSideDraftKey()
    this.pendingDraftBindings.set(pKey, {
      parentSessionKey,
      cwd,
      activeSideKey: freshDraftKey,
      sideFiles: [],
      updatedAt: Date.now()
    })
    this.parentBySide.set(sideLookupKey(freshDraftKey), { parentSessionKey, cwd })
    return { parentSessionKey, activeSideKey: freshDraftKey, hasPersistedHistory: false }
  }

  /**
   * Atomically remove all Side Chat bindings for a parent session being permanently
   * deleted (`sessions:remove`), returning all Side `.jsonl` files and runtime keys
   * for cascade stop + `removeSessionFile`.
   */
  takeSideFilesForParent(parentSessionKey: string): { sideFiles: string[]; runtimeKeys: string[] } {
    if (!parentSessionKey) return { sideFiles: [], runtimeKeys: [] }
    const pKey = parentLookupKey(parentSessionKey)
    const pending = this.pendingDraftBindings.get(pKey)
    this.pendingDraftBindings.delete(pKey)

    let persistedEntry: SideChatBindingEntry | undefined
    if (!parentSessionKey.startsWith('draft:')) {
      try {
        this.mutateStore((draft) => {
          persistedEntry = draft.bindings[pKey]
          delete draft.bindings[pKey]
        })
      } catch (error) {
        console.error('[pi-desktop] could not remove side chat binding on parent delete:', error)
      }
    }

    const sideFiles = deduplicateFiles([
      ...(pending?.activeSideFile ? [pending.activeSideFile] : []),
      ...(pending?.sideFiles ?? []),
      ...(persistedEntry?.activeSideFile ? [persistedEntry.activeSideFile] : []),
      ...(persistedEntry?.sideFiles ?? [])
    ])
    const runtimeKeys = new Set<string>([
      ...(this.supervisor?.sideKeysForParent(parentSessionKey) ?? []),
      ...(pending ? [pending.activeSideKey] : []),
      ...sideFiles
    ])

    for (const key of runtimeKeys) {
      this.parentBySide.delete(sideLookupKey(key))
    }
    for (const [sKey, assoc] of this.parentBySide) {
      if (parentLookupKey(assoc.parentSessionKey) === pKey) {
        this.parentBySide.delete(sKey)
      }
    }

    return { sideFiles, runtimeKeys: [...runtimeKeys] }
  }
}

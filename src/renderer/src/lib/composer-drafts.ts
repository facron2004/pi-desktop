import type { ImageContent, PiCommand } from '@shared/types'
import type { ComposerDraftFile } from './composer-files'

export interface ComposerDraftImage extends ImageContent {
  id: string
  name: string
  bytes: number
  /** A blob URL is valid only for the renderer process that created it. */
  previewUrl?: string
}

export interface ComposerDraftCommand {
  name: string
  source: PiCommand['source']
}

/** The image generator's controls, kept with the draft that is using them. */
export interface ComposerImageOptions {
  model: string
  size: string
  quality: string
  count: number
}

export interface ComposerDraft {
  text: string
  images: ComposerDraftImage[]
  command?: ComposerDraftCommand
  files?: ComposerDraftFile[]
  pastedRefs?: Record<string, string>
  history?: string[]
  /** Present while the composer is generating images instead of chatting. */
  image?: ComposerImageOptions
}

export interface ComposerDraftSnapshot {
  drafts: Record<string, ComposerDraft>
  /** The new-chat identity to reopen for each project, never an old session. */
  lastDraftKeys: Record<string, string>
}

export function composerDraftAfterSend(
  draft: ComposerDraft,
  text: string,
  image: ComposerImageOptions | undefined
): ComposerDraft {
  return {
    text: '',
    images: [],
    files: [],
    history: [text, ...(draft.history ?? []).filter((entry) => entry !== text)].slice(0, 50),
    image
  }
}

export function composerDraftHasContent(draft: ComposerDraft | undefined): boolean {
  return Boolean(draft && (
    draft.text.trim() || draft.command || draft.images.length > 0 || (draft.files?.length ?? 0) > 0
  ))
}

/** Maximum number of sent-history-only sessions kept in browser storage. */
export const MAX_HISTORY_ONLY_DRAFTS = 40

function isHistoryOnlyDraft(draft: ComposerDraft): boolean {
  return (
    !composerDraftHasContent(draft) &&
    !draft.image &&
    (!draft.pastedRefs || Object.keys(draft.pastedRefs).length === 0)
  )
}

/**
 * Keep every draft that still holds unsent work, and cap sent-history-only
 * entries by insertion recency so localStorage stays bounded over long use.
 */
export function pruneComposerDrafts(
  drafts: Record<string, ComposerDraft>,
  maxHistoryOnly = MAX_HISTORY_ONLY_DRAFTS
): Record<string, ComposerDraft> {
  const entries = Object.entries(drafts)
  let historyOnlyCount = 0
  for (const [, draft] of entries) {
    if (isHistoryOnlyDraft(draft)) historyOnlyCount += 1
  }
  if (historyOnlyCount <= maxHistoryOnly) return drafts

  let toDrop = historyOnlyCount - maxHistoryOnly
  const pruned: Record<string, ComposerDraft> = {}
  for (const [key, draft] of entries) {
    if (toDrop > 0 && isHistoryOnlyDraft(draft)) {
      toDrop -= 1
      continue
    }
    pruned[key] = draft
  }
  return pruned
}

export type DraftSaveResult = 'saved' | 'partial' | 'failed'

export const COMPOSER_DRAFTS_STORAGE_KEY = 'pi-desktop.composer-drafts.v1'

type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>

const EMPTY_SNAPSHOT: ComposerDraftSnapshot = { drafts: {}, lastDraftKeys: {} }
const snapshotCache = new WeakMap<DraftStorage, { raw: string; snapshot: ComposerDraftSnapshot }>()

function browserStorage(): DraftStorage | undefined {
  if (typeof localStorage !== 'undefined') return localStorage
  if (typeof window !== 'undefined') return window.localStorage
  return undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : undefined
}

function persistedDraft(value: unknown): ComposerDraft | undefined {
  const source = record(value)
  if (!source || typeof source.text !== 'string') return undefined
  const images = Array.isArray(source.images)
    ? source.images.flatMap((entry) => {
        const image = record(entry)
        if (
          !image || image.type !== 'image' ||
          typeof image.id !== 'string' || typeof image.name !== 'string' ||
          typeof image.data !== 'string' || typeof image.mimeType !== 'string' ||
          typeof image.bytes !== 'number' || !Number.isFinite(image.bytes)
        ) return []
        return [{
          id: image.id,
          type: 'image' as const,
          name: image.name,
          bytes: Math.max(0, image.bytes),
          data: image.data,
          mimeType: image.mimeType
        }]
      })
    : []
  const files = Array.isArray(source.files)
    ? source.files.flatMap((entry) => {
        const file = record(entry)
        if (!file || typeof file.id !== 'string' || typeof file.path !== 'string' || typeof file.name !== 'string') return []
        return [{ id: file.id, path: file.path, name: file.name }]
      })
    : undefined
  const pastedSource = record(source.pastedRefs)
  const pastedRefs = pastedSource
    ? Object.fromEntries(Object.entries(pastedSource).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined
  const commandSource = record(source.command)
  const command = commandSource && typeof commandSource.name === 'string' && typeof commandSource.source === 'string'
    ? { name: commandSource.name, source: commandSource.source as PiCommand['source'] }
    : undefined
  const imageSource = record(source.image)
  const image = imageSource &&
    typeof imageSource.model === 'string' &&
    typeof imageSource.size === 'string' &&
    typeof imageSource.quality === 'string' &&
    typeof imageSource.count === 'number' && Number.isFinite(imageSource.count)
    ? {
        model: imageSource.model,
        size: imageSource.size,
        quality: imageSource.quality,
        count: Math.min(4, Math.max(1, Math.round(imageSource.count)))
      }
    : undefined
  return {
    text: source.text,
    images,
    ...(command ? { command } : {}),
    ...(files ? { files } : {}),
    ...(pastedRefs ? { pastedRefs } : {}),
    ...(strings(source.history) ? { history: strings(source.history) } : {}),
    ...(image ? { image } : {})
  }
}

/** Read only the versioned shape; malformed entries are ignored, not trusted. */
export function loadComposerDrafts(storage = browserStorage()): ComposerDraftSnapshot {
  if (!storage) return EMPTY_SNAPSHOT
  try {
    const raw = storage.getItem(COMPOSER_DRAFTS_STORAGE_KEY)
    if (!raw) return EMPTY_SNAPSHOT
    const cached = snapshotCache.get(storage)
    if (cached && cached.raw === raw) {
      return {
        drafts: { ...cached.snapshot.drafts },
        lastDraftKeys: { ...cached.snapshot.lastDraftKeys }
      }
    }
    const parsed = record(JSON.parse(raw))
    if (!parsed || parsed.version !== 1) return EMPTY_SNAPSHOT
    const draftSource = record(parsed.drafts) ?? {}
    const drafts: Record<string, ComposerDraft> = {}
    for (const [key, value] of Object.entries(draftSource)) {
      const draft = persistedDraft(value)
      if (key && draft) drafts[key] = draft
    }
    const lastSource = record(parsed.lastDraftKeys) ?? {}
    const lastDraftKeys = Object.fromEntries(
      Object.entries(lastSource).filter((entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].startsWith('draft:')
      )
    )
    const snapshot = { drafts, lastDraftKeys }
    snapshotCache.set(storage, { raw, snapshot })
    return {
      drafts: { ...drafts },
      lastDraftKeys: { ...lastDraftKeys }
    }
  } catch {
    return EMPTY_SNAPSHOT
  }
}

/**
 * Save the whole draft map and each project's new-chat pointer. If image data
 * exceeds the quota, keep already saved attachments that are still present
 * before falling back to text and file references.
 */
export function saveComposerDrafts(
  snapshot: ComposerDraftSnapshot,
  storage = browserStorage()
): DraftSaveResult {
  if (!storage) return 'failed'
  const bounded = pruneComposerDrafts(snapshot.drafts)
  const drafts: Record<string, ComposerDraft> = Object.fromEntries(
    Object.entries(bounded).map(([key, draft]) => [key, {
      ...draft,
      images: draft.images.map(({ previewUrl: _previewUrl, ...image }) => image)
    }])
  )
  const write = (nextDrafts: Record<string, ComposerDraft>): boolean => {
    const serialized = JSON.stringify({
      version: 1,
      drafts: nextDrafts,
      lastDraftKeys: snapshot.lastDraftKeys
    })
    const cached = snapshotCache.get(storage)
    if (cached && cached.raw === serialized) return true
    try {
      storage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, serialized)
      snapshotCache.set(storage, {
        raw: serialized,
        snapshot: { drafts: nextDrafts, lastDraftKeys: { ...snapshot.lastDraftKeys } }
      })
      return true
    } catch {
      return false
    }
  }
  if (write(drafts)) return 'saved'

  const savedImages = new Map<string, ComposerDraftImage>()
  for (const draft of Object.values(loadComposerDrafts(storage).drafts)) {
    for (const image of draft.images) savedImages.set(image.id, image)
  }
  if (savedImages.size > 0) {
    let kept = 0
    let removed = 0
    const partial = Object.fromEntries(Object.entries(drafts).map(([key, draft]) => {
      const images = draft.images.filter(image => {
        const saved = savedImages.get(image.id)
        return saved?.data === image.data && saved?.mimeType === image.mimeType
      })
      kept += images.length
      removed += draft.images.length - images.length
      return [key, { ...draft, images }]
    }))
    if (kept && removed && write(partial)) return 'partial'
  }

  const textOnly = Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [
    key, { ...draft, images: [] }
  ]))
  if (write(textOnly)) return 'partial'

  // Last resort under severe quota pressure: drop sent-prompt histories so
  // unsent text and file references still survive restart.
  const activeTextOnly: Record<string, ComposerDraft> = {}
  for (const [key, draft] of Object.entries(textOnly)) {
    if (isHistoryOnlyDraft(draft)) continue
    const { history: _history, ...withoutHistory } = draft
    activeTextOnly[key] = withoutHistory
  }
  if (write(activeTextOnly)) return 'partial'
  return 'failed'
}

export function forgetLastDraftKey(
  snapshot: ComposerDraftSnapshot,
  draftKey: string
): ComposerDraftSnapshot {
  const lastDraftKeys = Object.fromEntries(
    Object.entries(snapshot.lastDraftKeys).filter(([, key]) => key !== draftKey)
  )
  return { ...snapshot, lastDraftKeys }
}

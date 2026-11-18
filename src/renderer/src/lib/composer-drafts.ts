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

export function composerDraftHasContent(draft: ComposerDraft | undefined): boolean {
  return Boolean(draft && (
    draft.text.trim() || draft.command || draft.images.length > 0 || (draft.files?.length ?? 0) > 0
  ))
}

export type DraftSaveResult = 'saved' | 'text-only' | 'failed'

export const COMPOSER_DRAFTS_STORAGE_KEY = 'pi-desktop.composer-drafts.v1'

type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>

const EMPTY_SNAPSHOT: ComposerDraftSnapshot = { drafts: {}, lastDraftKeys: {} }

function browserStorage(): DraftStorage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
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
    return { drafts, lastDraftKeys }
  } catch {
    return EMPTY_SNAPSHOT
  }
}

function serializableDraft(draft: ComposerDraft, includeImages: boolean): ComposerDraft {
  return {
    ...draft,
    images: includeImages
      ? draft.images.map(({ previewUrl: _previewUrl, ...image }) => image)
      : []
  }
}

/**
 * Save the whole draft map and each project's new-chat pointer. If large image
 * data exceeds the browser quota, retry once without images and report that
 * degradation so the caller can tell the user what a restart will restore.
 */
export function saveComposerDrafts(
  snapshot: ComposerDraftSnapshot,
  storage = browserStorage()
): DraftSaveResult {
  if (!storage) return 'failed'
  const write = (includeImages: boolean): boolean => {
    const drafts = Object.fromEntries(
      Object.entries(snapshot.drafts).map(([key, draft]) => [key, serializableDraft(draft, includeImages)])
    )
    try {
      storage.setItem(COMPOSER_DRAFTS_STORAGE_KEY, JSON.stringify({
        version: 1,
        drafts,
        lastDraftKeys: snapshot.lastDraftKeys
      }))
      return true
    } catch {
      return false
    }
  }
  if (write(true)) return 'saved'
  if (write(false)) return 'text-only'
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

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { ArrowUp, Eye, Loader2, Plus, Square, X } from 'lucide-react'
import {
  MAX_COMPOSER_IMAGE_BYTES,
  MAX_IMAGE_DATA_BYTES,
  MAX_SEARCH_QUERY_LENGTH,
  type FileEntry,
  type SideChatReference
} from '@shared/types'
import {
  useAppStore,
  type ComposerDraft,
  type ComposerDraftFile,
  type ComposerDraftImage
} from '../../store/useAppStore'
import { useSessionViewSlice } from '../../lib/conversation-scope'
import {
  composerFileToken,
  makeComposerFile,
  mergeComposerFiles
} from '../../lib/composer-files'
import { relativePath } from '../../lib/path'
import { useT } from '../../lib/i18n'
import { FileIcon } from '../FileIcon'
import { FileMention } from '../FileMention'
import { ImageButton } from '../Lightbox'
import { ModelPicker } from '../TopBar'
import { UsageBar } from '../UsageBar'
import { SideChatRefChip } from './SideChatRefChip'

interface MentionMatch {
  query: string
  start: number
  cursor: number
}

const EMPTY_IMAGES: ComposerDraftImage[] = []
const EMPTY_FILES: ComposerDraftFile[] = []
const EMPTY_REFS: SideChatReference[] = []

function isFocusInsideSideSurface(): boolean {
  const active = document.activeElement
  return Boolean(active instanceof Element && active.closest('[data-conversation-surface="side"]'))
}

function detectMention(text: string, cursor: number): MentionMatch | null {
  const before = text.slice(0, cursor)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return null
  return { query, start: at, cursor }
}

function makeDraftImage(
  data: string,
  mimeType: string,
  bytes: number,
  name = 'image'
): ComposerDraftImage {
  const id =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  return { id, type: 'image', name, bytes, data, mimeType }
}

function sumImageBytes(images: readonly ComposerDraftImage[]): number {
  let total = 0
  for (const image of images) total += image.bytes
  return total
}

function imageByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding)
}

function readBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : ''
      const comma = value.indexOf(',')
      resolve(comma >= 0 ? value.slice(comma + 1) : null)
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
  })
}

export interface SideChatComposerProps {
  sideSessionKey?: string
}

export const SideChatComposer = memo(function SideChatComposer({
  sideSessionKey
}: SideChatComposerProps) {
  const t = useT()
  const a11yId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const mentionListId = `${a11yId}-side-mentions`
  const slice = useSessionViewSlice(sideSessionKey)
  const draftKey = sideSessionKey ?? slice.sessionKey ?? ''
  const draftKeyRef = useRef(draftKey)
  draftKeyRef.current = draftKey

  const isStreaming = slice.isStreaming
  const aborting = slice.run.phase === 'aborting'
  const canCompose = slice.status.phase === 'ready' || slice.status.phase === 'starting'
  const queue = slice.queue
  const workspace = useAppStore((state) => state.workspace)
  const fontScale = useAppStore((state) => state.settings.fontScale ?? 1)
  const sendShortcut = useAppStore((state) => state.settings.sendShortcut ?? 'enter')
  const plainTextEditor = useAppStore((state) => state.settings.plainTextEditor === true)
  const updateDraft = useAppStore((state) => state.updateDraft)
  const sendSidePrompt = useAppStore((state) => state.sendSidePrompt)
  const stopSideChat = useAppStore((state) => state.stopSideChat)
  const removeSideReference = useAppStore((state) => state.removeSideReference)
  const prewarmRuntime = useAppStore((state) => state.prewarmRuntime)

  const draftEntry = useAppStore(
    useCallback((state) => (draftKey ? state.drafts[draftKey] : undefined), [draftKey])
  )
  const sideRefs = useAppStore(
    useCallback(
      (state) => (draftKey ? (state.sideQuotes?.[draftKey] ?? EMPTY_REFS) : EMPTY_REFS),
      [draftKey]
    )
  )
  const composerInsert = useAppStore(
    useCallback(
      (state) => (draftKey ? state.composerInserts?.[draftKey] : undefined),
      [draftKey]
    )
  )

  const [fallbackDraft, setFallbackDraft] = useState<ComposerDraft>({
    text: '',
    images: EMPTY_IMAGES
  })
  const fallbackDraftRef = useRef(fallbackDraft)
  fallbackDraftRef.current = fallbackDraft

  const draft = draftKey ? draftEntry : fallbackDraft
  const text = draft?.text ?? ''
  const images = draft?.images ?? EMPTY_IMAGES
  const files = draft?.files ?? EMPTY_FILES

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionListRef = useRef<HTMLDivElement>(null)
  const mentionCaret = useRef<number | null>(null)
  const [mention, setMention] = useState<MentionMatch | null>(null)
  const [mentionFiles, setMentionFiles] = useState<FileEntry[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [addingFiles, setAddingFiles] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const patchDraft = useCallback(
    (targetKey: string, updater: (prev: ComposerDraft) => ComposerDraft) => {
      if (targetKey) {
        updateDraft(targetKey, updater)
        return
      }
      setFallbackDraft((prev) => updater(prev))
    },
    [updateDraft]
  )

  const setText = useCallback(
    (next: string | ((current: string) => string), targetKey = draftKeyRef.current) => {
      patchDraft(targetKey, (prev) => ({
        ...prev,
        text: typeof next === 'function' ? next(prev.text) : next
      }))
    },
    [patchDraft]
  )

  const setImages = useCallback(
    (
      updater: (current: ComposerDraftImage[]) => ComposerDraftImage[],
      targetKey = draftKeyRef.current
    ) => {
      patchDraft(targetKey, (prev) => ({
        ...prev,
        images: updater(prev.images ?? EMPTY_IMAGES)
      }))
    },
    [patchDraft]
  )

  const setFiles = useCallback(
    (
      updater: (current: ComposerDraftFile[]) => ComposerDraftFile[],
      targetKey = draftKeyRef.current
    ) => {
      patchDraft(targetKey, (prev) => ({
        ...prev,
        files: updater(prev.files ?? EMPTY_FILES)
      }))
    },
    [patchDraft]
  )

  useEffect(() => {
    setMention(null)
    setMentionIndex(0)
  }, [draftKey])

  // Scoped focus listener: only focuses Side Chat when explicitly targeted.
  useEffect(() => {
    const onFocus = (event: Event) => {
      const target = (event as CustomEvent<{ target?: string } | undefined>).detail?.target
      if (target !== 'side') return
      const node = textareaRef.current
      if (!node) return
      node.focus()
      const end = node.value.length
      node.setSelectionRange(end, end)
    }
    window.addEventListener('pi:focus-composer', onFocus)
    return () => window.removeEventListener('pi:focus-composer', onFocus)
  }, [])

  const insertSeqRef = useRef(0)
  useEffect(() => {
    if (!composerInsert || composerInsert.seq === insertSeqRef.current) return
    insertSeqRef.current = composerInsert.seq
    if (!draftKeyRef.current) {
      const addition = composerInsert.text
      const replace = composerInsert.mode === 'replace'
      setFallbackDraft((prev) => ({
        ...prev,
        text: replace
          ? addition
          : prev.text.trim()
            ? `${prev.text.trimEnd()}\n${addition}`
            : addition
      }))
    }
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const cursor = node.value.length
      node.focus()
      node.setSelectionRange(cursor, cursor)
      node.scrollTop = node.scrollHeight
    })
  }, [composerInsert])

  // Auto-grow textarea up to 160px inside the docked panel.
  useLayoutEffect(() => {
    const node = textareaRef.current
    if (!node) return
    node.style.height = 'auto'
    const nextHeight = Math.min(node.scrollHeight, 160)
    node.style.height = `${nextHeight}px`
    node.style.overflowY = node.scrollHeight > 160 ? 'auto' : 'hidden'
  }, [text, fontScale])

  // Focus-scoped `Escape`: aborts ONLY Side Chat when focus is inside Side Chat.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (event.key !== 'Escape' || !isStreaming) return
      if (!isFocusInsideSideSurface()) return
      if (event.defaultPrevented) return
      event.preventDefault()
      void stopSideChat()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isStreaming, stopSideChat])

  // Project `@file` search using isolated `'side-composer-mention'` scope.
  useEffect(() => {
    if (!mention || !workspace?.path || mention.query.length > MAX_SEARCH_QUERY_LENGTH) {
      setMentionFiles([])
      setMentionIndex(0)
      return
    }
    setMentionFiles([])
    setMentionIndex(0)
    let cancelled = false
    let requestStarted = false
    const timer = window.setTimeout(() => {
      requestStarted = true
      void window.pi.fs
        .search(mention.query, 12, 'side-composer-mention')
        .then((result) => {
          if (cancelled) return
          setMentionFiles(result.entries)
          setMentionIndex(0)
        })
        .catch(() => {
          if (!cancelled) setMentionFiles([])
        })
    }, 110)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (requestStarted) {
        void window.pi.fs.search('', 0, 'side-composer-mention').catch(() => undefined)
      }
    }
  }, [mention, workspace?.path])

  useEffect(() => {
    mentionListRef.current
      ?.querySelector<HTMLElement>(`[data-active='true']`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [mentionIndex, mentionFiles])

  const applyMention = useCallback(
    (addition: string, at?: MentionMatch | null, targetKey = draftKeyRef.current) => {
      const activeAtApply = targetKey === draftKeyRef.current
      setText((current) => {
        const node = activeAtApply ? textareaRef.current : null
        const cursor = node?.selectionStart ?? current.length
        const active = at ?? detectMention(current, cursor)
        const from = active ? active.start : cursor
        const to = active ? active.cursor : cursor
        const gap = active || from === 0 || /\s/.test(current[from - 1]) ? '' : ' '
        if (activeAtApply) mentionCaret.current = from + gap.length + addition.length
        return `${current.slice(0, from)}${gap}${addition}${current.slice(to)}`
      }, targetKey)
      if (!activeAtApply) return
      setMention(null)
      requestAnimationFrame(() => {
        const target = textareaRef.current
        const wanted = mentionCaret.current
        if (!target || wanted === null) return
        mentionCaret.current = null
        const position = Math.min(wanted, target.value.length)
        target.focus()
        target.setSelectionRange(position, position)
      })
    },
    [setText]
  )

  const insertMention = useCallback(
    (file: FileEntry) => {
      const rel = relativePath(workspace?.path ?? '', file.path).replace(/\\/g, '/')
      const formatted = /\s/.test(rel) ? `@"${rel}" ` : `@${rel} `
      applyMention(formatted, mention)
    },
    [applyMention, mention, workspace?.path]
  )

  const addFiles = useCallback(
    async (fileList: FileList | null): Promise<void> => {
      if (!fileList || fileList.length === 0) return
      const targetKey = draftKeyRef.current
      setAddingFiles(true)
      try {
        const items = Array.from(fileList)
        const attachments: ComposerDraftFile[] = []
        let usedBytes = sumImageBytes(
          (targetKey ? useAppStore.getState().drafts[targetKey]?.images : fallbackDraftRef.current.images) ??
            EMPTY_IMAGES
        )
        for (const file of items) {
          if (file.type.startsWith('image/')) {
            if (
              file.size > MAX_IMAGE_DATA_BYTES ||
              usedBytes + file.size > MAX_COMPOSER_IMAGE_BYTES
            ) {
              const filePath = window.pi.fs.pathForFile(file)
              if (filePath) attachments.push(makeComposerFile(filePath))
              continue
            }
            const base64 = await readBase64(file)
            if (base64) {
              usedBytes += file.size
              setImages(
                (current) => [
                  ...current,
                  makeDraftImage(base64, file.type, file.size, file.name || 'image')
                ],
                targetKey
              )
            } else {
              const filePath = window.pi.fs.pathForFile(file)
              if (filePath) attachments.push(makeComposerFile(filePath))
            }
            continue
          }
          const filePath = window.pi.fs.pathForFile(file)
          if (filePath) attachments.push(makeComposerFile(filePath))
        }
        if (attachments.length > 0) {
          setFiles((current) => mergeComposerFiles(current, attachments), targetKey)
        }
      } finally {
        setAddingFiles(false)
      }
    },
    [setFiles, setImages]
  )

  const pickFiles = useCallback(async () => {
    const targetKey = draftKeyRef.current
    setAddingFiles(true)
    try {
      const currentImages =
        (targetKey ? useAppStore.getState().drafts[targetKey]?.images : fallbackDraftRef.current.images) ??
        EMPTY_IMAGES
      const remainingImageBytes = Math.max(
        0,
        MAX_COMPOSER_IMAGE_BYTES - sumImageBytes(currentImages)
      )
      const picked = await window.pi.dialog.pickFiles(
        workspace?.path || slice.status.cwd || undefined,
        remainingImageBytes
      )
      const pickedImages: ComposerDraftImage[] = []
      const pickedFiles: ComposerDraftFile[] = []
      let used = sumImageBytes(currentImages)
      for (const item of picked) {
        if (item.kind === 'path') {
          pickedFiles.push(makeComposerFile(item.path))
          continue
        }
        const byteSize = imageByteLength(item.data)
        if (used + byteSize > MAX_COMPOSER_IMAGE_BYTES) {
          if (item.path) pickedFiles.push(makeComposerFile(item.path))
          continue
        }
        used += byteSize
        pickedImages.push(
          makeDraftImage(
            item.data,
            item.mimeType,
            byteSize,
            item.path ? relativePath(workspace?.path ?? '', item.path) : 'image'
          )
        )
      }
      if (pickedImages.length > 0) {
        setImages((current) => [...current, ...pickedImages], targetKey)
      }
      if (pickedFiles.length > 0) {
        setFiles((current) => mergeComposerFiles(current, pickedFiles), targetKey)
      }
    } catch {
      useAppStore.getState().showToast('Could not add files', 'error')
    } finally {
      setAddingFiles(false)
    }
  }, [setFiles, setImages, slice.status.cwd, workspace?.path])

  const hasContent = Boolean(
    text.trim() || images.length > 0 || files.length > 0 || sideRefs.length > 0
  )

  const submit = useCallback(async () => {
    if (!canCompose || addingFiles || submitting || !hasContent) return
    const targetKey = draftKeyRef.current
    const submittedText = text.trim()
    const fileTokens = files.map(composerFileToken)
    const combinedText = [
      ...fileTokens,
      ...(submittedText
        ? [submittedText]
        : sideRefs.length > 0
          ? [t('Explain this referenced context from the main conversation.')]
          : [])
    ]
      .filter(Boolean)
      .join('\n')

    if (!combinedText && images.length === 0) return

    const imagePayloads = images.map((img) => ({
      data: img.data,
      mimeType: img.mimeType
    }))
    setSubmitting(true)
    setMention(null)
    try {
      const accepted = await sendSidePrompt(combinedText, imagePayloads)
      if (accepted) {
        // Re-read key in case draft:side:<uuid> promoted or initialized during send.
        const activeSideKey = useAppStore.getState().sideSessionKey ?? targetKey
        patchDraft(activeSideKey, (prev) => ({
          ...prev,
          text: prev.text === text ? '' : prev.text,
          images: EMPTY_IMAGES,
          files: EMPTY_FILES
        }))
        if (targetKey && targetKey !== activeSideKey) {
          patchDraft(targetKey, (prev) => ({
            ...prev,
            text: prev.text === text ? '' : prev.text,
            images: EMPTY_IMAGES,
            files: EMPTY_FILES
          }))
        }
      }
    } finally {
      setSubmitting(false)
    }
  }, [
    addingFiles,
    canCompose,
    files,
    hasContent,
    images,
    patchDraft,
    sendSidePrompt,
    sideRefs.length,
    submitting,
    t,
    text
  ])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return

    if (mention && mentionFiles.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((index) => (index + 1) % mentionFiles.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex(
          (index) => (index - 1 + mentionFiles.length) % mentionFiles.length
        )
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        const picked = mentionFiles[mentionIndex]
        if (picked) insertMention(picked)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setMention(null)
        return
      }
    } else if (mention && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setMention(null)
      return
    }

    if (event.key === 'Enter') {
      const mod = event.ctrlKey || event.metaKey
      const shouldSend =
        sendShortcut === 'ctrlEnter' ? mod && !event.shiftKey : !event.shiftKey && !event.altKey
      if (shouldSend) {
        event.preventDefault()
        void submit()
      }
    }
  }

  const pendingQueue = [
    ...queue.steering.map((value) => ({ kind: 'steer' as const, text: value })),
    ...queue.followUp.map((value) => ({ kind: 'followUp' as const, text: value }))
  ]

  const placeholder = slice.cwdWait
    ? t('Waiting for another operation in this folder…')
    : t('Ask about the main conversation, or @ a file…')
  const readOnlyTitle = t(
    'Side chat is read-only and never modifies files or runs shell commands'
  )
  const mentionListOpen = Boolean(mention)
  const activeOptionId =
    mentionListOpen && mentionFiles.length > 0
      ? `${mentionListId}-option-${mentionIndex}`
      : undefined

  return (
    <div className="composer-wrap side-chat__composer-wrap">
      <div className="composer-stack side-chat__composer-stack">
        {mention ? (
          <FileMention
            id={mentionListId}
            listRef={mentionListRef}
            files={mentionFiles}
            root={workspace?.path}
            activeIndex={mentionIndex}
            onActiveChange={setMentionIndex}
            onSelect={insertMention}
          />
        ) : null}

        <div
          className="composer side-chat__composer"
          data-streaming={isStreaming}
          data-has-content={hasContent}
        >
          {sideRefs.length > 0 ? (
            <div className="composer__queue side-chat__refs-tray">
              <div
                className="side-chat__refs"
                role="group"
                aria-label={t('Referenced main context')}
              >
                {sideRefs.map((ref) => (
                  <SideChatRefChip
                    key={ref.id}
                    reference={ref}
                    onRemove={(id) => removeSideReference(id, draftKey)}
                  />
                ))}
              </div>
            </div>
          ) : null}

          {pendingQueue.length > 0 ? (
            <div className="composer__queue">
              {pendingQueue.map((entry, index) => (
                <div className="composer__queue-item" data-kind={entry.kind} key={index}>
                  <span className="composer__queue-tag">
                    {entry.kind === 'steer' ? t('Steer') : t('Queue')}
                  </span>
                  <span className="composer__queue-text">{entry.text}</span>
                </div>
              ))}
            </div>
          ) : null}

          {images.length > 0 ? (
            <div className="composer__queue">
              <div className="composer__attachments">
                {images.map((img, index) => (
                  <span className="composer__attachment" key={img.id}>
                    <ImageButton
                      src={`data:${img.mimeType};base64,${img.data}`}
                      alt="attachment"
                      inline={{ data: img.data, mimeType: img.mimeType }}
                    />
                    <button
                      type="button"
                      className="composer__attachment-remove"
                      onClick={() =>
                        setImages((current) => current.filter((item) => item.id !== img.id))
                      }
                      aria-label={`${t('Remove image')} ${index + 1}`}
                      title={`${t('Remove image')} ${index + 1}`}
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {files.length > 0 ? (
            <div className="composer__queue">
              <div className="composer__attachments composer__attachments--files">
                {files.map((file) => (
                  <span className="composer__file" key={file.id} title={file.path}>
                    <FileIcon name={file.name} size={14} />
                    <span className="composer__file-name">{file.name}</span>
                    <button
                      type="button"
                      className="composer__file-remove"
                      onClick={() =>
                        setFiles((current) => current.filter((item) => item.id !== file.id))
                      }
                      aria-label={`${t('Remove file')} ${file.name}`}
                      title={`${t('Remove file')} ${file.name}`}
                    >
                      <X size={10} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="composer__input-row">
            <textarea
              ref={textareaRef}
              className="composer__input side-chat__input"
              rows={1}
              value={text}
              disabled={!canCompose}
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={mentionListOpen}
              aria-controls={mentionListOpen ? mentionListId : undefined}
              aria-activedescendant={activeOptionId}
              aria-label={t('Side chat message')}
              placeholder={placeholder}
              onFocus={() => {
                if (draftKey && !draftKey.startsWith('draft:')) {
                  prewarmRuntime(draftKey)
                }
              }}
              onChange={(event) => {
                const value = event.target.value
                const cursor = event.target.selectionStart ?? value.length
                setText(value)
                setMention(detectMention(value, cursor))
              }}
              onKeyDown={onKeyDown}
              onClick={(event) => {
                const cursor = event.currentTarget.selectionStart ?? text.length
                setMention(detectMention(text, cursor))
              }}
              onBlur={() => {
                window.setTimeout(() => setMention(null), 120)
              }}
              onPaste={(event) => {
                if (plainTextEditor) {
                  const textOnly = event.clipboardData?.getData('text/plain')
                  if (textOnly && !event.clipboardData?.files?.length) {
                    event.preventDefault()
                    document.execCommand('insertText', false, textOnly)
                    return
                  }
                }
                const pastedFiles = event.clipboardData?.files
                if (pastedFiles && pastedFiles.length > 0) {
                  event.preventDefault()
                  void addFiles(pastedFiles)
                }
              }}
              onDrop={(event) => {
                event.preventDefault()
                void addFiles(event.dataTransfer?.files ?? null)
              }}
            />
          </div>

          <div
            className="composer__bar side-chat__bar"
            data-streaming={isStreaming}
            data-ready={canCompose}
          >
            <button
              type="button"
              className="icon-btn side-chat__attach-btn"
              onClick={() => void pickFiles()}
              disabled={!canCompose || addingFiles}
              aria-busy={addingFiles || undefined}
              title={t('Attach files or images')}
              aria-label={t('Attach files or images')}
            >
              {addingFiles ? (
                <Loader2 size={15} className="spin" aria-hidden="true" />
              ) : (
                <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>

            <span
              className="side-chat__readonly"
              role="note"
              title={readOnlyTitle}
              aria-label={readOnlyTitle}
            >
              <Eye size={12} aria-hidden="true" />
              <span className="side-chat__readonly-label">{t('Read-only')}</span>
            </span>

            <div className="composer__bar-spacer" />

            <ModelPicker sessionKey={draftKey || undefined} rememberDefaults={false} />

            {isStreaming && (!hasContent || submitting) ? (
              <button
                type="button"
                className="btn composer__send composer__send--stop"
                data-aborting={aborting || undefined}
                disabled={aborting}
                onClick={() => void stopSideChat()}
                aria-label={aborting ? t('Stopping…') : t('Stop side chat (Esc)')}
                title={aborting ? t('Stopping…') : t('Stop side chat (Esc)')}
              >
                <Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary composer__send"
                onClick={() => void submit()}
                disabled={!canCompose || addingFiles || submitting || !hasContent}
                aria-busy={addingFiles || submitting || undefined}
                aria-label={t('Send message')}
                title={t('Send message')}
              >
                {addingFiles || submitting ? (
                  <Loader2 size={15} className="spin" aria-hidden="true" />
                ) : (
                  <ArrowUp size={18} strokeWidth={2.6} aria-hidden="true" />
                )}
              </button>
            )}
          </div>
        </div>

        {isStreaming && hasContent && !submitting ? (
          <div className="composer__stop-row">
            <button
              type="button"
              className="session-bar__stop"
              data-aborting={aborting || undefined}
              disabled={aborting}
              onClick={() => void stopSideChat()}
              aria-label={aborting ? t('Stopping…') : t('Stop side chat (Esc)')}
              title={aborting ? t('Stopping…') : t('Stop side chat (Esc)')}
            >
              <Square size={10} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              {aborting ? t('Stopping…') : t('Stop')}
            </button>
          </div>
        ) : null}

        <UsageBar sessionKey={draftKey || undefined} />
      </div>
    </div>
  )
})

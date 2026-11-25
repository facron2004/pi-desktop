import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  Check,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Network,
  Plus,
  Sparkles,
  Square,
  Wrench,
  X
} from 'lucide-react'
import {
  draftKeyOf,
  useAppStore,
  type ComposerDraft,
  type ComposerDraftCommand,
  type ComposerDraftFile,
  type ComposerDraftImage,
  type ComposerImageOptions,
  type QueueKind
} from '../store/useAppStore'
import {
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_IMAGE_SIZE,
  GOAL_STATUS_KEY,
  IMAGE_MODELS,
  IMAGE_QUALITIES,
  MAX_COMPOSER_IMAGE_BYTES,
  MAX_IMAGE_DATA_BYTES,
  MAX_SEARCH_QUERY_LENGTH
} from '@shared/types'
import type { AgentMode, AppLanguage, FileEntry, PiCommand } from '@shared/types'
import { readGoalStatus } from '@shared/task-mode-state'
import { goalBarVisible } from '@shared/goal-display'
import { appCommandName } from '../lib/app-commands'
import { commandIcon } from '../lib/command-source'
import { composerDraftAfterSend } from '../lib/composer-drafts'
import {
  composerFileToken,
  extractFilePathMentions,
  makeComposerFile,
  mergeComposerFiles
} from '../lib/composer-files'
import {
  IMAGE_RATIO_OPTIONS,
  imageModelName,
  imageQualityLabel,
  imageRatioLabel
} from '../lib/image-options'
import { filterCommands } from '../lib/commands'
import { relativePath } from '../lib/path'
import { useT } from '../lib/i18n'
import { CommandPalette } from './CommandPalette'
import { FileIcon } from './FileIcon'
import { FileMention } from './FileMention'
import { ModelPicker } from './TopBar'
import { ImageButton } from './Lightbox'
import { ProjectSelector } from './ProjectSelector'
import { BranchMenu } from './BranchMenu'
import { PermissionPicker } from './PermissionPicker'
import { AddMenu } from './AddMenu'
import { Popover } from './Popover'
import { GoalTargetIcon } from './GoalTargetIcon'
import { GoalBar } from './GoalBar'
import { UsageBar } from './UsageBar'

interface SlashMatch {
  query: string
  start: number
  cursor: number
}

interface MentionMatch {
  query: string
  start: number
  cursor: number
}

const EMPTY_IMAGES: ComposerDraftImage[] = []
const EMPTY_FILES: ComposerDraftFile[] = []
const EMPTY_HISTORY: string[] = []

/** What each task mode asks the user to type, so the box says what the mode does. */
const MODE_COMPOSER_PROMPTS: Partial<Record<AgentMode, string>> = {
  goal: 'Describe the goal to work toward…',
  plan: 'Describe the task to plan…',
  swarm: 'Describe the mission for the team…',
  plugin: 'Describe the extension to build…'
}

/** The chip above the composer names the active mode and how to leave it. */
const MODE_CHIPS: Record<Exclude<AgentMode, 'default'>, { label: string; leave: string }> = {
  goal: { label: 'Goal Mode', leave: 'Leave Goal Mode' },
  plan: { label: 'Plan Mode', leave: 'Leave Plan Mode' },
  swarm: { label: 'Swarm Mode', leave: 'Leave Swarm Mode' },
  plugin: { label: 'Plugin Mode', leave: 'Leave Plugin Mode' }
}

interface EnterImageModeDetail {
  prompt?: string
  options?: Partial<ComposerImageOptions>
  referenceImage?: {
    data: string
    mimeType: string
    name?: string
  }
  off?: boolean
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
  return Math.max(0, Math.floor(data.length * 3 / 4) - padding)
}

/** Detect a `/command` token that ends at the caret. */
function detectSlash(text: string, cursor: number): SlashMatch | null {
  const before = text.slice(0, cursor)
  const match = before.match(/^\s*\/([\p{L}\p{N}_:.-]*)$/u)
  if (!match) return null
  const query = match[1]
  return { query, start: before.indexOf('/'), cursor }
}

function findCommand(commands: PiCommand[], token: string, language: AppLanguage): PiCommand | undefined {
  const normalized = token.toLocaleLowerCase()
  return commands.find((command) => {
    const localized = command.source === 'app' ? appCommandName(command.name, language) : command.name
    return command.name.toLocaleLowerCase() === normalized || localized.toLocaleLowerCase() === normalized
  })
}

function recognizeCommandInput(
  text: string,
  commands: PiCommand[],
  language: AppLanguage
): { command: ComposerDraftCommand; argument: string } | undefined {
  const match = /^\s*\/([^\s/]+)(?:\s+([\s\S]*))?$/u.exec(text)
  if (!match) return undefined
  const command = findCommand(commands, match[1], language)
  if (!command) return undefined
  return { command: { name: command.name, source: command.source }, argument: match[2] ?? '' }
}

/**
 * Detect an `@file` token that ends at the caret.
 *
 * The `@` has to start a word, so an address in a sentence does not open the
 * file list.
 */
function detectMention(text: string, cursor: number): MentionMatch | null {
  const before = text.slice(0, cursor)
  const at = before.lastIndexOf('@')
  if (at === -1) return null
  if (at > 0 && !/\s/.test(before[at - 1])) return null
  const query = before.slice(at + 1)
  if (/\s/.test(query)) return null
  return { query, start: at, cursor }
}

export const Composer = memo(function Composer({ onOpenSwarm }: { onOpenSwarm: () => void }) {
  const submitComposerDraft = useAppStore((state) => state.submitComposerDraft)
  const stop = useAppStore((state) => state.stop)
  const isStreaming = useAppStore((state) => state.isStreaming)
  const aborting = useAppStore((state) => state.run.phase === 'aborting')
  const queue = useAppStore((state) => state.queue)
  const status = useAppStore((state) => state.status)
  const cwdWait = useAppStore((state) => state.cwdWait)
  const prewarmRuntime = useAppStore((state) => state.prewarmRuntime)
  const workspace = useAppStore((state) => state.workspace)
  const agentMode = useAppStore((state) => state.agentMode)
  const setAgentMode = useAppStore((state) => state.setAgentMode)
  const commands = useAppStore((state) => state.commands)
  const refreshSkillCommands = useAppStore((state) => state.refreshSkillCommands)
  const language = useAppStore((state) => state.settings.language ?? 'en')
  const draftKey = useAppStore((state) => draftKeyOf(state))
  const clientKey = useAppStore((state) => {
    const key = state.activeSessionFile || state.draftId
    return (key && state.threads[key]?.clientKey) || key || state.clientKey || '__fallback__'
  })
  const submitting = useAppStore((state) => Boolean(state.submittingDrafts[clientKey]))
  // A message edit can be taken back until something is sent from here.
  const undoEdit = useAppStore((state) => state.rewindUndo === true)
  const undoRewind = useAppStore((state) => state.undoRewind)
  const draftEntry = useAppStore(
    useCallback((state) => (draftKey ? state.drafts[draftKey] : undefined), [draftKey])
  )
  const updateDraft = useAppStore((state) => state.updateDraft)
  const composerText = useAppStore((state) => state.composerText)
  const clearComposerText = useAppStore((state) => state.clearComposerText)
  const composerInsert = useAppStore((state) => state.composerInsert)
  const fontScale = useAppStore((state) => state.settings.fontScale ?? 1)
  const sendShortcut = useAppStore((state) => state.settings.sendShortcut ?? 'enter')
  const defaultFollowUpMode = useAppStore((state) => state.settings.followUpMode ?? 'steer')
  const plainTextEditor = useAppStore((state) => state.settings.plainTextEditor === true)
  const pasteMentions = useAppStore((state) => state.settings.pasteMentions === true)
  const hasDialogue = useAppStore((state) => state.items.length > 0)
  const t = useT()

  // Used only on initial mount before bootstrap assigns a draftId or session file.
  const [fallbackDraft, setFallbackDraft] = useState<ComposerDraft>({
    text: '',
    images: EMPTY_IMAGES
  })
  const fallbackDraftRef = useRef(fallbackDraft)
  fallbackDraftRef.current = fallbackDraft

  const draft = draftKey ? draftEntry : fallbackDraft
  const text = draft?.text ?? ''
  const command = draft?.command
  const images = draft?.images ?? EMPTY_IMAGES
  const files = draft?.files ?? EMPTY_FILES
  const history = draft?.history ?? EMPTY_HISTORY
  const image = draft?.image

  const draftKeyRef = useRef(draftKey)
  draftKeyRef.current = draftKey

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

  const readTargetDraft = useCallback((targetKey: string): ComposerDraft => {
    if (targetKey) return useAppStore.getState().drafts[targetKey] ?? { text: '', images: EMPTY_IMAGES }
    return fallbackDraftRef.current
  }, [])

  const focusComposer = useCallback(() => {
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      node.focus()
      const end = node.value.length
      node.setSelectionRange(end, end)
    })
  }, [])

  const defaultImageOptions = useCallback((): ComposerImageOptions => {
    const settings = useAppStore.getState().settings
    return {
      model: settings.imageModel ?? '',
      size: settings.imageSize ?? DEFAULT_IMAGE_SIZE,
      quality: settings.imageQuality ?? DEFAULT_IMAGE_QUALITY,
      count: 1
    }
  }, [])

  const exitImageMode = useCallback(() => {
    patchDraft(draftKeyRef.current, (prev) => ({ ...prev, image: undefined }))
  }, [patchDraft])

  /** Put the composer into image mode without leaving the conversation. */
  const enterImageMode = useCallback((input?: string | EnterImageModeDetail) => {
    const detail: EnterImageModeDetail =
      typeof input === 'string' ? { prompt: input } : (input ?? {})
    if (detail.off) {
      exitImageMode()
      focusComposer()
      return
    }
    const targetKey = draftKeyRef.current
    patchDraft(targetKey, (prev) => {
      const baseOptions = prev.image ?? defaultImageOptions()
      const nextOptions: ComposerImageOptions = {
        ...baseOptions,
        ...(detail.options?.model !== undefined ? { model: detail.options.model } : {}),
        ...(detail.options?.size !== undefined ? { size: detail.options.size } : {}),
        ...(detail.options?.quality !== undefined ? { quality: detail.options.quality } : {}),
        ...(detail.options?.count !== undefined
          ? { count: Math.min(4, Math.max(1, Math.round(detail.options.count))) }
          : {})
      }
      let nextImages = prev.images
      if (detail.referenceImage?.data && detail.referenceImage?.mimeType) {
        const refData = detail.referenceImage.data
        const alreadyAttached = nextImages.some((item) => item.data === refData)
        if (!alreadyAttached) {
          const bytes = imageByteLength(refData)
          const committed = sumImageBytes(nextImages)
          if (bytes > 0 && bytes <= MAX_IMAGE_DATA_BYTES && committed + bytes <= MAX_COMPOSER_IMAGE_BYTES) {
            nextImages = [
              ...nextImages,
              makeDraftImage(
                refData,
                detail.referenceImage.mimeType,
                bytes,
                detail.referenceImage.name || 'reference.png'
              )
            ]
          }
        }
      }
      return {
        ...prev,
        command: undefined,
        image: nextOptions,
        images: nextImages,
        text: detail.prompt && detail.prompt.trim() ? detail.prompt : prev.text
      }
    })
    focusComposer()
  }, [defaultImageOptions, exitImageMode, focusComposer, patchDraft])

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
      next: ComposerDraftImage[] | ((current: ComposerDraftImage[]) => ComposerDraftImage[]),
      targetKey = draftKeyRef.current
    ) => {
      patchDraft(targetKey, (prev) => ({
        ...prev,
        images: typeof next === 'function' ? next(prev.images) : next
      }))
    },
    [patchDraft]
  )

  const setFiles = useCallback(
    (
      next: ComposerDraftFile[] | ((current: ComposerDraftFile[]) => ComposerDraftFile[]),
      targetKey = draftKeyRef.current
    ) => {
      patchDraft(targetKey, (prev) => {
        const current = prev.files ?? EMPTY_FILES
        return {
          ...prev,
          files: typeof next === 'function' ? next(current) : next
        }
      })
    },
    [patchDraft]
  )

  const setImageOption = useCallback(
    (patch: Partial<ComposerImageOptions>) => {
      patchDraft(draftKeyRef.current, (prev) =>
        prev.image ? { ...prev, image: { ...prev.image, ...patch } } : prev
      )
      const settingsPatch: { imageModel?: string; imageSize?: string; imageQuality?: string } = {}
      if (patch.model !== undefined) settingsPatch.imageModel = patch.model
      if (patch.size !== undefined) settingsPatch.imageSize = patch.size
      if (patch.quality !== undefined) settingsPatch.imageQuality = patch.quality
      if (Object.keys(settingsPatch).length > 0) {
        void useAppStore.getState().updateSettings(settingsPatch)
      }
    },
    [patchDraft]
  )

  /**
   * Older drafts and hand-pasted absolute paths arrive as `@"C:/..."` lines in
   * the textarea. Lift those into attachment chips the first time the draft is
   * shown; a relative `@path` mention stays text because it is part of the
   * message, not a file attachment.
   */
  useEffect(() => {
    const extracted = extractFilePathMentions(text)
    if (!extracted.files.length) return
    setFiles((current) => mergeComposerFiles(current, extracted.files))
    setText(extracted.text)
  }, [text, setFiles, setText])

  const pendingBytesByKeyRef = useRef<Map<string, number>>(new Map())
  const pendingAddsByKeyRef = useRef<Map<string, number>>(new Map())
  const [addingKeys, setAddingKeys] = useState<Record<string, number>>({})
  const addingFiles = (addingKeys[draftKey] ?? 0) > 0

  const bumpPendingAdds = useCallback((targetKey: string, delta: number) => {
    const next = Math.max(0, (pendingAddsByKeyRef.current.get(targetKey) ?? 0) + delta)
    if (next === 0) pendingAddsByKeyRef.current.delete(targetKey)
    else pendingAddsByKeyRef.current.set(targetKey, next)
    setAddingKeys((prev) => {
      if (next === 0) {
        if (!(targetKey in prev)) return prev
        const copy = { ...prev }
        delete copy[targetKey]
        return copy
      }
      return { ...prev, [targetKey]: next }
    })
  }, [])

  // Delivery is a preference, not a per-message control in the composer:
  // configure it in Settings so this bar stays to send/stop and the model.
  const kind: QueueKind = defaultFollowUpMode === 'queue' ? 'followUp' : 'steer'

  const [slash, setSlash] = useState<SlashMatch | null>(null)
  const [loadingSkillCommands, setLoadingSkillCommands] = useState(false)
  const [mention, setMention] = useState<MentionMatch | null>(null)
  const [mentionFiles, setMentionFiles] = useState<FileEntry[]>([])
  const [mentionIndex, setMentionIndex] = useState(0)
  const [paletteIndex, setPaletteIndex] = useState(0)
  const [commandSelected, setCommandSelected] = useState(false)
  const [imageSelected, setImageSelected] = useState(false)

  const commandLabel = command
    ? command.source === 'app'
      ? appCommandName(command.name, language)
      : command.name
    : ''
  const commandName = commandLabel ? `/${commandLabel}` : ''
  const commandHasNonAscii = /[^\x20-\x7e]/.test(commandLabel)
  const CommandIcon = command ? commandIcon(command) : undefined

  const reserveImageBytes = useCallback(
    (bytes: number, targetKey = draftKeyRef.current): boolean => {
      const committed = sumImageBytes(readTargetDraft(targetKey).images)
      const pending = pendingBytesByKeyRef.current.get(targetKey) ?? 0
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || committed + pending + bytes > MAX_COMPOSER_IMAGE_BYTES) {
        return false
      }
      pendingBytesByKeyRef.current.set(targetKey, pending + bytes)
      return true
    },
    [readTargetDraft]
  )

  const releaseReservedBytes = useCallback((bytes: number, targetKey = draftKeyRef.current): void => {
    const pending = Math.max(0, (pendingBytesByKeyRef.current.get(targetKey) ?? 0) - bytes)
    if (pending === 0) pendingBytesByKeyRef.current.delete(targetKey)
    else pendingBytesByKeyRef.current.set(targetKey, pending)
  }, [])

  const [historyNav, setHistoryNav] = useState<{ key: string; index: number }>({
    key: '',
    index: -1
  })
  const historyIndex = historyNav.key === draftKey ? historyNav.index : -1
  const setHistoryIndex = useCallback((index: number) => {
    setHistoryNav({ key: draftKeyRef.current, index })
  }, [])

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerA11yId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const commandListId = `${composerA11yId}-command-list`
  const mentionListId = `${composerA11yId}-mention-list`
  const mentionListRef = useRef<HTMLDivElement>(null)
  // Enter repeats while it is held, and a double-click can land before React
  // has cleared the draft. Track locks per conversation identity so a send in
  // one session never blocks sending in another.
  // Where the caret goes after a mention has been spliced in. The text is
  // updated through the queue, so the position is only known inside the update.
  const mentionCaret = useRef<number | null>(null)

  const canCompose = status.phase === 'ready' || status.phase === 'starting'
  const hasContent = Boolean(command || text.trim() || images.length > 0 || files.length > 0)
  // A goal of its own already fills the bar above the box — mode, state and the
  // controls that pause, edit or clear it — so the chip that only repeats "Goal
  // Mode" is redundant there. It comes back the moment the goal is cleared, and
  // it stays for every other task mode.
  const goalIsOnScreen = useAppStore((state) =>
    goalBarVisible(readGoalStatus(state.uiStatuses.find((entry) => entry.key === GOAL_STATUS_KEY)?.text)?.status)
  )
  const modeChip = agentMode === 'default' ? null : MODE_CHIPS[agentMode]
  const showModeChip = modeChip && !(agentMode === 'goal' && goalIsOnScreen)
  const modePrompt = MODE_COMPOSER_PROMPTS[agentMode]
  const inputPrompt = command
    ? t('Add command arguments…')
    : image
      ? t('Describe the image you want…')
      : canCompose
        ? cwdWait
          ? t('Waiting for another conversation in this folder…')
          : modePrompt
            ? t(modePrompt)
            : workspace
              ? t('Describe a task, or use @ to reference project files…')
              : t('Describe a task…')
        : status.phase === 'error'
          ? t('Pi unavailable')
          : !workspace
            ? t('Open a project folder to start')
            : t('Pi stopped')

  useEffect(() => {
    setSlash(null)
    setMention(null)
    setPaletteIndex(0)
    setCommandSelected(false)
    setImageSelected(false)
  }, [draftKey])

  useEffect(() => {
    const focus = (event: Event) => {
      const detail = (event as CustomEvent<{ target?: string } | undefined>).detail
      if (detail?.target === 'side') return
      const node = textareaRef.current
      if (!node) return
      node.focus()
      const end = node.value.length
      node.setSelectionRange(end, end)
    }
    window.addEventListener('pi:focus-composer', focus)
    return () => window.removeEventListener('pi:focus-composer', focus)
  }, [])

  // `/image` and the Add menu's Image action both land here: the generator's
  // controls belong to the composer, so they load in place instead of a panel.
  useEffect(() => {
    const onEnter = (event: Event) => {
      const detail = (event as CustomEvent<EnterImageModeDetail>).detail
      setImageSelected(false)
      enterImageMode(detail)
    }
    window.addEventListener('pi:enter-image-mode', onEnter)
    return () => window.removeEventListener('pi:enter-image-mode', onEnter)
  }, [enterImageMode])

  // Development aid: prefill the composer so screenshots can show the
  // command palette. Set by the main process via PI_DESKTOP_PREFILL.
  useEffect(() => {
    const prefill = (window as unknown as { __piDesktopDev?: { prefill?: string } })
      .__piDesktopDev?.prefill
    if (!prefill) return
    setText(prefill)
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const cursor = prefill.length
      node.focus()
      node.setSelectionRange(cursor, cursor)
      setSlash(detectSlash(prefill, cursor))
      setMention(detectMention(prefill, cursor))
    })
  }, [setText])

  // An extension can prefill the editor through `set_editor_text`.
  useEffect(() => {
    if (composerText === undefined) return
    const key = draftKeyRef.current
    if (!key) {
      setFallbackDraft((prev) => ({ ...prev, text: composerText }))
    } else if (useAppStore.getState().drafts[key]?.text !== composerText) {
      updateDraft(key, { text: composerText })
    }
    clearComposerText()
    requestAnimationFrame(() => {
      const node = textareaRef.current
      if (!node) return
      const cursor = composerText.length
      node.focus()
      node.setSelectionRange(cursor, cursor)
      node.scrollTop = node.scrollHeight
      setSlash(detectSlash(composerText, cursor))
      setMention(detectMention(composerText, cursor))
    })
  }, [composerText, clearComposerText, updateDraft])

  // A tool card can hand a command or a path back to the composer, and a
  // branch puts the original prompt back so it can be tweaked and sent again.
  const insertSeq = useRef(0)
  useEffect(() => {
    if (!composerInsert || composerInsert.seq === insertSeq.current) return
    insertSeq.current = composerInsert.seq
    if (!draftKeyRef.current) {
      const addition = composerInsert.text
      const replace = composerInsert.mode === 'replace'
      setFallbackDraft((prev) => ({
        ...prev,
        text: replace ? addition : prev.text.trim() ? `${prev.text.trimEnd()}\n${addition}` : addition
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

  const matching = useMemo(
    () => (slash ? filterCommands(commands, slash.query, language) : []),
    [commands, slash, language]
  )
  const skillCommands = useMemo(
    () => commands.filter((command) => command.source === 'skill'),
    [commands]
  )
  const pluginCommands = useMemo(
    () => commands.filter((command) => command.source === 'extension'),
    [commands]
  )

  const slashOpen = slash !== null
  useEffect(() => {
    if (!slashOpen || skillCommands.length > 0) {
      setLoadingSkillCommands(false)
      return
    }
    let active = true
    setLoadingSkillCommands(true)
    void refreshSkillCommands().finally(() => {
      if (active) setLoadingSkillCommands(false)
    })
    return () => {
      active = false
    }
  }, [slashOpen, skillCommands.length, workspace?.path, refreshSkillCommands])

  const textareaSizeRef = useRef<{
    height: number
    minHeight: number
    len: number
    newlines: number
    width: number
    fontScale: number
  }>({ height: 0, minHeight: 0, len: 0, newlines: 0, width: 0, fontScale })
  const [textareaLayoutVersion, setTextareaLayoutVersion] = useState(0)

  useEffect(() => {
    const node = textareaRef.current
    if (!node || typeof ResizeObserver === 'undefined') return
    let width = node.clientWidth
    let frame = 0
    const observer = new ResizeObserver(() => {
      const nextWidth = node.clientWidth
      if (nextWidth === width) return
      width = nextWidth
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        setTextareaLayoutVersion((version) => version + 1)
      })
    })
    observer.observe(node)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  useLayoutEffect(() => {
    const node = textareaRef.current
    if (!node) return
    const prev = textareaSizeRef.current
    const width = node.clientWidth
    const sameBox = prev.width === width && prev.fontScale === fontScale
    const caretAtEnd =
      document.activeElement === node &&
      node.selectionStart === text.length &&
      node.selectionEnd === text.length
    let newlines = 0
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) newlines += 1
    }
    const minHeight = sameBox ? prev.minHeight : 0
    // A single-line edit that stays within the empty placeholder minimum height
    // cannot shrink below `minHeight`, so skip collapsing `'auto'` on deletes.
    if (
      sameBox &&
      minHeight > 0 &&
      prev.height <= minHeight &&
      newlines === 0 &&
      text.length <= prev.len
    ) {
      textareaSizeRef.current = {
        height: prev.height,
        minHeight,
        len: text.length,
        newlines,
        width,
        fontScale
      }
      return
    }
    // Single-character additions that keep line breaks can only grow: skip the
    // collapsing `height = 'auto'` write so normal typing stays a single layout pass.
    const canOnlyGrow =
      prev.height > 0 &&
      sameBox &&
      text.length === prev.len + 1 &&
      newlines >= prev.newlines
    if (canOnlyGrow) {
      if (prev.height >= 240) {
        if (caretAtEnd) node.scrollTop = node.scrollHeight
        textareaSizeRef.current = {
          height: prev.height,
          minHeight,
          len: text.length,
          newlines,
          width,
          fontScale
        }
        return
      }
      const contentHeight = node.scrollHeight
      const nextHeight = Math.min(contentHeight, 240)
      if (nextHeight > prev.height) {
        node.style.height = `${nextHeight}px`
        node.style.overflowY = contentHeight > 240 ? 'auto' : 'hidden'
      }
      if (contentHeight > 240 && caretAtEnd) {
        node.scrollTop = contentHeight
      }
      textareaSizeRef.current = {
        height: Math.max(prev.height, nextHeight),
        minHeight,
        len: text.length,
        newlines,
        width,
        fontScale
      }
      return
    }
    const previousScrollTop = node.scrollTop
    node.style.height = 'auto'
    const contentHeight = node.scrollHeight
    const nextHeight = Math.min(contentHeight, 240)
    node.style.height = `${nextHeight}px`
    node.style.overflowY = contentHeight > 240 ? 'auto' : 'hidden'
    if (contentHeight > 240) {
      node.scrollTop = caretAtEnd ? contentHeight : previousScrollTop
    }
    textareaSizeRef.current = {
      height: nextHeight,
      minHeight: text.length === 0 ? nextHeight : minHeight,
      len: text.length,
      newlines,
      width,
      fontScale
    }
  }, [text, fontScale, inputPrompt, textareaLayoutVersion])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      if (document.querySelector('[aria-modal="true"]')) return
      if (document.activeElement?.closest('[data-conversation-surface="side"]')) return
      if (event.key !== 'Escape' || !isStreaming) return
      // The palette uses Escape to close itself and handles the key before
      // it reaches the window, so the run is left alone.
      if (event.defaultPrevented) return
      event.preventDefault()
      void stop()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isStreaming, stop])

  // Keep the highlighted command in view when the list changes.
  useEffect(() => {
    setPaletteIndex((index) => Math.min(index, Math.max(0, matching.length - 1)))
  }, [matching.length])

  useEffect(() => {
    mentionListRef.current
      ?.querySelector<HTMLElement>(`[data-active='true']`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [mentionIndex, mentionFiles])

  // The files that match the `@` in the composer. The search waits a moment,
  // so a fast typist does not walk the project over and over.
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
        .search(mention.query, 12, 'composer-mention')
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
      if (requestStarted) void window.pi.fs.search('', 0, 'composer-mention').catch(() => undefined)
    }
    // The caret moving inside the same token produces a new match object; the
    // search must follow the query, not the object, or a click would wipe the
    // list and reset the highlighted row.
  }, [mention?.query, workspace?.path])

  const closePalette = useCallback(() => setSlash(null), [])

  /**
   * Splice a finished mention (`@path` plus a trailing space) into the composer.
   *
   * `at` is the `@` query the caret sits in: it is replaced, so a half-typed
   * query never survives next to the new path. Without one the mention lands at
   * the caret, with a space in front when the text runs into it.
   */
  const applyMention = useCallback(
    (addition: string, at?: MentionMatch | null, targetKey = draftKeyRef.current): void => {
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

  /** The path of a file as the composer writes it: relative, with slashes. */
  const mentionToken = useCallback(
    (root: string, file: string): string => `@${relativePath(root, file).replace(/\\/g, '/')}`,
    []
  )

  /** Put the path of a picked file into the composer. */
  const insertMention = useCallback(
    (file: FileEntry) => {
      if (!mention) return
      applyMention(`${mentionToken(workspace?.path ?? '', file.path)} `, mention)
    },
    [applyMention, mention, mentionToken, workspace?.path]
  )

  const insertCommand = useCallback(
    (command: PiCommand) => {
      if (!slash) return
      const targetKey = draftKeyRef.current
      const currentText = readTargetDraft(targetKey).text
      const node = textareaRef.current
      const cursor = node?.selectionStart ?? slash.cursor
      const suffix = currentText.slice(cursor).replace(/^\s/, '')
      if (command.source === 'app' && command.name === 'image') {
        setCommandSelected(false)
        setImageSelected(false)
        setMention(null)
        setSlash(null)
        if (suffix.trim().toLowerCase() === 'off') {
          patchDraft(targetKey, (prev) => ({ ...prev, command: undefined, image: undefined, text: '' }))
          focusComposer()
          return
        }
        patchDraft(targetKey, (prev) => ({
          ...prev,
          command: undefined,
          image: prev.image ?? defaultImageOptions(),
          text: suffix
        }))
        requestAnimationFrame(() => {
          const target = textareaRef.current
          if (!target) return
          target.focus()
          target.setSelectionRange(0, 0)
        })
        return
      }
      patchDraft(targetKey, (prev) => ({
        ...prev,
        command: { name: command.name, source: command.source },
        text: suffix
      }))
      setCommandSelected(false)
      setImageSelected(false)
      setMention(null)
      requestAnimationFrame(() => {
        const target = textareaRef.current
        if (!target) return
        target.focus()
        target.setSelectionRange(0, 0)
      })
      setSlash(null)
    },
    [slash, readTargetDraft, patchDraft, defaultImageOptions, focusComposer]
  )

  const submit = useCallback(() => {
    const targetKey = draftKeyRef.current
    if (submitting) return
    if ((pendingAddsByKeyRef.current.get(targetKey) ?? 0) > 0) return
    const currentDraft = readTargetDraft(targetKey)
    if (!currentDraft.text.trim() && !currentDraft.command && !currentDraft.images.length && !(currentDraft.files?.length ?? 0)) return
    const rawTrimmed = currentDraft.text.trim()
    const rawImageMatch = !currentDraft.command ? /^\/(?:image|图片)(?:\s+([\s\S]*))?$/iu.exec(rawTrimmed) : null
    const rawImageArg = rawImageMatch ? (rawImageMatch[1] ?? '').trim() : ''
    const startsImage =
      (currentDraft.command?.source === 'app' && currentDraft.command.name === 'image') ||
      Boolean(rawImageMatch)
    const effectiveText = rawImageMatch ? rawImageArg : currentDraft.text
    if (
      (startsImage && effectiveText.trim().toLowerCase() === 'off') ||
      (currentDraft.image && /^\/?(?:image\s+|图片\s+)?off$/iu.test(rawTrimmed))
    ) {
      patchDraft(targetKey, (prev) => ({ ...prev, command: undefined, image: undefined, text: '' }))
      setCommandSelected(false)
      setImageSelected(false)
      closePalette()
      setMention(null)
      focusComposer()
      return
    }
    const imageOptions = startsImage
      ? (currentDraft.image ?? defaultImageOptions())
      : currentDraft.image
    // `/image` on its own only loads the controls; the prompt comes next.
    if (startsImage && !effectiveText.trim() && !currentDraft.images.length) {
      patchDraft(targetKey, (prev) => ({ ...prev, command: undefined, image: imageOptions, text: '' }))
      setCommandSelected(false)
      setImageSelected(false)
      closePalette()
      setMention(null)
      focusComposer()
      return
    }
    const loneSlash = /^\/([^\s/]+)$/.exec(rawTrimmed)
    if (!currentDraft.command && rawTrimmed === '/') {
      useAppStore.getState().showToast(t('Choose a slash command before sending'), 'warning')
      return
    }
    if (!rawImageMatch && loneSlash && !findCommand(commands, loneSlash[1], language)) {
      useAppStore.getState().showToast(t('No command matches this slash command'), 'warning')
      return
    }
    const fileReferences = (currentDraft.files ?? EMPTY_FILES).map(composerFileToken)
    const visibleText = effectiveText
    const body = [...fileReferences, visibleText].filter((part) => part.trim()).join('\n')
    const rawDraftText = currentDraft.command && !startsImage
      ? `/${currentDraft.command.name}${body ? ` ${body}` : ''}`
      : body
    const isCommandOrBash =
      rawDraftText.trimStart().startsWith('/') || rawDraftText.trimStart().startsWith('!')
    // A command other than `/image` keeps its own meaning even while the image
    // controls are on screen.
    const sendImage = (currentDraft.command && !startsImage) || isCommandOrBash ? undefined : imageOptions
    const draftText =
      sendImage && !rawDraftText.trim() && currentDraft.images.length > 0
        ? t('Create a refined variation based on the reference image.')
        : rawDraftText
    // An image prompt needs its own agent start: the options travel with the
    // run, and a steer would be folded into a run that already started.
    void submitComposerDraft(targetKey, {
      draft: currentDraft,
      text: draftText,
      kind: sendImage ? 'followUp' : kind,
      imageOptions,
      sendImage
    }).then((accepted) => {
      if (accepted && !targetKey) {
        patchDraft('', (prev) => prev === currentDraft ? composerDraftAfterSend(prev, draftText, imageOptions) : prev)
      }
    })
    setHistoryIndex(-1)
    setCommandSelected(false)
    setImageSelected(false)
    closePalette()
    setMention(null)
  }, [kind, submitting, submitComposerDraft, commands, language, t, closePalette, patchDraft, readTargetDraft, setHistoryIndex, defaultImageOptions, focusComposer])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    // A held Enter repeats. The first one already sent the draft.
    if (event.repeat && event.key === 'Enter') {
      event.preventDefault()
      return
    }
    // The file list comes first: an `@` in the text means the user is
    // pointing at a file, not at a command.
    if (mention) {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMention(null)
        return
      }
      if (mentionFiles.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setMentionIndex((index) => (index + 1) % mentionFiles.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setMentionIndex((index) => (index - 1 + mentionFiles.length) % mentionFiles.length)
          return
        }
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
          event.preventDefault()
          insertMention(mentionFiles[mentionIndex])
          return
        }
      }
    }

    if (slash && matching.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setPaletteIndex((index) => (index + 1) % matching.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setPaletteIndex((index) => (index - 1 + matching.length) % matching.length)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        insertCommand(matching[paletteIndex])
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closePalette()
        return
      }
    }

    if (
      slash &&
      matching.length === 0 &&
      event.key === 'Enter' &&
      (!event.shiftKey || event.ctrlKey || event.metaKey)
    ) {
      event.preventDefault()
      return
    }

    if (command && event.key === 'Backspace') {
      const input = event.currentTarget
      if (input.selectionStart === 0 && input.selectionEnd === 0) {
        event.preventDefault()
        if (commandSelected) {
          patchDraft(draftKeyRef.current, (prev) => ({ ...prev, command: undefined }))
          setCommandSelected(false)
          setSlash(null)
        } else {
          setCommandSelected(true)
        }
        return
      }
    } else if (commandSelected) {
      setCommandSelected(false)
    }

    if (image && !command && event.key === 'Backspace') {
      const input = event.currentTarget
      if (input.selectionStart === 0 && input.selectionEnd === 0) {
        event.preventDefault()
        if (imageSelected) {
          exitImageMode()
          setImageSelected(false)
        } else {
          setImageSelected(true)
        }
        return
      }
    } else if (imageSelected) {
      setImageSelected(false)
    }

    const isEnter = event.key === 'Enter'
    const isCtrlEnter = isEnter && (event.ctrlKey || event.metaKey)
    const isPlainEnter = isEnter && !event.shiftKey && !event.ctrlKey && !event.metaKey

    if (sendShortcut === 'ctrlEnter') {
      if (isCtrlEnter) {
        event.preventDefault()
        submit()
        return
      }
    } else {
      if (isPlainEnter) {
        event.preventDefault()
        submit()
        return
      }
      if (isCtrlEnter) {
        event.preventDefault()
        submit()
        return
      }
    }

    // Recall previous prompts with the arrow keys when the composer is empty.
    if (event.key === 'ArrowUp' && !event.shiftKey && !text) {
      if (!history.length) return
      event.preventDefault()
      const next = Math.min(historyIndex + 1, history.length - 1)
      setHistoryIndex(next)
      setText(history[next])
      return
    }
    if (event.key === 'ArrowDown' && !event.shiftKey && historyIndex >= 0) {
      event.preventDefault()
      const next = historyIndex - 1
      setHistoryIndex(next)
      setText(next < 0 ? '' : history[next])
    }
  }

  /** The base64 body of a file, read the way `addFiles` has always read a picture. */
  const readBase64 = (file: File): Promise<string> =>
    file.size > MAX_IMAGE_DATA_BYTES
      ? Promise.resolve('')
      : new Promise((resolve) => {
          try {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '')
            reader.onerror = () => resolve('')
            reader.onabort = () => resolve('')
            reader.readAsDataURL(file)
          } catch {
            resolve('')
          }
        })

  /**
   * Add a batch with `pasteMentions` on: a picture is written next to the
   * conversation first and then named in the message exactly the way a
   * hand-picked `@` mention is, while keeping the attachment it already was.
   *
   * The whole batch goes in with one splice, so two pictures in one paste can
   * never write over each other's reference. A picture the main process will
   * not take — a type outside its allowlist, a read-only folder — silently
   * stays the attachment it always was.
   */
  const addPicturesInPlace = async (items: File[], targetKey: string, cwd: string): Promise<void> => {
    const mentions: string[] = []
    const attachments: ComposerDraftFile[] = []
    for (const file of items) {
      if (!file.type.startsWith('image/')) {
        const filePath = window.pi.fs.pathForFile(file)
        if (filePath) attachments.push(makeComposerFile(filePath))
        continue
      }
      if (file.size > MAX_IMAGE_DATA_BYTES || !reserveImageBytes(file.size, targetKey)) {
        const filePath = window.pi.fs.pathForFile(file)
        if (filePath) attachments.push(makeComposerFile(filePath))
        continue
      }
      const base64 = await readBase64(file)
      if (!base64) {
        releaseReservedBytes(file.size, targetKey)
        const filePath = window.pi.fs.pathForFile(file)
        if (filePath) attachments.push(makeComposerFile(filePath))
        continue
      }
      releaseReservedBytes(file.size, targetKey)
      setImages(
        (current) => [...current, makeDraftImage(base64, file.type, file.size, file.name || 'image')],
        targetKey
      )
      // A clipboard picture keeps its name, size and stamp, so the same one
      // pasted twice is recognised before a second copy ever reaches the disk —
      // unless the composer no longer carries the name the first paste put in.
      const signature = `${file.name}|${file.size}|${file.type}|${file.lastModified}`
      const targetDraft = readTargetDraft(targetKey)
      const earlier = targetDraft.pastedRefs?.[signature]
      if (earlier && targetDraft.text.includes(earlier)) continue
      let saved: { path: string; root: string } | null = null
      try {
        saved = await window.pi.fs.savePastedImage(base64, file.type, cwd)
      } catch {
        saved = null
      }
      if (!saved) continue
      const token = mentionToken(saved.root, saved.path)
      patchDraft(targetKey, (prev) => ({
        ...prev,
        pastedRefs: { ...(prev.pastedRefs ?? {}), [signature]: token }
      }))
      mentions.push(token)
    }
    // Anything that is not a picture is a file attachment, shown by its icon
    // and turned into a `@` token only when the message is sent.
    if (attachments.length) {
      setFiles((current) => mergeComposerFiles(current, attachments), targetKey)
    }
    if (mentions.length) applyMention(`${mentions.join(' ')} `, null, targetKey)
  }

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (!files) return
    const state = useAppStore.getState()
    const targetKey = draftKeyRef.current || draftKeyOf(state)
    const cwd = state.threads[targetKey]?.status.cwd ?? state.workspace?.path ?? ''
    bumpPendingAdds(targetKey, 1)
    try {
      const items = Array.from(files)
      const inImageMode = Boolean(readTargetDraft(targetKey).image)
      // The switch decides whether a pasted picture is also named in the text,
      // and a batch without a picture does not go near the text at all.
      if (pasteMentions && !inImageMode && items.some((file) => file.type.startsWith('image/'))) {
        await addPicturesInPlace(items, targetKey, cwd)
        return
      }
      const attachments: ComposerDraftFile[] = []
      for (const file of items) {
        if (file.type.startsWith('image/')) {
          if (file.size > MAX_IMAGE_DATA_BYTES || !reserveImageBytes(file.size, targetKey)) {
            const filePath = window.pi.fs.pathForFile(file)
            if (filePath) attachments.push(makeComposerFile(filePath))
            continue
          }
          const base64 = await readBase64(file)
          releaseReservedBytes(file.size, targetKey)
          if (base64) {
            setImages(
              (current) => [...current, makeDraftImage(base64, file.type, file.size, file.name || 'image')],
              targetKey
            )
          } else {
            const filePath = window.pi.fs.pathForFile(file)
            if (filePath) attachments.push(makeComposerFile(filePath))
          }
          continue
        }
        const filePath = window.pi.fs.pathForFile(file)
        if (!filePath) continue
        attachments.push(makeComposerFile(filePath))
      }
      if (attachments.length) {
        setFiles((current) => mergeComposerFiles(current, attachments), targetKey)
      }
    } finally {
      bumpPendingAdds(targetKey, -1)
    }
  }

  const pickFiles = useCallback(async () => {
    const targetKey = draftKeyRef.current
    bumpPendingAdds(targetKey, 1)
    try {
      const committedBytes = sumImageBytes(readTargetDraft(targetKey).images)
      const pendingBytes = pendingBytesByKeyRef.current.get(targetKey) ?? 0
      const remainingImageBytes = Math.max(0, MAX_COMPOSER_IMAGE_BYTES - committedBytes - pendingBytes)
      const picked = await window.pi.dialog.pickFiles(
        workspace?.path || status.cwd || undefined,
        remainingImageBytes
      )
      const pickedImages: ComposerDraftImage[] = []
      const pickedFiles: ComposerDraftFile[] = []
      for (const item of picked) {
        if (item.kind === 'path') {
          pickedFiles.push(makeComposerFile(item.path))
          continue
        }
        const byteSize = imageByteLength(item.data)
        if (!reserveImageBytes(byteSize, targetKey)) {
          if (item.path) pickedFiles.push(makeComposerFile(item.path))
          continue
        }
        releaseReservedBytes(byteSize, targetKey)
        pickedImages.push(
          makeDraftImage(
            item.data,
            item.mimeType,
            byteSize,
            item.path ? relativePath(workspace?.path ?? '', item.path) : 'image'
          )
        )
      }
      if (pickedImages.length) setImages((current) => [...current, ...pickedImages], targetKey)
      if (pickedFiles.length) {
        setFiles((current) => mergeComposerFiles(current, pickedFiles), targetKey)
      }
    } catch {
      useAppStore.getState().showToast('Could not add files', 'error')
    } finally {
      bumpPendingAdds(targetKey, -1)
    }
  }, [
    workspace?.path,
    status.cwd,
    bumpPendingAdds,
    readTargetDraft,
    reserveImageBytes,
    releaseReservedBytes,
    setImages,
    setFiles
  ])

  const insertMenuCommand = useCallback(
    (command: PiCommand) => {
      if (command.source === 'app' && command.name === 'image') {
        enterImageMode()
        return
      }
      const targetKey = draftKeyRef.current
      const currentDraft = readTargetDraft(targetKey)
      if (!currentDraft.text.trim()) {
        patchDraft(targetKey, (prev) => ({
          ...prev,
          command: { name: command.name, source: command.source },
          text: ''
        }))
        setCommandSelected(false)
        setImageSelected(false)
        setSlash(null)
        setMention(null)
        requestAnimationFrame(() => {
          const target = textareaRef.current
          if (!target) return
          target.focus()
          target.setSelectionRange(0, 0)
        })
        return
      }
      const prefix = currentDraft.text.trimEnd()
      const commandName = command.source === 'app' ? appCommandName(command.name, language) : command.name
      const next = `${prefix ? `${prefix}\n` : ''}/${commandName} `
      setText(next, targetKey)
      setSlash(null)
      setMention(null)
      requestAnimationFrame(() => {
        const target = textareaRef.current
        if (!target) return
        target.focus()
        target.setSelectionRange(next.length, next.length)
        target.scrollTop = target.scrollHeight
      })
    },
    [enterImageMode, language, readTargetDraft, patchDraft, setText]
  )

  const commandListOpen = Boolean(slash && !mention)
  const mentionListOpen = Boolean(mention)
  const activeListId = commandListOpen ? commandListId : mentionListOpen ? mentionListId : undefined
  const activeOptionId = commandListOpen && matching.length > 0
    ? `${commandListId}-option-${paletteIndex}`
    : mentionListOpen && mentionFiles.length > 0
      ? `${mentionListId}-option-${mentionIndex}`
      : undefined

  const pendingQueue = [
    ...queue.steering.map((value) => ({ kind: 'steer' as const, text: value })),
    ...queue.followUp.map((value) => ({ kind: 'followUp' as const, text: value }))
  ]

  const openChangesInspector = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('pi:open-inspector', { detail: { tab: 'changes' } })
    )
  }, [])
  const toggleImageMode = useCallback(() => {
    if (image) exitImageMode()
    else enterImageMode()
  }, [image, exitImageMode, enterImageMode])

  return (
    <div className="composer-wrap">
      <div className="composer-stack">
        {slash && !mention ? (
          <CommandPalette
            id={commandListId}
            commands={matching}
            query={slash.query}
            activeIndex={paletteIndex}
            language={language}
            loading={loadingSkillCommands}
            onActiveChange={setPaletteIndex}
            onSelect={insertCommand}
          />
        ) : null}

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

        {!hasDialogue ? (
          <div className="composer__top-selectors">
            <ProjectSelector placement="top" align="left" />
            {workspace ? (
              <BranchMenu
                placement="top"
                align="left"
                onOpenChanges={openChangesInspector}
              />
            ) : null}
          </div>
        ) : null}

        <GoalBar key={clientKey} />

        {undoEdit ? (
          <div className="composer__rewind" role="status">
            <span className="composer__rewind-text">
              {t('Editing hid the messages after it')}
            </span>
            <button
              type="button"
              className="composer__rewind-undo"
              onClick={() => void undoRewind()}
            >
              {t('Undo edit')}
            </button>
          </div>
        ) : null}

        <div
          className="composer"
          data-streaming={isStreaming}
          data-has-content={hasContent}
        >
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

          {images.length > 0 && !image ? (
            <div className="composer__queue">
              <div className="composer__attachments">
                {images.map((image, index) => (
                  <span className="composer__attachment" key={image.id}>
                    <ImageButton
                      src={`data:${image.mimeType};base64,${image.data}`}
                      alt="attachment"
                      inline={{ data: image.data, mimeType: image.mimeType }}
                    />
                    <button
                      type="button"
                      className="composer__attachment-remove"
                      onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))}
                      aria-label={`${t('Remove image')} ${index + 1}`}
                      title={`${t('Remove image')} ${index + 1}`}
                    >
                      <X size={10} />
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
                      onClick={() => setFiles((current) => current.filter((item) => item.id !== file.id))}
                      aria-label={`${t('Remove file')} ${file.name}`}
                      title={`${t('Remove file')} ${file.name}`}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          {image ? (
            <div className="composer__image-context" role="group" aria-label={t('Image generation')}>
              <div className="composer__image-refs">
                {images.map((attached, index) => (
                  <span className="composer__image-ref" key={attached.id}>
                    <ImageButton
                      src={`data:${attached.mimeType};base64,${attached.data}`}
                      alt="reference"
                      inline={{ data: attached.data, mimeType: attached.mimeType }}
                    />
                    <button
                      type="button"
                      className="composer__image-ref-remove"
                      onClick={() => setImages((current) => current.filter((item) => item.id !== attached.id))}
                      aria-label={`${t('Remove image')} ${index + 1}`}
                      title={`${t('Remove image')} ${index + 1}`}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  className="composer__image-ref-add"
                  onClick={() => void pickFiles()}
                  disabled={!canCompose || addingFiles}
                  aria-busy={addingFiles || undefined}
                  title={t('Reference')}
                >
                  {addingFiles ? (
                    <Loader2 size={18} strokeWidth={1.6} className="spin" aria-hidden="true" />
                  ) : (
                    <Plus size={18} strokeWidth={1.6} aria-hidden="true" />
                  )}
                  <span>{t('Reference')}</span>
                </button>
              </div>
            </div>
          ) : null}

          <div className="composer__input-row" data-image-mode={image && !command ? 'true' : undefined}>
            {command && CommandIcon ? (
              <span
                className="composer__command"
                data-source={command.source}
                data-selected={commandSelected}
                data-script={commandHasNonAscii ? 'cjk' : 'ascii'}
                role="group"
                aria-label={`${t('Command')}: ${commandName}`}
                title={`${commandName} · ${t('Press Backspace twice to remove')}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  setCommandSelected(false)
                  textareaRef.current?.focus()
                }}
              >
                <span className="composer__command-icon" aria-hidden="true">
                  <CommandIcon size={13} strokeWidth={2} />
                </span>
                <span className="composer__command-label">{commandLabel}</span>
              </span>
            ) : image ? (
              <span
                className="composer__image-badge"
                data-selected={imageSelected || undefined}
                role="group"
                aria-label={t('Image generation')}
                title={`${t('Image generation')} · ${t('Press Backspace twice to remove')}`}
                onMouseDown={(event) => {
                  event.preventDefault()
                  setImageSelected(false)
                  textareaRef.current?.focus()
                }}
              >
                <ImageModeGlyph />
                <span className="composer__image-badge-label">{t('Image generation')}</span>
              </span>
            ) : null}

            <textarea
            ref={textareaRef}
            className={
              command || image
                ? image && !command
                  ? 'composer__input composer__input--command composer__input--image'
                  : 'composer__input composer__input--command'
                : 'composer__input'
            }
            rows={1}
            value={text}
            disabled={!canCompose}
            role="combobox"
            aria-autocomplete="list"
            aria-haspopup="listbox"
            aria-expanded={commandListOpen || mentionListOpen}
            aria-controls={activeListId}
            aria-activedescendant={activeOptionId}
            aria-label={inputPrompt}
            placeholder={inputPrompt}
            onFocus={() => prewarmRuntime()}
            onChange={(event) => {
              const value = event.target.value
              const cursor = event.target.selectionStart ?? value.length
              const recognized = command ? undefined : recognizeCommandInput(value, commands, language)
              if (recognized) {
                const argumentStart = value.length - recognized.argument.length
                const argumentCursor = Math.max(0, Math.min(recognized.argument.length, cursor - argumentStart))
                if (recognized.command.source === 'app' && recognized.command.name === 'image') {
                  const trimmedArg = recognized.argument.trim().toLowerCase()
                  patchDraft(draftKeyRef.current, (prev) => ({
                    ...prev,
                    command: undefined,
                    image: trimmedArg === 'off' ? undefined : (prev.image ?? defaultImageOptions()),
                    text: trimmedArg === 'off' ? '' : recognized.argument
                  }))
                  setCommandSelected(false)
                  setImageSelected(false)
                  setSlash(null)
                  setMention(trimmedArg === 'off' ? null : detectMention(recognized.argument, argumentCursor))
                  setPaletteIndex(0)
                  requestAnimationFrame(() => {
                    const target = textareaRef.current
                    if (!target) return
                    const nextPos = trimmedArg === 'off' ? 0 : argumentCursor
                    target.setSelectionRange(nextPos, nextPos)
                  })
                  return
                }
                patchDraft(draftKeyRef.current, (prev) => ({
                  ...prev,
                  command: recognized.command,
                  text: recognized.argument
                }))
                setCommandSelected(false)
                setImageSelected(false)
                setSlash(null)
                setMention(detectMention(recognized.argument, argumentCursor))
                setPaletteIndex(0)
                requestAnimationFrame(() => {
                  const target = textareaRef.current
                  if (!target) return
                  target.setSelectionRange(argumentCursor, argumentCursor)
                })
                return
              }
              setText(value)
              setCommandSelected(false)
              setImageSelected(false)
              setSlash(command ? null : detectSlash(value, cursor))
              setMention(detectMention(value, cursor))
              setPaletteIndex(0)
            }}
            onKeyDown={onKeyDown}
            onClick={(event) => {
              setCommandSelected(false)
              setImageSelected(false)
              const cursor = event.currentTarget.selectionStart ?? text.length
              setSlash(command ? null : detectSlash(text, cursor))
              setMention(detectMention(text, cursor))
            }}
            onBlur={() => {
              setCommandSelected(false)
              setImageSelected(false)
              // Let a click on a list item land before the list disappears.
              window.setTimeout(() => {
                setSlash(null)
                setMention(null)
              }, 120)
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
              const files = event.clipboardData?.files
              if (files && files.length) {
                event.preventDefault()
                void addFiles(files)
              }
            }}
            onDrop={(event) => {
              event.preventDefault()
              void addFiles(event.dataTransfer?.files ?? null)
            }}
          />
          </div>

          <div className="composer__bar" data-streaming={isStreaming} data-ready={canCompose}>
            <AddMenu
              ready={canCompose}
              busy={isStreaming}
              imageMode={Boolean(image)}
              skillCommands={skillCommands}
              pluginCommands={pluginCommands}
              onModeChange={setAgentMode}
              onPickFiles={pickFiles}
              onInsertCommand={insertMenuCommand}
              onEnterImageMode={toggleImageMode}
            />
            <PermissionPicker />
            {/* The mode chip sits *after* the permission control: it only
                exists while a task mode is on, and in front of that control it
                pushed 完全访问 sideways the moment a mode was picked. The
                permission control keeps one position; the chip grows to its
                right. */}
            {showModeChip && agentMode === 'swarm' ? (
              <div className="composer__swarm-mode">
                <button
                  type="button"
                  className="composer__swarm-roster"
                  aria-label={t('Open Swarm team')}
                  title={t('Open Swarm team')}
                  onClick={onOpenSwarm}
                >
                  <Network size={13} aria-hidden="true" />
                  <span>{t('Swarm Mode')}</span>
                </button>
                <button
                  type="button"
                  className="composer__mode"
                  title={isStreaming ? t('Stop the current run before changing modes') : t('Leave Swarm Mode')}
                  aria-label={t('Leave Swarm Mode')}
                  disabled={isStreaming || !canCompose}
                  onClick={() => void setAgentMode('default')}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            ) : showModeChip ? (
              <button
                type="button"
                className="composer__mode"
                title={isStreaming ? t('Stop the current run before changing modes') : t(modeChip.leave)}
                aria-label={t(modeChip.leave)}
                disabled={isStreaming || !canCompose}
                onClick={() => void setAgentMode('default')}
              >
                {agentMode === 'goal' ? (
                  <GoalTargetIcon />
                ) : agentMode === 'plan' ? (
                  <ListChecks size={13} />
                ) : (
                  <Wrench size={13} />
                )}
                <span>{t(modeChip.label)}</span>
                <X size={11} />
              </button>
            ) : null}
            {image ? (
              <>
                <ImageModelPicker value={image.model} onChange={setImageOption} />
                <ImageParamsPicker image={image} onChange={setImageOption} />
              </>
            ) : null}

            <div className="composer__bar-spacer" />

            {/* Kept mounted when Pi is cold or restarting. Unmounting it on
                anything but `ready` is what made the model control vanish. */}
            <ModelPicker />

            {isStreaming && (!hasContent || submitting) ? (
              <button
                type="button"
                className="btn composer__send composer__send--stop"
                data-aborting={aborting || undefined}
                disabled={aborting}
                onClick={() => void stop()}
                aria-label={aborting ? t('Stopping…') : t('Stop the current run (Esc)')}
                title={aborting ? t('Stopping…') : t('Stop the current run (Esc)')}
              >
                <Square size={12} fill="currentColor" strokeWidth={0} />
              </button>
            ) : (
              <button
                type="button"
                className="btn btn--primary composer__send"
                onClick={submit}
                disabled={!canCompose || addingFiles || submitting || !hasContent}
                aria-busy={addingFiles || submitting || undefined}
                aria-label={t('Send message')}
                title={t('Send message')}
              >
                {addingFiles || submitting ? <Loader2 size={15} className="spin" /> : <ArrowUp size={18} strokeWidth={2.6} />}
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
              onClick={() => void stop()}
              aria-label={aborting ? t('Stopping…') : t('Stop the current run (Esc)')}
              title={aborting ? t('Stopping…') : t('Stop the current run (Esc)')}
            >
              <Square size={10} fill="currentColor" strokeWidth={0} />
              {aborting ? t('Stopping…') : t('Stop')}
            </button>
          </div>
        ) : null}
        <UsageBar />
      </div>
    </div>
  )
})

/** Filled rounded photo mark for the inline image-mode chip, punched out in currentColor. */
function ImageModeGlyph() {
  return (
    <svg
      className="composer__image-badge-icon"
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M4 2.25H12Q14.5 2.25 14.5 4.75V11.25Q14.5 13.75 12 13.75H4Q1.5 13.75 1.5 11.25V4.75Q1.5 2.25 4 2.25ZM5.35 4.55A1.2 1.2 0 1 0 5.35 6.95A1.2 1.2 0 1 0 5.35 4.55ZM3.45 12.15L12.55 12.15Q13 12.15 12.76 11.75L10.55 7.6Q10.18 6.95 9.72 7.52L7.35 10.4L6.45 9.52Q6 9.08 5.58 9.54L3.22 11.75Q2.92 12.15 3.45 12.15Z"
      />
    </svg>
  )
}

/** The image model, as a chip in the composer bar rather than a form row. */
function ImageModelPicker({
  value,
  onChange
}: {
  value: string
  onChange: (patch: Partial<ComposerImageOptions>) => void
}) {
  const t = useT()
  return (
    <Popover
      placement="top"
      align="left"
      width={300}
      className="composer__image-model"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className="model-chip composer__image-chip composer__image-chip--model"
          data-active={open || undefined}
          aria-expanded={open}
          title={t('Image model')}
          onClick={toggle}
        >
          <ImageIcon size={14} strokeWidth={1.75} aria-hidden="true" />
          <span className="model-chip__name">
            {value ? imageModelName(value) : t('Gateway default')}
          </span>
        </button>
      )}
    >
      {(close) => (
        <div className="composer__image-model-list">
          <div className="popover__label">{t('Model')}</div>
          <button
            type="button"
            className="popover__item"
            role="menuitem"
            onClick={() => { onChange({ model: '' }); close() }}
          >
            <span className="popover__item-text">{t('Gateway default')}</span>
            {!value ? <Check size={14} /> : null}
          </button>
          {IMAGE_MODELS.map((id) => (
            <button
              key={id}
              type="button"
              className="popover__item"
              role="menuitem"
              onClick={() => { onChange({ model: id }); close() }}
            >
              <span className="popover__item-text">{imageModelName(id)}</span>
              {value === id ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}

/** Ratio, quality and count behind one compact chip, in the reference layout. */
function ImageParamsPicker({
  image,
  onChange
}: {
  image: ComposerImageOptions
  onChange: (patch: Partial<ComposerImageOptions>) => void
}) {
  const t = useT()
  const ratio = imageRatioLabel(image.size)
  const quality = imageQualityLabel(image.quality, t)
  return (
    <Popover
      placement="top"
      align="left"
      width={480}
      className="image-params-popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className="model-chip composer__image-chip composer__image-chip--params"
          data-active={open || undefined}
          aria-expanded={open}
          title={t('Image size and quality')}
          onClick={toggle}
        >
          <span>{ratio === 'Auto' ? t('Auto') : ratio}</span>
          <span className="composer__image-chip-sep" aria-hidden="true" />
          <span>{quality}</span>
          {image.count > 1 ? (
            <>
              <span className="composer__image-chip-sep" aria-hidden="true" />
              <span>{image.count}</span>
            </>
          ) : null}
        </button>
      )}
    >
      {() => (
        <div className="image-params">
          <div className="image-params__section">
            <div className="image-params__label">{t('Ratio')}</div>
            <div className="image-params__ratios">
              {IMAGE_RATIO_OPTIONS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className="image-params__ratio"
                  data-active={option.value === image.size ? 'true' : undefined}
                  aria-pressed={option.value === image.size}
                  onClick={() => onChange({ size: option.value })}
                >
                  <span className="image-params__ratio-icon" data-shape={option.shape} aria-hidden="true">
                    {option.shape === 'auto' ? <Sparkles size={14} /> : null}
                  </span>
                  <span>{option.label === 'Auto' ? t('Auto') : option.label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="image-params__section">
            <div className="image-params__label">{t('Quality')}</div>
            <div className="image-params__segments">
              {IMAGE_QUALITIES.map((value) => (
                <button
                  key={value}
                  type="button"
                  data-active={value === image.quality ? 'true' : undefined}
                  aria-pressed={value === image.quality}
                  onClick={() => onChange({ quality: value })}
                >
                  {imageQualityLabel(value, t)}
                </button>
              ))}
            </div>
          </div>
          <div className="image-params__section">
            <div className="image-params__label">{t('Count')}</div>
            <div className="image-params__segments image-params__segments--count">
              {[1, 2, 3, 4].map((value) => (
                <button
                  key={value}
                  type="button"
                  data-active={value === image.count ? 'true' : undefined}
                  aria-pressed={value === image.count}
                  onClick={() => onChange({ count: value })}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </Popover>
  )
}

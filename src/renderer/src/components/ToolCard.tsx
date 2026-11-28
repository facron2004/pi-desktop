import { memo, useEffect, useMemo, useState } from 'react'
import {
  Ban,
  Bot,
  ChevronRight,
  CircleAlert,
  CornerDownLeft,
  FileSearch,
  FileText,
  FolderOpen,
  ImagePlus,
  ListChecks,
  MessagesSquare,
  Monitor,
  Pencil,
  Play,
  Search,
  SquareTerminal,
  WandSparkles,
  Wrench
} from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import type { ToolItem } from '../lib/thread'
import { diffableEdits, summarizeTool, writtenContent } from '../lib/tool-renderers'
import { formatDuration } from '../lib/format'
import { buildDiff } from '../lib/diff-fold'
import { formatDiff } from '../lib/diff-text'
import { basename, relativePath } from '../lib/path'
import { subagentCalls, type SubagentTreeTask } from '../lib/subagents'
import { readToolFull, readToolOpen, writeToolFull, writeToolOpen } from '../lib/view-state'
import { useConversationValue } from '../hooks/useConversationValue'
import { CopyButton } from './conversation/CopyButton'
import { ImageButton, inlineOfDataUrl } from './Lightbox'
import { ToolResultPanel } from './conversation/ToolResultPanel'
import { useThreadEnv } from './conversation/ThreadEnvContext'
import { runInTerminal } from './conversation/tool-actions'
import { useT } from '../lib/i18n'
import { ErrorBoundary } from './ErrorBoundary'

const TONE_ICONS = {
  read: FileText,
  edit: Pencil,
  command: SquareTerminal,
  search: Search,
  subagent: Bot,
  plan: ListChecks,
  computer: Monitor,
  image: WandSparkles,
  generic: Wrench
} as const

// A bash execution card is one of the stream's leaves now; the stream still
// imports it from this module, so the old name is re-exported.
export { CommandOutput as BashCard } from './conversation/CommandOutput'

/**
 * One tool call as a row in the execution stream.
 *
 * The row is the whole story of the call in 32–40 pixels: what it touched,
 * how it ended and how long it took. Everything else — arguments, output,
 * a diff — is behind the caret, so a turn with a dozen calls stays scannable.
 *
 * The status comes from the node, which the reducer moves through
 * proposed → running → ok/error/aborted. A call that was named but never
 * executed stays `proposed` and says so: it did not succeed.
 */
export const ToolCard = memo(function ToolCard({
  item,
  expanded,
  onExpandedChange,
  presentation = 'card',
  hidePrompt = false
}: {
  item: ToolItem
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /**
   * `link` is the stream row: a verb and a target, the way a file or a
   * command is a link rather than a card with its own toolbar.
   */
  presentation?: 'card' | 'link'
  /** The reply already quotes the image prompt, so the fold must not repeat it. */
  hidePrompt?: boolean
}) {
  const { threadKey, insertIntoComposer, workspacePath, language, askSideChat } = useThreadEnv()
  const [manualOpen, setManualOpen] = useConversationValue(
    `${threadKey}\0${item.id}`,
    () => readToolOpen(threadKey, item.id)
  )
  const setOpen = (open: boolean | undefined) => {
    setManualOpen(open)
    writeToolOpen(threadKey, item.id, open)
  }
  // A link stays one line until it is opened. A card still opens itself on
  // failure, because there the failure is the whole of what the row is for.
  const open = expanded ?? manualOpen ?? (presentation !== 'link' && item.status === 'error')
  const toggleOpen = () => {
    if (onExpandedChange) {
      onExpandedChange(!open)
      writeToolOpen(threadKey, item.id, !open)
    } else setOpen(!open)
  }
  const [full, setFullState] = useConversationValue(
    `${threadKey}\0${item.id}\0full`,
    () => readToolFull(threadKey, item.id)
  )
  const setFull = (value: boolean) => {
    setFullState(value)
    writeToolFull(threadKey, item.id, value)
  }
  const t = useT()

  const summary = useMemo(() => summarizeTool(item), [item])
  const Icon = TONE_ICONS[summary.tone]
  const edits = useMemo(() => diffableEdits(item), [item])
  const diffs = useMemo(
    () => (open && edits.length > 0 ? edits.map((pair) => buildDiff(pair.oldText, pair.newText)) : []),
    [open, edits]
  )
  const content = useMemo(() => writtenContent(item), [item])

  const result = item.result ?? ''

  /**
   * What the copy button takes.
   *
   * The card shows the diff of an edit and the written file of a write, so
   * that is what leaves the app — anything else would copy a line of text
   * that is nowhere on the screen.
   */
  const copyable: { label: string; text: string | (() => string) } = useMemo(() => {
    if (item.status === 'error') {
      return { label: 'Copy the result', text: result }
    }
    if (item.toolName === 'generate_image') {
      const promptText = typeof item.args?.prompt === 'string' ? item.args.prompt.trim() : ''
      if (promptText) return { label: 'Copy prompt', text: promptText }
    }
    if (edits.length > 0) {
      if (open && diffs.length > 0) {
        return { label: 'Copy the diff', text: formatDiff(diffs) }
      }
      return {
        label: 'Copy the diff',
        text: () => formatDiff(edits.map((pair) => buildDiff(pair.oldText, pair.newText)))
      }
    }
    if (content) {
      return { label: 'Copy the file', text: content }
    }
    return { label: 'Copy the result', text: result }
  }, [item.status, item.toolName, item.args?.prompt, result, edits, open, diffs, content])

  // A command or a file path can be handed back to the composer, so the
  // user can build on it without copying it by hand.
  const reuse =
    item.toolName === 'bash' || item.toolName === 'powershell'
      ? { label: 'Reuse this command', text: String(item.args?.command ?? '') }
      : item.toolName === 'read' || item.toolName === 'edit' || item.toolName === 'write'
        ? {
            label: 'Ask about this file',
            text: relativePath(workspacePath ?? '', String(item.args?.path ?? ''))
          }
        : null
  const imagePrompt =
    item.toolName === 'generate_image' && typeof item.args?.prompt === 'string'
      ? item.args.prompt.trim()
      : ''
  const reuseImage = () => {
    if (!imagePrompt) return
    window.dispatchEvent(
      new CustomEvent('pi:enter-image-mode', {
        detail: {
          prompt: imagePrompt,
          options: imageOptionsFromItem(item)
        }
      })
    )
  }

  // A shell command can also be run again in the terminal drawer, where its
  // output stays out of the conversation.
  const terminalCommand =
    item.toolName === 'bash' || item.toolName === 'powershell'
      ? String(item.args?.command ?? '')
      : ''

  // A line of the diff leads to that line of the file, so a change can be
  // followed into the code around it.
  const editedFile = item.toolName === 'edit' ? String(item.args?.path ?? '') : ''
  const openLine = (line: number) => {
    if (!editedFile) return
    window.dispatchEvent(
      new CustomEvent<InspectorRequest>('pi:open-inspector', {
        detail: { tab: 'files', file: editedFile, line }
      })
    )
  }

  // A card about a file can open that file in the viewer.
  const viewedFile =
    item.toolName === 'read' || item.toolName === 'edit' || item.toolName === 'write'
      ? String(item.args?.path ?? '')
      : ''

  // The state of a call is its own; the icon follows it rather than the
  // tone, so a failed read still looks like a read that failed.
  const state =
    item.status === 'error'
      ? 'error'
      : item.status === 'aborted'
        ? 'aborted'
        : item.status === 'proposed'
          ? 'proposed'
          : item.status === 'running'
            ? 'running'
            : 'ok'
  const commandTool = item.toolName === 'bash' || item.toolName === 'powershell'
  const fileAction = item.toolName === 'read' || item.toolName === 'edit' || item.toolName === 'write'
  const subagentTasks = presentation === 'link' && item.toolName === 'subagent'
    ? subagentCalls([item])[0]?.tasks ?? []
    : []
  const taskNames = subagentTasks.map((task) => shortTaskName(task.label || task.task))
  const taskNamesTitle = subagentTasks.map((task) => task.label || task.task).join('\n')
  const linkVerb = commandTool
    ? t(
        state === 'running'
          ? 'Running command'
          : state === 'error'
            ? 'Command failed'
            : state === 'aborted'
              ? 'Command stopped'
              : state === 'proposed'
                ? 'Command not run'
                : 'Ran command'
      )
    : item.toolName === 'read'
      ? t(
          state === 'running'
            ? 'Reading file'
            : state === 'error'
              ? 'File read failed'
              : state === 'aborted'
                ? 'File read stopped'
                : state === 'proposed'
                  ? 'File read not run'
                  : 'Read file'
        )
      : item.toolName === 'edit'
        ? t(
            state === 'running'
              ? 'Editing file'
              : state === 'error'
                ? 'File edit failed'
                : state === 'aborted'
                  ? 'File edit stopped'
                  : state === 'proposed'
                    ? 'File edit not run'
                    : 'Edited file'
          )
        : item.toolName === 'write'
          ? t(
              state === 'running'
                ? 'Writing file'
                : state === 'error'
                  ? 'File write failed'
                  : state === 'aborted'
                    ? 'File write stopped'
                    : state === 'proposed'
                      ? 'File write not run'
                      : 'Wrote file'
            )
          : subagentTasks.length > 0
            ? joinTaskNames(taskNames, language)
            : t(summary.label)
  const StateIcon =
    item.status === 'error'
      ? CircleAlert
      : item.status === 'aborted'
        ? Ban
        : null

  const openViewedFile = () => {
    if (!viewedFile) return
    window.dispatchEvent(
      new CustomEvent<InspectorRequest>('pi:open-inspector', {
        detail: { tab: 'files', file: viewedFile }
      })
    )
  }
  const linkText = commandTool
    ? summary.detail
    : subagentTasks.length > 0
      ? t(subagentStatusPhrase(subagentTasks))
      : viewedFile
        ? relativePath(workspacePath ?? '', viewedFile) || summary.detail
        : summary.detail

  const details = (
    <ToolResultPanel
      item={item}
      open={open}
      full={full}
      onFullChange={setFull}
      diffs={diffs}
      content={content}
      onOpenLine={editedFile ? openLine : undefined}
      hideImagePrompt={hidePrompt}
    />
  )

  if (presentation === 'link') {
    const failure = state === 'error' && result.length <= 180 ? result.trim() : ''
    const failurePreview = /^[^\r\n]+$/.test(failure) ? failure : ''
    const targetText = failurePreview || linkText
    return (
      <ErrorBoundary inline scope="tool card">
        <div className="tool tool--link" data-tone={summary.tone} data-status={state}>
          <div className="tool-link">
            <button
              type="button"
              className="tool-link__toggle"
              aria-expanded={open}
              onClick={toggleOpen}
            >
              <ChevronRight size={13} className="caret" data-open={open} />
              <span className="tool-link__icon">
                <Icon size={12} strokeWidth={2.2} />
              </span>
              <span className="tool-link__verb">{linkVerb}</span>
            </button>
            {targetText ? viewedFile && state !== 'error' && !subagentTasks.length && !commandTool ? (
              <button
                type="button"
                className="tool-link__target"
                title={t('Open this file')}
                onClick={openViewedFile}
              >
                {linkText}
              </button>
            ) : (
              <button
                type="button"
                className="tool-link__target"
                data-monospace={subagentTasks.length || failurePreview ? 'false' : undefined}
                title={
                  subagentTasks.length
                    ? taskNamesTitle
                    : commandTool
                      ? String(item.args?.command ?? linkText)
                      : viewedFile || linkText || targetText
                }
                onClick={toggleOpen}
              >
                {targetText}
              </button>
            ) : null}
            {StateIcon ? (
              <StateIcon size={13} color={item.status === 'error' ? 'var(--status-danger)' : undefined} />
            ) : null}
            {!commandTool && !fileAction && !subagentTasks.length && (item.status === 'proposed' || item.status === 'error' || item.status === 'aborted') ? (
              <span className="tool-link__state" data-state={state}>
                {t(stateLabel(item.status))}
              </span>
            ) : null}
            {item.durationMs !== undefined && item.status !== 'running' ? (
              <span className="tool-link__time">{formatDuration(item.durationMs)}</span>
            ) : null}
            {askSideChat ? (
              <button
                type="button"
                className="tool-link__ask-side"
                title={t('Ask Side Chat about this tool call')}
                aria-label={t('Ask Side Chat about this tool call')}
                onClick={(event) => {
                  const turnId = event.currentTarget.closest<HTMLElement>('[data-turn]')?.dataset.turn
                  askSideChat({
                    kind: 'tool',
                    ...(turnId ? { turnId } : {}),
                    toolCallId: item.toolCallId,
                    toolName: item.toolName,
                    summary: linkText || summary.detail || item.toolName,
                    status: state
                  })
                }}
              >
                <MessagesSquare size={12} aria-hidden="true" />
              </button>
            ) : null}
          </div>
          {details}
          {item.toolName === 'generate_image' ? <GeneratedImageStrip item={item} /> : null}
        </div>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary inline scope="tool card">
      <div className="tool" data-tone={summary.tone} data-status={state}>
        <div className="tool__head">
          <button className="tool__head-main" aria-expanded={open} onClick={toggleOpen}>
            <span className="tool__icon">
              <Icon size={12} strokeWidth={2.2} />
            </span>
            <span className="tool__name">{t(summary.label)}</span>
            <span className="tool__summary" title={summary.detail}>
              {summary.detail}
            </span>
            {StateIcon ? (
              <StateIcon size={13} color={item.status === 'error' ? 'var(--status-danger)' : undefined} />
            ) : null}
            {item.durationMs !== undefined ? (
              <span className="tool__status">{formatDuration(item.durationMs)}</span>
            ) : null}
            <span className="tool__state" data-state={state}>
              {t(stateLabel(item.status))}
            </span>
          </button>

          {viewedFile ? (
            <button
              className="tool__reuse-icon"
              title={t('Open this file')}
              aria-label={t('Open this file')}
              onClick={openViewedFile}
            >
              <FileSearch size={12} />
            </button>
          ) : null}

          {imagePrompt ? (
            <button
              className="tool__reuse-icon"
              title={t('Reuse in image generator')}
              aria-label={t('Reuse in image generator')}
              onClick={reuseImage}
            >
              <CornerDownLeft size={12} />
            </button>
          ) : null}

          {reuse ? (
            <button
              className="tool__reuse-icon"
              title={t(reuse.label)}
              aria-label={t(reuse.label)}
              onClick={() => insertIntoComposer(reuse.text)}
            >
              <CornerDownLeft size={12} />
            </button>
          ) : null}

          {terminalCommand ? (
            <button
              className="tool__reuse-icon"
              title={t('Run in terminal')}
              aria-label={t('Run in terminal')}
              onClick={() => runInTerminal(terminalCommand)}
            >
              <Play size={12} />
            </button>
          ) : null}

          {askSideChat ? (
            <button
              type="button"
              className="tool__reuse-icon"
              title={t('Ask Side Chat about this tool call')}
              aria-label={t('Ask Side Chat about this tool call')}
              onClick={(event) => {
                const turnId = event.currentTarget.closest<HTMLElement>('[data-turn]')?.dataset.turn
                askSideChat({
                  kind: 'tool',
                  ...(turnId ? { turnId } : {}),
                  toolCallId: item.toolCallId,
                  toolName: item.toolName,
                  summary: summary.detail || linkText || item.toolName,
                  status: state
                })
              }}
            >
              <MessagesSquare size={12} aria-hidden="true" />
            </button>
          ) : null}

          <CopyButton text={copyable.text} label={t(copyable.label)} />

          <button
            className="tool__caret"
            onClick={toggleOpen}
            aria-label={open ? t('Collapse') : t('Expand')}
            aria-expanded={open}
          >
            <ChevronRight size={13} className="caret" data-open={open} />
          </button>
        </div>

        {details}
        {item.toolName === 'generate_image' ? <GeneratedImageStrip item={item} /> : null}
      </div>
    </ErrorBoundary>
  )
})

function imageOptionsFromItem(item: ToolItem): {
  model?: string
  size?: string
  quality?: string
  count?: number
} {
  const detailsModel =
    item.details && typeof item.details === 'object' && typeof (item.details as { model?: unknown }).model === 'string'
      ? (item.details as { model: string }).model.trim()
      : ''
  const argModel = typeof item.args?.model === 'string' ? item.args.model.trim() : ''
  const model = detailsModel || argModel
  const size = typeof item.args?.size === 'string' && item.args.size.trim() ? item.args.size.trim() : undefined
  const quality = typeof item.args?.quality === 'string' && item.args.quality.trim() ? item.args.quality.trim() : undefined
  const rawCount = Number(item.args?.n)
  const count = Number.isFinite(rawCount) ? Math.min(4, Math.max(1, Math.round(rawCount))) : undefined
  return {
    ...(model ? { model } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(quality !== undefined ? { quality } : {}),
    ...(count !== undefined ? { count } : {})
  }
}

function useGeneratedImageAsReference(src: string, path: string, item: ToolItem): void {
  const inline = inlineOfDataUrl(src)
  if (!inline) return
  window.dispatchEvent(
    new CustomEvent('pi:enter-image-mode', {
      detail: {
        referenceImage: {
          data: inline.data,
          mimeType: inline.mimeType,
          name: basename(path) || 'reference.png'
        },
        options: imageOptionsFromItem(item)
      }
    })
  )
}

/**
 * The pictures a `generate_image` call produced.
 *
 * The tool already wrote them into the project; this strip reads them through
 * the same verified image bridge as the Images page, so the conversation shows
 * the result without a second copy of the bytes.
 */
function GeneratedImageStrip({ item }: { item: ToolItem }) {
  const t = useT()
  const details = item.details
  const paths = useMemo(() => {
    if (!details || typeof details !== 'object') return []
    const list = (details as { paths?: unknown }).paths
    return Array.isArray(list)
      ? list.filter((path): path is string => typeof path === 'string' && path.length > 0)
      : []
  }, [details])
  const [previews, setPreviews] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    const missing = paths.filter((path) => !previews[path])
    if (!missing.length) return
    void Promise.all(
      missing.map(async (path) => {
        const data = await window.pi.fs.readImageDataUrl(path).catch(() => null)
        return data ? ([path, data] as const) : null
      })
    ).then((entries) => {
      if (cancelled) return
      const found = entries.filter((entry): entry is readonly [string, string] => entry !== null)
      if (found.length) {
        setPreviews((current) => ({ ...current, ...Object.fromEntries(found) }))
      }
    })
    return () => { cancelled = true }
  }, [paths])

  const loaded = paths.filter((path) => previews[path])
  if (!loaded.length) {
    if (item.status === 'running') {
      const rawCount = Number(item.args?.n)
      const count = Number.isFinite(rawCount) ? Math.min(4, Math.max(1, Math.round(rawCount))) : 1
      return (
        <div className="tool__images" data-running="true" data-count={count}>
          {Array.from({ length: count }, (_, index) => (
            <div className="tool__image-placeholder" key={index} role="status">
              <span className="spinner" aria-hidden="true" />
              <span>{t('Generating an image')}</span>
            </div>
          ))}
        </div>
      )
    }
    return null
  }
  return (
    <div className="tool__images" data-count={loaded.length}>
      {loaded.map((path) => {
        const src = previews[path]
        const name = basename(path)
        return (
          <div className="tool__image-item" key={path}>
            <ImageButton
              src={src}
              alt={name}
              title={name}
              filePath={path}
              onUseAsReference={() => useGeneratedImageAsReference(src, path, item)}
            />
            <div className="tool__image-actions">
              <button
                type="button"
                className="tool__image-action"
                onClick={() => useGeneratedImageAsReference(src, path, item)}
                title={t('Use as reference')}
                aria-label={t('Use as reference')}
              >
                <ImagePlus size={12} aria-hidden="true" />
                <span>{t('Reference')}</span>
              </button>
              <button
                type="button"
                className="tool__image-action tool__image-action--icon"
                onClick={() => void window.pi.fs.reveal(path)}
                title={t('Reveal in the file manager')}
                aria-label={t('Reveal in the file manager')}
              >
                <FolderOpen size={12} aria-hidden="true" />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function shortTaskName(value: string): string {
  const firstLine = value.trim().split(/\r?\n/, 1)[0] || 'Subagent'
  return firstLine.length > 48 ? `${firstLine.slice(0, 47)}…` : firstLine
}

function joinTaskNames(names: string[], language: string): string {
  const visible = names.length > 3
    ? [...names.slice(0, 2), language === 'zh-CN' ? `+${names.length - 2}` : `+${names.length - 2} more`]
    : names
  const joined = language === 'zh-CN'
    ? visible.join('、')
    : visible.length < 2
      ? visible[0] ?? ''
      : visible.length === 2
        ? `${visible[0]} and ${visible[1]}`
        : `${visible.slice(0, -1).join(', ')}, and ${visible.at(-1)}`
  return joined.length > 88 ? `${joined.slice(0, 87)}…` : joined
}

function subagentStatusPhrase(tasks: SubagentTreeTask[]): string {
  if (tasks.every((task) => task.status === 'proposed')) return 'Not run'
  if (tasks.some((task) => task.status === 'running')) {
    return tasks.some((task) => task.status === 'completed') ? 'Still working' : 'Started working'
  }
  if (tasks.some((task) => task.status === 'queued')) return 'Queued'
  if (tasks.some((task) => task.status === 'failed' || task.status === 'timed_out')) return 'Finished with errors'
  if (tasks.some((task) => task.status === 'completed') && tasks.some((task) => task.status === 'aborted')) {
    return 'Partially stopped'
  }
  if (tasks.every((task) => task.status === 'aborted')) return 'Stopped'
  return 'Finished'
}

/** The word for a tool status, in one place. */
function stateLabel(status: ToolItem['status']): string {
  switch (status) {
    case 'proposed':
      return 'Not run'
    case 'running':
      return 'Running'
    case 'error':
      return 'Failed'
    case 'aborted':
      return 'Stopped'
    default:
      return 'Completed'
  }
}

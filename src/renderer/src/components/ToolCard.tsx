import { memo, useEffect, useMemo, useState } from 'react'
import {
  Ban,
  Bot,
  ChevronRight,
  CircleAlert,
  CornerDownLeft,
  FileSearch,
  FileText,
  ListChecks,
  Monitor,
  Pencil,
  Play,
  Search,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import type { ToolItem } from '../lib/thread'
import { diffableEdits, summarizeTool, writtenContent } from '../lib/tool-renderers'
import { formatDuration } from '../lib/format'
import { buildDiff } from '../lib/diff-fold'
import { formatDiff } from '../lib/diff-text'
import { relativePath } from '../lib/path'
import { subagentCalls, type SubagentTreeTask } from '../lib/subagents'
import { useAppStore } from '../store/useAppStore'
import { readToolFull, readToolOpen, writeToolFull, writeToolOpen } from '../lib/view-state'
import { CopyButton } from './conversation/CopyButton'
import { ToolResultPanel } from './conversation/ToolResultPanel'
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
  presentation = 'card'
}: {
  item: ToolItem
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /**
   * `link` is the stream row: a verb and a target, the way a file or a
   * command is a link rather than a card with its own toolbar.
   */
  presentation?: 'card' | 'link'
}) {
  const threadKey = useAppStore((state) => state.activeSessionFile ?? state.draftId ?? 'draft')
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(() =>
    readToolOpen(threadKey, item.id)
  )
  useEffect(() => {
    setManualOpen(readToolOpen(threadKey, item.id))
  }, [threadKey, item.id])
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
  const [full, setFullState] = useState(() => readToolFull(threadKey, item.id))
  useEffect(() => {
    setFullState(readToolFull(threadKey, item.id))
  }, [threadKey, item.id])
  const setFull = (value: boolean) => {
    setFullState(value)
    writeToolFull(threadKey, item.id, value)
  }
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const workspacePath = useAppStore((state) => state.workspace?.path)
  const language = useAppStore((state) => state.settings.language ?? 'en')
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
  }, [item.status, result, edits, open, diffs, content])

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
    />
  )

  if (presentation === 'link') {
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
            {linkText ? viewedFile && !subagentTasks.length && !commandTool ? (
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
                data-monospace={subagentTasks.length ? 'false' : undefined}
                title={
                  subagentTasks.length
                    ? taskNamesTitle
                    : commandTool
                      ? String(item.args?.command ?? linkText)
                      : linkText
                }
                onClick={toggleOpen}
              >
                {linkText}
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
          </div>
          {details}
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
      </div>
    </ErrorBoundary>
  )
})

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

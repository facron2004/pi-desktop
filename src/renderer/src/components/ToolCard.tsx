import { memo, useEffect, useMemo, useState } from 'react'
import {
  Ban,
  ChevronRight,
  CircleAlert,
  CornerDownLeft,
  FileSearch,
  FileText,
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
import { useAppStore } from '../store/useAppStore'
import { readToolFull, readToolOpen, writeToolFull, writeToolOpen } from '../lib/view-state'
import { CopyButton } from './conversation/CopyButton'
import { ToolResultPanel } from './conversation/ToolResultPanel'
import { runInTerminal } from './conversation/tool-actions'
import { useT } from '../lib/i18n'

const TONE_ICONS = {
  read: FileText,
  edit: Pencil,
  command: SquareTerminal,
  search: Search,
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
  const setFull = (value: boolean) => {
    setFullState(value)
    writeToolFull(threadKey, item.id, value)
  }
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const workspace = useAppStore((state) => state.workspace)
  const t = useT()

  const summary = useMemo(() => summarizeTool(item), [item])
  const Icon = TONE_ICONS[summary.tone]
  const diffs = useMemo(
    () => diffableEdits(item).map((pair) => buildDiff(pair.oldText, pair.newText)),
    [item]
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
  const copyable =
    item.status === 'error'
      ? { label: 'Copy the result', text: result }
      : diffs.length > 0
        ? { label: 'Copy the diff', text: formatDiff(diffs) }
        : content
          ? { label: 'Copy the file', text: content }
          : { label: 'Copy the result', text: result }

  // A command or a file path can be handed back to the composer, so the
  // user can build on it without copying it by hand.
  const reuse =
    item.toolName === 'bash' || item.toolName === 'powershell'
      ? { label: 'Reuse this command', text: String(item.args?.command ?? '') }
      : item.toolName === 'read' || item.toolName === 'edit' || item.toolName === 'write'
        ? {
            label: 'Ask about this file',
            text: relativePath(workspace?.path ?? '', String(item.args?.path ?? ''))
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
  const linkText = viewedFile
    ? relativePath(workspace?.path ?? '', viewedFile) || summary.detail
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
            <span className="tool-link__verb">{t(summary.label)}</span>
          </button>
          {viewedFile ? (
            <button
              type="button"
              className="tool-link__target"
              title={t('Open this file')}
              onClick={openViewedFile}
            >
              {linkText}
            </button>
          ) : (
            <button type="button" className="tool-link__target" onClick={toggleOpen}>
              {linkText}
            </button>
          )}
          {item.status === 'running' ? <span className="spinner" /> : null}
          {StateIcon ? (
            <StateIcon size={13} color={item.status === 'error' ? 'var(--status-danger)' : undefined} />
          ) : null}
          {item.status === 'proposed' || item.status === 'error' || item.status === 'aborted' ? (
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
    )
  }

  return (
    <div className="tool" data-tone={summary.tone} data-status={state}>
      <div className="tool__head">
        <button className="tool__head-main" aria-expanded={open} onClick={toggleOpen}>
          <span className="tool__icon">
            <Icon size={12} strokeWidth={2.2} />
          </span>
          <span className="tool__name">{t(summary.label)}</span>
          <span className="tool__summary">{summary.detail}</span>
          {item.status === 'running' ? (
            <span className="spinner" />
          ) : StateIcon ? (
            <StateIcon size={13} color={item.status === 'error' ? 'var(--red)' : undefined} />
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
  )
})

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

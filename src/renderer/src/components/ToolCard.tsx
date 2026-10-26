import { memo, useMemo, useState } from 'react'
import {
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  CornerDownLeft,
  FileSearch,
  FileText,
  Pencil,
  Play,
  Search,
  SquareTerminal,
  Wrench,
  Ban
} from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import type { BashItem, ToolItem } from '../lib/thread'
import { diffableEdits, summarizeTool, writtenContent } from '../lib/tool-renderers'
import { formatDuration } from '../lib/format'
import { buildDiff } from '../lib/diff-fold'
import { formatDiff } from '../lib/diff-text'
import { languageOf } from '../lib/files'
import { basename, relativePath } from '../lib/path'
import { useAppStore } from '../store/useAppStore'
import { CodeSnippet } from './CodeSnippet'
import { DiffView } from './DiffView'
import { useT } from '../lib/i18n'

const TONE_ICONS = {
  read: FileText,
  edit: Pencil,
  command: SquareTerminal,
  search: Search,
  generic: Wrench
} as const

/** Results longer than this are collapsed behind a "show more" control. */
const RESULT_PREVIEW = 1200

/**
 * A button that copies a text and says so for a moment.
 *
 * The output of a command is often worth keeping, and copying it by hand
 * out of a long log is a nuisance.
 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()
  if (!text) return null
  return (
    <button
      className="tool__reuse-icon"
      title={t(label)}
      aria-label={t(label)}
      onClick={() => {
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          })
          .catch(() => {
            showToast(t('The clipboard is not available'), 'error')
          })
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
}

/**
 * Hands a command to the terminal drawer.
 *
 * The drawer is mounted by the app rather than by the card, so a card cannot
 * call the drawer's run path directly; the hand-off goes through the window
 * event the app listens for.
 */
function runInTerminal(command: string): void {
  window.dispatchEvent(new CustomEvent('pi:terminal-run', { detail: { command } }))
}

/**
 * A command Pi ran itself, rather than through a tool call.
 *
 * The output arrives in chunks while the command runs, so the card keeps the
 * body closed until it is asked for.
 */
export const BashCard = memo(function BashCard({ item }: { item: BashItem }) {
  const [manualOpen, setManualOpen] = useState<boolean>()
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const t = useT()
  const running = item.exitCode === undefined
  const failed = item.exitCode !== undefined && item.exitCode !== 0
  const status = failed ? 'error' : running ? 'running' : 'ok'
  const open = manualOpen ?? failed
  const toggleOpen = () => setManualOpen(!open)

  return (
    <div className="tool" data-tone="command" data-status={status}>
      <div className="tool__head">
        <button className="tool__head-main" aria-expanded={open} onClick={toggleOpen}>
          <span className="tool__icon">
            <SquareTerminal size={12} strokeWidth={2.2} />
          </span>
          <span className="tool__name">{item.excludeFromContext ? '!!bash' : 'bash'}</span>
          <span className="tool__summary">{item.command || t('running…')}</span>
          {item.excludeFromContext ? (
            <span className="tool__status" title={t('Excluded from model context')}>
              {t('no context')}
            </span>
          ) : null}
          {running ? (
            <span className="spinner" />
          ) : failed ? (
            <span className="tool__status">
              {t('exit')} {item.exitCode}
            </span>
          ) : null}
          <span className="tool__state" data-state={status}>
            {t(failed ? 'Failed' : running ? 'Running' : 'Completed')}
          </span>
        </button>
        {item.command ? (
          <>
            <button
              className="tool__reuse-icon"
              title={t('Reuse this command')}
              aria-label={t('Reuse this command')}
              onClick={() =>
                insertIntoComposer(
                  item.excludeFromContext ? `!!${item.command}` : `!${item.command}`
                )
              }
            >
              <CornerDownLeft size={12} />
            </button>
            <button
              className="tool__reuse-icon"
              title={t('Run in terminal')}
              aria-label={t('Run in terminal')}
              onClick={() => runInTerminal(item.command)}
            >
              <Play size={12} />
            </button>
          </>
        ) : null}
        <CopyButton text={item.output} label={t('Copy the output')} />
        <button
          className="tool__caret"
          onClick={toggleOpen}
          aria-label={open ? t('Collapse') : t('Expand')}
          aria-expanded={open}
        >
          <ChevronRight size={13} className="caret" data-open={open} />
        </button>
      </div>

      {open ? (
        <div className="tool__body">
          {item.output ? (
            <pre className={`tool__pre${failed ? ' tool__error' : ''}`}>{item.output}</pre>
          ) : (
            <pre className="tool__pre">{t('No output.')}</pre>
          )}
        </div>
      ) : null}
    </div>
  )
})

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
  onExpandedChange
}: {
  item: ToolItem
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
}) {
  const [manualOpen, setManualOpen] = useState<boolean>()
  const open = expanded ?? manualOpen ?? item.status === 'error'
  const toggleOpen = () => {
    if (onExpandedChange) onExpandedChange(!open)
    else setManualOpen(!open)
  }
  const [full, setFull] = useState(false)
  const diffSplit = useAppStore((state) => state.settings.diffSplit === true)
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
  const truncated = result.length > RESULT_PREVIEW
  const visibleResult = truncated && !full ? result.slice(0, RESULT_PREVIEW) : result

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

  // The file a card is about, so its content can be highlighted as code.
  const fileName = basename(String(item.args?.path ?? ''))
  const language = languageOf(fileName)

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

  return (
    <div className="tool" data-tone={summary.tone} data-status={state}>
      <div className="tool__head">
        <button className="tool__head-main" aria-expanded={open} onClick={toggleOpen}>
          <span className="tool__icon">
            <Icon size={12} strokeWidth={2.2} />
          </span>
          <span className="tool__name">{summary.label}</span>
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
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent<InspectorRequest>('pi:open-inspector', {
                  detail: { tab: 'files', file: viewedFile }
                })
              )
            }
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

      {open ? (
        <div className="tool__body">
          {item.status === 'error' && visibleResult ? (
            <pre className="tool__pre tool__error">{visibleResult}</pre>
          ) : null}

          {diffs.length > 0 ? (
            <DiffView
              diffs={diffs}
              mode={diffSplit ? 'split' : 'unified'}
              onOpenLine={editedFile ? openLine : undefined}
            />
          ) : null}

          {content ? <CodeSnippet code={content} language={language} /> : null}

          {item.toolName === 'bash' || item.toolName === 'powershell'
            ? // The header already shows the first line of the command, so
              // only a command that runs over several lines is repeated.
              String(item.args?.command ?? '').includes('\n') && (
                <pre className="tool__pre">{String(item.args?.command ?? '')}</pre>
              )
            : null}

          {visibleResult && item.status !== 'error' ? (
            item.toolName === 'read' ? (
              <CodeSnippet code={visibleResult} language={language} />
            ) : (
              <pre className="tool__pre">{visibleResult}</pre>
            )
          ) : null}

          {truncated ? (
            <button className="tool__more" onClick={() => setFull((value) => !value)}>
              {full
                ? t('Show less')
                : `${t('Show')} ${(result.length - RESULT_PREVIEW).toLocaleString()} ${t('more characters')}`}
            </button>
          ) : null}

          {!diffs.length && !visibleResult && !content ? (
            <pre className="tool__pre">{JSON.stringify(item.args ?? {}, null, 2)}</pre>
          ) : null}
        </div>
      ) : null}
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

import { useMemo, useState } from 'react'
import {
  ChevronRight,
  CircleAlert,
  CornerDownLeft,
  FilePlus,
  FileText,
  Pencil,
  Search,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import type { BashItem, ToolItem } from '../lib/thread'
import { describeTool, editPairs, type ToolTone } from '../lib/tools'
import { formatDuration } from '../lib/format'
import { relativePath } from '../lib/path'
import { useAppStore } from '../store/useAppStore'
import { buildDiff, DiffView } from './DiffView'

export const TOOL_ICONS: Record<ToolTone | 'error', typeof FileText> = {
  read: FileText,
  edit: Pencil,
  exec: SquareTerminal,
  write: FilePlus,
  search: Search,
  generic: Wrench,
  error: CircleAlert
}

/** Results longer than this are collapsed behind a "show more" control. */
const RESULT_PREVIEW = 1200

/**
 * A command Pi ran itself, rather than through a tool call.
 *
 * The output arrives in chunks while the command runs, so the card keeps the
 * body closed until it is asked for.
 */
export function BashCard({ item }: { item: BashItem }) {
  const [open, setOpen] = useState(false)
  const failed = item.exitCode !== undefined && item.exitCode !== 0

  return (
    <div className="tool" data-tone={failed ? 'error' : 'exec'}>
      <div className="tool__head">
        <button className="tool__head-main" onClick={() => setOpen((value) => !value)}>
          <span className="tool__icon">
            <SquareTerminal size={12} strokeWidth={2.2} />
          </span>
          <span className="tool__name">bash</span>
          <span className="tool__summary">{item.command || 'running…'}</span>
          {item.exitCode !== undefined ? (
            <span className="tool__status">{failed ? `exit ${item.exitCode}` : 'ok'}</span>
          ) : null}
        </button>
        <button
          className="tool__caret"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          <ChevronRight size={13} className="caret" data-open={open} />
        </button>
      </div>

      {open ? (
        <div className="tool__body">
          {item.output ? (
            <pre className={`tool__pre${failed ? ' tool__error' : ''}`}>{item.output}</pre>
          ) : (
            <pre className="tool__pre">No output.</pre>
          )}
        </div>
      ) : null}
    </div>
  )
}

export function ToolCard({ item }: { item: ToolItem }) {
  // Edits are the interesting part, so their diff starts expanded.
  const [open, setOpen] = useState(item.toolName === 'edit')
  const [full, setFull] = useState(false)
  const diffSplit = useAppStore((state) => state.settings.diffSplit === true)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const workspace = useAppStore((state) => state.workspace)
  const descriptor = describeTool(item.toolName)
  const tone = item.status === 'error' ? 'error' : descriptor.tone
  const Icon = TOOL_ICONS[tone]

  const diffs = useMemo(() => {
    if (item.toolName !== 'edit') return []
    return editPairs(item.args ?? {}).map((pair) => buildDiff(pair.oldText, pair.newText))
  }, [item.args, item.toolName])

  const summary = descriptor.summary(item.args ?? {})
  const result = item.result ?? ''
  const truncated = result.length > RESULT_PREVIEW
  const visibleResult = truncated && !full ? result.slice(0, RESULT_PREVIEW) : result

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

  return (
    <div className="tool" data-tone={tone}>
      <div className="tool__head">
        <button className="tool__head-main" onClick={() => setOpen((value) => !value)}>
          <span className="tool__icon">
            <Icon size={12} strokeWidth={2.2} />
          </span>
          <span className="tool__name">{item.toolName}</span>
          <span className="tool__summary">{summary}</span>
          {item.status === 'running' ? (
            <span className="spinner" />
          ) : item.status === 'error' ? (
            <CircleAlert size={13} color="var(--red)" />
          ) : null}
          {item.durationMs !== undefined ? (
            <span className="tool__status">{formatDuration(item.durationMs)}</span>
          ) : null}
        </button>

        {reuse ? (
          <button
            className="tool__reuse-icon"
            title={reuse.label}
            aria-label={reuse.label}
            onClick={() => insertIntoComposer(reuse.text)}
          >
            <CornerDownLeft size={12} />
          </button>
        ) : null}

        <button
          className="tool__caret"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? 'Collapse' : 'Expand'}
        >
          <ChevronRight size={13} className="caret" data-open={open} />
        </button>
      </div>

      {open ? (
        <div className="tool__body">
          {diffs.length > 0 ? <DiffView diffs={diffs} mode={diffSplit ? 'split' : 'unified'} /> : null}

          {item.toolName === 'write' ? (
            <pre className="tool__pre">{String(item.args?.content ?? '')}</pre>
          ) : null}

          {item.toolName === 'bash' || item.toolName === 'powershell' ? (
            <pre className="tool__pre">{String(item.args?.command ?? '')}</pre>
          ) : null}

          {visibleResult ? (
            <pre className={`tool__pre${item.status === 'error' ? ' tool__error' : ''}`}>
              {visibleResult}
            </pre>
          ) : null}

          {truncated ? (
            <button className="tool__more" onClick={() => setFull((value) => !value)}>
              {full
                ? 'Show less'
                : `Show ${(result.length - RESULT_PREVIEW).toLocaleString()} more characters`}
            </button>
          ) : null}

          {!diffs.length && !visibleResult && item.toolName !== 'write' ? (
            <pre className="tool__pre">{JSON.stringify(item.args ?? {}, null, 2)}</pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

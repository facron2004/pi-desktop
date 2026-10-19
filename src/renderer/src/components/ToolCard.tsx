import { useMemo, useState } from 'react'
import {
  ChevronRight,
  CircleAlert,
  FilePlus,
  FileText,
  Pencil,
  Search,
  SquareTerminal,
  Wrench
} from 'lucide-react'
import type { ToolItem } from '../lib/thread'
import { describeTool, editPairs, type ToolTone } from '../lib/tools'
import { formatDuration } from '../lib/format'
import { buildDiff, DiffView } from './DiffView'

const ICONS: Record<ToolTone | 'error', typeof FileText> = {
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

export function ToolCard({ item }: { item: ToolItem }) {
  // Edits are the interesting part, so their diff starts expanded.
  const [open, setOpen] = useState(item.toolName === 'edit')
  const [full, setFull] = useState(false)
  const descriptor = describeTool(item.toolName)
  const tone = item.status === 'error' ? 'error' : descriptor.tone
  const Icon = ICONS[tone]

  const diffs = useMemo(() => {
    if (item.toolName !== 'edit') return []
    return editPairs(item.args ?? {}).map((pair) => buildDiff(pair.oldText, pair.newText))
  }, [item.args, item.toolName])

  const summary = descriptor.summary(item.args ?? {})
  const result = item.result ?? ''
  const truncated = result.length > RESULT_PREVIEW
  const visibleResult = truncated && !full ? result.slice(0, RESULT_PREVIEW) : result

  return (
    <div className="tool" data-tone={tone}>
      <button className="tool__head" onClick={() => setOpen((value) => !value)}>
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
        <ChevronRight size={13} className="caret" data-open={open} />
      </button>

      {open ? (
        <div className="tool__body">
          {diffs.length > 0 ? <DiffView diffs={diffs} /> : null}

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

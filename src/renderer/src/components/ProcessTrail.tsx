import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ToolItem } from '../lib/thread'
import { describeTool } from '../lib/tools'
import { useSearchQuery } from '../lib/search-context'
import { useAppStore } from '../store/useAppStore'
import { readProcessOpen, readToolOpen, writeProcessOpen, writeToolOpen } from '../lib/view-state'
import { activityHeadline } from './ToolGroup'
import { useT } from '../lib/i18n'

/**
 * The working trace of one stretch of a turn: thinking and tool calls.
 *
 * While that stretch is the live tail it stays open and indented, so the
 * step can be watched. Once the stretch is no longer the thing happening,
 * it collapses to a single indented line — the answer keeps the column,
 * and the trace stays one click away instead of stacking under it.
 *
 * Both of those are settings, and this is the only component that reads them:
 * `autoFoldProcess` picks the default of the fold, `toolCallSummary` makes a
 * live stretch answer to the same one line a settled one already shows. The
 * fold stays a projection of `live` — nothing is remembered about the run —
 * so a reopened conversation folds exactly like the running one did.
 */
export function ProcessTrail({
  tools,
  thoughts,
  searchText,
  live,
  defaultOpen = false,
  children
}: {
  tools: ToolItem[]
  thoughts: number
  /** Thinking text, so an in-thread search can open the fold it lives in. */
  searchText: string
  live: boolean
  defaultOpen?: boolean
  children: ReactNode
}) {
  const t = useT()
  const workspace = useAppStore((state) => state.workspace)
  const threadKey = useAppStore((state) => state.activeSessionFile ?? state.draftId ?? 'draft')
  /** On by default: a trace that is over folds, and only the reader opens it again. */
  const autoFold = useAppStore((state) => state.settings.autoFoldProcess !== false)
  /** Off by default: while the agent works, every call keeps its own row. */
  const gatherCalls = useAppStore((state) => state.settings.toolCallSummary === true)
  const query = useSearchQuery().trim().toLowerCase()
  const activity = activityHeadline(tools, t)
  const thought = thoughts > 0 ? t('Thought') : ''
  const title = tools.length === 0 ? thought : activity.title
  const processId = tools[0]?.id ?? `${title}-${searchText.length}`
  const groupId = `group-${processId}`
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(() =>
    readProcessOpen(threadKey, processId)
  )
  const [batchOpen, setBatchOpen] = useState<boolean | undefined>(() =>
    readToolOpen(threadKey, groupId)
  )
  // A live stretch is a batch only from the second call up — one call is one
  // legible row, the way ToolGroup keeps a lone item a row — and a stretch of
  // pure thinking is never a batch, so the switch cannot hide a thought row.
  const summarizing = live && gatherCalls && tools.length > 1
  const summary = [
    tools.length > 0 ? thought : '',
    activity.summary,
    activity.status === 'error' ? t('Failed') : '',
    activity.status === 'aborted' ? t('Stopped') : '',
    activity.status === 'proposed' ? t('Not run') : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const toolText = tools
    .map((item) => `${item.toolName} ${describeTool(item.toolName).summary(item.args ?? {}, workspace?.path)}`)
    .join('\n')
  const searchMatch = Boolean(query) && `${searchText}\n${toolText}`.toLowerCase().includes(query)
  /**
   * The whole fold rule.
   *
   * A search hit always opens the trace it lives in — including the one the
   * summary line is hiding. Otherwise the reader's own click wins, and the
   * setting only supplies the default: a gathered live batch starts shut, a
   * settled trace starts shut unless `autoFoldProcess` is off. A live batch
   * remembers its answer under the batch's own key, never under the trace's,
   * so peeking at the calls while the agent works cannot decide how the
   * trace folds once it has settled.
   */
  const open =
    searchMatch ||
    (summarizing ? (batchOpen ?? false) : (manualOpen ?? (defaultOpen || !autoFold)))
  const toggleOpen = () => {
    const next = !open
    if (summarizing) {
      setBatchOpen(next)
      writeToolOpen(threadKey, groupId, next)
    } else {
      setManualOpen(next)
      writeProcessOpen(threadKey, processId, next)
    }
  }

  // A live stretch that is not a batch is the raw trace, exactly as before.
  if (live && !summarizing) {
    return <div className="process process--live">{children}</div>
  }

  return (
    <div
      className="process"
      data-open={open}
      data-status={activity.status}
      data-live={summarizing || undefined}
    >
      <button
        type="button"
        className="process__head"
        aria-expanded={open}
        title={summarizing ? t(open ? 'Collapse' : 'Expand') : undefined}
        onClick={toggleOpen}
      >
        <ChevronRight size={13} className="caret" data-open={open} />
        <span className="process__label">{title}</span>
        {summarizing && activity.status === 'running' ? <span className="spinner" /> : null}
        {summary ? <span className="process__summary">{summary}</span> : null}
      </button>
      {open ? <div className="process__body">{children}</div> : null}
    </div>
  )
}

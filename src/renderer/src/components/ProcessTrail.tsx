import { useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ToolItem } from '../lib/thread'
import { describeTool } from '../lib/tools'
import { useSearchQuery } from '../lib/search-context'
import { useAppStore } from '../store/useAppStore'
import { readProcessOpen, writeProcessOpen } from '../lib/view-state'
import { activityHeadline } from './ToolGroup'
import { useT } from '../lib/i18n'

/**
 * The working trace of one stretch of a turn: thinking and tool calls.
 *
 * While that stretch is the live tail it stays open and indented, so the
 * step can be watched. Once the stretch is no longer the thing happening,
 * it collapses to a single indented line — the answer keeps the column,
 * and the trace stays one click away instead of stacking under it.
 */
export function ProcessTrail({
  tools,
  thoughts,
  searchText,
  live,
  children
}: {
  tools: ToolItem[]
  thoughts: number
  /** Thinking text, so an in-thread search can open the fold it lives in. */
  searchText: string
  live: boolean
  children: ReactNode
}) {
  const t = useT()
  const workspace = useAppStore((state) => state.workspace)
  const threadKey = useAppStore((state) => state.activeSessionFile ?? state.draftId ?? 'draft')
  const query = useSearchQuery().trim().toLowerCase()
  const activity = activityHeadline(tools, t)
  const thought = thoughts > 0 ? t('Thought') : ''
  const title = tools.length === 0 ? thought : activity.title
  const processId = tools[0]?.id ?? `${title}-${searchText.length}`
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(() =>
    readProcessOpen(threadKey, processId)
  )
  const toggleOpen = () => {
    const next = !open
    setManualOpen(next)
    writeProcessOpen(threadKey, processId, next)
  }
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
  const open = live || searchMatch || (manualOpen ?? false)

  if (live) {
    return <div className="process process--live">{children}</div>
  }

  return (
    <div className="process" data-open={open} data-status={activity.status}>
      <button
        type="button"
        className="process__head"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <ChevronRight size={13} className="caret" data-open={open} />
        <span className="process__label">{title}</span>
        {summary ? <span className="process__summary">{summary}</span> : null}
      </button>
      {open ? <div className="process__body">{children}</div> : null}
    </div>
  )
}

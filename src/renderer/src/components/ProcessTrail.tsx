import { memo, useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, CircleAlert, FileText, ListChecks, Pencil, Search, SquareTerminal } from 'lucide-react'
import type { ToolItem } from '../lib/thread'
import { describeTool } from '../lib/tools'
import { useSearchQuery } from '../lib/search-context'
import { readProcessOpen, writeProcessOpen } from '../lib/view-state'
import { activityHeadline } from './ToolGroup'
import { useT } from '../lib/i18n'
import { useThreadEnv } from './conversation/ThreadEnvContext'

const ACTION_ICONS = {
  edit: Pencil,
  command: SquareTerminal,
  search: Search,
  read: FileText,
  generic: ListChecks
}

/** A consecutive group of tool calls with one disclosure in the reading column. */
export const ProcessTrail = memo(function ProcessTrail({
  tools,
  live,
  children
}: {
  tools: ToolItem[]
  live: boolean
  children: ReactNode
}) {
  const t = useT()
  const { workspacePath, threadKey, autoFoldProcess: autoFold, toolCallSummary: gatherCalls } = useThreadEnv()
  const query = useSearchQuery().trim().toLowerCase()
  const activity = activityHeadline(tools, t)
  const processId = tools[0]?.id ?? ''
  const [manualOpen, setManualOpen] = useState<boolean | undefined>(() =>
    readProcessOpen(threadKey, processId)
  )
  useEffect(() => {
    setManualOpen(readProcessOpen(threadKey, processId))
  }, [threadKey, processId])

  const busy = live && activity.busy
  // A completed group can fold as soon as its calls finish, even if the
  // agent is still writing the rest of the turn.
  if (tools.length === 0 || (busy && !gatherCalls)) {
    return (
      <div className={live ? 'process process--live' : 'process'} data-status={activity.status}>
        {children}
      </div>
    )
  }

  const searchMatch = query
    ? tools.map((item) => `${item.toolName} ${describeTool(item.toolName).summary(item.args ?? {}, workspacePath)}`).join('\n')
        .toLowerCase()
        .includes(query)
    : false
  const open = searchMatch || (manualOpen ?? (!busy && !autoFold))
  const toggleOpen = () => {
    const next = !open
    setManualOpen(next)
    writeProcessOpen(threadKey, processId, next)
  }
  const status = busy && activity.status === 'proposed' ? 'running' : activity.status
  const Icon = status === 'error' ? CircleAlert : ACTION_ICONS[activity.tone]
  const label = status !== activity.status ? t('Working…') : activity.label
  const stateLabel = status === 'aborted' ? t('Stopped') : status === 'proposed' ? t('Not run') : ''

  return (
    <div
      className="process"
      data-open={open}
      data-status={status}
      data-live={busy || undefined}
    >
      <button
        type="button"
        className="process__head"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <Icon size={14} aria-hidden="true" className="process__icon" />
        <span className="process__label">{label}{stateLabel ? ` · ${stateLabel}` : ''}</span>
        {activity.failedCount > 0 ? (
          <span className="process__failure">
            {t(`${activity.failedCount} ${activity.failedCount === 1 ? 'failed call' : 'failed calls'}`)}
          </span>
        ) : null}
        <ChevronRight size={13} className="caret" data-open={open} aria-hidden="true" />
      </button>
      {open ? <div className="process__body">{children}</div> : null}
    </div>
  )
})

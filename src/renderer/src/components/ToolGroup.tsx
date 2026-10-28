import { useState } from 'react'
import { Ban, ChevronRight, CircleAlert, ListChecks } from 'lucide-react'
import type { ToolItem } from '../lib/thread'
import { describeTool } from '../lib/tools'
import { summarizeTool } from '../lib/tool-renderers'
import { useSearchQuery } from '../lib/search-context'
import { useAppStore } from '../store/useAppStore'
import { ToolCard } from './ToolCard'
import { useT } from '../lib/i18n'

/** Consecutive calls share an activity summary; full records stay one click away. */
export function ToolGroup({ items }: { items: ToolItem[] }) {
  const workspace = useAppStore((state) => state.workspace)
  const query = useSearchQuery().trim().toLowerCase()
  const t = useT()
  const failed = items.some((item) => item.status === 'error')
  // A tool that was named but never ran is not a failure either: the group
  // says so rather than marking the whole batch red.
  const running = items.some((item) => item.status === 'running')
  const aborted = items.some((item) => item.status === 'aborted')
  const proposed = items.some((item) => item.status === 'proposed')
  const status = failed ? 'error' : running ? 'running' : aborted ? 'aborted' : proposed ? 'proposed' : 'ok'
  const Icon = failed ? CircleAlert : aborted ? Ban : ListChecks
  const searchMatch = Boolean(query) && items.some((item) =>
    `${item.toolName} ${describeTool(item.toolName).summary(item.args ?? {}, workspace?.path)}`
      .toLowerCase().includes(query)
  )

  const [manualOpen, setManualOpen] = useState<boolean>()
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({})
  const open = searchMatch || (manualOpen ?? (failed || items.some((item) => expandedItems[item.id] === true)))
  const toggleOpen = () => setManualOpen(!open)
  const setItemExpanded = (id: string, expanded: boolean) =>
    setExpandedItems((current) => ({ ...current, [id]: expanded }))

  const renderItem = (item: ToolItem) => (
    <ToolCard
      key={item.id}
      item={item}
      expanded={expandedItems[item.id]}
      onExpandedChange={(expanded) => setItemExpanded(item.id, expanded)}
    />
  )

  if (items.length === 1) return renderItem(items[0])

  const counts = { read: 0, search: 0, edit: 0, command: 0, generic: 0 }
  for (const item of items) counts[summarizeTool(item).tone] += 1
  const summary = [
    counts.read ? t(`${counts.read} ${counts.read === 1 ? 'file read' : 'file reads'}`) : '',
    counts.search ? t(`${counts.search} ${counts.search === 1 ? 'search' : 'searches'}`) : '',
    counts.edit ? t(`${counts.edit} ${counts.edit === 1 ? 'edit' : 'edits'}`) : '',
    counts.command ? t(`${counts.command} ${counts.command === 1 ? 'command run' : 'commands run'}`) : '',
    counts.generic ? t(`${counts.generic} ${counts.generic === 1 ? 'tool call' : 'tool calls'}`) : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const explored = counts.read + counts.search === items.length

  return (
    <div className="tool tool--group" data-tone="generic" data-status={status} data-open={open}>
      <div className="tool__head">
        <button
          className="tool__head-main"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          <span className="tool__icon">
            <Icon size={12} strokeWidth={2.2} />
          </span>
          <span className="tool__name">
            {t(running ? 'Working…' : explored && status === 'ok' ? 'Explored' : 'Activity')}
          </span>
          <span className="tool__summary">{summary}</span>
          {running ? <span className="spinner" /> : null}
          <span className="tool__state" data-state={status}>
            {t(
              failed
                ? 'Failed'
                : running
                  ? 'Running'
                  : aborted
                    ? 'Stopped'
                    : proposed
                      ? 'Not run'
                      : 'Completed'
            )}
          </span>
        </button>
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
        <div className="tool__body tool__body--group">
          {items.map(renderItem)}
        </div>
      ) : null}
    </div>
  )
}

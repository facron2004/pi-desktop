import { useState } from 'react'
import { ChevronRight, CircleAlert, ListChecks } from 'lucide-react'
import type { ToolItem } from '../lib/thread'
import { describeTool } from '../lib/tools'
import { useSearchQuery } from '../lib/search-context'
import { useAppStore } from '../store/useAppStore'
import { ThinkingBlock } from './MessageItem'
import { ToolCard } from './ToolCard'
import { useT } from '../lib/i18n'

export type ToolGroupItem =
  | ToolItem
  | { kind: 'thinking'; id: string; text: string; streaming: boolean }

/** Keep a continuous run of tools and thinking compact until its details are requested. */
export function ToolGroup({ items }: { items: ToolGroupItem[] }) {
  const workspace = useAppStore((state) => state.workspace)
  const query = useSearchQuery().trim().toLowerCase()
  const t = useT()
  const tools = items.filter((item) => item.kind === 'tool')
  const thoughtCount = items.length - tools.length
  const failed = tools.some((item) => item.status === 'error')
  // A tool that was named but never ran is not a failure either: the group
  // says so rather than marking the whole batch red.
  const running = items.some((item) => item.kind === 'tool' ? item.status === 'running' : item.streaming)
  const proposed = tools.some((item) => item.status === 'proposed')
  const status = failed ? 'error' : running ? 'running' : proposed ? 'proposed' : 'ok'
  const Icon = failed ? CircleAlert : ListChecks
  const searchMatch = Boolean(query) && tools.some((item) =>
    `${item.toolName} ${describeTool(item.toolName).summary(item.args ?? {}, workspace?.path)}`
      .toLowerCase().includes(query)
  )

  const [manualOpen, setManualOpen] = useState<boolean>()
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({})
  const open = searchMatch || (manualOpen ?? (failed || items.some((item) => expandedItems[item.id] === true)))
  const toggleOpen = () => setManualOpen(!open)
  const setItemExpanded = (id: string, expanded: boolean) =>
    setExpandedItems((current) => ({ ...current, [id]: expanded }))

  const renderItem = (item: ToolGroupItem) =>
    item.kind === 'tool' ? (
      <ToolCard
        key={item.id}
        item={item}
        expanded={expandedItems[item.id]}
        onExpandedChange={(expanded) => setItemExpanded(item.id, expanded)}
      />
    ) : (
      <ThinkingBlock
        key={item.id}
        text={item.text}
        streaming={item.streaming}
        expanded={expandedItems[item.id]}
        onExpandedChange={(expanded) => setItemExpanded(item.id, expanded)}
      />
    )

  if (items.length === 1) return renderItem(items[0])

  const summary = [
    tools.length ? `${tools.length} ${t('tool calls')}` : '',
    thoughtCount ? `${thoughtCount} ${t('thinking steps')}` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="tool tool--group" data-tone="generic" data-status={status}>
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
            {t('Execution details')}
          </span>
          <span className="tool__summary">{summary}</span>
          {running ? <span className="spinner" /> : null}
          <span className="tool__state" data-state={status}>
            {t(
              failed
                ? 'Failed'
                : running
                  ? 'Running'
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

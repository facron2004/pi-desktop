import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ToolItem } from '../lib/thread'
import { describeTool } from '../lib/tools'
import { useAppStore } from '../store/useAppStore'
import { ToolCard, TOOL_ICONS } from './ToolCard'
import { useT } from '../lib/i18n'

/**
 * Several calls of the same tool in a row, folded into one card.
 *
 * A run of reads or searches says much more in a single line than in a dozen
 * separate cards. Edits and writes carry their own diff or content, so a
 * group that holds one of those starts open.
 */
export function ToolGroup({ items }: { items: ToolItem[] }) {
  const workspace = useAppStore((state) => state.workspace)
  const descriptor = describeTool(items[0].toolName)
  const t = useT()
  const tone = items.some((item) => item.status === 'error') ? 'error' : descriptor.tone
  const Icon = TOOL_ICONS[tone]

  // A group that hides a running tool would hide the progress, and one that
  // hides an edit would hide the diff.
  const showDetail =
    items.some((item) => item.status === 'running') ||
    items.some((item) => item.toolName === 'edit' || item.toolName === 'write')
  const [open, setOpen] = useState(showDetail)

  const summary = items
    .map((item) => descriptor.summary(item.args ?? {}, workspace?.path))
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="tool tool--group" data-tone={tone}>
      <div className="tool__head">
        <button className="tool__head-main" onClick={() => setOpen((value) => !value)}>
          <span className="tool__icon">
            <Icon size={12} strokeWidth={2.2} />
          </span>
          <span className="tool__name">
            {items.length} {descriptor.plural}
          </span>
          <span className="tool__summary">{summary}</span>
        </button>
        <button
          className="tool__caret"
          onClick={() => setOpen((value) => !value)}
          aria-label={open ? t('Collapse') : t('Expand')}
        >
          <ChevronRight size={13} className="caret" data-open={open} />
        </button>
      </div>

      {open ? (
        <div className="tool__body tool__body--group">
          {items.map((item) => (
            <ToolCard key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

import { useState } from 'react'
import { Ban, ChevronRight, CircleAlert, ListChecks } from 'lucide-react'
import type { ToolItem } from '../lib/thread'
import { describeTool } from '../lib/tools'
import { summarizeTool } from '../lib/tool-renderers'
import { useSearchQuery } from '../lib/search-context'
import { useAppStore } from '../store/useAppStore'
import { readToolOpen, writeToolOpen } from '../lib/view-state'
import { ToolCard } from './ToolCard'
import { useT } from '../lib/i18n'

export type ActivityStatus = 'error' | 'running' | 'aborted' | 'proposed' | 'ok'

/**
 * One line for a batch of calls.
 *
 * The card shows counts. The inline conversation fold uses the action label
 * to describe a finished batch without exposing arguments or output.
 */
export function activityHeadline(
  items: ToolItem[],
  t: (text: string) => string
): {
  title: string
  summary: string
  status: ActivityStatus
  failedCount: number
  tone: 'edit' | 'command' | 'search' | 'read' | 'generic'
  label: string
  busy: boolean
} {
  const counts = { read: 0, search: 0, edit: 0, command: 0, subagent: 0, plan: 0, computer: 0, image: 0, generic: 0 }
  let failedCount = 0
  let proposedCount = 0
  let running = false
  let aborted = false
  for (const item of items) {
    if (item.status === 'error') failedCount += 1
    if (item.status === 'proposed') proposedCount += 1
    if (item.status === 'running') running = true
    if (item.status === 'aborted') aborted = true
    counts[summarizeTool(item).tone] += 1
  }
  // A mixed batch is not "Not run": only a batch in which every call never
  // started gets that label. Individual proposed rows still say so.
  const proposed = items.length > 0 && proposedCount === items.length
  const status: ActivityStatus = failedCount > 0
    ? 'error'
    : running
      ? 'running'
      : aborted
        ? 'aborted'
        : proposed
          ? 'proposed'
          : 'ok'
  // Delegation, plan review, desktop actions and image calls are tool calls
  // too; the batch summary only distinguishes the work it can describe
  // precisely.
  const genericCount = counts.generic + counts.subagent + counts.plan + counts.computer + counts.image
  const summary = [
    counts.read ? t(`${counts.read} ${counts.read === 1 ? 'file read' : 'file reads'}`) : '',
    counts.search ? t(`${counts.search} ${counts.search === 1 ? 'search' : 'searches'}`) : '',
    counts.edit ? t(`${counts.edit} ${counts.edit === 1 ? 'edit' : 'edits'}`) : '',
    counts.command ? t(`${counts.command} ${counts.command === 1 ? 'command run' : 'commands run'}`) : '',
    genericCount ? t(`${genericCount} ${genericCount === 1 ? 'tool call' : 'tool calls'}`) : ''
  ]
    .filter(Boolean)
    .join(' · ')
  const explored = items.length > 0 && counts.read + counts.search === items.length
  const title = t(running ? 'Working…' : explored && status === 'ok' && proposedCount === 0 ? 'Explored' : 'Activity')
  const tone = counts.edit ? 'edit' : counts.command ? 'command' : counts.search ? 'search' : counts.read ? 'read' : 'generic'
  const label = status === 'ok' && proposedCount === 0
    ? [
        counts.read || counts.search ? t('Explored') : '',
        counts.edit ? t(counts.edit === 1 ? 'Edited file' : 'File edits') : '',
        counts.command ? t(counts.command === 1 ? 'Ran command' : 'Ran commands') : '',
        genericCount ? t('Used tools') : ''
      ].filter(Boolean).join(' · ')
    : status === 'running' && counts.command === items.length
      ? t(counts.command === 1 ? 'Running command' : 'Running commands')
      : status === 'running' && counts.edit === 1 && items.length === 1
        ? t('Editing file')
        : title
  return { title, summary, status, failedCount, tone, label, busy: running || proposedCount > 0 }
}

/** Consecutive calls share an activity summary; full records stay one click away. */
export function ToolGroup({ items }: { items: ToolItem[] }) {
  const workspace = useAppStore((state) => state.workspace)
  const threadKey = useAppStore((state) => state.activeSessionFile ?? state.draftId ?? 'draft')
  const query = useSearchQuery().trim().toLowerCase()
  const t = useT()
  const { title, summary, status } = activityHeadline(items, t)
  // A tool that was named but never ran is not a failure either: the group
  // says so rather than marking the whole batch red.
  const Icon = status === 'error' ? CircleAlert : status === 'aborted' ? Ban : ListChecks
  const searchMatch = Boolean(query) && items.some((item) =>
    `${item.toolName} ${describeTool(item.toolName).summary(item.args ?? {}, workspace?.path)}`
      .toLowerCase().includes(query)
  )

  const groupId = `group-${items[0]?.id ?? 'empty'}`
  const [manualOpen, setManualOpenState] = useState<boolean | undefined>(() =>
    readToolOpen(threadKey, groupId)
  )
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({})
  const open = searchMatch || (manualOpen ?? (status === 'error' || items.some((item) => expandedItems[item.id] === true)))
  const toggleOpen = () => {
    const next = !open
    setManualOpenState(next)
    writeToolOpen(threadKey, groupId, next)
  }
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
          <span className="tool__name">{title}</span>
          <span className="tool__summary">{summary}</span>
          <span className="tool__state" data-state={status}>
            {t(
              status === 'error'
                ? 'Failed'
                : status === 'running'
                  ? 'Running'
                  : status === 'aborted'
                    ? 'Stopped'
                    : status === 'proposed'
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

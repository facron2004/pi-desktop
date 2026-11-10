import { ArrowLeft, Bot } from 'lucide-react'
import { useMemo } from 'react'
import type { SubagentTreeTask } from '../lib/subagents'
import { itemsFromMessages } from '../lib/thread'
import { formatDuration } from '../lib/format'
import { useT } from '../lib/i18n'
import { Markdown } from './Markdown'
import { ToolCard } from './ToolCard'
import { LogOutput } from './conversation/LogOutput'
import '../styles/subagent-conversation.css'

const STATUS_LABEL: Record<SubagentTreeTask['status'], string> = {
  proposed: 'Not run',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Stopped'
}

export interface SubagentConversationTarget {
  task: SubagentTreeTask
  sessionName?: string
}

/**
 * The child conversation behind one subagent row.
 *
 * The subagent process is isolated, so its transcript is carried in the tool
 * result details. Rendering it through the same `itemsFromMessages` projection
 * keeps child tool calls and replies in their real order instead of inventing a
 * second message format.
 */
export function SubagentConversation({
  target,
  onBack
}: {
  target: SubagentConversationTarget
  onBack: () => void
}) {
  const t = useT()
  const task = target.task
  const items = useMemo(() => itemsFromMessages(task.messages ?? []), [task.messages])
  const hasUserMessage = items.some((item) => item.kind === 'user')
  const duration = task.startedAt === undefined
    ? undefined
    : Math.max(0, (task.finishedAt ?? Date.now()) - task.startedAt)

  return (
    <div className="subagent-conversation">
      <div className="subagent-conversation__head">
        <button type="button" className="ghost-btn subagent-conversation__back" onClick={onBack}>
          <ArrowLeft size={13} />
          {t('Back')}
        </button>
        <span className="subagent-conversation__identity">
          <Bot size={14} aria-hidden="true" />
          <strong title={task.task}>{task.task}</strong>
        </span>
        <span className="subagent-conversation__meta">
          <span data-status={task.status}>{t(STATUS_LABEL[task.status])}</span>
          {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
        </span>
      </div>
      <div className="subagent-conversation__body">
        {task.messagesTruncated ? (
          <div className="subagent-conversation__truncated">{t('Earlier messages are omitted to keep this transcript responsive.')}</div>
        ) : null}
        {!hasUserMessage ? (
          <div className="subagent-conversation__user">{task.task}</div>
        ) : null}
        {items.length ? items.map((item) => {
          if (item.kind === 'user') {
            return <div className="subagent-conversation__user" key={item.id}>{item.text}</div>
          }
          if (item.kind === 'assistant') {
            return item.blocks.map((block, index) => {
              if (block.type === 'text' && block.text.trim()) {
                return (
                  <div className="subagent-conversation__assistant" key={`${item.id}-${index}`}>
                    <Markdown>{block.text}</Markdown>
                  </div>
                )
              }
              return null
            })
          }
          if (item.kind === 'tool') {
            return <ToolCard key={item.id} item={item} presentation="card" />
          }
          return null
        }) : task.output || task.errorMessage ? (
          <LogOutput text={task.output || task.errorMessage || ''} />
        ) : (
          <div className="subagent-conversation__empty" role="status">{t('Waiting for output…')}</div>
        )}
      </div>
    </div>
  )
}

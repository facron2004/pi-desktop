import { ArrowLeft, Bot } from 'lucide-react'
import { memo, useCallback, useMemo, useState } from 'react'
import type { SubagentTreeTask } from '../lib/subagents'
import { itemsFromMessages, type UserItem } from '../lib/thread'
import { buildTurns, type Turn } from '../lib/turns'
import { formatDuration } from '../lib/format'
import { useT } from '../lib/i18n'
import { NoticeMessage, UserMessage } from './MessageItem'
import { ProcessTrail } from './ProcessTrail'
import { BashCard, ToolCard } from './ToolCard'
import { AssistantMessage } from './conversation/AssistantMessage'
import { LogOutput } from './conversation/LogOutput'
import { StreamingText } from './conversation/StreamingText'
import { ThreadEnvStoreProvider } from './conversation/ThreadEnvContext'
import '../styles/subagent-conversation.css'

const STATUS_LABEL: Record<SubagentTreeTask['status'], string> = {
  proposed: 'Not run',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Stopped',
  timed_out: 'Timed out'
}

export interface SubagentConversationTarget {
  task: SubagentTreeTask
  sessionName?: string
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null)

  const copy = useCallback(async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(id)
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600)
    } catch {
      /* clipboard may be unavailable */
    }
  }, [])

  return { copied, copy }
}

/**
 * One turn of the child transcript, drawn with the conversation's own pieces.
 *
 * The projection already matches the parent session (`buildTurns` over the
 * same items), so only the run chrome is missing here: the reply keeps the
 * column, commentary and tool calls fold into a process row, and a turn that
 * is still being written stays open.
 */
const SubagentTurn = memo(function SubagentTurn({
  turn,
  prompt,
  liveTail,
  onCopy,
  copied
}: {
  turn: Turn
  /** The task text, when truncation left the turn without its own prompt. */
  prompt?: UserItem | null
  liveTail: boolean
  onCopy: (id: string, text: string) => void
  copied: string | null
}) {
  const toolMap = useMemo(
    () => new Map(turn.tools.map((tool) => [tool.toolCallId, tool])),
    [turn.tools]
  )
  // A call the resumed transcript no longer links to an assistant block still
  // needs a row; it is drawn at its own position, like the parent thread does.
  const orphanTools = useMemo(() => {
    const referenced = new Set<string>()
    for (const assistant of turn.assistants) {
      for (const block of assistant.blocks) {
        if (block.type === 'toolCall') referenced.add(block.id)
      }
    }
    return turn.tools.filter((tool) => !referenced.has(tool.toolCallId))
  }, [turn.assistants, turn.tools])

  return (
    <section className="turn" data-live={liveTail ? 'true' : undefined}>
      {turn.user || prompt ? (
        <UserMessage item={(turn.user ?? prompt)!} onCopy={onCopy} copied={copied} />
      ) : null}

      {turn.assistants.length > 0 ||
      turn.tools.length > 0 ||
      turn.notices.length > 0 ||
      turn.bash.length > 0 ? (
        <div className="assistant">
          <div className="assistant__body">
            <AssistantMessage
              turn={turn}
              toolMap={toolMap}
              liveTail={liveTail}
              processOpen
            />

            {turn.bash.map((item) => (
              <BashCard key={item.id} item={item} />
            ))}

            {orphanTools.length > 0 ? (
              <ProcessTrail
                key="process-orphans"
                tools={orphanTools}
                thoughts={0}
                searchText=""
                live={liveTail && orphanTools.some((tool) => tool.status === 'running')}
              >
                {orphanTools.map((tool) => (
                  <ToolCard key={tool.id} item={tool} presentation="link" />
                ))}
              </ProcessTrail>
            ) : null}

            {turn.notices.map((notice) => (
              <NoticeMessage key={notice.id} item={notice} />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
})

/**
 * The child conversation behind one subagent row.
 *
 * The subagent process is isolated, so its transcript is carried in the tool
 * result details. Projecting it through `itemsFromMessages` and `buildTurns`
 * and rendering it with the conversation's own message components keeps the
 * child's bubbles, commentary, folds and tool rows identical to a normal
 * session instead of inventing a second transcript style.
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
  const turns = useMemo(() => buildTurns(items), [items])
  const hasUserMessage = items.some((item) => item.kind === 'user')
  const { copied, copy } = useCopy()
  const duration = task.startedAt === undefined
    ? undefined
    : Math.max(0, (task.finishedAt ?? Date.now()) - task.startedAt)
  const liveTail = task.status === 'running'
  const liveProgress = liveTail ? task.progressText : undefined
  const threadKey = `subagent:${task.id}`
  // Truncation can drop the child's own prompt. The task text is the one copy
  // of it left, and it belongs in the same bubble a recorded prompt would use.
  const taskPrompt = useMemo<UserItem | null>(() => hasUserMessage ? null : {
    id: 'subagent-task',
    kind: 'user',
    text: task.task,
    images: [],
    timestamp: task.startedAt ?? Date.now(),
    order: -1
  }, [hasUserMessage, task.startedAt, task.task])
  const liveCommentary = items[items.length - 1]?.kind === 'tool'

  return (
    <div className="subagent-conversation">
      <div className="subagent-conversation__head">
        <button type="button" className="ghost-btn subagent-conversation__back" onClick={onBack}>
          <ArrowLeft size={13} />
          {t('Back')}
        </button>
        <span className="subagent-conversation__identity">
          <Bot size={14} aria-hidden="true" />
          <strong title={task.task}>{task.label || task.task}</strong>
        </span>
        <span className="subagent-conversation__meta">
          <span data-status={task.status}>{t(STATUS_LABEL[task.status])}</span>
          {duration !== undefined ? <span>{formatDuration(duration)}</span> : null}
        </span>
      </div>
      <div className="subagent-conversation__body">
        <ThreadEnvStoreProvider threadKey={threadKey} workspacePath={task.cwd || undefined}>
          {task.messagesTruncated ? (
            <div className="subagent-conversation__truncated">{t('Earlier messages are omitted to keep this transcript responsive.')}</div>
          ) : null}
          {turns.length ? turns.map((turn, index) => (
            <SubagentTurn
              key={turn.id}
              turn={turn}
              prompt={index === 0 ? taskPrompt : undefined}
              liveTail={liveTail && index === turns.length - 1}
              onCopy={copy}
              copied={copied}
            />
          )) : taskPrompt ? (
            <section className="turn">
              <UserMessage item={taskPrompt} onCopy={copy} copied={copied} />
            </section>
          ) : null}
          {liveProgress ? (
            <div className="assistant">
              <div className="assistant__body">
                <StreamingText text={liveProgress} streaming commentary={liveCommentary} />
              </div>
            </div>
          ) : null}
          {turns.length === 0 && !liveProgress ? (
            task.output || task.errorMessage ? (
              <LogOutput text={task.output || task.errorMessage || ''} />
            ) : (
              <div className="subagent-conversation__empty" role="status">{t('Waiting for output…')}</div>
            )
          ) : null}
        </ThreadEnvStoreProvider>
      </div>
    </div>
  )
}

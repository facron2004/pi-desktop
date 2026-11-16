import { memo, useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { conversationRows } from '../lib/live-sessions'
import { subagentCalls } from '../lib/subagents'
import { SubagentConversation } from './SubagentConversation'
import { SubagentTree } from './SubagentTree'

export interface SubagentSelection {
  sessionKey: string
  taskId: string
}

function SubagentOverview({
  onSelectTask
}: {
  onSelectTask: (selection: SubagentSelection | null) => void
}) {
  const sessions = useAppStore((state) => state.sessions)
  const threads = useAppStore((state) => state.threads)
  const workspacePath = useAppStore((state) => state.workspace?.path)
  const selectSession = useAppStore((state) => state.selectSession)
  const cancelSubagentTask = useAppStore((state) => state.cancelSubagentTask)
  // Use the same merge as the sidebar so a live draft or a prompt still on its
  // way to Pi does not disappear from the subagent page before it is persisted.
  const listed = useMemo(
    () => conversationRows(sessions, threads, workspacePath),
    [sessions, threads, workspacePath]
  )

  return (
    <div className="subagent-panel">
      <SubagentTree
        sessions={listed}
        threads={threads}
        onSelect={(session) => void selectSession(session)}
        onOpenTask={(task, session) => onSelectTask({ sessionKey: session.file, taskId: task.id })}
        onCancelTask={(taskId, session) => void cancelSubagentTask(taskId, session.file)}
        showEmpty
      />
    </div>
  )
}

function SubagentDetail({
  selected,
  onSelectTask
}: {
  selected: SubagentSelection
  onSelectTask: (selection: SubagentSelection | null) => void
}) {
  const selectedItems = useAppStore((state) => {
    const activeKey = state.activeSessionFile ?? state.draftId ?? ''
    return selected.sessionKey === activeKey
      ? state.items
      : state.threads[selected.sessionKey]?.items
  })
  // Keep only the selection in view state; progress and output stay in the thread.
  const selectedTask = useMemo(
    () => subagentCalls(selectedItems ?? []).flatMap((call) => call.tasks).find((task) => task.id === selected.taskId),
    [selected.taskId, selectedItems]
  )

  if (selectedTask) {
    return <SubagentConversation target={{ task: selectedTask }} onBack={() => onSelectTask(null)} />
  }
  return <SubagentOverview onSelectTask={onSelectTask} />
}

/**
 * The right panel's subagent page.
 *
 * The tree itself only projects the subagent tool calls already in each
 * conversation thread; this page simply gives it a permanent home beside the
 * conversation instead of mixing it into the project list.
 */
export const SubagentPanel = memo(function SubagentPanel({ selected, onSelectTask }: {
  selected: SubagentSelection | null
  onSelectTask: (selection: SubagentSelection | null) => void
}) {
  if (selected) {
    return <SubagentDetail selected={selected} onSelectTask={onSelectTask} />
  }
  return <SubagentOverview onSelectTask={onSelectTask} />
})

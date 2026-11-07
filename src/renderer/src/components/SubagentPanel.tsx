import { useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { conversationRows } from '../lib/live-sessions'
import { subagentCalls } from '../lib/subagents'
import { SubagentConversation } from './SubagentConversation'
import { SubagentTree } from './SubagentTree'

export interface SubagentSelection {
  sessionKey: string
  taskId: string
}

/**
 * The right panel's subagent page.
 *
 * The tree itself only projects the subagent tool calls already in each
 * conversation thread; this page simply gives it a permanent home beside the
 * conversation instead of mixing it into the project list.
 */
export function SubagentPanel({ selected, onSelectTask }: {
  selected: SubagentSelection | null
  onSelectTask: (selection: SubagentSelection | null) => void
}) {
  const sessions = useAppStore((state) => state.sessions)
  const threads = useAppStore((state) => state.threads)
  const items = useAppStore((state) => state.items)
  const activeKey = useAppStore((state) => state.activeSessionFile ?? state.draftId ?? '')
  const workspace = useAppStore((state) => state.workspace)
  const selectSession = useAppStore((state) => state.selectSession)
  // Use the same merge as the sidebar so a live draft or a prompt still on its
  // way to Pi does not disappear from the subagent page before it is persisted.
  const listed = useMemo(
    () => conversationRows(sessions, threads, workspace?.path),
    [sessions, threads, workspace?.path]
  )
  const selectedItems = selected?.sessionKey === activeKey
    ? items
    : selected ? threads[selected.sessionKey]?.items : undefined
  // Keep only the selection in view state; progress and output stay in the thread.
  const selectedTask = useMemo(() => selected
    ? subagentCalls(selectedItems ?? []).flatMap((call) => call.tasks).find((task) => task.id === selected.taskId)
    : undefined, [selected, selectedItems])

  if (selectedTask) {
    return <SubagentConversation target={{ task: selectedTask }} onBack={() => onSelectTask(null)} />
  }

  return (
    <div className="subagent-panel">
      <SubagentTree
        sessions={listed}
        threads={threads}
        onSelect={(session) => void selectSession(session)}
        onOpenTask={(task, session) => onSelectTask({ sessionKey: session.file, taskId: task.id })}
        showEmpty
      />
    </div>
  )
}

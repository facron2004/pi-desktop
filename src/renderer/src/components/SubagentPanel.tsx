import { memo, useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { conversationRows } from '../lib/live-sessions'
import { isDelegationTool, subagentCallOf } from '../lib/subagents'
import { SubagentConversation } from './SubagentConversation'
import { SubagentTree } from './SubagentTree'

export interface SubagentSelection {
  sessionKey: string
  taskId: string
}

export function SubagentOverview({
  onSelectTask,
  sessionKey
}: {
  onSelectTask: (selection: SubagentSelection) => void
  sessionKey?: string
}) {
  const sessions = useAppStore((state) => state.sessions)
  const threadsMetaVersion = useAppStore((state) => state.threadsMetaVersion)
  const threadsToolsRevision = useAppStore((state) => state.threadsToolsRevision)
  const workspacePath = useAppStore((state) => state.workspace?.path)
  const selectSession = useAppStore((state) => state.selectSession)
  const cancelSubagentTask = useAppStore((state) => state.cancelSubagentTask)
  // Subscribe only to metadata + tool revisions rather than the whole `threads`
  // map so 60fps text deltas in any conversation do not rebuild the tree.
  const { threads, listed } = useMemo(() => {
    const currentThreads = useAppStore.getState().threads
    const rows = conversationRows(sessions, currentThreads, workspacePath)
    return {
      threads: currentThreads,
      listed: sessionKey === undefined ? rows : rows.filter((session) => session.file === sessionKey)
    }
  }, [sessions, workspacePath, threadsMetaVersion, threadsToolsRevision, sessionKey])

  const tree = (
    <SubagentTree
      sessions={listed}
      threads={threads}
      onSelect={(session) => void selectSession(session)}
      onOpenTask={(task, session) => onSelectTask({ sessionKey: session.file, taskId: task.id })}
      onCancelTask={(taskId, session) => void cancelSubagentTask(taskId, session.file)}
      showEmpty={sessionKey === undefined}
    />
  )
  return sessionKey === undefined ? <div className="subagent-panel">{tree}</div> : tree
}

function SubagentDetail({
  selected,
  onSelectTask
}: {
  selected: SubagentSelection
  onSelectTask: (selection: SubagentSelection | null) => void
}) {
  // `subagentCallOf` is WeakMap-cached per ToolItem, so selecting the task
  // directly preserves object identity across parent text-delta frames.
  const selectedTask = useAppStore((state) => {
    const activeKey = state.activeSessionFile ?? state.draftId ?? ''
    const items = selected.sessionKey === activeKey
      ? state.items
      : state.threads[selected.sessionKey]?.items
    if (!items) return undefined
    for (const item of items) {
      if (item.kind !== 'tool' || !isDelegationTool(item.toolName)) continue
      const match = subagentCallOf(item).tasks.find((task) => task.id === selected.taskId)
      if (match) return match
    }
    return undefined
  })

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

import { useMemo, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { conversationRows } from '../lib/live-sessions'
import { SubagentConversation, type SubagentConversationTarget } from './SubagentConversation'
import { SubagentTree } from './SubagentTree'

/**
 * The right panel's subagent page.
 *
 * The tree itself only projects the subagent tool calls already in each
 * conversation thread; this page simply gives it a permanent home beside the
 * conversation instead of mixing it into the project list.
 */
export function SubagentPanel() {
  const sessions = useAppStore((state) => state.sessions)
  const threads = useAppStore((state) => state.threads)
  const workspace = useAppStore((state) => state.workspace)
  const selectSession = useAppStore((state) => state.selectSession)
  // Use the same merge as the sidebar so a live draft or a prompt still on its
  // way to Pi does not disappear from the subagent page before it is persisted.
  const listed = useMemo(
    () => conversationRows(sessions, threads, workspace?.path),
    [sessions, threads, workspace?.path]
  )
  const [selected, setSelected] = useState<SubagentConversationTarget | null>(null)

  if (selected) {
    return <SubagentConversation target={selected} onBack={() => setSelected(null)} />
  }

  return (
    <div className="subagent-panel">
      <SubagentTree
        sessions={listed}
        threads={threads}
        onSelect={(session) => void selectSession(session)}
        onOpenTask={(task, sessionName) => setSelected({ task, sessionName })}
        showEmpty
      />
    </div>
  )
}

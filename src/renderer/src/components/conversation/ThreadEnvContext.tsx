import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useAppStore } from '../../store/useAppStore'

export interface ThreadEnvValue {
  threadKey: string
  workspacePath?: string
  autoFoldProcess: boolean
  toolCallSummary: boolean
  diffSplit: boolean
  language: string
  insertIntoComposer: (text: string) => void
}

const ThreadEnvContext = createContext<ThreadEnvValue | null>(null)

export function ThreadEnvStoreProvider({
  threadKey: providedThreadKey,
  workspacePath: providedWorkspacePath,
  children
}: {
  threadKey?: string
  workspacePath?: string
  children: ReactNode
}) {
  const storeThreadKey = useAppStore((state) => state.activeSessionFile ?? state.draftId ?? 'draft')
  const storeWorkspacePath = useAppStore((state) => state.workspace?.path)
  const autoFoldProcess = useAppStore((state) => state.settings.autoFoldProcess !== false)
  const toolCallSummary = useAppStore((state) => state.settings.toolCallSummary === true)
  const diffSplit = useAppStore((state) => state.settings.diffSplit === true)
  const language = useAppStore((state) => state.settings.language ?? 'en')
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)

  const threadKey = providedThreadKey ?? storeThreadKey
  const workspacePath = providedWorkspacePath ?? storeWorkspacePath

  const value = useMemo<ThreadEnvValue>(
    () => ({
      threadKey,
      workspacePath,
      autoFoldProcess,
      toolCallSummary,
      diffSplit,
      language,
      insertIntoComposer
    }),
    [threadKey, workspacePath, autoFoldProcess, toolCallSummary, diffSplit, language, insertIntoComposer]
  )

  return <ThreadEnvContext.Provider value={value}>{children}</ThreadEnvContext.Provider>
}

export function useThreadEnv(): ThreadEnvValue {
  const ctx = useContext(ThreadEnvContext)
  if (ctx) return ctx
  const state = useAppStore.getState()
  return {
    threadKey: state.activeSessionFile ?? state.draftId ?? 'draft',
    workspacePath: state.workspace?.path,
    autoFoldProcess: state.settings.autoFoldProcess !== false,
    toolCallSummary: state.settings.toolCallSummary === true,
    diffSplit: state.settings.diffSplit === true,
    language: state.settings.language ?? 'en',
    insertIntoComposer: state.insertIntoComposer
  }
}

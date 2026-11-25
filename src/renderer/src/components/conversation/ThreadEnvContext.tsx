import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react'
import { isSideSessionKey } from '@shared/side-chat'
import { useAppStore } from '../../store/useAppStore'
import {
  dispatchOpenSideChat,
  type SideChatReferenceInput
} from '../../lib/side-chat-context'

export type ThreadSurface = 'main' | 'side' | 'subagent'

export interface ThreadEnvValue {
  threadKey: string
  workspacePath?: string
  surface: ThreadSurface
  autoFoldProcess: boolean
  toolCallSummary: boolean
  diffSplit: boolean
  language: string
  insertIntoComposer: (text: string, mode?: 'append' | 'replace') => void
  askSideChat?: (ref: SideChatReferenceInput) => void
}

const ThreadEnvContext = createContext<ThreadEnvValue | null>(null)

export function ThreadEnvStoreProvider({
  threadKey: providedThreadKey,
  workspacePath: providedWorkspacePath,
  surface: providedSurface,
  askSideChat: providedAskSideChat,
  children
}: {
  threadKey?: string
  workspacePath?: string
  surface?: ThreadSurface
  askSideChat?: (ref: SideChatReferenceInput) => void
  children: ReactNode
}) {
  const storeThreadKey = useAppStore((state) => state.activeSessionFile ?? state.draftId ?? 'draft')
  const storeWorkspacePath = useAppStore((state) => state.workspace?.path)
  const autoFoldProcess = useAppStore((state) => state.settings.autoFoldProcess !== false)
  const toolCallSummary = useAppStore((state) => state.settings.toolCallSummary !== false)
  const diffSplit = useAppStore((state) => state.settings.diffSplit === true)
  const language = useAppStore((state) => state.settings.language ?? 'en')
  const storeInsertIntoComposer = useAppStore((state) => state.insertIntoComposer)

  const threadKey = providedThreadKey ?? storeThreadKey
  const workspacePath = providedWorkspacePath ?? storeWorkspacePath
  const surface: ThreadSurface =
    providedSurface ??
    (providedThreadKey?.startsWith('subagent:')
      ? 'subagent'
      : isSideSessionKey(providedThreadKey)
        ? 'side'
        : 'main')

  const insertIntoComposer = useCallback(
    (text: string, mode?: 'append' | 'replace') => {
      storeInsertIntoComposer(text, mode, providedThreadKey)
    },
    [storeInsertIntoComposer, providedThreadKey]
  )

  const defaultAskSideChat = useCallback((ref: SideChatReferenceInput) => {
    dispatchOpenSideChat({ mode: 'open', focus: true, reference: ref })
  }, [])

  const askSideChat =
    surface === 'main' ? (providedAskSideChat ?? defaultAskSideChat) : undefined

  const value = useMemo<ThreadEnvValue>(
    () => ({
      threadKey,
      workspacePath,
      surface,
      autoFoldProcess,
      toolCallSummary,
      diffSplit,
      language,
      insertIntoComposer,
      askSideChat
    }),
    [
      threadKey,
      workspacePath,
      surface,
      autoFoldProcess,
      toolCallSummary,
      diffSplit,
      language,
      insertIntoComposer,
      askSideChat
    ]
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
    surface: 'main',
    autoFoldProcess: state.settings.autoFoldProcess !== false,
    toolCallSummary: state.settings.toolCallSummary !== false,
    diffSplit: state.settings.diffSplit === true,
    language: state.settings.language ?? 'en',
    insertIntoComposer: state.insertIntoComposer
  }
}

import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  isSideSessionKey,
  type ContextBreakdown,
  type ExtensionUiRequest,
  type ForkTarget,
  type ModelInfo,
  type PiCommand,
  type PiState,
  type RuntimeStatus,
  type SessionStats
} from '@shared/types'
import {
  draftKeyOf,
  resolveThreadKey,
  useAppStore,
  type AppStore,
  type CwdWaitState,
  type RetryState,
  type RunState,
  type SessionThread,
  type UiStatusEntry,
  type UiWidgetEntry
} from '../store/useAppStore'
import type { ThreadItem } from './thread'

export type ConversationSurface = 'main' | 'side'

export interface ConversationScopeValue {
  surface: ConversationSurface
  sessionKey?: string
  readOnly: boolean
}

const DEFAULT_SCOPE: ConversationScopeValue = Object.freeze({
  surface: 'main',
  sessionKey: undefined,
  readOnly: false
})

const ConversationScopeContext = createContext<ConversationScopeValue>(DEFAULT_SCOPE)

const EMPTY_ITEMS = Object.freeze([]) as unknown as ThreadItem[]
const EMPTY_MODELS = Object.freeze([]) as unknown as ModelInfo[]
const EMPTY_LEVELS = Object.freeze([]) as unknown as string[]
const EMPTY_COMMANDS = Object.freeze([]) as unknown as PiCommand[]
const EMPTY_UI_REQUESTS = Object.freeze([]) as unknown as ExtensionUiRequest[]
const EMPTY_UI_STATUSES = Object.freeze([]) as unknown as UiStatusEntry[]
const EMPTY_UI_WIDGETS = Object.freeze([]) as unknown as UiWidgetEntry[]
const EMPTY_FORK_TARGETS = Object.freeze([]) as unknown as ForkTarget[]
const EMPTY_QUEUE = Object.freeze({
  steering: Object.freeze([]) as unknown as string[],
  followUp: Object.freeze([]) as unknown as string[]
})
const IDLE_SIDE_RUN: RunState = Object.freeze({
  phase: 'idle',
  turns: 0,
  settled: true
})
const IDLE_SIDE_STATUS: RuntimeStatus = Object.freeze({
  phase: 'ready'
})

/**
 * Frozen fallback thread used when `threads[sideKey]` has not yet been materialized,
 * avoiding any inline `{}` or `[]` allocations inside Zustand selectors.
 */
export const IDLE_SIDE_THREAD: SessionThread = Object.freeze({
  items: EMPTY_ITEMS,
  historyLoaded: false,
  historyTruncated: false,
  run: IDLE_SIDE_RUN,
  isStreaming: false,
  transport: 'connected',
  uiRequest: undefined,
  uiRequests: EMPTY_UI_REQUESTS,
  clientKey: 'side-idle',
  cwdWait: undefined,
  uiStatuses: EMPTY_UI_STATUSES,
  uiWidgets: EMPTY_UI_WIDGETS,
  uiTitle: undefined,
  queue: EMPTY_QUEUE,
  retry: undefined,
  piState: undefined,
  stats: undefined,
  contextBreakdown: undefined,
  error: undefined,
  status: IDLE_SIDE_STATUS,
  forkTargets: EMPTY_FORK_TARGETS,
  rewindUndo: undefined,
  agentMode: 'default',
  hasLiveTaskMode: false,
  models: EMPTY_MODELS,
  thinkingLevels: EMPTY_LEVELS,
  commands: EMPTY_COMMANDS,
  version: 0,
  submitSeq: 0,
  notice: undefined
})

export interface ConversationScopeProviderProps {
  surface: ConversationSurface
  sessionKey?: string
  readOnly?: boolean
  children: ReactNode
}

export function ConversationScopeProvider({
  surface,
  sessionKey,
  readOnly,
  children
}: ConversationScopeProviderProps) {
  const value = useMemo<ConversationScopeValue>(
    () => ({
      surface,
      sessionKey,
      readOnly: readOnly ?? surface === 'side'
    }),
    [surface, sessionKey, readOnly]
  )
  return (
    <ConversationScopeContext.Provider value={value}>
      {children}
    </ConversationScopeContext.Provider>
  )
}

export function useConversationScope(): ConversationScopeValue {
  return useContext(ConversationScopeContext)
}

export interface SessionViewSlice {
  surface: ConversationSurface
  sessionKey: string
  readOnly: boolean
  items: ThreadItem[]
  isStreaming: boolean
  run: RunState
  transport: 'connected' | 'disconnected'
  status: RuntimeStatus
  retry?: RetryState
  error?: string
  cwdWait?: CwdWaitState | null
  piState?: PiState
  models: ModelInfo[]
  thinkingLevels: string[]
  stats?: SessionStats
  contextBreakdown?: ContextBreakdown
  hydrating: boolean
  clientKey: string
  submitSeq: number
  queue: { steering: string[]; followUp: string[] }
  commands: PiCommand[]
  uiStatuses: UiStatusEntry[]
  historyLoaded: boolean
  historyTruncated: boolean
}

export function readSessionViewSlice(
  state: AppStore,
  scope: ConversationScopeValue = DEFAULT_SCOPE,
  explicitKey?: string
): SessionViewSlice {
  const mainKey = draftKeyOf(state)
  const mainCanonical = mainKey ? resolveThreadKey(mainKey) : ''
  const rawKey =
    explicitKey !== undefined
      ? explicitKey
      : scope.surface === 'side'
        ? (scope.sessionKey ?? state.sideSessionKey ?? '')
        : (scope.sessionKey ?? mainKey)
  const canonicalKey = rawKey ? resolveThreadKey(rawKey) : ''
  const isSide =
    scope.surface === 'side' ||
    isSideSessionKey(canonicalKey) ||
    Boolean(canonicalKey && state.sideParentByKey && canonicalKey in state.sideParentByKey)
  const surface: ConversationSurface = isSide ? 'side' : 'main'
  const readOnly = scope.surface === 'side' ? scope.readOnly : isSide

  // Main surface targeting the active Main conversation reads projected top-level store fields.
  if (!isSide && (!canonicalKey || canonicalKey === mainCanonical)) {
    const hydrating = Boolean(
      (canonicalKey && state.hydratingSessionFile === canonicalKey) ||
        (canonicalKey && state.hydratingSessions?.[canonicalKey])
    )
    return {
      surface: 'main',
      sessionKey: canonicalKey || rawKey,
      readOnly: false,
      items: state.items,
      isStreaming: state.isStreaming,
      run: state.run,
      transport: state.transport,
      status: state.status,
      retry: state.retry,
      error: state.error,
      cwdWait: state.cwdWait,
      piState: state.piState,
      models: state.models,
      thinkingLevels: state.thinkingLevels,
      stats: state.stats,
      contextBreakdown: state.contextBreakdown,
      hydrating,
      clientKey: state.clientKey,
      submitSeq: state.submitSeq ?? 0,
      queue: state.queue,
      commands: state.commands,
      uiStatuses: state.uiStatuses,
      historyLoaded: Boolean(state.historyLoaded),
      historyTruncated: Boolean(state.historyTruncated)
    }
  }

  const thread = (canonicalKey ? state.threads[canonicalKey] : undefined) ?? IDLE_SIDE_THREAD
  const hydrating = Boolean(canonicalKey && state.hydratingSessions?.[canonicalKey])

  return {
    surface,
    sessionKey: canonicalKey || rawKey,
    readOnly,
    items: thread.items,
    isStreaming: thread.isStreaming,
    run: thread.run,
    transport: thread.transport,
    status: thread.status,
    retry: thread.retry,
    error: thread.error,
    cwdWait: thread.cwdWait,
    piState: thread.piState,
    models: thread.models ?? EMPTY_MODELS,
    thinkingLevels: thread.thinkingLevels ?? EMPTY_LEVELS,
    stats: thread.stats,
    contextBreakdown: thread.contextBreakdown,
    hydrating,
    clientKey: thread.clientKey || IDLE_SIDE_THREAD.clientKey,
    submitSeq: thread.submitSeq ?? 0,
    queue: thread.queue ?? EMPTY_QUEUE,
    commands: thread.commands ?? EMPTY_COMMANDS,
    uiStatuses: thread.uiStatuses ?? EMPTY_UI_STATUSES,
    historyLoaded: Boolean(thread.historyLoaded),
    historyTruncated: Boolean(thread.historyTruncated)
  }
}

export function useSessionViewSlice(explicitKey?: string): SessionViewSlice {
  const scope = useConversationScope()
  return useAppStore(useShallow((state) => readSessionViewSlice(state, scope, explicitKey)))
}

export function useSessionSelector<T>(
  selector: (slice: SessionViewSlice, state: AppStore) => T,
  explicitKey?: string
): T {
  const scope = useConversationScope()
  return useAppStore((state) => selector(readSessionViewSlice(state, scope, explicitKey), state))
}

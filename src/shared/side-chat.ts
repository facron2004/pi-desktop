/**
 * Shared Side Chat constants, session key predicates, and IPC contracts.
 *
 * Kept free of Node built-ins so both main/preload (`tsconfig.node.json`) and
 * renderer (`tsconfig.web.json`) import the exact same definitions.
 */

export const SIDE_CHAT_DIR_NAME = '_side-chats'
export const SIDE_DRAFT_PREFIX = 'draft:side:'
export const SIDE_CHAT_STATUS_KEY = 'pi-desktop-side-chat'
export const SIDE_CHAT_META_ENTRY_TYPE = 'pi-desktop-side-chat'
export const SIDE_CHAT_TURN_META_ENTRY_TYPE = 'pi-desktop-side-turn-meta'

export const MAX_SIDE_CHAT_REFERENCES = 6
export const MAX_SIDE_CHAT_SNIPPET_CHARS = 2000

export type SessionRuntimeRole = 'main' | 'side'

export type SideChatPresetKind =
  | 'explain-live'
  | 'summarize-main'
  | 'diagnose-error'
  | 'breakdown-plan'
  | 'review-session'
  | 'review-worktree'

export type SideChatReference =
  | {
      id: string
      kind: 'selection'
      sourceMainKey: string
      turnId?: string
      messageId?: string
      source: 'user' | 'assistant' | 'tool' | 'thinking'
      snippet: string
    }
  | {
      id: string
      kind: 'turn'
      sourceMainKey: string
      turnId: string
      turnOrdinal: number
      assistantMessageId?: string
      preview: string
    }
  | {
      id: string
      kind: 'tool'
      sourceMainKey: string
      turnId?: string
      toolCallId: string
      toolName: string
      summary: string
      status: 'proposed' | 'running' | 'ok' | 'error' | 'aborted'
    }
  | {
      id: string
      kind: 'error'
      sourceMainKey: string
      turnId?: string
      title?: string
      message: string
    }
  | {
      id: string
      kind: 'file-diff'
      sourceMainKey: string
      filePath: string
      lineRange?: { start: number; end: number }
      snippet?: string
    }

export interface SideChatStateSnapshot {
  parentSessionKey: string
  activeSideKey: string
  hasPersistedHistory: boolean
  parentRunning: boolean
  parentTurnCount: number
  sessionChangedFiles: string[]
}

export interface SideChatStagePromptInput {
  sideSessionKey: string
  parentSessionKey: string
  references?: SideChatReference[]
  preset?: SideChatPresetKind
  stepText?: string
}

export interface SideChatTurnMetaPayload {
  userText?: string
  references?: SideChatReference[]
  preset?: SideChatPresetKind
  stepText?: string
  timestamp: number
}

export function isSideSessionKey(key: string | null | undefined): boolean {
  if (!key) return false
  return key.startsWith(SIDE_DRAFT_PREFIX) || /[\\/]_side-chats(?:[\\/]|$)/i.test(key)
}

export function mintSideDraftKey(): string {
  const uuid =
    typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`
  return `${SIDE_DRAFT_PREFIX}${uuid}`
}

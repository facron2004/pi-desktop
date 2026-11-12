/**
 * Per-conversation view preferences.
 *
 * Expansion is a property of the reader's place in a conversation, not of a
 * React component instance. Components are unmounted when the view changes,
 * so the state lives here, keyed by the same conversation key the store uses.
 * These are view preferences only: none of this is execution state.
 */

interface ConversationViewState {
  toolOpen: Map<string, boolean>
  toolFull: Map<string, boolean>
  fileOpen: Map<string, boolean>
  processOpen: Map<string, boolean>
  historyFirstVisibleTurn?: number
}

const conversations = new Map<string, ConversationViewState>()

function stateFor(threadId: string, create = false): ConversationViewState | undefined {
  let state = conversations.get(threadId)
  if (!state && create) {
    state = {
      toolOpen: new Map(),
      toolFull: new Map(),
      fileOpen: new Map(),
      processOpen: new Map()
    }
    conversations.set(threadId, state)
  }
  return state
}

function prune(threadId: string, state: ConversationViewState): void {
  if (
    state.toolOpen.size === 0 &&
    state.toolFull.size === 0 &&
    state.fileOpen.size === 0 &&
    state.processOpen.size === 0 &&
    state.historyFirstVisibleTurn === undefined
  ) {
    conversations.delete(threadId)
  }
}

/** Whether one row of the stream is opened. */
export function readToolOpen(threadId: string, toolId: string): boolean | undefined {
  return stateFor(threadId)?.toolOpen.get(toolId)
}

export function writeToolOpen(threadId: string, toolId: string, open: boolean | undefined): void {
  if (open !== undefined) {
    stateFor(threadId, true)!.toolOpen.set(toolId, open)
    return
  }
  const state = stateFor(threadId)
  if (!state) return
  state.toolOpen.delete(toolId)
  prune(threadId, state)
}

export function readToolFull(threadId: string, toolId: string): boolean {
  return stateFor(threadId)?.toolFull.get(toolId) ?? false
}

export function writeToolFull(threadId: string, toolId: string, full: boolean): void {
  stateFor(threadId, true)!.toolFull.set(toolId, full)
}

export function readFileOpen(threadId: string, path: string): boolean {
  return stateFor(threadId)?.fileOpen.get(path) ?? false
}

export function writeFileOpen(threadId: string, path: string, open: boolean): void {
  stateFor(threadId, true)!.fileOpen.set(path, open)
}

export function readProcessOpen(threadId: string, processId: string): boolean | undefined {
  return stateFor(threadId)?.processOpen.get(processId)
}

export function writeProcessOpen(
  threadId: string,
  processId: string,
  open: boolean | undefined
): void {
  if (open !== undefined) {
    stateFor(threadId, true)!.processOpen.set(processId, open)
    return
  }
  const state = stateFor(threadId)
  if (!state) return
  state.processOpen.delete(processId)
  prune(threadId, state)
}

export function readHistoryFirstVisibleTurn(threadId: string): number | undefined {
  return stateFor(threadId)?.historyFirstVisibleTurn
}

export function writeHistoryFirstVisibleTurn(threadId: string, firstVisibleTurn: number | undefined): void {
  const state = stateFor(threadId, firstVisibleTurn !== undefined)
  if (!state) return
  if (firstVisibleTurn === undefined) delete state.historyFirstVisibleTurn
  else state.historyFirstVisibleTurn = Math.max(0, Math.floor(firstVisibleTurn))
  prune(threadId, state)
}

/** Drop view preferences for a conversation that no longer exists. */
export function clearViewState(threadId: string): void {
  conversations.delete(threadId)
}

/** Carry a draft's open rows over when Pi writes it to a session file. */
export function migrateViewState(from: string, to: string): void {
  if (from === to) return
  const source = conversations.get(from)
  if (!source) return
  const target = conversations.get(to)
  if (!target) {
    conversations.delete(from)
    conversations.set(to, source)
    return
  }

  for (const [id, value] of source.toolOpen) {
    if (!target.toolOpen.has(id)) target.toolOpen.set(id, value)
  }
  for (const [id, value] of source.toolFull) {
    if (!target.toolFull.has(id)) target.toolFull.set(id, value)
  }
  for (const [id, value] of source.fileOpen) {
    if (!target.fileOpen.has(id)) target.fileOpen.set(id, value)
  }
  for (const [id, value] of source.processOpen) {
    if (!target.processOpen.has(id)) target.processOpen.set(id, value)
  }
  if (source.historyFirstVisibleTurn !== undefined) {
    target.historyFirstVisibleTurn = target.historyFirstVisibleTurn === undefined
      ? source.historyFirstVisibleTurn
      : Math.min(target.historyFirstVisibleTurn, source.historyFirstVisibleTurn)
  }
  conversations.delete(from)
}

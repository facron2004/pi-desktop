/**
 * Per-conversation view preferences.
 *
 * Expansion is a property of the reader's place in a conversation, not of a
 * React component instance. Components are unmounted when the view changes,
 * so the state lives here, keyed by the same conversation key the store uses.
 * These are view preferences only: none of this is execution state.
 */

const toolOpen = new Map<string, boolean>()
const toolFull = new Map<string, boolean>()
const fileOpen = new Map<string, boolean>()
const processOpen = new Map<string, boolean>()
const historyExpanded = new Set<string>()

function keyOf(threadId: string, id: string): string {
  return `${threadId}\u0000${id}`
}

export function readToolOpen(threadId: string, toolId: string): boolean | undefined {
  return toolOpen.get(keyOf(threadId, toolId))
}

export function writeToolOpen(threadId: string, toolId: string, open: boolean | undefined): void {
  const key = keyOf(threadId, toolId)
  if (open === undefined) toolOpen.delete(key)
  else toolOpen.set(key, open)
}

export function readToolFull(threadId: string, toolId: string): boolean {
  return toolFull.get(keyOf(threadId, toolId)) ?? false
}

export function writeToolFull(threadId: string, toolId: string, full: boolean): void {
  toolFull.set(keyOf(threadId, toolId), full)
}

export function readFileOpen(threadId: string, path: string): boolean {
  return fileOpen.get(keyOf(threadId, path)) ?? false
}

export function writeFileOpen(threadId: string, path: string, open: boolean): void {
  fileOpen.set(keyOf(threadId, path), open)
}

export function readProcessOpen(threadId: string, processId: string): boolean | undefined {
  return processOpen.get(keyOf(threadId, processId))
}

export function writeProcessOpen(
  threadId: string,
  processId: string,
  open: boolean | undefined
): void {
  const key = keyOf(threadId, processId)
  if (open === undefined) processOpen.delete(key)
  else processOpen.set(key, open)
}

export function readHistoryExpanded(threadId: string): boolean {
  return historyExpanded.has(threadId)
}

export function writeHistoryExpanded(threadId: string, expanded: boolean): void {
  if (expanded) historyExpanded.add(threadId)
  else historyExpanded.delete(threadId)
}

/** Carry a draft's open rows over when Pi writes its session file. */
export function migrateViewState(from: string, to: string): void {
  if (from === to) return
  for (const map of [toolOpen, toolFull, fileOpen, processOpen]) {
    for (const [key, value] of [...map]) {
      const [threadId, id] = key.split('\u0000')
      if (threadId !== from) continue
      map.delete(key)
      if (!map.has(`${to}\u0000${id}`)) map.set(`${to}\u0000${id}`, value)
    }
  }
  if (historyExpanded.has(from)) {
    historyExpanded.delete(from)
    historyExpanded.add(to)
  }
}

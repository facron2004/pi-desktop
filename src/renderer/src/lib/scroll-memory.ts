/**
 * Per-conversation scroll memory.
 *
 * The transcript is a single scroll container that is reused when the reader
 * switches conversations. Each conversation therefore has to remember two
 * things on its own: where the reader was, and whether they were following
 * the live output. This module is the pure arithmetic; `Thread` owns the DOM
 * and the map.
 */

/** How far from the bottom still counts as "following the output". */
export const SCROLL_FOLLOW_RANGE = 80

/** What one conversation remembers. */
export interface ScrollMemoryEntry {
  /** The scroll offset the reader left the conversation at, in pixels. */
  top: number
  /** Whether the reader was at (or near) the bottom when they left. */
  atBottom: boolean
}

export interface ScrollMetrics {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export function distanceFromBottom(node: ScrollMetrics): number {
  return Math.max(0, node.scrollHeight - node.scrollTop - node.clientHeight)
}

/** Whether the reader is close enough to the bottom to keep following. */
export function isNearBottom(node: ScrollMetrics, range = SCROLL_FOLLOW_RANGE): boolean {
  return distanceFromBottom(node) < range
}

/** The entry to store when the reader leaves a conversation. */
export function captureScroll(node: ScrollMetrics, range = SCROLL_FOLLOW_RANGE): ScrollMemoryEntry {
  return { top: Math.max(0, node.scrollTop), atBottom: isNearBottom(node, range) }
}

/** Clamp a stored offset to what the current (possibly shorter) transcript allows. */
export function clampScrollTop(node: ScrollMetrics): number {
  return Math.max(0, Math.min(node.scrollTop, node.scrollHeight - node.clientHeight))
}

/**
 * Apply a stored entry and report the follow state the caller should adopt.
 * A conversation that was at the bottom follows again; one that was reading
 * up stays frozen.
 */
export function applyScroll(
  node: ScrollMetrics,
  entry: ScrollMemoryEntry | undefined,
  range = SCROLL_FOLLOW_RANGE
): { stick: boolean; atBottom: boolean; top: number } {
  if (!entry || entry.atBottom) {
    return { stick: true, atBottom: true, top: Math.max(0, node.scrollHeight - node.clientHeight) }
  }
  const top = Math.max(0, Math.min(entry.top, node.scrollHeight - node.clientHeight))
  return { stick: isNearBottom({ ...node, scrollTop: top }, range), atBottom: false, top }
}

/* ------------------------------------------------------------------ *
 * Process-wide conversation memories
 *
 * `Thread` is unmounted whenever the active view is an empty chat. A
 * component-local Map would therefore forget the reader's place exactly when
 * they glance at a new conversation and come back. The map belongs to the
 * module, keyed by the same conversation key the store uses.
 * ------------------------------------------------------------------ */

const memories = new Map<string, ScrollMemoryEntry>()

export function readScrollMemory(key: string): ScrollMemoryEntry | undefined {
  return memories.get(key)
}

export function rememberScrollMemory(
  key: string,
  node: ScrollMetrics,
  range = SCROLL_FOLLOW_RANGE
): void {
  memories.set(key, captureScroll(node, range))
}

export function rememberScrollPosition(key: string, entry: ScrollMemoryEntry): void {
  memories.set(key, entry)
}

/** Move the reader's place when a draft becomes a session file. */
export function migrateScrollMemory(from: string, to: string): void {
  if (from === to) return
  const entry = memories.get(from)
  if (!entry) return
  if (!memories.has(to)) memories.set(to, entry)
  memories.delete(from)
}

/** Drop one conversation's memory, or all of them. */
export function clearScrollMemory(key?: string): void {
  if (key === undefined) memories.clear()
  else memories.delete(key)
}

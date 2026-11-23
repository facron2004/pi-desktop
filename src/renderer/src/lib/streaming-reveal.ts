/**
 * Pacing for a streamed answer that arrives in one large chunk.
 *
 * Pi's deltas are painted once per animation frame, but a provider can still
 * hand over a whole paragraph at once. When that happens the reader sees a
 * wall of text appear in a single frame. This module supplies the visible
 * character count for a small typewriter layer: the full text stays in the
 * store as the source of truth, and this only decides how much of it is
 * painted so far.
 *
 * The pace is deliberately adaptive. A slow provider that already delivers a
 * few characters per frame must not be slowed down by an artificial queue,
 * and a very long reply must not take minutes to finish revealing.
 */

/** Characters per second at the current distance from the full text. */
export function revealSpeed(charsBehind: number): number {
  if (charsBehind > 1200) return 2400
  if (charsBehind > 400) return 800
  return 220
}

/**
 * Advance the visible character count by one frame.
 *
 * `elapsedMs` is clamped so a backgrounded tab does not dump the whole answer
 * on return, and the step is at least one character so a small gap still
 * closes. The result never passes `target`.
 */
export function advanceReveal(shown: number, target: number, elapsedMs: number): number {
  if (shown >= target) return target
  const elapsed = Math.min(64, Math.max(0, elapsedMs))
  const step = Math.max(1, Math.round((revealSpeed(target - shown) * elapsed) / 1000))
  return Math.min(target, shown + step)
}

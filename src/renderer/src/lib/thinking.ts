/**
 * Reasoning effort helpers.
 *
 * Pi reports the levels a model supports, but the saved/live level can come
 * from a different model (or from a session opened before Pi has answered).
 * The UI must only ever show a level that exists in that model's list;
 * otherwise the slider has no position and paints as an empty bar.
 */

const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Generic choices for settings that can be saved before Pi reports model-specific levels. */
export const DEFAULT_THINKING_LEVELS: readonly string[] = EFFORT_ORDER

function rankOf(level: string): number | undefined {
  const index = EFFORT_ORDER.indexOf(level.toLowerCase())
  return index < 0 ? undefined : index
}

/**
 * Pick a usable effort level for `levels`.
 *
 * Preference order: the live level, the saved level, then the supported level
 * closest to the preferred one. `undefined` means the model has no levels at
 * all (or Pi has not reported them yet), which the caller renders as an empty
 * state instead of a broken slider.
 */
export function resolveThinkingLevel(
  levels: readonly string[],
  liveLevel?: string,
  savedLevel?: string
): string | undefined {
  if (levels.length === 0) return undefined

  const find = (value?: string) =>
    value ? levels.find((level) => level.toLowerCase() === value.toLowerCase()) : undefined

  const live = find(liveLevel)
  if (live) return live
  const saved = find(savedLevel)
  if (saved) return saved

  const preferred = liveLevel ?? savedLevel
  if (!preferred) return levels[0]
  const preferredRank = rankOf(preferred)
  if (preferredRank === undefined) return levels[0]

  let best = levels[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of levels) {
    const rank = rankOf(level)
    if (rank === undefined) continue
    const distance = Math.abs(rank - preferredRank)
    if (distance < bestDistance) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

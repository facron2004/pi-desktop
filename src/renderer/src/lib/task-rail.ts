/**
 * What the task-rail toggle means.
 *
 * The rail folds itself when a docked tool panel narrows the main stage, and
 * `narrowOverride` is the reader's word about that narrow episode (`null`: no
 * word, so it stays folded). A press is not a loan for the episode — it is the
 * reader's preference — so it moves the base preference too.
 *
 * Without that, closing the panel gave the width back, the board fell through
 * to the old base value, and the rail vanished again: the reader pressed "show
 * task status", saw it appear, closed the panel, and watched the same control
 * undo itself. Only the narrow episode resets `narrowOverride` (in `App`, when
 * the stage is wide again), so the next episode starts from the same auto-fold
 * every other reader gets.
 */
export interface TaskRailPress {
  narrowOverride: boolean | null
  base: boolean
}

export function toggleTaskRail(state: {
  narrow: boolean
  narrowOverride: boolean | null
  base: boolean
}): TaskRailPress {
  if (!state.narrow) return { narrowOverride: state.narrowOverride, base: !state.base }
  // In a narrow stage the rail is folded unless the reader said otherwise, so
  // the press flips the visible state, not the base one.
  const next = !(state.narrowOverride ?? false)
  return { narrowOverride: next, base: next }
}

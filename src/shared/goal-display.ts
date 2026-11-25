import type { GoalState } from './types'

/**
 * What the goal bar's badge says.
 *
 * The bar answers one question — is this objective being worked on right now? —
 * so a live goal has exactly two words. A goal the extension paused and a goal
 * that was restored with nobody running it are the same thing to the reader:
 * both are `Paused`. `blocked` and `complete` keep their own word because they
 * are outcomes, not a run state, and calling a finished goal "paused" would be
 * a lie.
 *
 * `status` is the value the badge writes into `data-status` (the stylesheet's
 * own names), `label` is the i18n key.
 */
export interface GoalBadge {
  status: 'active' | 'paused' | 'blocked' | 'complete'
  label: 'Running' | 'Paused' | 'Blocked' | 'Complete'
}

export function goalBadge(status: GoalState['status'], running: boolean): GoalBadge {
  if (running) return { status: 'active', label: 'Running' }
  if (status === 'blocked') return { status: 'blocked', label: 'Blocked' }
  if (status === 'complete') return { status: 'complete', label: 'Complete' }
  return { status: 'paused', label: 'Paused' }
}

/** Only a live goal can be toggled: an outcome is not a run to start again. */
export function goalCanToggleRun(badge: GoalBadge): boolean {
  return badge.status === 'active' || badge.status === 'paused'
}

/**
 * Whether the objective still needs a bar above the composer.
 *
 * A finished goal does not: the work is over, and the closing row at the end of
 * the transcript (`GoalCompleteRow`) is where its objective and summary belong.
 * Everything that reacts to "a goal is on screen" reads this, so the composer
 * cannot hide a control for a bar that is still drawn, or reserve room for one
 * that is gone.
 */
export function goalBarVisible(status: GoalState['status'] | undefined): boolean {
  return status !== undefined && status !== 'complete'
}

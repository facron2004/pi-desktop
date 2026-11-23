/**
 * When the sidebar's update control should be drawn.
 *
 * Codex keeps a `dismissed_version` beside the latest one it found
 * (`codex-rs/tui/src/updates.rs`, `updates_cache`): a reader who says "not this
 * one" stops being told about *that* release, and the notice comes back by
 * itself as soon as something newer is published. The alternative — a control
 * that nags until it is obeyed — is what this replaces.
 *
 * Kept free of React and of the store so the rule can be tested on its own.
 */

export interface UpdateNoticeState {
  /** The release the last check found, when one is offered. */
  latest?: string | null
  /** The version the reader told the app not to mention again. */
  dismissedVersion?: string | null
  /** A download is running: the control is progress now, not a notice. */
  busy?: boolean
  /** The installer is on disk: the control is the restart affordance. */
  ready?: boolean
}

export function shouldShowUpdateNotice(state: UpdateNoticeState): boolean {
  if (!state.latest) return false
  // Work in flight is never hidden: a half-downloaded installer the reader
  // cannot see or restart is worse than the notice they dismissed.
  if (state.busy || state.ready) return true
  return state.dismissedVersion?.trim() !== state.latest
}

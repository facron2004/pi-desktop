/**
 * When the usage line under the composer prints its readings.
 *
 * The line is a report on a turn, not a live readout. While the turn is still
 * running — including when the reader has interjected and Pi is working on the
 * same run — the numbers would tick under a conversation that is not finished,
 * and a figure read mid-run describes a turn nobody can compare it with yet.
 * The readings appear when the run settles, which is the moment the reader can
 * put them beside what the turn actually did.
 *
 * The context ring is not one of those readings. It is a live gauge: it says
 * how full the window the next prompt has to fit in is, which is exactly what a
 * reader watching a long run needs to know. It stays while the run goes.
 *
 * `phase !== 'idle'` with `settled` false is the same "a run is open" state the
 * transcript draws its status row from (`Thread`'s `runOpen`): `queued` covers
 * the window between handing Pi a prompt and its first event, and `aborting`
 * covers a stop that has not landed yet.
 */
export interface UsageRun {
  phase: string
  settled?: boolean
}

export function usageReadingsVisible(run: UsageRun | undefined, isStreaming: boolean): boolean {
  if (isStreaming) return false
  if (!run) return true
  return run.phase === 'idle' || run.settled === true
}

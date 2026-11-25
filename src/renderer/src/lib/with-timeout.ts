/**
 * Await a promise, but not forever.
 *
 * A model or reasoning switch talks to a Pi process that can be busy with a long
 * turn, wedged, or already gone. Without a deadline the promise may never settle:
 * the control stays "updating" and the next attempt is refused as "already in
 * progress" for the rest of the session — which reads as a frozen switch.
 *
 * The work is not cancelled (the store's callers cannot abort an IPC request);
 * the deadline only decides when the UI stops waiting.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

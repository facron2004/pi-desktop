import type { TerminalExitPayload } from '@shared/types'

/** Holds shell exits that can arrive before terminal:create returns its ID. */
export class EarlyTerminalExits {
  private readonly exits = new Map<string, TerminalExitPayload>()

  record(exit: TerminalExitPayload): void {
    this.exits.set(exit.id, exit)
  }

  takeFor(id: string): TerminalExitPayload | undefined {
    const exit = this.exits.get(id)
    this.exits.clear()
    return exit
  }
}

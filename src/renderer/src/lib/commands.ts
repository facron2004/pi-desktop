import type { PiCommand } from '@shared/types'

/**
 * How well a command matches what was typed.
 *
 * A command that contains the query as it is wins over one that only has
 * the letters of the query in the right order, and a tight match wins
 * over a loose one. A negative score means the command does not match.
 */
export function matchScore(command: PiCommand, needle: string): number {
  const name = command.name.toLowerCase()
  if (name === needle) return 1000

  const direct = name.indexOf(needle)
  if (direct !== -1) return 800 - direct

  const description = command.description?.toLowerCase() ?? ''
  const inDescription = description.indexOf(needle)
  if (inDescription !== -1) return 600 - inDescription

  // The letters of the query in order, spread over the name: "expt" finds
  // "export".
  let at = 0
  let gaps = 0
  for (const letter of needle) {
    const found = name.indexOf(letter, at)
    if (found === -1) return -1
    gaps += found - at
    at = found + 1
  }
  return 400 - gaps
}

/**
 * The commands that match a query, the best one first.
 *
 * Without a query the order is left alone, so the commands the app adds
 * stay in front of the ones Pi provides.
 */
export function filterCommands(commands: PiCommand[], query: string): PiCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return commands

  return commands
    .map((command, index) => ({ command, index, score: matchScore(command, needle) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command)
}

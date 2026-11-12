import type { PiCommand } from '@shared/types'
import type { AppLanguage } from '@shared/types'
import { APP_COMMAND_ZH_NAMES } from './app-commands'

/**
 * How well a command matches what was typed.
 *
 * A command that contains the query as it is wins over one that only has
 * the letters of the query in the right order, and a tight match wins
 * over a loose one. A negative score means the command does not match.
 */
export function matchScore(command: PiCommand, needle: string, language: AppLanguage = 'en'): number {
  const name = command.name.toLowerCase()
  if (name === needle) return 1000

  if (language === 'zh-CN' && command.source === 'app') {
    const localizedName = APP_COMMAND_ZH_NAMES[command.name]?.toLowerCase()
    if (localizedName === needle) return 1000
    const localizedMatch = localizedName?.indexOf(needle) ?? -1
    if (localizedMatch !== -1) return 800 - localizedMatch
  }

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
export function filterCommands(commands: PiCommand[], query: string, language: AppLanguage = 'en'): PiCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return commands

  return commands
    .map((command, index) => ({ command, index, score: matchScore(command, needle, language) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.command)
}

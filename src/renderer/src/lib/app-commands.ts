import type { PiCommand } from '@shared/types'

/**
 * The commands the desktop app offers next to Pi's own.
 *
 * Pi's built-in commands — `/name`, `/export`, `/fork` and the rest — only
 * exist in the interactive terminal; the RPC mode does not run them. The app
 * implements the ones that make sense here, so the palette has a single place
 * for everything that can be typed.
 */
export const APP_COMMANDS: PiCommand[] = [
  {
    name: 'name',
    description: 'Rename this conversation — follow it with the new name',
    source: 'app',
    takesArgument: true
  },
  {
    name: 'export',
    description: 'Export this conversation as HTML',
    source: 'app'
  },
  {
    name: 'duplicate',
    description: 'Copy this conversation into a new one',
    source: 'app'
  },
  {
    name: 'branch',
    description: 'Branch from the last prompt',
    source: 'app'
  },
  {
    name: 'tree',
    description: 'Show the branches of this conversation',
    source: 'app'
  },
  {
    name: 'mcp',
    description: 'Show the MCP servers configured for this project',
    source: 'app'
  },
  {
    name: 'compact',
    description: 'Summarise the conversation to free up the context',
    source: 'app'
  },
  {
    name: 'copy',
    description: 'Copy the last answer to the clipboard',
    source: 'app'
  },
  {
    name: 'changes',
    description: 'Review the files Pi changed',
    source: 'app'
  },
  {
    name: 'commit',
    description: 'Review the working tree and commit it',
    source: 'app'
  },
  {
    name: 'terminal',
    description: 'Open or close the terminal',
    source: 'app'
  },
  {
    name: 'files',
    description: 'Browse the project files',
    source: 'app'
  },
  {
    name: 'new',
    description: 'Start a new conversation',
    source: 'app'
  }
]

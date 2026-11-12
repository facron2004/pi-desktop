import type { AppLanguage, PiCommand } from '@shared/types'

/** Chinese aliases are what users see and type in the Chinese interface. */
export const APP_COMMAND_ZH_NAMES: Record<string, string> = {
  name: '重命名',
  plan: '计划',
  goal: '目标',
  subagent: '子代理',
  plugin: '插件',
  export: '导出对话',
  duplicate: '复制对话',
  branch: '创建分支',
  tree: '会话树',
  mcp: '服务配置',
  compact: '压缩上下文',
  copy: '复制回复',
  changes: '查看更改',
  commit: '提交更改',
  terminal: '终端',
  files: '项目文件',
  new: '新建对话'
}

export function appCommandName(name: string, language: AppLanguage): string {
  return language === 'zh-CN' ? APP_COMMAND_ZH_NAMES[name] ?? name : name
}

/** Convert a Chinese command typed in the composer to Pi's canonical token. */
export function normalizeAppCommandInput(text: string): string {
  const match = /^\/([^\s]+)([\s\S]*)$/.exec(text)
  if (!match) return text
  const alias = match[1].toLocaleLowerCase()
  const canonical = Object.entries(APP_COMMAND_ZH_NAMES).find(
    ([, localized]) => localized.toLocaleLowerCase() === alias
  )?.[0]
  return canonical ? `/${canonical}${match[2]}` : text
}

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
    name: 'plan',
    description: 'Enter Plan Mode — explore read-only, then approve the plan',
    source: 'app',
    takesArgument: true
  },
  {
    name: 'goal',
    description: 'Set a goal this conversation keeps working toward',
    source: 'app',
    takesArgument: true
  },
  {
    name: 'subagent',
    description: 'Switch to Subagent Mode — delegate independent work',
    source: 'app'
  },
  {
    name: 'plugin',
    description: 'Switch to Plugin Mode — build or modify a Pi extension',
    source: 'app'
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

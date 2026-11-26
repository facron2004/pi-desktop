/**
 * What the settings search can find.
 *
 * This is a hand-written index, not a scrape of the components: the pages are
 * lazy, and mounting all twelve just to read their labels would start provider
 * and update requests. The index names the settings a reader is likely to look
 * for, with the words they might type in either language. A setting that is
 * missing here is still reachable by its page; adding a row is a one-line
 * change, and `tests/settings-search.test.ts` proves every row still points at
 * a real page and has a Chinese reading.
 */

import type { SettingsPage } from './settings-pages'

export interface SettingsSearchEntry {
  page: SettingsPage
  /** The English label the page renders (a key in the i18n map). */
  label: string
  /** Extra words that should find this row, in either language. */
  keywords: string[]
}

export const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  // General
  { page: 'general', label: 'Language', keywords: ['language', 'locale', 'english', 'chinese', '语言', '界面', '中文', '英文'] },
  { page: 'general', label: 'Default file opening location', keywords: ['open', 'editor', 'folder', '默认', '打开', '编辑器'] },
  { page: 'general', label: 'Out-of-project chat folder', keywords: ['chat folder', 'storage', '数据', '文件夹', '聊天目录'] },
  { page: 'general', label: 'Compact locally saved chat history', keywords: ['history', 'disk', 'cleanup', '历史', '磁盘', '压缩'] },
  { page: 'general', label: 'Keep running in the tray', keywords: ['tray', 'close', 'quit', '托盘', '关闭', '后台'] },
  { page: 'general', label: 'Computer Use', keywords: ['computer', 'screen', 'mouse', 'desktop', '电脑', '屏幕', '鼠标'] },
  { page: 'general', label: 'Plain text editor', keywords: ['plain text', 'markdown', 'editor', '纯文本', '编辑器'] },
  { page: 'general', label: 'Show context window usage', keywords: ['context', 'usage', 'ring', '上下文', '用量'] },
  { page: 'general', label: 'Send shortcut', keywords: ['enter', 'ctrl enter', 'send', '发送', '回车'] },
  { page: 'general', label: 'Follow-up handling method', keywords: ['queue', 'steer', 'follow up', '排队', '追加'] },
  { page: 'general', label: 'Integrated terminal shell', keywords: ['terminal', 'shell', 'powershell', 'bash', '终端', '外壳'] },
  { page: 'general', label: 'Agent environment', keywords: ['windows', 'native', 'environment', '环境', '原生'] },
  // Agent and conversation
  { page: 'agent', label: 'Default model', keywords: ['model', 'provider', '模型', '提供商'] },
  { page: 'agent', label: 'Default permission', keywords: ['permission', 'approval', 'tools', '权限', '批准', '审批'] },
  { page: 'agent', label: 'Default reasoning effort', keywords: ['reasoning', 'thinking', 'effort', '推理', '思考', '强度'] },
  { page: 'agent', label: 'Default plan mode', keywords: ['plan', 'plan mode', '计划', '计划模式'] },
  { page: 'agent', label: 'Subagent model', keywords: ['subagent', 'child', 'delegate', '子智能体', '子代理', '委派'] },
  { page: 'agent', label: 'Subagent reasoning effort', keywords: ['subagent', 'reasoning', '子智能体', '推理'] },
  { page: 'agent', label: 'Auto-mention pasted images', keywords: ['paste', 'image', 'mention', '粘贴', '图片', '引用'] },
  { page: 'agent', label: 'Auto-fold the working process', keywords: ['fold', 'process', 'tools', '折叠', '过程', '工具'] },
  { page: 'agent', label: 'Tool call summary', keywords: ['tool', 'summary', 'group', '工具', '汇总', '合并'] },
  { page: 'agent', label: 'Auto-generate title', keywords: ['title', 'name', 'rename', '标题', '命名'] },
  { page: 'agent', label: 'Enable full access?', keywords: ['full access', 'permission', 'yolo', '完全访问', '权限'] },
  // Models
  { page: 'models', label: 'Add provider', keywords: ['provider', 'api', 'key', 'base url', '提供商', '接口', '密钥'] },
  { page: 'models', label: 'Providers', keywords: ['provider', 'model list', '提供商', '模型列表'] },
  { page: 'models', label: 'Test connection', keywords: ['test', 'connection', 'probe', '测试', '连接'] },
  { page: 'models', label: 'API format', keywords: ['api', 'format', 'openai', 'anthropic', 'gemini', '格式'] },
  { page: 'models', label: 'Provider name', keywords: ['name', 'provider', '名称', '提供商'] },
  { page: 'models', label: 'Save and use', keywords: ['save', 'default', '保存', '默认'] },
  // Appearance
  { page: 'appearance', label: 'Mode', keywords: ['theme', 'dark', 'light', 'system', '模式', '深色', '浅色', '跟随系统'] },
  { page: 'appearance', label: 'Theme', keywords: ['theme', 'preset', 'palette', '主题', '预设', '配色'] },
  { page: 'appearance', label: 'Accent color', keywords: ['accent', 'color', '强调色', '颜色'] },
  { page: 'appearance', label: 'Background', keywords: ['background', 'canvas', '背景'] },
  { page: 'appearance', label: 'Foreground', keywords: ['foreground', 'text', '前景', '文字颜色'] },
  { page: 'appearance', label: 'Tone', keywords: ['contrast', 'tone', '对比度', '色调'] },
  { page: 'appearance', label: 'Font', keywords: ['font', 'family', '字体', '字形'] },
  { page: 'appearance', label: 'Text size', keywords: ['font size', 'scale', '字号', '字体大小', '缩放'] },
  { page: 'appearance', label: 'Diff layout', keywords: ['diff', 'unified', 'split', '差异', '并排', '统一'] },
  { page: 'appearance', label: 'Desktop notifications', keywords: ['notification', 'notify', '通知', '提醒'] },
  // Usage
  { page: 'usage', label: 'Total cost', keywords: ['cost', 'price', 'spend', '费用', '花费'] },
  { page: 'usage', label: 'Cache hit rate', keywords: ['cache', 'hit rate', '缓存', '命中率'] },
  { page: 'usage', label: 'Usage heatmap', keywords: ['heatmap', 'activity', '热力图', '活跃'] },
  { page: 'usage', label: 'Compact automatically', keywords: ['compact', 'context', '压缩', '上下文'] },
  { page: 'usage', label: 'Retry automatically', keywords: ['retry', 'error', '重试', '错误'] },
  // Shortcuts
  { page: 'shortcuts', label: 'Keyboard shortcuts', keywords: ['keyboard', 'shortcut', 'keybinding', '快捷键', '键位'] },
  { page: 'shortcuts', label: 'Reset all', keywords: ['reset', 'default', '重置', '恢复默认'] },
  // Personalization
  { page: 'personalization', label: 'Custom instructions', keywords: ['instructions', 'prompt', 'system', '指令', '提示词', '个性化'] },
  { page: 'personalization', label: 'Instructions for Pi', keywords: ['instructions', 'system prompt', '指令', '系统提示词'] },
  // Remote access
  { page: 'remote', label: 'Enable remote access', keywords: ['remote', 'phone', 'mobile', '远程', '手机', '移动端'] },
  { page: 'remote', label: 'Pair a phone', keywords: ['pair', 'qr', 'code', '配对', '二维码', '验证码'] },
  { page: 'remote', label: 'Paired phones', keywords: ['phones', 'paired', 'devices', '设备', '手机'] },
  { page: 'remote', label: 'Remove paired phone', keywords: ['revoke', 'remove', '解除', '移除'] },
  // IM channels
  { page: 'im-channels', label: 'Add Feishu channel', keywords: ['feishu', 'lark', 'bot', '飞书', '机器人'] },
  { page: 'im-channels', label: 'Add WeChat channel', keywords: ['wechat', 'webhook', '微信'] },
  { page: 'im-channels', label: 'Bridge URL', keywords: ['url', 'bridge', 'webhook', '地址', '桥接'] },
  { page: 'im-channels', label: 'Bridge personal token', keywords: ['token', 'secret', 'personal token', '密钥', '令牌'] },
  { page: 'im-channels', label: 'Allowed chat IDs (optional, one per line)', keywords: ['chat id', 'allowed', '群', '会话', '允许'] },
  { page: 'im-channels', label: 'Remove channel', keywords: ['remove', 'delete', '移除', '删除'] },
  // Memory
  { page: 'memory', label: 'Use memories in new conversations', keywords: ['memory', 'memories', '记忆', '记忆库'] },
  { page: 'memory', label: 'Learn from finished conversations', keywords: ['learn', 'learning', '学习', '记忆'] },
  { page: 'memory', label: 'Extraction model', keywords: ['extraction', 'model', '提取', '模型'] },
  { page: 'memory', label: 'Learn from recent', keywords: ['learn', 'recent', '学习', '最近'] },
  { page: 'memory', label: 'Clear all', keywords: ['clear', 'delete all', '清空', '删除全部'] },
  { page: 'memory', label: 'Open folder', keywords: ['folder', 'files', '文件夹', '目录'] },
  // Archived conversations
  { page: 'archived', label: 'Archived conversations', keywords: ['archived', 'archive', '归档', '已归档'] },
  { page: 'archived', label: 'Restore', keywords: ['restore', 'unarchive', '恢复', '取消归档'] },
  // About
  { page: 'about', label: 'Application version', keywords: ['version', 'app', '版本', '应用'] },
  { page: 'about', label: 'Built-in service version', keywords: ['pi', 'cli', 'version', '内置', '服务', '版本'] },
  { page: 'about', label: 'Check for updates', keywords: ['update', 'upgrade', '更新', '升级'] },
  { page: 'about', label: 'Automatically check for updates', keywords: ['update', 'automatic', '自动', '更新'] }
]

export interface SettingsSearchPage {
  id: SettingsPage
  /** The English page label, a key in the i18n map. */
  label: string
}

export interface SettingsSearchResult {
  page: SettingsPage
  /** The page label, translated for the interface on screen. */
  label: string
  /** The matching setting's label, when the page itself did not match. */
  match?: string
}

function normalize(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * The pages that answer `query`, in navigation order.
 *
 * An empty query returns every page (the navigation as it is at rest). A page
 * matches by its own name or by one of its indexed settings; when a setting is
 * what matched, the result carries its label so the reader knows what to look
 * for after the page opens.
 */
export function searchSettings(
  pages: readonly SettingsSearchPage[],
  query: string,
  translate: (text: string) => string
): SettingsSearchResult[] {
  const needle = normalize(query)
  const results: SettingsSearchResult[] = []
  for (const page of pages) {
    const label = translate(page.label)
    if (!needle) {
      results.push({ page: page.id, label })
      continue
    }
    if (normalize(`${page.label} ${label}`).includes(needle)) {
      results.push({ page: page.id, label })
      continue
    }
    const hit = SETTINGS_SEARCH_ENTRIES.find((entry) => {
      if (entry.page !== page.id) return false
      const haystack = `${entry.label} ${translate(entry.label)} ${entry.keywords.join(' ')}`
      return normalize(haystack).includes(needle)
    })
    if (hit) results.push({ page: page.id, label, match: translate(hit.label) })
  }
  return results
}

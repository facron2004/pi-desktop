import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FileJson,
  MessageSquare,
  RefreshCw,
  Search,
  Server,
  ShieldOff,
  Sparkles,
  Wrench,
  X
} from 'lucide-react'
import '../styles/appearance.css'
import type {
  AggregatedUsageStats,
  AuthStatus,
  McpConfig,
  McpServerInfo,
  VersionCheckResult
} from '@shared/types'
import { formatCost, formatTokens } from '../lib/format'
import { useT } from '../lib/i18n'
import { useIsDark } from '../lib/theme'
import { useAppStore } from '../store/useAppStore'
import { Popover } from './Popover'
import { Switch } from './Switch'

function NativeMark({ src }: { src?: string }) {
  if (!src) return null
  return <img className="settings-icon-select__img" src={src} alt="" />
}

function SettingsIconSelect({
  label,
  value,
  icons,
  options,
  onChange
}: {
  label: string
  value: string
  icons: Record<string, string>
  options: { value: string; label: string; icon: string }[]
  onChange: (value: string) => void
}) {
  const current = options.find((option) => option.value === value) ?? options[0]
  return (
    <Popover
      align="right"
      width={220}
      className="settings-icon-select__popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className="settings-icon-select"
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={toggle}
        >
          <NativeMark src={icons[current.icon]} />
          <span className="settings-icon-select__label">{current.label}</span>
          <ChevronDown size={13} className="settings-icon-select__chevron" data-open={open} />
        </button>
      )}
    >
      {(close) => (
        <div className="settings-icon-select__menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="settings-icon-select__option"
              onClick={() => {
                onChange(option.value)
                close()
              }}
            >
              <NativeMark src={icons[option.icon]} />
              <span>{option.label}</span>
              {option.value === value ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}

function PageIntro({ title, description }: { title: string; description: string }) {
  return (
    <header className="settings-page-head">
      <h3>{title}</h3>
      <p>{description}</p>
    </header>
  )
}

function SettingsGroup({
  title,
  action,
  children
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="settings-group">
      <div className="settings-group__head">
        <h4>{title}</h4>
        {action ? <div className="settings-group__action">{action}</div> : null}
      </div>
      <div className="settings-fields">{children}</div>
    </section>
  )
}

export interface GeneralSettingsForm {
  piPath: string
  provider: string
  defaultModel: string
  defaultThinking: string
}

interface GeneralSettingsProps {
  form?: GeneralSettingsForm
  onChange?: (patch: Partial<GeneralSettingsForm>) => void
  auth?: AuthStatus | null
  checking?: boolean
  onCheck?: (providerOverride?: string) => void
  onOpenProject?: () => void
  onResetPiPath?: () => void
}

export function GeneralSettings(_props: GeneralSettingsProps = {}) {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const info = useAppStore((state) => state.info)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()

  const currentChatFolder = settings.externalChatFolder || info?.sessionRoot || ''
  const [nativeIcons, setNativeIcons] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancel = false
    void window.pi.shell.nativeIcons().then((next) => {
      if (!cancel) setNativeIcons(next)
    })
    return () => {
      cancel = true
    }
  }, [])

  const handlePickChatFolder = async () => {
    try {
      const selected = await window.pi.dialog.pickDirectory(currentChatFolder)
      if (selected) {
        await updateSettings({ externalChatFolder: selected })
        showToast(t('Settings saved'))
      }
    } catch {
      showToast(t('Could not pick directory'), 'error')
    }
  }

  return (
    <div className="settings-page settings-page--compact">
      <SettingsGroup title={t('General')}>
        {/* 1. 项目外聊天文件夹 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Out-of-project chat folder')}</span>
            <span className="settings-item-row__desc">
              {t('Default storage location for data from new chats started outside a project.')}
            </span>
          </div>
          <div className="settings-folder-picker">
            <span className="settings-folder-path" title={currentChatFolder}>
              {currentChatFolder}
            </span>
            <button type="button" className="btn btn--sm" onClick={handlePickChatFolder}>
              {t('Change')}
            </button>
          </div>
        </div>

        {/* 2. 默认文件打开位置 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Default file opening location')}</span>
            <span className="settings-item-row__desc">{t('Default location to open files and folders')}</span>
          </div>
          <SettingsIconSelect
            label={t('Default file opening location')}
            value={settings.defaultFileOpener ?? 'vscode'}
            icons={nativeIcons}
            onChange={(value) => void updateSettings({ defaultFileOpener: value })}
            options={[
              { value: 'vscode', label: 'VS Code', icon: 'vscode' },
              { value: 'cursor', label: 'Cursor', icon: 'cursor' },
              { value: 'windsurf', label: 'Windsurf', icon: 'windsurf' },
              { value: 'system', label: t('System default'), icon: 'system' }
            ]}
          />
        </div>

        {/* 3. 智能体环境 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Agent environment')}</span>
            <span className="settings-item-row__desc">{t('Choose where the agent runs on Windows')}</span>
          </div>
          <SettingsIconSelect
            label={t('Agent environment')}
            value={settings.agentEnvironment ?? 'windows'}
            icons={nativeIcons}
            onChange={(value) => void updateSettings({ agentEnvironment: value })}
            options={[
              { value: 'windows', label: t('Windows Native'), icon: 'windows' },
              { value: 'wsl', label: 'WSL', icon: 'wsl' }
            ]}
          />
        </div>

        {/* 4. 集成终端 Shell */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Integrated terminal shell')}</span>
            <span className="settings-item-row__desc">{t('Choose the shell to open in the integrated terminal')}</span>
          </div>
          <SettingsIconSelect
            label={t('Integrated terminal shell')}
            value={settings.terminalShell ?? 'powershell'}
            icons={nativeIcons}
            onChange={(value) => void updateSettings({ terminalShell: value })}
            options={[
              { value: 'powershell', label: 'PowerShell', icon: 'powershell' },
              { value: 'cmd', label: 'Command Prompt (CMD)', icon: 'cmd' },
              { value: 'gitbash', label: 'Git Bash', icon: 'gitbash' },
              { value: 'wsl', label: 'WSL (Bash)', icon: 'wsl' }
            ]}
          />
        </div>

        {/* 5. 语言 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Language')}</span>
            <span className="settings-item-row__desc">{t('Application interface language')}</span>
          </div>
          <select
            className="input settings-select"
            aria-label={t('Language')}
            value={settings.language ?? 'zh-CN'}
            onChange={(e) => void updateSettings({ language: e.target.value as 'zh-CN' | 'en' })}
          >
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
        </div>

        {/* 6. 压缩本地保存的聊天历史记录 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Compact locally saved chat history')}</span>
            <span className="settings-item-row__desc">
              {t('Compact older local chat history to save disk space. Changes take effect after restarting.')}
            </span>
          </div>
          <Switch
            checked={settings.compactChatHistory !== false}
            onChange={(checked) => void updateSettings({ compactChatHistory: checked })}
            label={t('Compact locally saved chat history')}
          />
        </div>

        {/* 7. 插件 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Plugins')}</span>
            <span className="settings-item-row__desc">{t('Allow using installed plugins')}</span>
          </div>
          <Switch
            checked={settings.pluginsEnabled !== false}
            onChange={(checked) => void updateSettings({ pluginsEnabled: checked })}
            label={t('Plugins')}
          />
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('Editor')}>
        {/* 纯文本编辑器 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Plain text editor')}</span>
            <span className="settings-item-row__desc">
              {t('When composing messages, keep code, Markdown, and tables as plain text only')}
            </span>
          </div>
          <Switch
            checked={Boolean(settings.plainTextEditor)}
            onChange={(checked) => void updateSettings({ plainTextEditor: checked })}
            label={t('Plain text editor')}
          />
        </div>

        {/* 显示上下文窗口使用情况 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Show context window usage')}</span>
          </div>
          <Switch
            checked={settings.showContextUsage !== false}
            onChange={(checked) => void updateSettings({ showContextUsage: checked })}
            label={t('Show context window usage')}
          />
        </div>

        {/* 发送快捷键 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Send shortcut')}</span>
            <span className="settings-item-row__desc">{t('Choose whether pressing Enter sends or inserts a new line')}</span>
          </div>
          <select
            className="input settings-select"
            aria-label={t('Send shortcut')}
            value={settings.sendShortcut ?? 'enter'}
            onChange={(e) =>
              void updateSettings({ sendShortcut: e.target.value as 'enter' | 'ctrlEnter' })
            }
          >
            <option value="enter">{t('Press Enter')}</option>
            <option value="ctrlEnter">{t('Press Ctrl+Enter')}</option>
          </select>
        </div>

        {/* 跟进处理方式 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Follow-up handling method')}</span>
            <span className="settings-item-row__desc">
              {t('Queue follow-up messages while the agent is running, or steer subsequent actions.')}
            </span>
          </div>
          <div className="segmented">
            <button
              type="button"
              data-active={(settings.followUpMode ?? 'steer') === 'queue'}
              aria-pressed={(settings.followUpMode ?? 'steer') === 'queue'}
              onClick={() => void updateSettings({ followUpMode: 'queue' })}
            >
              {t('Queue')}
            </button>
            <button
              type="button"
              data-active={(settings.followUpMode ?? 'steer') === 'steer'}
              aria-pressed={(settings.followUpMode ?? 'steer') === 'steer'}
              onClick={() => void updateSettings({ followUpMode: 'steer' })}
            >
              {t('Steer')}
            </button>
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

interface ThemePreset {
  id: string
  name: string
  accent: string
  light: { bg: string; fg: string }
  dark: { bg: string; fg: string }
}

const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    accent: '#D97757',
    light: { bg: '#FAF9F5', fg: '#141413' },
    dark: { bg: '#212121', fg: '#ECECEC' }
  },
  {
    id: 'claude',
    name: 'Claude',
    accent: '#D97757',
    light: { bg: '#FBF9F5', fg: '#1F1E1D' },
    dark: { bg: '#18181B', fg: '#F4F4F5' }
  },
  {
    id: 'pi',
    name: 'Pi Classic',
    accent: '#D95B26',
    light: { bg: '#FFFFFF', fg: '#242424' },
    dark: { bg: '#16181D', fg: '#F2F4F8' }
  },
  {
    id: 'github',
    name: 'GitHub',
    accent: '#0969DA',
    light: { bg: '#FFFFFF', fg: '#1F2328' },
    dark: { bg: '#0D1117', fg: '#E6EDF3' }
  },
  {
    id: 'vitesse',
    name: 'Vitesse',
    accent: '#4D9375',
    light: { bg: '#FAFAFA', fg: '#374151' },
    dark: { bg: '#121212', fg: '#DBDBDB' }
  },
  {
    id: 'nord',
    name: 'Nord',
    accent: '#88C0D0',
    light: { bg: '#ECEFF4', fg: '#2E3440' },
    dark: { bg: '#2E3440', fg: '#ECEFF4' }
  }
]

const ACCENT_PRESETS = [
  { label: 'Custom', value: 'custom' },
  { label: 'Terracotta (ChatGPT)', value: '#D97757' },
  { label: 'Classic Orange (Pi)', value: '#D95B26' },
  { label: 'Emerald (OpenAI)', value: '#10A37F' },
  { label: 'Ocean Blue', value: '#3B82F6' },
  { label: 'Violet', value: '#8B5CF6' },
  { label: 'Rose', value: '#EC4899' },
  { label: 'Amber', value: '#F59E0B' },
  { label: 'Cyan', value: '#06B6D4' }
]

const TONE_PRESETS = [
  { id: 'neutral', label: 'Default' },
  { id: 'warm', label: 'Warm' },
  { id: 'cool', label: 'Cool' },
  { id: 'slate', label: 'Slate' },
  { id: 'contrast', label: 'High contrast' }
]

// Every label is an English key so `t()` can translate it; the English UI
// must never fall back to the Chinese names that used to live here.
const FONT_DISPLAY_NAMES: Record<string, string> = {
  system: 'System default',
  sans: 'Modern Sans',
  chinese: 'Chinese First',
  mono: 'Monospace Code',
  serif: 'Classic Serif',
  'Microsoft YaHei': 'Microsoft YaHei',
  'Microsoft YaHei UI': 'Microsoft YaHei UI',
  SimSun: 'SimSun',
  NSimSun: 'NSimSun',
  SimHei: 'SimHei',
  KaiTi: 'KaiTi',
  FangSong: 'FangSong',
  DengXian: 'DengXian',
  'PingFang SC': 'PingFang SC',
  'PingFang SC Regular': 'PingFang SC Regular',
  'PingFang SC Medium': 'PingFang SC Medium',
  'PingFang SC Bold': 'PingFang SC Bold',
  'Hiragino Sans GB': 'Hiragino Sans GB',
  'Segoe UI': 'Segoe UI',
  'Cascadia Code': 'Cascadia Code',
  Consolas: 'Consolas',
  'JetBrains Mono': 'JetBrains Mono',
  'Fira Code': 'Fira Code',
  'Source Code Pro': 'Source Code Pro',
  Arial: 'Arial',
  'Helvetica Neue': 'Helvetica Neue',
  Inter: 'Inter',
  Roboto: 'Roboto'
}

function normalizeCssColor(value: string): string | null {
  if (!value) return null
  const shortHex = /^#([0-9a-f]{3})$/i.exec(value)
  if (shortHex) {
    return `#${shortHex[1]
      .split('')
      .map((char) => char + char)
      .join('')}`.toUpperCase()
  }
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toUpperCase()
  const rgb = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/i.exec(value)
  if (!rgb) return null
  const hex = (part: string) => Math.min(255, Number(part)).toString(16).padStart(2, '0')
  return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`.toUpperCase()
}

const POPULAR_FONT_FAMILIES = [
  'Microsoft YaHei',
  'PingFang SC',
  'PingFang SC Regular',
  'PingFang SC Medium',
  'PingFang SC Bold',
  'Segoe UI',
  'Cascadia Code',
  'Consolas',
  'JetBrains Mono',
  'Fira Code',
  'DengXian',
  'SimHei',
  'KaiTi',
  'Arial',
  'Inter'
]

export function AppearanceSettings() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()
  const isDark = useIsDark()

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [systemFonts, setSystemFonts] = useState<string[]>([])
  const [fontsLoading, setFontsLoading] = useState(true)
  const [fontQuery, setFontQuery] = useState('')
  const [defaultColors, setDefaultColors] = useState(() => ({
    accent: isDark ? '#4C9AFF' : '#292929',
    bg: isDark ? '#16181D' : '#FFFFFF',
    fg: isDark ? '#F2F4F8' : '#242424'
  }))

  // The appearance page shows what is painted, so the "no custom theme" row
  // has to follow the live tokens when the theme (or the system theme) flips.
  useEffect(() => {
    // Read the values that are actually painted instead of assuming a preset.
    const rootStyle = window.getComputedStyle(document.documentElement)
    setDefaultColors({
      accent:
        normalizeCssColor(rootStyle.getPropertyValue('--accent').trim()) ??
        (isDark ? '#4C9AFF' : '#292929'),
      bg:
        normalizeCssColor(rootStyle.getPropertyValue('--surface-canvas').trim()) ??
        (isDark ? '#16181D' : '#FFFFFF'),
      fg:
        normalizeCssColor(rootStyle.getPropertyValue('--text-primary').trim()) ??
        (isDark ? '#F2F4F8' : '#242424')
    })
  }, [isDark, settings.accentColor, settings.customBg, settings.customFg, settings.themePreset])

  useEffect(() => {
    let active = true
    window.pi.app
      .getSystemFonts()
      .then((fonts) => {
        if (active && Array.isArray(fonts) && fonts.length > 0) {
          setSystemFonts(fonts)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setFontsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const currentPresetObj = settings.themePreset
    ? THEME_PRESETS.find((preset) => preset.id === settings.themePreset)
    : undefined

  const effectiveAccent =
    settings.accentColor ?? currentPresetObj?.accent ?? defaultColors.accent

  const effectiveBg =
    settings.customBg ??
    (currentPresetObj
      ? (isDark ? currentPresetObj.dark.bg : currentPresetObj.light.bg)
      : defaultColors.bg)

  const effectiveFg =
    settings.customFg ??
    (currentPresetObj
      ? (isDark ? currentPresetObj.dark.fg : currentPresetObj.light.fg)
      : defaultColors.fg)

  const matchedAccentPreset = ACCENT_PRESETS.find(
    (p) => p.value.toLowerCase() === effectiveAccent.toLowerCase()
  )

  const matchedTone = TONE_PRESETS.find((tone) => tone.id === (settings.themeTone ?? 'neutral'))
  const currentFontVal = settings.fontFamily ?? 'system'
  const currentFontLabel = t(
    FONT_DISPLAY_NAMES[currentFontVal] ?? (currentFontVal === 'system' ? 'System default' : currentFontVal)
  )

  const themeSelectValue = currentPresetObj
    ? currentPresetObj.id
    : settings.themePreset === 'custom'
      ? 'custom'
      : 'default'
  const themeLabel = currentPresetObj
    ? t(currentPresetObj.name)
    : settings.themePreset === 'custom'
      ? t('Custom')
      : t('Default')
  const accentLabel = matchedAccentPreset
    ? t(matchedAccentPreset.label)
    : settings.accentColor || currentPresetObj
      ? t('Custom')
      : t('Default')

  const popularOnSystem = useMemo(() => {
    if (systemFonts.length === 0) return []
    return POPULAR_FONT_FAMILIES.filter((font) => systemFonts.includes(font))
  }, [systemFonts])

  const otherSystemFonts = useMemo(() => {
    if (systemFonts.length === 0) return []
    const popSet = new Set(POPULAR_FONT_FAMILIES)
    return systemFonts.filter((font) => !popSet.has(font))
  }, [systemFonts])

  const fontChoices = useMemo(() => {
    const normalize = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '')
    const needle = normalize(fontQuery)
    const labelOf = (font: string) => t(FONT_DISPLAY_NAMES[font] ?? font)
    const matches = (value: string, label: string) =>
      !needle || normalize(value).includes(needle) || normalize(label).includes(needle)
    const choices: { value: string; label: string; group: string }[] = []
    const systemLabel = t(FONT_DISPLAY_NAMES.system)
    if (matches('system', systemLabel)) {
      choices.push({ value: 'system', label: systemLabel, group: '' })
    }
    const recommended = t('Recommended')
    for (const font of popularOnSystem) {
      const label = labelOf(font)
      if (matches(font, label)) choices.push({ value: font, label, group: recommended })
    }
    if (otherSystemFonts.length > 0) {
      const group = `${t('System Fonts')} (${systemFonts.length})`
      for (const font of otherSystemFonts) {
        const label = labelOf(font)
        if (matches(font, label)) choices.push({ value: font, label, group })
      }
    } else if (systemFonts.length === 0) {
      const group = t('Presets')
      const presets = [
        ['sans', t('Modern Sans')],
        ['chinese', t('Chinese First')],
        ['mono', t('Monospace Code')],
        ['serif', t('Classic Serif')]
      ] as const
      for (const [value, label] of presets) {
        if (matches(value, label)) choices.push({ value, label, group })
      }
    }
    if (
      currentFontVal !== 'system' &&
      !popularOnSystem.includes(currentFontVal) &&
      !otherSystemFonts.includes(currentFontVal) &&
      !choices.some((choice) => choice.value === currentFontVal) &&
      matches(currentFontVal, currentFontLabel)
    ) {
      choices.push({ value: currentFontVal, label: currentFontLabel, group: '' })
    }
    return choices
  }, [
    currentFontLabel,
    currentFontVal,
    fontQuery,
    otherSystemFonts,
    popularOnSystem,
    settings.language,
    systemFonts.length,
    t
  ])

  const handleModeChange = (mode: 'system' | 'light' | 'dark') => {
    const nextDark =
      mode === 'dark' ||
      (mode === 'system' &&
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)

    // With no preset chosen, changing the mode must only change the mode:
    // writing the old ChatGPT colours here is what made the dialog lie.
    const preset = settings.themePreset
      ? THEME_PRESETS.find((p) => p.id === settings.themePreset)
      : undefined
    if (preset) {
      void updateSettings({
        theme: mode,
        accentColor: preset.accent,
        customBg: nextDark ? preset.dark.bg : preset.light.bg,
        customFg: nextDark ? preset.dark.fg : preset.light.fg
      })
    } else {
      void updateSettings({ theme: mode })
    }
  }

  const handlePresetChange = (presetId: string) => {
    if (presetId === 'default') {
      void updateSettings({
        themePreset: undefined,
        accentColor: undefined,
        customBg: undefined,
        customFg: undefined
      })
      return
    }
    if (presetId === 'custom') {
      void updateSettings({ themePreset: 'custom' })
      return
    }
    const preset = THEME_PRESETS.find((p) => p.id === presetId)
    if (!preset) return
    void updateSettings({
      themePreset: preset.id,
      accentColor: preset.accent,
      customBg: isDark ? preset.dark.bg : preset.light.bg,
      customFg: isDark ? preset.dark.fg : preset.light.fg
    })
  }

  const handleResetDefaults = () => {
    void updateSettings({
      theme: 'dark',
      themePreset: undefined,
      themeTone: 'neutral',
      accentColor: undefined,
      customBg: undefined,
      customFg: undefined,
      fontFamily: 'system',
      fontScale: 1,
      diffSplit: false
    })
    showToast(t('Appearance reset to defaults'))
  }

  const copyThemeJson = () => {
    const config = {
      theme: settings.theme,
      themePreset: settings.themePreset ?? 'default',
      accentColor: effectiveAccent,
      customBg: effectiveBg,
      customFg: effectiveFg,
      themeTone: settings.themeTone ?? 'neutral',
      fontFamily: settings.fontFamily ?? 'system'
    }
    void navigator.clipboard.writeText(JSON.stringify(config, null, 2))
    showToast(t('Theme copied to clipboard'))
  }

  const exportThemeJson = () => {
    const config = {
      name: currentPresetObj?.name ?? (settings.themePreset === 'custom' ? 'Custom' : 'Default'),
      theme: settings.theme,
      themePreset: settings.themePreset ?? 'default',
      accentColor: effectiveAccent,
      customBg: effectiveBg,
      customFg: effectiveFg,
      themeTone: settings.themeTone ?? 'neutral',
      fontFamily: settings.fontFamily ?? 'system'
    }
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pi-theme-${config.themePreset}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="appearance-container">
      {/* 标题与副标题 */}
      <h2 className="appearance-title">{t('Appearance')}</h2>
      <div className="appearance-subtitle">{t('Visual style')}</div>

      {/* 模式选择卡片 */}
      <div className="appearance-card appearance-card--mode">
        <div className="appearance-row__label">{t('Mode')}</div>
        <div className="appearance-mode-picker" role="radiogroup" aria-label={t('Mode')}>
          {/* 跟随系统 */}
          <button
            type="button"
            className="appearance-mode-btn"
            data-active={settings.theme === 'system'}
            onClick={() => handleModeChange('system')}
            title={t('System')}
            aria-label={t('System')}
          >
            <div className="mini-preview-system">
              <div className="mini-preview-system__left">
                <div className="mini-line mini-line--top-light" />
                <div className="mini-line mini-line--text-light" />
                <div className="mini-line mini-line--text-light" style={{ width: '60%' }} />
              </div>
              <div className="mini-preview-system__right">
                <div className="mini-line mini-line--top-dark" />
                <div className="mini-line mini-line--accent" />
                <div className="mini-line mini-line--text-dark" style={{ width: '70%' }} />
              </div>
            </div>
          </button>

          {/* 浅色模式 */}
          <button
            type="button"
            className="appearance-mode-btn"
            data-active={settings.theme === 'light'}
            onClick={() => handleModeChange('light')}
            title={t('Light')}
            aria-label={t('Light')}
          >
            <div className="mini-preview-light">
              <div className="mini-line mini-line--top-light" />
              <div className="mini-line mini-line--text-light" />
              <div className="mini-line mini-line--accent" />
              <div className="mini-line mini-line--text-light" style={{ width: '65%' }} />
            </div>
          </button>

          {/* 深色模式 */}
          <button
            type="button"
            className="appearance-mode-btn"
            data-active={settings.theme === 'dark'}
            onClick={() => handleModeChange('dark')}
            title={t('Dark')}
            aria-label={t('Dark')}
          >
            <div className="mini-preview-dark">
              <div className="mini-line mini-line--top-dark" />
              <div className="mini-line mini-line--text-dark" />
              <div className="mini-line mini-line--accent" />
              <div className="mini-line mini-line--text-dark" style={{ width: '65%' }} />
            </div>
          </button>
        </div>
      </div>

      {/* 视觉配置详情卡片 */}
      <div className="appearance-card appearance-group-card">
        {/* 主题 */}
        <div className="appearance-row">
          <div className="appearance-row__label">{t('Theme')}</div>
          <div className="appearance-row__right">
            <button
              type="button"
              className="appearance-action-btn"
              title={t('Export this conversation as HTML')}
              onClick={exportThemeJson}
            >
              <Download size={14} />
            </button>
            <button
              type="button"
              className="appearance-action-btn"
              title={t('Theme copied to clipboard')}
              onClick={copyThemeJson}
            >
              <Copy size={14} />
            </button>
            <div className="appearance-select-pill">
              <Sparkles size={13} className="appearance-select-pill__icon" />
              <span>{themeLabel}</span>
              <ChevronDown size={13} className="appearance-select-pill__chevron" />
              <select
                className="appearance-select-native"
                aria-label={t('Theme')}
                value={themeSelectValue}
                onChange={(e) => handlePresetChange(e.target.value)}
              >
                <option value="default">{t('Default')}</option>
                {THEME_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {t(p.name)}
                  </option>
                ))}
                <option value="custom">{t('Custom')}</option>
              </select>
            </div>
          </div>
        </div>

        {/* 强调色 */}
        <div className="appearance-row">
          <div className="appearance-row__label">{t('Accent color')}</div>
          <div className="appearance-row__right">
            <div className="appearance-select-pill">
              <span>{accentLabel}</span>
              <ChevronDown size={13} className="appearance-select-pill__chevron" />
              <select
                className="appearance-select-native"
                aria-label={t('Accent color')}
                value={matchedAccentPreset ? matchedAccentPreset.value : 'custom'}
                onChange={(e) => {
                  if (e.target.value !== 'custom') {
                    void updateSettings({ accentColor: e.target.value, themePreset: 'custom' })
                  }
                }}
              >
                {ACCENT_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {t(p.label)}
                  </option>
                ))}
              </select>
            </div>
            <div className="appearance-swatch-pill" title={t('Accent color')}>
              <span className="appearance-swatch-dot" style={{ backgroundColor: effectiveAccent }} />
              <span className="appearance-swatch-hex">{effectiveAccent.toUpperCase()}</span>
              <input
                type="color"
                className="appearance-swatch-native"
                value={effectiveAccent}
                onChange={(e) => {
                  void updateSettings({ accentColor: e.target.value, themePreset: 'custom' })
                }}
              />
            </div>
          </div>
        </div>

        {/* 背景 */}
        <div className="appearance-row">
          <div className="appearance-row__label">{t('Background')}</div>
          <div className="appearance-row__right">
            <div className="appearance-swatch-pill" title={t('Background')}>
              <span className="appearance-swatch-dot" style={{ backgroundColor: effectiveBg }} />
              <span className="appearance-swatch-hex">{effectiveBg.toUpperCase()}</span>
              <input
                type="color"
                className="appearance-swatch-native"
                value={effectiveBg}
                onChange={(e) => {
                  void updateSettings({ customBg: e.target.value, themePreset: 'custom' })
                }}
              />
            </div>
          </div>
        </div>

        {/* 前景 */}
        <div className="appearance-row">
          <div className="appearance-row__label">{t('Foreground')}</div>
          <div className="appearance-row__right">
            <div className="appearance-swatch-pill" title={t('Foreground')}>
              <span className="appearance-swatch-dot" style={{ backgroundColor: effectiveFg }} />
              <span className="appearance-swatch-hex">{effectiveFg.toUpperCase()}</span>
              <input
                type="color"
                className="appearance-swatch-native"
                value={effectiveFg}
                onChange={(e) => {
                  void updateSettings({ customFg: e.target.value, themePreset: 'custom' })
                }}
              />
            </div>
          </div>
        </div>

        {/* 色调 */}
        <div className="appearance-row">
          <div className="appearance-row__label">{t('Tone')}</div>
          <div className="appearance-row__right">
            <div className="appearance-select-pill">
              <span>{t(matchedTone?.label ?? 'Default')}</span>
              <ChevronDown size={13} className="appearance-select-pill__chevron" />
              <select
                className="appearance-select-native"
                aria-label={t('Tone')}
                value={settings.themeTone ?? 'neutral'}
                onChange={(e) => void updateSettings({ themeTone: e.target.value })}
              >
                {TONE_PRESETS.map((tone) => (
                  <option key={tone.id} value={tone.id}>
                    {t(tone.label)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* 字体 */}
        <div className="appearance-row">
          <div className="appearance-row__label">{t('Font')}</div>
          <div className="appearance-row__right">
            <Popover
              align="right"
              width={280}
              className="font-menu-popover"
              renderTrigger={({ open, toggle }) => (
                <button
                  type="button"
                  className="appearance-select-pill"
                  aria-label={t('Font')}
                  aria-haspopup="listbox"
                  aria-expanded={open}
                  onClick={(event) => {
                    if (!open) setFontQuery('')
                    toggle(event)
                  }}
                >
                  <span>{currentFontLabel}</span>
                  <ChevronDown size={13} className="appearance-select-pill__chevron" />
                </button>
              )}
            >
              {(close) => {
                let lastGroup = ''
                return (
                  <div className="font-menu" role="listbox" aria-label={t('Font')}>
                    <div className="font-menu__search">
                      <Search size={13} />
                      <input
                        autoFocus
                        value={fontQuery}
                        placeholder={t('Search fonts')}
                        aria-label={t('Search fonts')}
                        onChange={(event) => setFontQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.keyCode === 229) return
                          if (event.key === 'ArrowDown') {
                            event.preventDefault()
                            event.currentTarget
                              .closest('.font-menu')
                              ?.querySelector<HTMLButtonElement>('.font-menu__list .popover__item')
                              ?.focus()
                            return
                          }
                          if (event.key === 'Enter' && fontChoices.length === 1) {
                            event.preventDefault()
                            void updateSettings({ fontFamily: fontChoices[0].value })
                            close()
                          }
                        }}
                      />
                      {fontQuery ? (
                        <button
                          type="button"
                          className="font-menu__clear"
                          aria-label={t('Clear the filter')}
                          onClick={() => setFontQuery('')}
                        >
                          <X size={12} />
                        </button>
                      ) : null}
                    </div>
                    <div className="font-menu__list">
                      {fontsLoading ? (
                        <div className="font-menu__empty" role="status">{t('Loading fonts…')}</div>
                      ) : null}
                      {fontChoices.length === 0 && !fontsLoading ? (
                        <div className="font-menu__empty">
                          {t('No matching fonts')}
                        </div>
                      ) : (
                        fontChoices.map((choice) => {
                          const header =
                            choice.group && choice.group !== lastGroup ? (
                              <div className="popover__label" key={`group-${choice.group}`}>
                                {choice.group}
                              </div>
                            ) : null
                          lastGroup = choice.group
                          const selected = choice.value === currentFontVal
                          return (
                            <div key={choice.value}>
                              {header}
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                className="popover__item font-menu__item"
                                data-selected={selected}
                                onClick={() => {
                                  void updateSettings({ fontFamily: choice.value })
                                  close()
                                }}
                              >
                                <span className="popover__item-text">{choice.label}</span>
                                {selected ? <Check size={14} /> : null}
                              </button>
                            </div>
                          )
                        })
                      )}
                    </div>
                  </div>
                )
              }}
            </Popover>
          </div>
        </div>
      </div>

      {/* 底部动作链接 */}
      <div className="appearance-footer">
        <button
          type="button"
          className="appearance-text-btn"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          <span>{t('Advanced')}</span>
          {showAdvanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <button
          type="button"
          className="appearance-text-btn appearance-text-btn--reset"
          onClick={handleResetDefaults}
        >
          {t('Reset to default settings')}
        </button>
      </div>

      {/* 高级展开项 */}
      {showAdvanced ? (
        <div className="appearance-advanced">
          <SettingsGroup title={t('Language')}>
            <div className="segmented" role="group" aria-label={t('Language')}>
              {([
                { label: 'English', value: 'en' },
                { label: '简体中文', value: 'zh-CN' }
              ] as const).map((option) => (
                <button
                  key={option.value}
                  aria-pressed={(settings.language ?? 'en') === option.value}
                  data-active={(settings.language ?? 'en') === option.value}
                  onClick={() => void updateSettings({ language: option.value })}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </SettingsGroup>

          <SettingsGroup title={t('Text size')}>
            <div className="segmented settings-text-size" role="group" aria-label={t('Text size')}>
              {[
                { label: 'Small', value: 0.92 },
                { label: 'Default', value: 1 },
                { label: 'Large', value: 1.1 },
                { label: 'XL', value: 1.22 }
              ].map((option) => (
                <button
                  key={option.label}
                  data-size={option.label.toLowerCase()}
                  aria-pressed={Math.abs((settings.fontScale ?? 1) - option.value) < 0.01}
                  data-active={Math.abs((settings.fontScale ?? 1) - option.value) < 0.01}
                  onClick={() => void updateSettings({ fontScale: option.value })}
                >
                  {t(option.label)}
                </button>
              ))}
            </div>
          </SettingsGroup>

          <SettingsGroup title={t('Diff layout')}>
            <div className="segmented" role="group" aria-label={t('Diff layout')}>
              <button
                aria-pressed={!settings.diffSplit}
                data-active={!settings.diffSplit}
                onClick={() => void updateSettings({ diffSplit: false })}
              >
                {t('Unified')}
              </button>
              <button
                aria-pressed={settings.diffSplit === true}
                data-active={settings.diffSplit === true}
                onClick={() => void updateSettings({ diffSplit: true })}
              >
                {t('Side by side')}
              </button>
            </div>
          </SettingsGroup>

          <SettingsGroup title={t('Notifications')}>
            <div className="field">
              <div className="field__row settings-switch-row">
                <Switch
                  checked={settings.desktopNotifications !== false}
                  onChange={(value) => void updateSettings({ desktopNotifications: value })}
                  label={t('Desktop notifications')}
                />
                <span className="field__hint">
                  {t(
                    'Notify when Pi finishes a turn or needs confirmation while the window is in the background.'
                  )}
                </span>
              </div>
            </div>
          </SettingsGroup>
        </div>
      ) : null}
    </div>
  )
}

export function UsageSettings() {
  const settings = useAppStore((state) => state.settings)
  const piState = useAppStore((state) => state.piState)
  const setAutoCompaction = useAppStore((state) => state.setAutoCompaction)
  const setAutoRetry = useAppStore((state) => state.setAutoRetry)
  const t = useT()

  const [usageStats, setUsageStats] = useState<AggregatedUsageStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedPeriod, setSelectedPeriod] = useState<'today' | 'week' | 'month' | 'allTime'>('today')

  const loadStats = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.pi.sessions.usageStats(settings.externalChatFolder)
      setUsageStats(res)
    } catch (err) {
      console.error('Failed to load usage stats:', err)
    } finally {
      setLoading(false)
    }
  }, [settings.externalChatFolder])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  const periods: Array<{ key: 'today' | 'week' | 'month' | 'allTime'; title: string }> = [
    { key: 'today', title: t('Period Day') },
    { key: 'week', title: t('Period Week') },
    { key: 'month', title: t('Period Month') },
    { key: 'allTime', title: t('Period All') }
  ]

  const activeData = usageStats ? usageStats[selectedPeriod] : null
  const activeTokens = activeData?.tokens
  const activeConvs = activeData?.conversationsCount ?? 0
  const activeMsgs = activeData?.messageCount ?? 0
  const avgTokens = activeConvs > 0 && activeTokens ? Math.round(activeTokens.totalTokens / activeConvs) : 0

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Usage')}
        description={t('Global token consumption statistics and conversation activity across time horizons.')}
      />

      {/* 4 Overview Period Cards */}
      <SettingsGroup
        title={t('Token usage overview')}
        action={
          <button
            type="button"
            className="btn btn--sm"
            disabled={loading}
            onClick={() => void loadStats()}
          >
            <RefreshCw size={12} className={loading ? 'spin' : undefined} />
            {t('Refresh')}
          </button>
        }
      >
        <div className="usage-period-grid">
          {periods.map(({ key, title }) => {
            const periodData = usageStats ? usageStats[key] : null
            const tokens = periodData?.tokens.totalTokens ?? 0
            const convs = periodData?.conversationsCount ?? 0
            const msgs = periodData?.messageCount ?? 0
            const isSelected = selectedPeriod === key

            return (
              <button
                key={key}
                type="button"
                className="usage-period-card"
                data-active={isSelected}
                onClick={() => setSelectedPeriod(key)}
              >
                <div className="usage-period-card__header">
                  <span>{title}</span>
                  {isSelected && <span className="usage-period-badge">{t('Selected')}</span>}
                </div>
                <div className="usage-period-card__tokens">
                  {formatTokens(tokens)}
                </div>
                <div className="usage-period-card__footer">
                  <span className="usage-period-badge">
                    <MessageSquare size={10} />
                    {convs} {t('Conversations')}
                  </span>
                  <span>· {msgs} {t('turns')}</span>
                </div>
              </button>
            )
          })}
        </div>
      </SettingsGroup>

      {/* Selected Period Detailed Breakdown */}
      <SettingsGroup
        title={`${periods.find((p) => p.key === selectedPeriod)?.title ?? ''} - ${t('Detailed breakdown')}`}
      >
        <div className="usage-detail-grid">
          <div className="usage-detail-metric">
            <span className="usage-detail-metric__label">{t('Total tokens')}</span>
            <span className="usage-detail-metric__value">{formatTokens(activeTokens?.totalTokens)}</span>
          </div>
          <div className="usage-detail-metric">
            <span className="usage-detail-metric__label">{t('Input tokens')}</span>
            <span className="usage-detail-metric__value">{formatTokens(activeTokens?.input)}</span>
          </div>
          <div className="usage-detail-metric">
            <span className="usage-detail-metric__label">{t('Output tokens')}</span>
            <span className="usage-detail-metric__value">{formatTokens(activeTokens?.output)}</span>
          </div>
          <div className="usage-detail-metric">
            <span className="usage-detail-metric__label">{t('Cache read')}</span>
            <span className="usage-detail-metric__value">{formatTokens(activeTokens?.cacheRead)}</span>
          </div>
          <div className="usage-detail-metric">
            <span className="usage-detail-metric__label">{t('Cache write')}</span>
            <span className="usage-detail-metric__value">{formatTokens(activeTokens?.cacheWrite)}</span>
          </div>
          <div className="usage-detail-metric">
            <span className="usage-detail-metric__label">{t('Conversations')}</span>
            <span className="usage-detail-metric__value">{activeConvs}</span>
          </div>
          <div className="usage-detail-metric">
            <span className="usage-detail-metric__label">{t('Message turns')}</span>
            <span className="usage-detail-metric__value">{activeMsgs}</span>
          </div>
          <div className="usage-detail-metric">
            <span className="usage-detail-metric__label">{t('Avg / conversation')}</span>
            <span className="usage-detail-metric__value">{formatTokens(avgTokens)}</span>
          </div>
          {activeTokens?.cost && activeTokens.cost > 0 ? (
            <div className="usage-detail-metric">
              <span className="usage-detail-metric__label">{t('Estimated cost')}</span>
              <span className="usage-detail-metric__value">{formatCost(activeTokens.cost)}</span>
            </div>
          ) : null}
        </div>
      </SettingsGroup>

      {/* Model Distribution */}
      {usageStats && usageStats.byModel.length > 0 && (
        <SettingsGroup title={t('Model distribution')}>
          <div className="usage-model-list">
            {usageStats.byModel.map((m) => {
              const allTimeTotal = usageStats.allTime.tokens.totalTokens || 1
              const pct = Math.min(100, Math.round((m.totalTokens / allTimeTotal) * 100))
              return (
                <div key={m.model} className="usage-model-row">
                  <div className="usage-model-row__head">
                    <span className="usage-model-row__name">{m.model}</span>
                    <div className="usage-model-row__stats">
                      <span>{formatTokens(m.totalTokens)}</span>
                      <span>{pct}%</span>
                      <span>{m.messageCount} {t('turns')}</span>
                      {m.cost > 0 && <span>{formatCost(m.cost)}</span>}
                    </div>
                  </div>
                  <div className="usage-model-row__bar">
                    <div className="usage-model-row__bar-fill" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </SettingsGroup>
      )}

      {/* Recent 7 Days Trend */}
      {usageStats && usageStats.recentDays.some((d) => d.totalTokens > 0 || d.conversationsCount > 0) && (
        <SettingsGroup title={t('Recent daily trend')}>
          <table className="usage-days-table">
            <thead>
              <tr>
                <th>{t('Date')}</th>
                <th>{t('Token consumption')}</th>
                <th>{t('Active conversations')}</th>
                <th>{t('Message turns')}</th>
              </tr>
            </thead>
            <tbody>
              {usageStats.recentDays.map((d) => (
                <tr key={d.date}>
                  <td>{d.date}</td>
                  <td>{formatTokens(d.totalTokens)}</td>
                  <td>{d.conversationsCount}</td>
                  <td>{d.messageCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </SettingsGroup>
      )}

      {/* Automation & context policy */}
      <SettingsGroup title={t('Automation & context policy')}>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={piState?.autoCompactionEnabled !== false}
              onChange={(value) => void setAutoCompaction(value)}
              label={t('Compact automatically')}
            />
            <span className="field__hint">{t('when the context window fills up')}</span>
          </div>
        </div>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={piState?.autoRetryEnabled !== false}
              onChange={(value) => void setAutoRetry(value)}
              label={t('Retry automatically')}
            />
            <span className="field__hint">{t('on transient provider errors')}</span>
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

export function PluginsSettings({ onClose }: { onClose?: () => void }) {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const commands = useAppStore((state) => state.commands)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const t = useT()

  const [mcpConfig, setMcpConfig] = useState<McpConfig | null>(null)
  const [mcpState, setMcpState] = useState<'loading' | 'error' | 'ready'>('loading')
  const [filterKind, setFilterKind] = useState<'all' | 'extension' | 'skill'>('all')
  const [query, setQuery] = useState('')

  const loadMcp = useCallback(async () => {
    setMcpState('loading')
    try {
      setMcpConfig(await window.pi.mcp.read())
      setMcpState('ready')
    } catch {
      setMcpState('error')
    }
  }, [])

  useEffect(() => {
    void loadMcp()
  }, [loadMcp, settings.trustProject])

  const extensionCommands = useMemo(
    () => commands.filter((cmd) => cmd.source === 'extension' || cmd.source === 'skill'),
    [commands]
  )

  const filteredCommands = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return extensionCommands.filter((cmd) => {
      if (filterKind !== 'all' && cmd.source !== filterKind) return false
      if (!needle) return true
      return (
        cmd.name.toLowerCase().includes(needle) ||
        (cmd.description ?? '').toLowerCase().includes(needle)
      )
    })
  }, [extensionCommands, filterKind, query])

  const servers = mcpConfig?.servers ?? []
  const enabledServers = servers.filter((s) => s.enabled).length

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Plugins')}
        description={t('Manage MCP servers, project extensions, and loaded skills or plugin commands.')}
      />

      <SettingsGroup title={t('Project resources')}>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={settings.trustProject !== false}
              onChange={(value) => void updateSettings({ trustProject: value })}
              label={t('Trust project-local extensions and settings')}
            />
            <span className="field__hint">
              {t('Allow project-local .pi/extensions, .pi/skills and .pi/settings.json to load in all workspaces. Turn this off for untrusted code.')}
            </span>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t('MCP servers')}
        action={
          <div className="settings-inline-actions">
            {mcpState === 'ready' ? (
              <span className="settings-badge">
                {enabledServers}/{servers.length} {t('enabled')}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => void loadMcp()}
              disabled={mcpState === 'loading'}
            >
              <RefreshCw size={12} className={mcpState === 'loading' ? 'spin' : undefined} />
              {t('Refresh')}
            </button>
          </div>
        }
      >
        {mcpState === 'loading' ? (
          <div className="settings-empty">
            <RefreshCw size={13} className="spin" /> {t('Reading the MCP configuration…')}
          </div>
        ) : mcpState === 'error' || !mcpConfig ? (
          <div className="settings-empty">
            <AlertTriangle size={13} /> {t('Could not read the MCP configuration.')}
          </div>
        ) : (
          <>
            <div className="mcp__files">
              <div className="mcp__file" data-missing={!mcpConfig.userExists || undefined}>
                <FileJson size={12} />
                <span className="mcp__file-scope">{t('User configuration')}</span>
                <span className="mcp__file-path" title={mcpConfig.userPath}>
                  {mcpConfig.userPath}
                </span>
                {!mcpConfig.userExists ? (
                  <span className="mcp__file-badge">{t('not found')}</span>
                ) : null}
              </div>
              <div className="mcp__file" data-missing={!mcpConfig.projectExists || undefined}>
                <FileJson size={12} />
                <span className="mcp__file-scope">{t('Project configuration')}</span>
                <span className="mcp__file-path" title={mcpConfig.projectPath}>
                  {mcpConfig.projectPath || '—'}
                </span>
                {!mcpConfig.projectExists ? (
                  <span className="mcp__file-badge">{t('not found')}</span>
                ) : null}
              </div>
            </div>

            {mcpConfig.projectIgnored ? (
              <p className="mcp__trust">
                <ShieldOff size={12} />
                {t('The project MCP configuration is ignored while project trust is off.')}
              </p>
            ) : null}

            {mcpConfig.errors.map((err) => (
              <p className="mcp__error" key={err}>
                <AlertTriangle size={12} />
                {err}
              </p>
            ))}

            {servers.length === 0 ? (
              <div className="settings-empty">
                {t('No MCP servers are configured.')}{' '}
                {t('Add servers with “pi mcp add …” or edit the JSON files above.')}
              </div>
            ) : (
              <div className="settings-card-list">
                {servers.map((server) => (
                  <McpPluginCard key={server.name} server={server} />
                ))}
              </div>
            )}
          </>
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t('Extensions & skills')}
        action={<span className="settings-badge">{extensionCommands.length}</span>}
      >
        {extensionCommands.length === 0 ? (
          <div className="settings-empty">
            {t('No plugins or skills loaded in the current session.')}
          </div>
        ) : (
          <>
            <div className="settings-filter-bar">
              <div className="segmented" role="group" aria-label={t('Extensions & skills')}>
                <button
                  type="button"
                  data-active={filterKind === 'all'}
                  aria-pressed={filterKind === 'all'}
                  onClick={() => setFilterKind('all')}
                >
                  {t('All')}
                </button>
                <button
                  type="button"
                  data-active={filterKind === 'extension'}
                  aria-pressed={filterKind === 'extension'}
                  onClick={() => setFilterKind('extension')}
                >
                  {t('Plugins')}
                </button>
                <button
                  type="button"
                  data-active={filterKind === 'skill'}
                  aria-pressed={filterKind === 'skill'}
                  onClick={() => setFilterKind('skill')}
                >
                  {t('Skills')}
                </button>
              </div>
              <div className="settings-search">
                <Search size={13} />
                <input
                  value={query}
                  placeholder={t('Filter plugins or skills…')}
                  aria-label={t('Filter plugins or skills…')}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setQuery('')}
                    aria-label={t('Clear the filter')}
                  >
                    <X size={12} />
                  </button>
                ) : null}
              </div>
            </div>

            {filteredCommands.length === 0 ? (
              <div className="settings-empty">
                {t('No command matches')} “{query}”
              </div>
            ) : (
              <div className="settings-card-list">
                {filteredCommands.map((cmd) => (
                  <div key={`${cmd.source}:${cmd.name}`} className="settings-card">
                    <div className="settings-card__main">
                      <div className="settings-card__title-row">
                        {cmd.source === 'skill' ? <Sparkles size={13} /> : <Wrench size={13} />}
                        <span className="settings-card__title">/{cmd.name}</span>
                        <span
                          className="settings-tag"
                          data-tone={cmd.source === 'extension' ? 'accent' : undefined}
                        >
                          {cmd.source === 'extension' ? t('Plugin') : t('Skill')}
                        </span>
                        {cmd.sourceInfo?.scope ? (
                          <span className="settings-tag">{cmd.sourceInfo.scope}</span>
                        ) : null}
                      </div>
                      {cmd.description ? (
                        <span className="settings-card__sub">{cmd.description}</span>
                      ) : null}
                    </div>
                    <div className="settings-card__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={() => {
                          insertIntoComposer(`/${cmd.name} `, 'replace')
                          onClose?.()
                        }}
                      >
                        {t('Use in chat')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </SettingsGroup>
    </div>
  )
}

function McpPluginCard({ server }: { server: McpServerInfo }) {
  const t = useT()
  const commandLine = [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
  const meta = [
    server.timeout ? `${t('timeout')} ${server.timeout}s` : null,
    server.envKeys.length > 0 ? `${t('env')}: ${server.envKeys.join(', ')}` : null,
    server.headerKeys.length > 0 ? `${t('headers')}: ${server.headerKeys.join(', ')}` : null
  ].filter((part): part is string => Boolean(part))

  return (
    <div className="settings-card" data-disabled={!server.enabled || undefined}>
      <div className="settings-card__main">
        <div className="settings-card__title-row">
          <Server size={13} />
          <span className="settings-card__title">{server.name}</span>
          <span className="settings-tag">
            {server.scope === 'both'
              ? t('project override')
              : server.scope === 'project'
                ? t('project')
                : t('user')}
          </span>
          <span className="settings-tag">
            {server.transport === 'unknown' ? t('unknown') : server.transport}
          </span>
          <span className="settings-tag" data-tone={server.enabled ? 'accent' : undefined}>
            {server.enabled ? t('enabled') : t('disabled')}
          </span>
        </div>
        {server.description ? <span className="settings-card__sub">{server.description}</span> : null}
        <span className="settings-card__code">
          {server.transport === 'http' && server.url ? server.url : commandLine || '—'}
        </span>
        {meta.length > 0 ? <span className="settings-card__sub">{meta.join(' · ')}</span> : null}
      </div>
    </div>
  )
}

type PanelWidth = 'sidebarWidth' | 'drawerWidth' | 'terminalHeight'

/** The sidebar and inspector defaults; the terminal derives its default from the window height. */
const PANEL_DEFAULTS: Record<'sidebarWidth' | 'drawerWidth', number> = {
  sidebarWidth: 240,
  drawerWidth: 440
}

const PANEL_ROWS: { key: PanelWidth; label: string }[] = [
  { key: 'sidebarWidth', label: 'Sidebar' },
  { key: 'drawerWidth', label: 'Inspector' },
  { key: 'terminalHeight', label: 'Terminal' }
]

export function PanelsSettings() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const t = useT()

  const resetWidth = (key: PanelWidth) => {
    if (key === 'sidebarWidth') void updateSettings({ sidebarWidth: PANEL_DEFAULTS.sidebarWidth })
    else if (key === 'drawerWidth') void updateSettings({ drawerWidth: PANEL_DEFAULTS.drawerWidth })
    else void updateSettings({ terminalHeight: undefined })
  }

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Panels')}
        description={t('Put the surrounding panels back to their default size, and choose how diffs are shown.')}
      />

      <SettingsGroup title={t('Panel widths')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {PANEL_ROWS.map((row) => {
            const value = settings[row.key]
            return (
              <div className="field" key={row.key}>
                <div className="field__row">
                  <span className="field__label">{t(row.label)}</span>
                  <span
                    className="field__hint"
                    style={{ flex: 1, fontVariantNumeric: 'tabular-nums' }}
                  >
                    {typeof value === 'number' ? `${value} px` : t('Default')}
                  </span>
                  <button className="btn btn--sm" onClick={() => resetWidth(row.key)}>
                    {t('Reset')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <span className="field__hint">
          {t('You can also drag the edge of a panel to resize it.')}
        </span>
      </SettingsGroup>

      <SettingsGroup title={t('Diff layout')}>
        <div className="segmented" role="group" aria-label={t('Diff layout')}>
          <button
            aria-pressed={!settings.diffSplit}
            data-active={!settings.diffSplit}
            onClick={() => void updateSettings({ diffSplit: false })}
          >
            {t('Unified')}
          </button>
          <button
            aria-pressed={settings.diffSplit === true}
            data-active={settings.diffSplit === true}
            onClick={() => void updateSettings({ diffSplit: true })}
          >
            {t('Side by side')}
          </button>
        </div>
      </SettingsGroup>
    </div>
  )
}

export function PersonalizationSettings({
  value,
  onChange
}: {
  value: string
  onChange: (value: string) => void
}) {
  const t = useT()

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Personalization')}
        description={t('Add instructions that Pi should follow across your workspaces.')}
      />

      <SettingsGroup title={t('Custom instructions')}>
        <div className="field">
          <label className="field__label" htmlFor="custom-instructions">
            {t('Instructions for Pi')}
          </label>
          <textarea
            id="custom-instructions"
            className="input settings-textarea"
            value={value}
            placeholder={t('For example, describe your preferred language, style, or workflow.')}
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="field__hint">
            {t('Appended to Pi’s system prompt when the runtime starts. Project AGENTS.md files continue to provide project-specific context.')}
          </span>
        </div>
      </SettingsGroup>
    </div>
  )
}

export function ProjectSafetySettings() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const t = useT()

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Project safety')}
        description={t('Control whether Pi loads configuration and extensions from local workspaces.')}
      />

      <SettingsGroup title={t('Project resources')}>
        <div className="field">
          <div className="field__row settings-switch-row">
            <Switch
              checked={settings.trustProject !== false}
              onChange={(value) => void updateSettings({ trustProject: value })}
              label={t('Trust project-local extensions and settings')}
            />
            <span className="field__hint">
              {t('Allow project-local .pi/extensions, .pi/skills and .pi/settings.json to load in all workspaces. Turn this off for untrusted code.')}
              <br />
              {t('Saved immediately. Restart Pi Desktop to apply this to the Pi runtime. MCP configuration uses this setting the next time it is read.')}
            </span>
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

export function AboutSettings() {
  const info = useAppStore((state) => state.info)
  const refreshInfo = useAppStore((state) => state.refreshInfo)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()

  const [checking, setChecking] = useState(false)
  const [upgradingCli, setUpgradingCli] = useState(false)
  const [upgradingApp, setUpgradingApp] = useState(false)
  const [updateStatus, setUpdateStatus] = useState<VersionCheckResult | null>(null)

  const handleCheck = async (silent = false) => {
    setChecking(true)
    try {
      const result = await window.pi.app.checkUpdate()
      setUpdateStatus(result)
      if (!silent && !result.app.hasUpdate && !result.piCli.hasUpdate) {
        showToast(t('Up to date'))
      }
    } catch {
      if (!silent) {
        showToast(t('Check failed'), 'error')
      }
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    void handleCheck(true)
  }, [])

  const handleUpgradeCli = async () => {
    setUpgradingCli(true)
    try {
      const res = await window.pi.app.upgradePiCli()
      if (res.success) {
        showToast(t('Upgrade completed'))
        await refreshInfo()
        const result = await window.pi.app.checkUpdate()
        setUpdateStatus(result)
      } else {
        showToast(res.error ? `${t('Upgrade failed')}: ${res.error}` : t('Upgrade failed'), 'error')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast(`${t('Upgrade failed')}: ${msg}`, 'error')
    } finally {
      setUpgradingCli(false)
    }
  }

  const handleUpgradeApp = async () => {
    setUpgradingApp(true)
    try {
      const res = await window.pi.app.upgradeApp()
      if (res.success) {
        showToast(t('Upgrade completed'))
        await refreshInfo()
        const result = await window.pi.app.checkUpdate()
        setUpdateStatus(result)
      } else {
        showToast(res.error ? `${t('Upgrade failed')}: ${res.error}` : t('Upgrade failed'), 'error')
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast(`${t('Upgrade failed')}: ${msg}`, 'error')
    } finally {
      setUpgradingApp(false)
    }
  }

  const appCurrent = info?.version ?? '0.5.0'
  const piCliCurrent = info?.pi.version ?? '—'

  return (
    <div className="settings-page settings-page--compact">
      <PageIntro
        title={t('About')}
        description={t('Version information and update checking.')}
      />

      <SettingsGroup
        title={t('Version info')}
        action={
          <button
            type="button"
            className="btn btn--sm"
            disabled={checking || upgradingCli || upgradingApp}
            onClick={() => void handleCheck()}
          >
            <RefreshCw size={12} className={checking ? 'spin' : ''} />
            {checking ? t('Checking...') : t('Check for updates')}
          </button>
        }
      >
        {/* 1. 应用版本 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info settings-version-info">
            <span className="settings-item-row__title">{t('Application version')}</span>
            <span className="settings-item-row__desc">
              Pi Desktop v{appCurrent}
            </span>
          </div>
          <div className="settings-version-actions">
            {checking ? (
              <span className="settings-badge">
                <RefreshCw size={10} className="spin" style={{ marginRight: 4 }} />
                {t('Checking...')}
              </span>
            ) : updateStatus?.app.hasUpdate ? (
              <>
                <span className="settings-badge" data-tone="amber">
                  <Sparkles size={11} style={{ marginRight: 4 }} />
                  {t('New version')} v{updateStatus.app.latest}
                </span>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={upgradingApp}
                  onClick={() => void handleUpgradeApp()}
                >
                  <Download size={12} className={upgradingApp ? 'spin' : ''} />
                  {upgradingApp ? t('Upgrading...') : t('Pull update')}
                </button>
              </>
            ) : updateStatus?.app ? (
              <span className="settings-badge" data-tone="green">
                <Check size={11} style={{ marginRight: 4 }} />
                {t('Up to date')}
              </span>
            ) : null}
          </div>
        </div>

        {/* 2. Pi CLI 版本 */}
        <div className="settings-item-row">
          <div className="settings-item-row__info settings-version-info">
            <span className="settings-item-row__title">{t('Pi CLI version')}</span>
            <span className="settings-item-row__desc">
              @earendil-works/pi-coding-agent v{piCliCurrent}
            </span>
          </div>
          <div className="settings-version-actions">
            {checking ? (
              <span className="settings-badge">
                <RefreshCw size={10} className="spin" style={{ marginRight: 4 }} />
                {t('Checking...')}
              </span>
            ) : updateStatus?.piCli.hasUpdate ? (
              <>
                <span className="settings-badge" data-tone="amber">
                  <Sparkles size={11} style={{ marginRight: 4 }} />
                  {t('New version')} v{updateStatus.piCli.latest}
                </span>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={upgradingCli}
                  onClick={() => void handleUpgradeCli()}
                >
                  <Download size={12} className={upgradingCli ? 'spin' : ''} />
                  {upgradingCli ? t('Upgrading...') : t('Reinstall & Upgrade')}
                </button>
              </>
            ) : updateStatus?.piCli ? (
              <span className="settings-badge" data-tone="green">
                <Check size={11} style={{ marginRight: 4 }} />
                {t('Up to date')}
              </span>
            ) : null}
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

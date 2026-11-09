import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  RefreshCw,
  Search,
  Sparkles,
  X
} from 'lucide-react'
import '../styles/appearance.css'
import '../styles/settings-agent.css'
import type {
  AggregatedUsageStats,
  AuthStatus,
  DailyUsageStat,
  ModelInfo,
  ModelUsageStat,
  PermissionMode,
  VersionCheckResult
} from '@shared/types'
import { resolveSavedModel, selectableModels } from '@shared/provider-models'
import { formatCost, formatTokens, formatUsageTokens } from '../lib/format'
import {
  FONT_SCALE_LABELS,
  FONT_SCALE_PRESETS,
  normalizeFontScale
} from '@shared/font-scale'
import { useT } from '../lib/i18n'
import { useIsDark } from '../lib/theme'
import { DEFAULT_THINKING_LEVELS } from '../lib/thinking'
import { useAppStore } from '../store/useAppStore'
import { ConfirmDialog } from './ConfirmDialog'
import { ColorField } from './ColorPicker'
import { Popover } from './Popover'
import { ShortcutsList } from './ShortcutsList'
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
  onChange,
  className
}: {
  label: string
  value: string
  icons: Record<string, string>
  options: { value: string; label: string; icon: string }[]
  onChange: (value: string) => void
  className?: string
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
          className={`settings-icon-select ${className ?? ''}`}
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

interface SettingsSelectOption {
  value: string
  label: string
  /** A provider header; consecutive options with the same group share one. */
  group?: string
  disabled?: boolean
}

/**
 * The settings dropdown. It is a popover list rather than a native select:
 * the closed control keeps its label on one line with an ellipsis, and the
 * open list can group provider models under their own headings.
 */
function SettingsSelect({
  label,
  value,
  options,
  onChange,
  className,
  menuWidth = 240,
  placeholder
}: {
  label: string
  value: string
  options: SettingsSelectOption[]
  onChange: (value: string) => void
  className?: string
  menuWidth?: number
  placeholder?: string
}) {
  const current = options.find((option) => option.value === value)
  const groups: { name: string; options: SettingsSelectOption[] }[] = []
  for (const option of options) {
    const name = option.group ?? ''
    const last = groups[groups.length - 1]
    if (last && last.name === name) last.options.push(option)
    else groups.push({ name, options: [option] })
  }
  return (
    <Popover
      align="right"
      width={menuWidth}
      className="settings-picker__popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className={`settings-picker${className ? ` ${className}` : ''}`}
          aria-label={label}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={current?.label ?? placeholder}
          onClick={toggle}
        >
          <span className="settings-picker__label">
            {current?.label ?? placeholder ?? ''}
          </span>
          <ChevronDown size={13} className="settings-picker__chevron" data-open={open} />
        </button>
      )}
    >
      {(close) => (
        <div className="settings-picker__menu" role="listbox" aria-label={label}>
          {groups.map((group) => (
            <div className="settings-picker__group" key={group.name || '\u0000'}>
              {group.name ? (
                <div className="settings-picker__group-label" title={group.name}>
                  {group.name}
                </div>
              ) : null}
              {group.options.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  disabled={option.disabled}
                  className="settings-picker__option"
                  title={option.label}
                  onClick={() => {
                    onChange(option.value)
                    close()
                  }}
                >
                  <span className="settings-picker__option-label">{option.label}</span>
                  {option.value === value ? (
                    <Check size={13} className="settings-picker__check" />
                  ) : null}
                </button>
              ))}
            </div>
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
          <SettingsIconSelect
            label={t('Language')}
            value={settings.language ?? 'zh-CN'}
            icons={{}}
            className="settings-icon-select--language"
            onChange={(value) => void updateSettings({ language: value as 'zh-CN' | 'en' })}
            options={[
              { value: 'zh-CN', label: '简体中文', icon: '' },
              { value: 'en', label: 'English', icon: '' }
            ]}
          />
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

        {/* Closing hides to the tray instead of quitting. The process reads this live. */}
        <div className="settings-item-row">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Keep running in the tray')}</span>
            <span className="settings-item-row__desc">
              {t('Closing the window hides Pi Desktop in the system tray instead of quitting.')}
            </span>
          </div>
          <Switch
            checked={settings.trayPersistent === true}
            onChange={(checked) => void updateSettings({ trayPersistent: checked })}
            label={t('Keep running in the tray')}
          />
        </div>

        {/* Computer Use is a capability, not a task mode. The switch is the approval. */}
        <div className="settings-item-row settings-item-row--fixed-control">
          <div className="settings-item-row__info">
            <span className="settings-item-row__title">{t('Computer Use')}</span>
            <span className="settings-item-row__desc">
              {t('Let the agent see and operate this Windows desktop. Screenshots, clicks and keystrokes are not asked for one by one. Plan Mode still cannot use it.')}
            </span>
          </div>
          <Switch
            checked={settings.computerUse === true}
            onChange={(checked) => void updateSettings({ computerUse: checked })}
            label={t('Computer Use')}
          />
        </div>
      </SettingsGroup>

      <ProjectSafetySettings />

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
          <SettingsIconSelect
            label={t('Send shortcut')}
            value={settings.sendShortcut ?? 'enter'}
            icons={{}}
            className="settings-icon-select--shortcut"
            onChange={(value) =>
              void updateSettings({ sendShortcut: value as 'enter' | 'ctrlEnter' })
            }
            options={[
              { value: 'enter', label: t('Press Enter'), icon: '' },
              { value: 'ctrlEnter', label: t('Press Ctrl+Enter'), icon: '' }
            ]}
          />
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
    light: { bg: '#FFFFFF', fg: '#000000' },
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
  { id: 'neutral', label: 'Normal contrast' },
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

  const toneValue = settings.themeTone === 'contrast' ? 'contrast' : 'neutral'
  const matchedTone = TONE_PRESETS.find((tone) => tone.id === toneValue)
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
            <ColorField
              label={t('Accent color')}
              value={effectiveAccent}
              onChange={(hex) => {
                void updateSettings({ accentColor: hex, themePreset: 'custom' })
              }}
            />
          </div>
        </div>

        {/* 背景 */}
        <div className="appearance-row">
          <div className="appearance-row__label">{t('Background')}</div>
          <div className="appearance-row__right">
            <ColorField
              label={t('Background')}
              value={effectiveBg}
              onChange={(hex) => {
                void updateSettings({ customBg: hex, themePreset: 'custom' })
              }}
            />
          </div>
        </div>

        {/* 前景 */}
        <div className="appearance-row">
          <div className="appearance-row__label">{t('Foreground')}</div>
          <div className="appearance-row__right">
            <ColorField
              label={t('Foreground')}
              value={effectiveFg}
              onChange={(hex) => {
                void updateSettings({ customFg: hex, themePreset: 'custom' })
              }}
            />
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
                value={toneValue}
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
          <SettingsGroup title={t('Text size')}>
            <div className="segmented settings-text-size" role="group" aria-label={t('Text size')}>
              {[
                { label: FONT_SCALE_LABELS[0], value: FONT_SCALE_PRESETS[0], data: 'small' },
                { label: FONT_SCALE_LABELS[1], value: FONT_SCALE_PRESETS[1], data: 'standard' },
                { label: FONT_SCALE_LABELS[2], value: FONT_SCALE_PRESETS[2], data: 'large' },
                { label: FONT_SCALE_LABELS[3], value: FONT_SCALE_PRESETS[3], data: 'extra-large' }
              ].map((option) => {
                const active =
                  Math.abs(
                    normalizeFontScale(settings.fontScale) - option.value
                  ) < 0.001
                return (
                  <button
                    key={option.label}
                    data-size={option.data}
                    aria-pressed={active}
                    data-active={active}
                    onClick={() => void updateSettings({ fontScale: option.value })}
                  >
                    {t(option.label)}
                  </button>
                )
              })}
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

/**
 * A help mark with the app's own bubble. The usage page is read for numbers, and
 * the native title tooltip is both slower and the one chrome the user asked not
 * to see here.
 */
function UsageHint({ text }: { text: string }) {
  const t = useT()
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  const show = (target: HTMLElement) => {
    const rect = target.getBoundingClientRect()
    setTip({
      x: Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150),
      y: rect.bottom + 8
    })
  }
  return (
    <>
      <span
        className="usage-metric__hint"
        role="note"
        aria-label={t('Show how this is calculated')}
        tabIndex={0}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={() => setTip(null)}
        onFocus={(event) => show(event.currentTarget)}
        onBlur={() => setTip(null)}
      >
        <CircleHelp size={11} aria-hidden="true" />
      </span>
      {tip
        ? createPortal(
            <div className="usage-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
              {text}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/**
 * Ten months of days at 10px squares fill the settings column: the cell is
 * capped at 10px and the grid takes whatever width those columns need. The
 * cells never stretch, so a wider window shows more days instead of bigger
 * blocks.
 */
const HEATMAP_DAYS = 300

export function UsageSettings() {
  const settings = useAppStore((state) => state.settings)
  const piState = useAppStore((state) => state.piState)
  const setAutoCompaction = useAppStore((state) => state.setAutoCompaction)
  const setAutoRetry = useAppStore((state) => state.setAutoRetry)
  const t = useT()

  const [usageStats, setUsageStats] = useState<AggregatedUsageStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedPeriod, setSelectedPeriod] = useState<'today' | 'week' | 'month' | 'allTime'>('today')
  const [hoveredDay, setHoveredDay] = useState<{
    day: DailyUsageStat
    dateLabel: string
    x: number
    y: number
  } | null>(null)
  // The bar chart's own bubble, anchored above the hovered bar. The native
  // title tooltip is exactly the system chrome this page must not show.
  const [hoveredModel, setHoveredModel] = useState<{
    stat: ModelUsageStat
    share: number
    series: number
    x: number
    y: number
  } | null>(null)

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
  const activeMsgs = activeData?.messageCount ?? 0
  const activeRequests = activeMsgs
  const activeCacheRead = activeTokens?.cacheRead ?? 0
  const cacheHitRate = (cacheRead: number | undefined, input: number | undefined): number => {
    const denominator = (cacheRead ?? 0) + (input ?? 0)
    return denominator > 0 ? Math.round(((cacheRead ?? 0) / denominator) * 1000) / 10 : 0
  }
  const activeCacheHitRate = cacheHitRate(activeTokens?.cacheRead, activeTokens?.input)
  const heatmap = useMemo(() => {
    const locale = settings.language === 'zh-CN' ? 'zh-CN' : 'en'
    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (HEATMAP_DAYS - 1))
    const leadingDays = (start.getDay() + 6) % 7
    const weekCount = Math.ceil((leadingDays + HEATMAP_DAYS) / 7)
    const gridStart = new Date(start)
    gridStart.setDate(gridStart.getDate() - leadingDays)
    const usageByDate = new Map(
      (usageStats?.heatmapDays ?? usageStats?.recentDays ?? []).map((day) => [day.date, day])
    )
    const dateKey = (date: Date) =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
    const cells: Array<{
      date: Date
      day: NonNullable<typeof usageStats>['recentDays'][number]
      week: number
      weekday: number
      level: number
    }> = []
    const monthLabels: Array<{ week: number; label: string; fullLabel: string }> = []
    const monthFormatter = new Intl.DateTimeFormat(locale, { month: 'short' })
    const fullDateFormatter = new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
    const weekdayFormatter = new Intl.DateTimeFormat(locale, { weekday: 'short' })
    let rangeTokens = 0
    let activeDays = 0

    for (let week = 0; week < weekCount; week++) {
      for (let weekday = 0; weekday < 7; weekday++) {
        const date = new Date(gridStart)
        date.setDate(gridStart.getDate() + week * 7 + weekday)
        if (date < start || date > today) continue
        const key = dateKey(date)
        const day = usageByDate.get(key) ?? {
          date: key,
          totalTokens: 0,
          conversationsCount: 0,
          messageCount: 0
        }
        rangeTokens += day.totalTokens
        if (day.totalTokens > 0) activeDays += 1
        if (date.getDate() === 1) {
          monthLabels.push({
            week,
            label: monthFormatter.format(date),
            fullLabel: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long' }).format(date)
          })
        }
        cells.push({ date, day, week, weekday, level: 0 })
      }
    }

    const maxTokens = Math.max(0, ...cells.map((cell) => cell.day.totalTokens))
    for (const cell of cells) {
      cell.level = cell.day.totalTokens === 0 || maxTokens === 0
        ? 0
        : Math.max(1, Math.ceil((cell.day.totalTokens / maxTokens) * 4))
    }

    const weekdays = Array.from({ length: 7 }, (_, day) => {
      const date = new Date(2024, 0, 1 + day)
      return weekdayFormatter.format(date)
    })

    return { cells, monthLabels, weekdays, weekCount, rangeTokens, activeDays, fullDateFormatter, locale }
  }, [settings.language, usageStats])

  // Two rows of four: what the period cost and how much it moved, then the
  // token split underneath it. The real-token reading is the one to look at,
  // so it is the only cell carrying an emphasis.
  const overviewMetrics: Array<{
    key: string
    label: string
    value: string
    hint?: string
    emphasis?: boolean
  }> = [
    { key: 'cost', label: t('Total cost'), value: formatCost(activeTokens?.cost) },
    { key: 'requests', label: t('Total requests'), value: String(activeRequests) },
    {
      key: 'tokens',
      label: t('Real tokens'),
      value: formatUsageTokens(activeTokens?.totalTokens),
      hint: t('Every token billed in this period: input, output and cache reads and writes.'),
      emphasis: true
    },
    {
      key: 'hit-rate',
      label: t('Cache hit rate'),
      value: `${activeCacheHitRate.toFixed(1)}%`,
      hint: t('Cache hits divided by all prompt tokens, cached and new.')
    },
    { key: 'input', label: t('New input'), value: formatUsageTokens(activeTokens?.input) },
    { key: 'output', label: t('Output'), value: formatUsageTokens(activeTokens?.output) },
    {
      key: 'cache-write',
      label: t('Cache write'),
      value: formatUsageTokens(activeTokens?.cacheWrite),
      hint: t('Tokens written into the prompt cache.')
    },
    { key: 'cache-hit', label: t('Cache hit'), value: formatUsageTokens(activeCacheRead) }
  ]

  // The bars scale against their own tallest model; the share is in the tooltip.
  const modelPeak = Math.max(1, ...(usageStats?.byModel ?? []).map((model) => model.totalTokens))
  // The share is the share of every token ever billed.
  const modelTotal = usageStats?.allTime.tokens.totalTokens || 1

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Usage')}
        description={t('Global token consumption statistics and conversation activity across time horizons.')}
      />

      <SettingsGroup
        title={t('Usage heatmap')}
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
        <div
          className="usage-heatmap"
          style={{ '--usage-week-count': heatmap.weekCount } as CSSProperties}
        >
          <div className="usage-heatmap__summary">
            <span>{t('Past 10 months')}</span>
            <span>
              {heatmap.activeDays} {t('Active days')} · {formatTokens(heatmap.rangeTokens)} {t('Total tokens')}
            </span>
          </div>
          <div className="usage-heatmap__viewport">
            <div className="usage-heatmap__layout">
              <div className="usage-heatmap__weekdays" aria-hidden="true">
                <span />
                {heatmap.weekdays.map((day, index) => (
                  <span key={index}>{index === 0 || index === 2 || index === 4 ? day : ''}</span>
                ))}
              </div>
              <div className="usage-heatmap__calendar">
                <div
                  className="usage-heatmap__months"
                  aria-hidden="true"
                >
                  {heatmap.monthLabels.map(({ week, label, fullLabel }) => (
                    <span key={`${week}-${label}`} style={{ gridColumn: week + 1 }} title={fullLabel}>
                      {label}
                    </span>
                  ))}
                </div>
                <div
                  className="usage-heatmap__cells"
                  role="grid"
                  aria-label={t('Usage heatmap')}
                >
                  {heatmap.cells.map(({ date, day, week, weekday, level }) => {
                    const dateLabel = heatmap.fullDateFormatter.format(date)
                    const description = `${dateLabel} · ${t('Total tokens')}: ${day.totalTokens.toLocaleString(heatmap.locale)} · ${t('Cache hit rate')}: ${cacheHitRate(day.cacheRead, day.input).toFixed(1)}%`
                    return (
                      <span
                        key={day.date}
                        className="usage-heatmap__cell"
                        data-level={level}
                        role="gridcell"
                        aria-label={description}
                        style={{ gridColumn: week + 1, gridRow: weekday + 1 }}
                        onMouseEnter={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect()
                          setHoveredDay({
                            day,
                            dateLabel,
                            x: Math.min(rect.right + 10, window.innerWidth - 200),
                            y: Math.min(rect.top + rect.height / 2, window.innerHeight - 96)
                          })
                        }}
                        onMouseLeave={() => setHoveredDay(null)}
                      />
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
          <div className="usage-heatmap__legend" aria-label={t('Usage intensity')}>
            <span>{t('Less')}</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <span key={level} className="usage-heatmap__cell" data-level={level} aria-hidden="true" />
            ))}
            <span>{t('More')}</span>
          </div>
        </div>
      </SettingsGroup>

      {/* Compact overview: one period selector, eight readings in two rows. */}
      <SettingsGroup
        title={t('Token usage overview')}
        action={
          <SettingsSelect
            label={t('Period')}
            value={selectedPeriod}
            options={periods.map(({ key, title }) => ({ value: key, label: title }))}
            onChange={(value) => setSelectedPeriod(value as typeof selectedPeriod)}
            menuWidth={180}
            className="usage-period-select"
          />
        }
      >
        <div className="usage-overview">
          {overviewMetrics.map((metric) => (
            <div
              key={metric.key}
              className="usage-overview__metric"
              data-emphasis={metric.emphasis ? 'true' : undefined}
            >
              <span className="usage-overview__label">
                <span className="usage-overview__label-text">{metric.label}</span>
                {metric.hint ? <UsageHint text={metric.hint} /> : null}
              </span>
              <span className="usage-overview__value">{metric.value}</span>
            </div>
          ))}
        </div>
      </SettingsGroup>

      {/* Model distribution: a column per model, each with its token count
          printed above the bar so the height and the number can be read
          together. Share, turns and cost ride along on the column's tooltip. */}
      {usageStats && usageStats.byModel.length > 0 && (
        <SettingsGroup title={t('Model distribution')}>
          <div className="usage-model-chart">
            <div className="usage-model-chart__plot">
              {usageStats.byModel.map((m, index) => {
                const share = Math.min(100, (m.totalTokens / modelTotal) * 100)
                return (
                  <div
                    key={m.model}
                    className="usage-model-chart__column"
                    onMouseEnter={(event) => {
                      const bar = event.currentTarget.querySelector<HTMLElement>(
                        '.usage-model-chart__bar'
                      )
                      const anchor = (bar ?? event.currentTarget).getBoundingClientRect()
                      setHoveredModel({
                        stat: m,
                        share,
                        series: index % 6,
                        x: Math.min(
                          Math.max(anchor.left + anchor.width / 2, 150),
                          window.innerWidth - 150
                        ),
                        // The bubble hangs above the bar; the floor keeps a tall
                        // bar from pushing it past the top of the window.
                        y: Math.max(124, anchor.top - 10)
                      })
                    }}
                    onMouseLeave={() => setHoveredModel(null)}
                  >
                    <div className="usage-model-chart__bar-area">
                      <div
                        className="usage-model-chart__bar"
                        data-series={index % 6}
                        style={{
                          height: `${Math.max(
                            4,
                            Math.round((m.totalTokens / modelPeak) * 100)
                          )}%`
                        }}
                      >
                        <span className="usage-model-chart__value">
                          {formatUsageTokens(m.totalTokens)}
                        </span>
                      </div>
                    </div>
                    <span className="usage-model-chart__xlabel">
                      {m.model.split('/').pop() ?? m.model}
                    </span>
                  </div>
                )
              })}
            </div>
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

      {hoveredDay
        ? createPortal(
            <div
              className="usage-heatmap-tooltip"
              role="tooltip"
              style={{ left: hoveredDay.x, top: hoveredDay.y }}
            >
              <div className="usage-heatmap-tooltip__date">{hoveredDay.dateLabel}</div>
              <div className="usage-heatmap-tooltip__row">
                <span>{t('Total tokens')}</span>
                <strong>{formatUsageTokens(hoveredDay.day.totalTokens)}</strong>
              </div>
              <div className="usage-heatmap-tooltip__row">
                <span>{t('Cache hit rate')}</span>
                <strong>{cacheHitRate(hoveredDay.day.cacheRead, hoveredDay.day.input).toFixed(1)}%</strong>
              </div>
            </div>,
            document.body
          )
        : null}

      {hoveredModel
        ? createPortal(
            <div
              className="usage-model-tooltip"
              role="tooltip"
              style={{ left: hoveredModel.x, top: hoveredModel.y }}
            >
              <div className="usage-model-tooltip__head">
                <span
                  className="usage-model-tooltip__swatch"
                  data-series={hoveredModel.series}
                  aria-hidden="true"
                />
                <span className="usage-model-tooltip__name">{hoveredModel.stat.model}</span>
              </div>
              <div className="usage-model-tooltip__row">
                <span>{t('Total tokens')}</span>
                <strong>{formatUsageTokens(hoveredModel.stat.totalTokens)}</strong>
              </div>
              <div className="usage-model-tooltip__row">
                <span>{t('Share')}</span>
                <strong>{hoveredModel.share.toFixed(1)}%</strong>
              </div>
              <div className="usage-model-tooltip__row">
                <span>{t('Turns')}</span>
                <strong>{hoveredModel.stat.messageCount}</strong>
              </div>
              {hoveredModel.stat.cost > 0 ? (
                <div className="usage-model-tooltip__row">
                  <span>{t('Cost')}</span>
                  <strong>{formatCost(hoveredModel.stat.cost)}</strong>
                </div>
              ) : null}
            </div>,
            document.body
          )
        : null}
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

function ProjectSafetySettings() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const t = useT()

  return (
    <SettingsGroup title={t('Project safety')}>
      <div className="settings-item-row settings-item-row--fixed-control">
        <div className="settings-item-row__info">
          <span className="settings-item-row__title">
            {t('Trust project-local extensions and settings')}
          </span>
          <span className="settings-item-row__desc">
            {t('Project-local extensions can execute code. Enable this only for projects you trust.')}
          </span>
          <span className="settings-item-row__desc">
            {t('Saved immediately. Restart Pi Desktop to apply this to the Pi runtime. MCP configuration uses this setting the next time it is read.')}
          </span>
        </div>
        <Switch
          checked={settings.trustProject === true}
          onChange={(value) => void updateSettings({ trustProject: value })}
          label={t('Trust project-local extensions and settings')}
        />
      </div>
    </SettingsGroup>
  )
}

/** The shortcut table as a settings page. `Ctrl+/` opens the same list in a
 *  modal; both render `ShortcutsList`, so they can never show two different
 *  tables. Only the settings page lets a chord be rebound. */
export function ShortcutsSettings() {
  const t = useT()
  return (
    <div className="settings-page">
      <PageIntro
        title={t('Keyboard shortcuts')}
        description={t('All app shortcuts in one place. Click a key combination to change it.')}
      />
      <p className="shortcuts-hint">
        {t('Backspace resets a shortcut to its default, Esc cancels the recording.')}
      </p>
      <ShortcutsList editable />
    </div>
  )
}

export function AboutSettings() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const info = useAppStore((state) => state.info)
  const refreshInfo = useAppStore((state) => state.refreshInfo)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()
  const infoRequested = useRef(false)

  useEffect(() => {
    if (infoRequested.current || info?.pi.version) return
    infoRequested.current = true
    void refreshInfo()
  }, [info?.pi.version, refreshInfo])

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

  const appCurrent = info?.version ?? '—'
  const piCliCurrent = info?.pi.version ?? '—'

  return (
    <div className="settings-page settings-page--compact">
      <SettingsGroup title={t('Version and updates')}>
        <div className="settings-about-card">
          <div className="settings-item-row settings-about-row">
            <div className="settings-item-row__info">
              <span className="settings-item-row__title">{t('Application version')}</span>
              <span className="settings-item-row__desc">{t('Current application version')}</span>
            </div>
            <div className="settings-version-actions">
              <span className="settings-about-value">{appCurrent}</span>
              {updateStatus?.app.hasUpdate ? (
                <>
                  <span className="settings-badge" data-tone="amber">
                    <Sparkles size={11} style={{ marginRight: 4 }} />
                    {t('New version')} v{updateStatus.app.latest}
                  </span>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={upgradingApp || upgradingCli}
                    onClick={() => void handleUpgradeApp()}
                  >
                    <Download size={12} />
                    {upgradingApp ? t('Upgrading...') : t('Pull update')}
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <div className="settings-item-row settings-about-row">
            <div className="settings-item-row__info">
              <span className="settings-item-row__title">{t('Built-in service version')}</span>
              <span className="settings-item-row__desc">{t('Current built-in service version')}</span>
            </div>
            <div className="settings-version-actions">
              <span className="settings-about-value">{piCliCurrent}</span>
              {updateStatus?.piCli.hasUpdate ? (
                <>
                  <span className="settings-badge" data-tone="amber">
                    <Sparkles size={11} style={{ marginRight: 4 }} />
                    {t('New version')} v{updateStatus.piCli.latest}
                  </span>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={upgradingCli || upgradingApp}
                    onClick={() => void handleUpgradeCli()}
                  >
                    <Download size={12} />
                    {upgradingCli ? t('Upgrading...') : t('Reinstall & Upgrade')}
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <div className="settings-item-row settings-about-row">
            <div className="settings-item-row__info">
              <span className="settings-item-row__title">{t('Check for updates')}</span>
              <span className="settings-item-row__desc">{t('Manually check for available updates')}</span>
            </div>
            <button
              type="button"
              className="btn btn--sm"
              disabled={checking || upgradingCli || upgradingApp}
              onClick={() => void handleCheck()}
            >
              <RefreshCw size={12} className={checking ? 'spin' : ''} />
              {checking ? t('Checking...') : t('Check now')}
            </button>
          </div>

          <div className="settings-item-row settings-about-row">
            <div className="settings-item-row__info">
              <span className="settings-item-row__title">{t('Automatically download updates')}</span>
              <span className="settings-item-row__desc">
                {t('Download built-in service updates in the background and restart the app to finish installing')}
              </span>
            </div>
            <Switch
              checked={settings.automaticUpdates === true}
              onChange={(value) => void updateSettings({ automaticUpdates: value })}
              label={t('Automatically download updates')}
            />
          </div>
        </div>
      </SettingsGroup>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Agent and conversation
 * ------------------------------------------------------------------ */

const modelSpec = (model: ModelInfo): string => `${model.provider}/${model.id}`

/**
 * The three levels with the exact words `PermissionPicker` shows. That list is
 * private to the component, so the strings live here too; sharing the English
 * keys is what keeps the two dialogs from drifting into different wording.
 */
const PERMISSION_MODES: { value: PermissionMode; label: string; description: string }[] = [
  { value: 'ask', label: 'Request approval', description: 'Ask before every agent tool operation.' },
  {
    value: 'auto',
    label: 'Approve for me',
    description: 'Approve ordinary files in the working folder; ask for commands and other access.'
  },
  { value: 'full', label: 'Full access', description: 'Allow all agent tools without approval.' }
]

/** The row shape GeneralSettings uses: title and description left, control right. */
function SettingsItemRow({
  title,
  description,
  children
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  return (
    // The page's own row class: these descriptions are two lines long, and the
    // shared row sizes its text column by content — which pushed the control
    // onto a second line instead of holding it on the row's right edge.
    <div className="settings-item-row settings-item-row--agent">
      <div className="settings-item-row__info">
        <span className="settings-item-row__title">{title}</span>
        {description ? <span className="settings-item-row__desc">{description}</span> : null}
      </div>
      {children}
    </div>
  )
}

/**
 * Models the selects on this page can offer.
 *
 * The saved provider catalog is folded in with whatever the live process
 * published, so a default can be chosen while no Pi process is running. The
 * grouping is the composer picker's: providers in first-appearance order, Pi's
 * order preserved inside each provider.
 */
function useModelChoices(): { models: ModelInfo[]; groups: [string, ModelInfo[]][] } {
  const runtimeModels = useAppStore((state) => state.models)
  const catalogModels = useAppStore((state) => state.catalogModels)
  const disabledModelSpecs = useAppStore((state) => state.disabledModelSpecs)
  const models = useMemo(
    () => selectableModels(runtimeModels, catalogModels, disabledModelSpecs),
    [runtimeModels, catalogModels, disabledModelSpecs]
  )
  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>()
    for (const model of models) {
      const group = map.get(model.provider)
      if (group) group.push(model)
      else map.set(model.provider, [model])
    }
    return [...map]
  }, [models])
  return { models, groups }
}

function ModelSelect({
  label,
  value,
  groups,
  emptyLabel,
  onChange,
  className
}: {
  label: string
  value: string
  groups: [string, ModelInfo[]][]
  emptyLabel?: string
  onChange: (spec: string) => void
  className?: string
}) {
  const t = useT()
  // A saved pair the catalog no longer offers still has to appear in the
  // control. Dropping it would paint the first row and claim that was the choice.
  const listed = groups.some(([, list]) => list.some((model) => modelSpec(model) === value))
  const options: SettingsSelectOption[] = []
  if (emptyLabel) options.push({ value: '', label: emptyLabel })
  for (const [provider, list] of groups) {
    for (const model of list) {
      options.push({ value: modelSpec(model), label: model.name || model.id, group: provider })
    }
  }
  if (value && !listed) options.push({ value, label: value })
  // Nothing to list is worth saying out loud; a bare default looks like a choice.
  if (groups.length === 0) {
    return (
      <SettingsSelect
        label={label}
        value=""
        options={[{ value: '', label: t('No models yet.'), disabled: true }]}
        onChange={() => undefined}
        menuWidth={300}
        className={className}
      />
    )
  }
  return (
    <SettingsSelect
      label={label}
      value={value}
      options={options}
      onChange={onChange}
      menuWidth={300}
      className={className}
    />
  )
}

/**
 * A reasoning-effort select.
 *
 * The levels Pi reports belong to the model on screen. A saved effort that came
 * from another model is still offered, or the control would read as unset.
 */
function LevelSelect({
  label,
  value,
  levels,
  emptyLabel,
  onChange
}: {
  label: string
  value: string
  levels: readonly string[]
  emptyLabel: string
  onChange: (level: string) => void
}) {
  const t = useT()
  const levelLabel = (level: string) => t(level.charAt(0).toUpperCase() + level.slice(1))
  const match = value
    ? levels.find((level) => level.toLowerCase() === value.toLowerCase())
    : undefined
  const options: SettingsSelectOption[] = [{ value: '', label: emptyLabel }]
  for (const level of levels) {
    options.push({ value: level, label: levelLabel(level) })
  }
  if (value && !match) options.push({ value, label: levelLabel(value) })
  return (
    <SettingsSelect
      label={label}
      value={match ?? value}
      options={options}
      onChange={onChange}
      menuWidth={200}
    />
  )
}

/**
 * The defaults a new conversation starts with and how its work is shown.
 * Every control saves on the spot — this dialog has no save button.
 */
export function AgentSettings() {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const refreshModelCatalog = useAppStore((state) => state.refreshModelCatalog)
  const liveLevels = useAppStore((state) => state.thinkingLevels)
  const t = useT()
  const { models, groups } = useModelChoices()
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)

  // A provider saved in the Model page is not in this store until the catalog is
  // re-read, and this page has to work with no Pi process to tell it otherwise.
  useEffect(() => {
    void refreshModelCatalog()
  }, [refreshModelCatalog])

  // This is a saved default for new conversations, so it can use Pi's generic
  // effort choices even when no running session has reported model-specific levels.
  const levels: readonly string[] = liveLevels.length > 0 ? liveLevels : DEFAULT_THINKING_LEVELS
  const permissionMode = settings.permissionMode ?? 'ask'
  const defaultModel = resolveSavedModel(settings.model, settings.provider, models)
  const subagentModel = resolveSavedModel(settings.subagentModel, settings.subagentProvider, models)

  const saveModel = (spec: string) => {
    if (!spec) {
      void updateSettings({ model: undefined, provider: undefined })
      return
    }
    const model = models.find((item) => modelSpec(item) === spec)
    if (!model) return
    // Kept in the shape the rest of the app compares: `provider/id`, plus the
    // provider id on its own, exactly as `setModel` writes the live choice.
    void updateSettings({ model: spec, provider: model.provider })
  }

  const saveSubagentModel = (spec: string) => {
    if (!spec) {
      void updateSettings({ subagentModel: undefined, subagentProvider: undefined })
      return
    }
    const model = models.find((item) => modelSpec(item) === spec)
    if (!model) return
    void updateSettings({ subagentModel: spec, subagentProvider: model.provider })
  }

  const savePermission = (value: PermissionMode) => {
    void updateSettings({ permissionMode: value })
  }

  // The picker's safety step, kept here too: full access is never one click away.
  const pickPermission = (value: PermissionMode) => {
    if (value === permissionMode) return
    if (value === 'full') {
      setConfirmFullAccess(true)
      return
    }
    savePermission(value)
  }

  return (
    <div className="settings-page">
      <PageIntro
        title={t('Agent and conversation')}
        description={t('What every new conversation starts with, and how the work it does is shown to you.')}
      />

      <SettingsGroup title={t('Agent defaults')}>
        <SettingsItemRow
          title={t('Default model')}
          description={t('The model a new conversation starts with. The conversation on screen keeps the model it already chose.')}
        >
          <ModelSelect
            label={t('Default model')}
            value={defaultModel ? modelSpec(defaultModel) : ''}
            groups={groups}
            emptyLabel={t('Automatic (Pi default)')}
            onChange={saveModel}
          />
        </SettingsItemRow>

        <SettingsItemRow
          title={t('Default permission')}
          description={t('How Pi asks before it uses a tool. This one applies straight away, including to a conversation already running.')}
        >
          <div className="segmented" role="group" aria-label={t('Default permission')}>
            {PERMISSION_MODES.map((entry) => {
              const active = entry.value === permissionMode
              return (
                <button
                  key={entry.value}
                  type="button"
                  data-active={active}
                  aria-pressed={active}
                  title={t(entry.description)}
                  onClick={() => pickPermission(entry.value)}
                >
                  {t(entry.label)}
                </button>
              )
            })}
          </div>
        </SettingsItemRow>

        {/* Seven effort levels do not fit one segmented control, so this row
            gets a select; the scale is Pi's, not a made-up shortlist. */}
        <SettingsItemRow
          title={t('Default reasoning effort')}
          description={t('The reasoning effort a new conversation starts with. Automatic leaves the choice to Pi.')}
        >
          <LevelSelect
            label={t('Default reasoning effort')}
            value={settings.thinkingLevel ?? ''}
            levels={levels}
            emptyLabel={t('Automatic (Pi default)')}
            onChange={(level) => void updateSettings({ thinkingLevel: level || undefined })}
          />
        </SettingsItemRow>

        <SettingsItemRow
          title={t('Default plan mode')}
          description={t('Open a brand-new conversation in Plan Mode, which begins read-only: read, grep, find, ls and the plan tool. Approving the plan, or /plan off, leaves it. A conversation already open or resumed from disk keeps the mode it stored.')}
        >
          <Switch
            checked={settings.defaultPlanMode === true}
            onChange={(checked) => void updateSettings({ defaultPlanMode: checked })}
            label={t('Default plan mode')}
          />
        </SettingsItemRow>
      </SettingsGroup>

      <SettingsGroup title={t('Subagents')}>
        <SettingsItemRow
          title={t('Subagent model')}
          description={t('The model a spawned subagent runs on. Follow the conversation keeps the model of the conversation that delegated the task. Reaches the subagents dispatched by conversations started from now on.')}
        >
          <ModelSelect
            label={t('Subagent model')}
            value={subagentModel ? modelSpec(subagentModel) : ''}
            groups={groups}
            emptyLabel={t('Follow the conversation')}
            className="settings-select--subagent"
            onChange={saveSubagentModel}
          />
        </SettingsItemRow>

        <SettingsItemRow
          title={t('Subagent reasoning effort')}
          description={t('The reasoning effort a spawned subagent runs with. The setup is written when a conversation starts, so it reaches the subagents of new conversations.')}
        >
          <LevelSelect
            label={t('Subagent reasoning effort')}
            value={settings.subagentThinking ?? ''}
            levels={levels}
            emptyLabel={t('Follow the conversation')}
            onChange={(level) => void updateSettings({ subagentThinking: level || undefined })}
          />
        </SettingsItemRow>
      </SettingsGroup>

      <SettingsGroup title={t('Composer')}>
        <SettingsItemRow
          title={t('Auto-mention pasted images')}
          description={t('Reference a pasted picture in the message, not only attach it.')}
        >
          <Switch
            checked={settings.pasteMentions === true}
            onChange={(checked) => void updateSettings({ pasteMentions: checked })}
            label={t('Auto-mention pasted images')}
          />
        </SettingsItemRow>
      </SettingsGroup>

      <SettingsGroup title={t('Message folding')}>
        <SettingsItemRow
          title={t('Auto-fold the working process')}
          description={t('Keep a finished turn’s tools and thinking folded so the answer is what stays on screen. Turn this off to leave the work visible.')}
        >
          <Switch
            checked={settings.autoFoldProcess !== false}
            onChange={(checked) => void updateSettings({ autoFoldProcess: checked })}
            label={t('Auto-fold the working process')}
          />
        </SettingsItemRow>

        {/* A different thing from the row above: this one is about the live list
            while the agent works, not about a turn that has already settled. */}
        <SettingsItemRow
          title={t('Tool call summary')}
          description={t('While the agent is working, gather consecutive tool calls into one summary line instead of a list that keeps growing. This is not the folding of a finished turn.')}
        >
          <Switch
            checked={settings.toolCallSummary === true}
            onChange={(checked) => void updateSettings({ toolCallSummary: checked })}
            label={t('Tool call summary')}
          />
        </SettingsItemRow>
      </SettingsGroup>

      <SettingsGroup title={t('Chat titles')}>
        <SettingsItemRow
          title={t('Auto-generate title')}
          description={t('Name a new conversation from its first exchange. This spends one extra model call.')}
        >
          <Switch
            checked={settings.autoTitle === true}
            onChange={(checked) => void updateSettings({ autoTitle: checked })}
            label={t('Auto-generate title')}
          />
        </SettingsItemRow>
      </SettingsGroup>

      {confirmFullAccess
        ? createPortal(
            <ConfirmDialog
              className="permission-confirm"
              title={t('Enable full access?')}
              body={t(
                'Full access lets the agent read and change files outside the working folder, run commands, and access the network with your system account permissions. Tool operations will no longer ask for approval. You can switch back at any time.'
              )}
              tone="danger"
              onCancel={() => setConfirmFullAccess(false)}
              onConfirm={() => {
                setConfirmFullAccess(false)
                savePermission('full')
              }}
            />,
            document.body
          )
        : null}
    </div>
  )
}

import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Download, Search, Sparkles, X } from 'lucide-react'
import {
  FONT_SCALE_LABELS,
  FONT_SCALE_PRESETS,
  normalizeFontScale
} from '@shared/font-scale'
import { useT } from '../../lib/i18n'
import { useIsDark } from '../../lib/theme'
import { useAppStore } from '../../store/useAppStore'
import { ColorField } from '../ColorPicker'
import { Popover } from '../Popover'
import { Switch } from '../Switch'
import { SettingsGroup } from './SettingsShared'

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

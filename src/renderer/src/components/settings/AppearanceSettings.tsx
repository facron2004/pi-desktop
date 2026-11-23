import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Download, Search, X } from 'lucide-react'
import {
  ACCENT_PRESETS,
  CUSTOM_THEME_ID,
  DEFAULT_THEME_ID,
  THEME_PRESETS,
  TONE_PRESETS,
  findThemePreset,
  presetPalette
} from '@shared/theme-presets'
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

/** One preset's canvas with its accent sitting on it, as the menu draws it. */
function ThemeSwatch({ bg, accent }: { bg: string; accent: string }) {
  return (
    <span className="appearance-swatch" style={{ background: bg }} aria-hidden="true">
      <span className="appearance-swatch__dot" style={{ background: accent }} />
    </span>
  )
}

/** One accent as a solid chip, for the accent menu. */
function AccentSwatch({ color }: { color: string }) {
  return (
    <span
      className="appearance-swatch appearance-swatch--solid"
      style={{ background: color }}
      aria-hidden="true"
    />
  )
}

/** A pill's shape, shared by the three menus so they cannot drift apart. */
function MenuRow({
  label,
  selected,
  onPick,
  swatch,
  role = 'option'
}: {
  label: string
  selected: boolean
  onPick: () => void
  swatch?: ReactNode
  role?: 'option'
}) {
  return (
    <button
      type="button"
      role={role}
      aria-selected={selected}
      className="popover__item appearance-menu__item"
      data-selected={selected}
      onClick={onPick}
    >
      {swatch}
      <span className="popover__item-text">{label}</span>
      {selected ? <Check size={14} /> : null}
    </button>
  )
}

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

  const currentPresetObj = findThemePreset(settings.themePreset)

  const effectiveAccent =
    settings.accentColor ?? currentPresetObj?.accent ?? defaultColors.accent

  const effectiveBg =
    settings.customBg ??
    (currentPresetObj ? presetPalette(currentPresetObj, isDark).bg : defaultColors.bg)

  const effectiveFg =
    settings.customFg ??
    (currentPresetObj ? presetPalette(currentPresetObj, isDark).fg : defaultColors.fg)

  const matchedAccentPreset = ACCENT_PRESETS.find(
    (p) => p.value.toLowerCase() === effectiveAccent.toLowerCase()
  )

  const toneValue = settings.themeTone === 'contrast' ? 'contrast' : 'neutral'
  const matchedTone = TONE_PRESETS.find((tone) => tone.id === toneValue)
  const currentFontVal = settings.fontFamily ?? 'system'
  const currentFontLabel = t(
    FONT_DISPLAY_NAMES[currentFontVal] ?? (currentFontVal === 'system' ? 'System default' : currentFontVal)
  )

  // The pill shows what is painted, so "Default" previews the live tokens and
  // "Custom" previews the hand-picked pair — every row of the menu is a
  // colour the reader can tell apart at a glance.
  const themeIsCustom = settings.themePreset === CUSTOM_THEME_ID
  const themeLabel = currentPresetObj
    ? t(currentPresetObj.name)
    : themeIsCustom
      ? t('Custom')
      : t('Default')
  // Which menu row is ticked: `default` and `custom` are not presets.
  const themeMenuValue =
    currentPresetObj?.id ?? (themeIsCustom ? CUSTOM_THEME_ID : DEFAULT_THEME_ID)
  const accentLabel = matchedAccentPreset
    ? t(matchedAccentPreset.label)
    : settings.accentColor || currentPresetObj
      ? t('Custom')
      : t('Default')

  // Every row of the theme menu is drawn from the colours it will paint, so
  // two presets that look alike cannot hide behind their names any more.
  // "Custom" has no colours of its own until the reader picks some, so until
  // then it wears an empty slot instead of repeating "Default"'s swatch.
  const themeChoices = useMemo(() => {
    const rows: { value: string; label: string; bg: string; accent: string; empty?: boolean }[] = [
      {
        value: DEFAULT_THEME_ID,
        label: t('Default'),
        bg: defaultColors.bg,
        accent: defaultColors.accent
      }
    ]
    for (const preset of THEME_PRESETS) {
      const palette = presetPalette(preset, isDark)
      rows.push({
        value: preset.id,
        label: t(preset.name),
        bg: palette.bg,
        accent: preset.accent
      })
    }
    rows.push({
      value: CUSTOM_THEME_ID,
      label: t('Custom'),
      bg: effectiveBg,
      accent: effectiveAccent,
      empty: !themeIsCustom
    })
    return rows
  }, [defaultColors, effectiveAccent, effectiveBg, isDark, themeIsCustom, t])

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
    const preset = findThemePreset(settings.themePreset)
    if (preset) {
      const palette = presetPalette(preset, nextDark)
      void updateSettings({
        theme: mode,
        accentColor: preset.accent,
        customBg: palette.bg,
        customFg: palette.fg
      })
    } else {
      void updateSettings({ theme: mode })
    }
  }

  const handlePresetChange = (presetId: string) => {
    if (presetId === DEFAULT_THEME_ID) {
      void updateSettings({
        themePreset: undefined,
        accentColor: undefined,
        customBg: undefined,
        customFg: undefined
      })
      return
    }
    if (presetId === CUSTOM_THEME_ID) {
      void updateSettings({ themePreset: CUSTOM_THEME_ID })
      return
    }
    const preset = findThemePreset(presetId)
    if (!preset) return
    const palette = presetPalette(preset, isDark)
    void updateSettings({
      themePreset: preset.id,
      accentColor: preset.accent,
      customBg: palette.bg,
      customFg: palette.fg
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
            <Popover
              align="right"
              width={244}
              className="appearance-menu"
              renderTrigger={({ open, toggle }) => (
                <button
                  type="button"
                  className="appearance-select-pill"
                  aria-label={t('Theme')}
                  aria-haspopup="listbox"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  <ThemeSwatch bg={effectiveBg} accent={effectiveAccent} />
                  <span>{themeLabel}</span>
                  <ChevronDown size={13} className="appearance-select-pill__chevron" />
                </button>
              )}
            >
              {(close) => (
                <div className="appearance-menu__list" role="listbox" aria-label={t('Theme')}>
                  {themeChoices.map((choice) => (
                    <MenuRow
                      key={choice.value}
                      label={choice.label}
                      selected={choice.value === themeMenuValue}
                      swatch={
                        choice.empty ? (
                          <span
                            className="appearance-swatch appearance-swatch--empty"
                            aria-hidden="true"
                          />
                        ) : (
                          <ThemeSwatch bg={choice.bg} accent={choice.accent} />
                        )
                      }
                      onPick={() => {
                        handlePresetChange(choice.value)
                        close()
                      }}
                    />
                  ))}
                </div>
              )}
            </Popover>
          </div>
        </div>

        {/* 强调色 */}
        <div className="appearance-row">
          <div className="appearance-row__label">{t('Accent color')}</div>
          <div className="appearance-row__right">
            <Popover
              align="right"
              width={244}
              className="appearance-menu"
              renderTrigger={({ open, toggle }) => (
                <button
                  type="button"
                  className="appearance-select-pill"
                  aria-label={t('Accent color')}
                  aria-haspopup="listbox"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  <AccentSwatch color={effectiveAccent} />
                  <span>{accentLabel}</span>
                  <ChevronDown size={13} className="appearance-select-pill__chevron" />
                </button>
              )}
            >
              {(close) => (
                <div className="appearance-menu__list" role="listbox" aria-label={t('Accent color')}>
                  {ACCENT_PRESETS.map((preset) => {
                    const isCustomRow = preset.value === CUSTOM_THEME_ID
                    const selected = isCustomRow
                      ? !matchedAccentPreset
                      : matchedAccentPreset?.value === preset.value
                    return (
                      <MenuRow
                        key={preset.value}
                        label={t(preset.label)}
                        selected={selected}
                        swatch={<AccentSwatch color={isCustomRow ? effectiveAccent : preset.value} />}
                        onPick={() => {
                          if (!isCustomRow) {
                            void updateSettings({
                              accentColor: preset.value,
                              themePreset: CUSTOM_THEME_ID
                            })
                          }
                          close()
                        }}
                      />
                    )
                  })}
                </div>
              )}
            </Popover>
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
            <Popover
              align="right"
              width={220}
              className="appearance-menu"
              renderTrigger={({ open, toggle }) => (
                <button
                  type="button"
                  className="appearance-select-pill"
                  aria-label={t('Tone')}
                  aria-haspopup="listbox"
                  aria-expanded={open}
                  onClick={toggle}
                >
                  <span>{t(matchedTone?.label ?? 'Default')}</span>
                  <ChevronDown size={13} className="appearance-select-pill__chevron" />
                </button>
              )}
            >
              {(close) => (
                <div className="appearance-menu__list" role="listbox" aria-label={t('Tone')}>
                  {TONE_PRESETS.map((tone) => (
                    <MenuRow
                      key={tone.id}
                      label={t(tone.label)}
                      selected={tone.id === toneValue}
                      onPick={() => {
                        void updateSettings({ themeTone: tone.id })
                        close()
                      }}
                    />
                  ))}
                </div>
              )}
            </Popover>
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

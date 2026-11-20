import type { ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { useAppStore } from '../../store/useAppStore'
import { Popover } from '../Popover'
import { Switch } from '../Switch'
// The picker's own sheet ships with the component: SettingsSelect is also used
// outside the settings dialog, which is a separate lazy chunk.
import '../../styles/appearance.css'

export interface SettingsSelectOption {
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
export function SettingsSelect({
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

export function PageIntro({ title, description }: { title: string; description: string }) {
  return (
    <header className="settings-page-head">
      <h3>{title}</h3>
      <p>{description}</p>
    </header>
  )
}

export function SettingsGroup({
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

export function ProjectSafetySettings() {
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

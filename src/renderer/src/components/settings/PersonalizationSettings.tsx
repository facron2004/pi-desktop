import { useT } from '../../lib/i18n'
import { PageIntro, SettingsGroup } from './SettingsShared'

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

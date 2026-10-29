import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Cpu,
  Gauge,
  Info,
  Palette,
  PanelsTopLeft,
  Puzzle,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  X
} from 'lucide-react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import {
  AboutSettings,
  AppearanceSettings,
  GeneralSettings,
  PanelsSettings,
  PersonalizationSettings,
  PluginsSettings,
  ProjectSafetySettings,
  UsageSettings
} from './SettingsSections'
import { ModelsSettings } from './models/ModelsSettings'

export type SettingsPage =
  | 'general'
  | 'models'
  | 'appearance'
  | 'usage'
  | 'plugins'
  | 'personalization'
  | 'panels'
  | 'project-safety'
  | 'about'

const PAGES = [
  { id: 'general', label: 'General', Icon: SlidersHorizontal },
  { id: 'models', label: 'Model management', Icon: Cpu },
  { id: 'appearance', label: 'Appearance', Icon: Palette },
  { id: 'usage', label: 'Usage', Icon: Gauge },
  { id: 'plugins', label: 'Plugins', Icon: Puzzle },
  { id: 'personalization', label: 'Personalization', Icon: UserRound },
  { id: 'panels', label: 'Panels', Icon: PanelsTopLeft },
  { id: 'project-safety', label: 'Project safety', Icon: ShieldCheck },
  { id: 'about', label: 'About', Icon: Info }
] as const

export function SettingsDialog({
  onClose,
  initialPage = 'general'
}: {
  onClose: () => void
  initialPage?: SettingsPage
}) {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)

  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [customInstructions, setCustomInstructions] = useState(settings.customInstructions ?? '')

  useEffect(() => {
    setPage(initialPage)
  }, [initialPage])

  useEffect(() => {
    setCustomInstructions(settings.customInstructions ?? '')
  }, [settings.customInstructions])

  const hasDraftChanges =
    (customInstructions.trim() || undefined) !==
      (settings.customInstructions?.trim() || undefined)
  const draftPage = page === 'personalization'

  const save = async () => {
    await updateSettings({
      customInstructions: customInstructions.trim() || undefined
    })
    showToast(t('Settings saved'))
  }

  return (
    <div className="modal-layer no-drag" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="settings-title" className="modal__title">{t('Settings')}</h2>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t('Close')}
            title={t('Close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t('Settings sections')}>
            {PAGES.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                data-active={page === id}
                aria-current={page === id ? 'page' : undefined}
                onClick={() => setPage(id)}
              >
                <Icon size={15} />
                <span>{t(label)}</span>
              </button>
            ))}
          </nav>

          <main className="settings-content">
            {page === 'general' ? <GeneralSettings /> : null}
            {page === 'models' ? <ModelsSettings /> : null}
            {page === 'appearance' ? <AppearanceSettings /> : null}
            {page === 'usage' ? <UsageSettings /> : null}
            {page === 'plugins' ? <PluginsSettings onClose={onClose} /> : null}
            {page === 'personalization' ? (
              <PersonalizationSettings
                value={customInstructions}
                onChange={setCustomInstructions}
              />
            ) : null}
            {page === 'panels' ? <PanelsSettings /> : null}
            {page === 'project-safety' ? <ProjectSafetySettings /> : null}
            {page === 'about' ? <AboutSettings /> : null}
          </main>
        </div>

        <div className="modal__foot">
          <span className="settings-save-hint">
            {t(
              hasDraftChanges
                ? 'You have unsaved changes'
                : draftPage
                  ? 'Save to apply your changes'
                  : page === 'models'
                    ? 'Edit a provider and save to apply changes'
                    : page === 'about'
                      ? 'Version and runtime information'
                      : 'Changes are saved automatically'
            )}
          </span>
          {draftPage || hasDraftChanges ? (
            <button
              type="button"
              className="btn btn--primary"
              disabled={!hasDraftChanges}
              onClick={() => void save()}
            >
              <Check size={13} />
              {t('Save')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

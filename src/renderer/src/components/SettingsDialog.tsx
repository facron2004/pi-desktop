import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Info,
  Palette,
  PanelsTopLeft,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  X
} from 'lucide-react'
import type { AuthStatus } from '@shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import {
  AboutSettings,
  AppearanceSettings,
  GeneralSettings,
  PanelsSettings,
  PersonalizationSettings,
  ProjectSafetySettings
} from './SettingsSections'

type SettingsPage =
  | 'general'
  | 'personalization'
  | 'appearance'
  | 'panels'
  | 'project-safety'
  | 'about'

const PAGES = [
  { id: 'general', label: 'General', Icon: SlidersHorizontal },
  { id: 'personalization', label: 'Personalization', Icon: UserRound },
  { id: 'appearance', label: 'Appearance', Icon: Palette },
  { id: 'panels', label: 'Panels', Icon: PanelsTopLeft },
  { id: 'project-safety', label: 'Project safety', Icon: ShieldCheck },
  { id: 'about', label: 'About', Icon: Info }
] as const

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const settings = useAppStore((state) => state.settings)
  const models = useAppStore((state) => state.models)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const showToast = useAppStore((state) => state.showToast)
  const pickWorkspace = useAppStore((state) => state.pickWorkspace)
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)

  const [page, setPage] = useState<SettingsPage>('general')
  const [piPath, setPiPath] = useState(settings.piPath ?? '')
  const [provider, setProvider] = useState(settings.provider ?? '')
  const [defaultModel, setDefaultModel] = useState(settings.model ?? '')
  const [defaultThinking, setDefaultThinking] = useState(settings.thinkingLevel ?? '')
  const [customInstructions, setCustomInstructions] = useState(settings.customInstructions ?? '')
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    setPiPath(settings.piPath ?? '')
    setDefaultModel(settings.model ?? '')
    setDefaultThinking(settings.thinkingLevel ?? '')
    setCustomInstructions(settings.customInstructions ?? '')
  }, [settings.piPath, settings.model, settings.thinkingLevel, settings.customInstructions])

  const save = async () => {
    const selectedModel = models.find(
      (model) =>
        defaultModel === model.id || defaultModel === `${model.provider}/${model.id}`
    )
    await updateSettings({
      piPath: piPath.trim() || undefined,
      provider: provider.trim() || undefined,
      model: selectedModel
        ? `${selectedModel.provider}/${selectedModel.id}`
        : defaultModel.trim() || undefined,
      thinkingLevel: defaultThinking || undefined,
      customInstructions: customInstructions.trim() || undefined
    })
    showToast(t('Settings saved'))
  }

  const check = async () => {
    if (!provider.trim()) {
      showToast(t('Enter a provider first, e.g. anthropic'))
      return
    }
    setChecking(true)
    try {
      const result = await window.pi.auth.check(provider.trim())
      setAuth(result)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="modal-layer" onMouseDown={onClose}>
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
          <button className="icon-btn" onClick={onClose} aria-label={t('Close')}>
            <X size={15} />
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
            {page === 'general' ? (
              <GeneralSettings
                form={{
                  piPath,
                  provider,
                  defaultModel,
                  defaultThinking
                }}
                onChange={(patch) => {
                  if ('piPath' in patch) setPiPath(patch.piPath ?? '')
                  if ('provider' in patch) setProvider(patch.provider ?? '')
                  if ('defaultModel' in patch) setDefaultModel(patch.defaultModel ?? '')
                  if ('defaultThinking' in patch) setDefaultThinking(patch.defaultThinking ?? '')
                }}
                auth={auth}
                checking={checking}
                onCheck={() => void check()}
                onOpenProject={() => void pickWorkspace()}
                onResetPiPath={() => {
                  setPiPath('')
                  void updateSettings({ piPath: undefined })
                }}
              />
            ) : null}
            {page === 'personalization' ? (
              <PersonalizationSettings
                value={customInstructions}
                onChange={setCustomInstructions}
              />
            ) : null}
            {page === 'appearance' ? <AppearanceSettings /> : null}
            {page === 'panels' ? <PanelsSettings /> : null}
            {page === 'project-safety' ? <ProjectSafetySettings /> : null}
            {page === 'about' ? <AboutSettings /> : null}
          </main>
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={onClose}>
            {t('Close')}
          </button>
          <button className="btn btn--primary" onClick={() => void save()}>
            <Check size={13} />
            {t('Save')}
          </button>
        </div>
      </div>
    </div>
  )
}

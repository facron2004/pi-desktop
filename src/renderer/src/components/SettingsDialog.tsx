import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  Brain,
  Cpu,
  Gauge,
  Info,
  Keyboard,
  Palette,
  SlidersHorizontal,
  Smartphone,
  UserRound,
  X
} from 'lucide-react'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import {
  AboutSettings,
  AgentSettings,
  AppearanceSettings,
  GeneralSettings,
  PersonalizationSettings,
  ShortcutsSettings,
  UsageSettings
} from './SettingsSections'
import { MemorySettings } from './MemorySettings'
import { ModelsSettings } from './models/ModelsSettings'
import { RemoteAccessSettings } from './RemoteAccessSettings'

export type SettingsPage =
  | 'general'
  | 'agent'
  | 'models'
  | 'appearance'
  | 'usage'
  | 'shortcuts'
  | 'personalization'
  | 'remote'
  | 'memory'
  | 'about'

const PAGES = [
  { id: 'general', label: 'General', Icon: SlidersHorizontal },
  { id: 'agent', label: 'Agent and conversation', Icon: Bot },
  { id: 'models', label: 'Model management', Icon: Cpu },
  { id: 'appearance', label: 'Appearance', Icon: Palette },
  { id: 'usage', label: 'Usage', Icon: Gauge },
  { id: 'shortcuts', label: 'Keyboard shortcuts', Icon: Keyboard },
  { id: 'personalization', label: 'Personalization', Icon: UserRound },
  { id: 'remote', label: 'Remote access', Icon: Smartphone },
  { id: 'memory', label: 'Memory', Icon: Brain },
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
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  // Opening the dialog should not land on the close icon and paint a ring on
  // a control the user did not touch; the container receives focus instead.
  useDialogFocus(dialogRef, onClose, { initialFocus: 'dialog' })

  const [page, setPage] = useState<SettingsPage>(initialPage)
  const [customInstructions, setCustomInstructions] = useState(settings.customInstructions ?? '')
  const customInstructionsRef = useRef(customInstructions)
  customInstructionsRef.current = customInstructions
  const savedInstructionsRef = useRef(settings.customInstructions ?? '')

  useEffect(() => {
    setPage(initialPage)
  }, [initialPage])

  useEffect(() => {
    const next = settings.customInstructions ?? ''
    const previous = savedInstructionsRef.current
    savedInstructionsRef.current = next
    // Do not overwrite a newer draft when an earlier autosave lands.
    setCustomInstructions((current) => (current === previous ? next : current))
  }, [settings.customInstructions])

  // Other settings save immediately; personalization is the one draft field.
  // Keep it automatic too, and flush on close so closing the dialog mid-typing
  // cannot lose the last characters.
  useEffect(() => {
    const value = customInstructions.trim() || undefined
    const saved = settings.customInstructions?.trim() || undefined
    if (value === saved) return
    const timer = window.setTimeout(() => {
      void updateSettings({ customInstructions: value })
    }, 400)
    return () => window.clearTimeout(timer)
  }, [customInstructions, settings.customInstructions, updateSettings])

  useEffect(
    () => () => {
      const value = customInstructionsRef.current.trim() || undefined
      const saved = savedInstructionsRef.current.trim() || undefined
      if (value !== saved) void updateSettings({ customInstructions: value })
    },
    [updateSettings]
  )

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
            {page === 'agent' ? <AgentSettings /> : null}
            {page === 'models' ? <ModelsSettings /> : null}
            {page === 'appearance' ? <AppearanceSettings /> : null}
            {page === 'usage' ? <UsageSettings /> : null}
            {page === 'shortcuts' ? <ShortcutsSettings /> : null}
            {page === 'personalization' ? (
              <PersonalizationSettings
                value={customInstructions}
                onChange={setCustomInstructions}
              />
            ) : null}
            {page === 'remote' ? <RemoteAccessSettings /> : null}
            {page === 'memory' ? <MemorySettings /> : null}
            {page === 'about' ? <AboutSettings /> : null}
          </main>
        </div>

      </div>
    </div>
  )
}

import { RotateCcw } from 'lucide-react'
import { useT } from '../../lib/i18n'
import { hasAnyCustomShortcut } from '../../lib/shortcuts'
import { useAppStore } from '../../store/useAppStore'
import { ShortcutsList } from '../ShortcutsList'

/** The shortcut table as a settings page. `Ctrl+/` opens the same list in a
 *  modal; both render `ShortcutsList`, so they can never show two different
 *  tables. Only the settings page lets chords be edited, added or removed. */
export function ShortcutsSettings() {
  const t = useT()
  const bindings = useAppStore((state) => state.settings.shortcutBindings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const hasCustom = hasAnyCustomShortcut(bindings)

  return (
    <div className="settings-page shortcuts-page">
      <header className="shortcuts-page__head">
        <div>
          <h3>{t('Keyboard shortcuts')}</h3>
          <p>{t('Keyboard shortcuts for quick navigation and control.')}</p>
        </div>
        {hasCustom ? (
          <button
            type="button"
            className="shortcuts-reset-all"
            onClick={() => void updateSettings({ shortcutBindings: {} }, { shortcutBindings: bindings })}
          >
            <RotateCcw size={13} />
            <span>{t('Reset all')}</span>
          </button>
        ) : null}
      </header>
      <ShortcutsList editable />
    </div>
  )
}

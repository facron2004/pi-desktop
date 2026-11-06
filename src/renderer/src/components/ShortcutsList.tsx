import { useAppStore } from '../store/useAppStore'
import { SHORTCUTS, formatPlatformShortcut } from '../lib/shortcuts'
import { useT } from '../lib/i18n'

/**
 * The shortcut table on its own, so the modal and the settings page show the
 * same list without either of them owning a second copy.
 */
export function ShortcutsList() {
  const t = useT()
  const platform = useAppStore((state) => state.info?.platform)
  const groups = Array.from(new Set(SHORTCUTS.map((entry) => entry.group)))

  return (
    <div className="shortcuts-list">
      {groups.map((group) => (
        <section className="shortcut-group" key={group}>
          <h3 className="shortcut-group__title">{t(group)}</h3>
          {SHORTCUTS.filter((entry) => entry.group === group).map((entry) => (
            <div className="shortcut" key={entry.label}>
              <span className="shortcut__label">{t(entry.label)}</span>
              <span className="shortcut__keys">
                {entry.keys.map((key, index) => (
                  <span className="shortcut__key" key={key}>
                    {index > 0 && entry.keySeparator === 'or' ? (
                      <span className="shortcut__key-separator">{t('or')}</span>
                    ) : null}
                    <kbd>{formatPlatformShortcut(key, platform)}</kbd>
                  </span>
                ))}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

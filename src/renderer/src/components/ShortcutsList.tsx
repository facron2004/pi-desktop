import { RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  SHORTCUTS,
  activeKeys,
  chordFromEvent,
  conflictingShortcut,
  formatPlatformShortcut,
  isModifierKey,
  type ShortcutId
} from '../lib/shortcuts'
import { useT } from '../lib/i18n'

/**
 * The shortcut table on its own, so the modal and the settings page show the
 * same list without either of them owning a second copy. The settings page
 * turns each app chord into a button that records a new one; the modal stays
 * a reference.
 */
export function ShortcutsList({ editable = false }: { editable?: boolean }) {
  const t = useT()
  const platform = useAppStore((state) => state.info?.platform)
  const bindings = useAppStore((state) => state.settings.shortcutBindings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const groups = Array.from(new Set(SHORTCUTS.map((entry) => entry.group)))
  const [recording, setRecording] = useState<ShortcutId | null>(null)
  const [error, setError] = useState<{ id: ShortcutId; text: string } | null>(null)

  const bind = (id: ShortcutId, chord: string[]) => {
    void updateSettings({ shortcutBindings: { ...(bindings ?? {}), [id]: chord } })
  }

  const reset = (id: ShortcutId) => {
    const next = { ...(bindings ?? {}) }
    delete next[id]
    void updateSettings({ shortcutBindings: next })
  }

  // While a row is recording it owns the keyboard: capture phase, so the app's
  // own handler and the dialog's focus trap never see the chord being typed.
  useEffect(() => {
    if (!recording) return
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setRecording(null)
        setError(null)
        return
      }
      if (isModifierKey(event.key)) return
      if (event.key === 'Backspace' || event.key === 'Delete') {
        reset(recording)
        setRecording(null)
        setError(null)
        return
      }
      const chord = chordFromEvent(event)
      if (!chord) return
      if (!chord.includes('Ctrl') && !chord.includes('Alt')) {
        setError({ id: recording, text: t('Include Ctrl or Alt') })
        return
      }
      const conflict = conflictingShortcut(recording, chord, bindings)
      if (conflict) {
        setError({
          id: recording,
          text: `${t('Already used by')} ${t(conflict.label)}`
        })
        return
      }
      bind(recording, chord)
      setRecording(null)
      setError(null)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  })

  return (
    <div className="shortcuts-list">
      {groups.map((group) => (
        <section className="shortcut-group" key={group}>
          <h3 className="shortcut-group__title">{t(group)}</h3>
          {SHORTCUTS.filter((entry) => entry.group === group).map((entry) => {
            const id = entry.id
            const keys = activeKeys(entry, bindings)
            const custom = Boolean(id && bindings?.[id])
            const recordingThis = Boolean(id && recording === id)
            const keycaps = keys.map((key, index) => (
              <span className="shortcut__key" key={`${key}-${index}`}>
                {index > 0 ? (
                  <span
                    className={
                      entry.keySeparator === 'or' ? 'shortcut__key-separator' : 'shortcut__plus'
                    }
                    aria-hidden="true"
                  >
                    {entry.keySeparator === 'or' ? t('or') : '+'}
                  </span>
                ) : null}
                <kbd>{formatPlatformShortcut(key, platform)}</kbd>
              </span>
            ))

            return (
              <div className="shortcut" key={`${group}-${entry.label}`}>
                <span className="shortcut__label">{t(entry.label)}</span>
                <span className="shortcut__control">
                  {id && custom && !recordingThis ? (
                    <button
                      type="button"
                      className="icon-btn shortcut__reset"
                      title={t('Reset to default')}
                      aria-label={`${t('Reset to default')}: ${t(entry.label)}`}
                      onClick={() => reset(id)}
                    >
                      <RotateCcw size={12} />
                    </button>
                  ) : null}
                  {id && editable ? (
                    <button
                      type="button"
                      className="shortcut__keys shortcut__keys--editable"
                      data-recording={recordingThis || undefined}
                      title={t('Change shortcut')}
                      aria-label={`${t('Change shortcut')}: ${t(entry.label)}`}
                      onClick={() => {
                        setRecording(recordingThis ? null : id)
                        setError(null)
                      }}
                    >
                      {recordingThis ? (
                        <span
                          className="shortcut__recording"
                          data-error={error?.id === id || undefined}
                        >
                          {error?.id === id ? error.text : t('Press a shortcut…')}
                        </span>
                      ) : (
                        keycaps
                      )}
                    </button>
                  ) : (
                    <span className="shortcut__keys">{keycaps}</span>
                  )}
                </span>
              </div>
            )
          })}
        </section>
      ))}
    </div>
  )
}

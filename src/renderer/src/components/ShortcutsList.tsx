import { Plus, RotateCcw, Search, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import {
  activeChords,
  chordFromEvent,
  conflictingShortcut,
  entriesForDisplay,
  formatChord,
  formatPlatformShortcut,
  heldModifiersFromEvent,
  isCustomizedShortcut,
  isModifierKey,
  matchesShortcutSearch,
  sameChord,
  serializeChords,
  type ShortcutChord,
  type ShortcutEntry,
  type ShortcutId
} from '../lib/shortcuts'
import { useT } from '../lib/i18n'
import '../styles/shortcuts.css'

type RecordingTarget =
  | { id: ShortcutId; mode: 'replace'; slotIndex: number }
  | { id: ShortcutId; mode: 'add' }

/**
 * The shortcut table on its own, so the modal and the settings page show the
 * same searchable grouped cards without either of them owning a second copy.
 * The settings page lets each app action edit, add, remove, or reset chords;
 * the modal stays a searchable reference.
 */
export function ShortcutsList({
  editable = false,
  searchable = true
}: {
  editable?: boolean
  searchable?: boolean
}) {
  const t = useT()
  const platform = useAppStore((state) => state.info?.platform)
  const bindings = useAppStore((state) => state.settings.shortcutBindings)
  const sendShortcut = useAppStore((state) => state.settings.sendShortcut ?? 'enter')
  const updateSettings = useAppStore((state) => state.updateSettings)

  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<RecordingTarget | null>(null)
  const [heldModifiers, setHeldModifiers] = useState<string[]>([])
  const [error, setError] = useState<{ id: ShortcutId; text: string } | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const entries = useMemo(() => entriesForDisplay(sendShortcut), [sendShortcut])

  const filteredEntries = useMemo(
    () =>
      entries.filter((entry) =>
        matchesShortcutSearch(entry, query, bindings, t, platform)
      ),
    [bindings, entries, platform, query, t]
  )

  const groups = useMemo(
    () => Array.from(new Set(filteredEntries.map((entry) => entry.group))),
    [filteredEntries]
  )

  const cancelRecording = useCallback(() => {
    setRecording(null)
    setHeldModifiers([])
    setError(null)
  }, [])

  const saveChords = useCallback(
    (entry: ShortcutEntry, chords: ShortcutChord[]) => {
      if (!entry.id) return
      const next = { ...(bindings ?? {}) }
      const serialized = serializeChords(entry, chords)
      if (serialized === undefined) delete next[entry.id]
      else next[entry.id] = serialized
      void updateSettings({ shortcutBindings: next })
    },
    [bindings, updateSettings]
  )

  const resetRow = useCallback(
    (id: ShortcutId) => {
      if (recording?.id === id) cancelRecording()
      const next = { ...(bindings ?? {}) }
      delete next[id]
      void updateSettings({ shortcutBindings: next })
    },
    [bindings, cancelRecording, recording?.id, updateSettings]
  )

  const removeChord = useCallback(
    (entry: ShortcutEntry, slotIndex: number) => {
      if (!entry.id) return
      if (recording?.id === entry.id) cancelRecording()
      const current = activeChords(entry, bindings)
      const next = current.filter((_, index) => index !== slotIndex)
      saveChords(entry, next)
    },
    [bindings, cancelRecording, recording?.id, saveChords]
  )

  const startReplace = (id: ShortcutId, slotIndex: number) => {
    if (
      recording?.id === id &&
      recording.mode === 'replace' &&
      recording.slotIndex === slotIndex
    ) {
      cancelRecording()
      return
    }
    setRecording({ id, mode: 'replace', slotIndex })
    setHeldModifiers([])
    setError(null)
  }

  const startAdd = (id: ShortcutId) => {
    if (recording?.id === id && recording.mode === 'add') {
      cancelRecording()
      return
    }
    setRecording({ id, mode: 'add' })
    setHeldModifiers([])
    setError(null)
  }

  // While a binding slot is recording it owns the keyboard on window capture,
  // ahead of the dialog focus trap and global shortcuts.
  useEffect(() => {
    if (!recording) return
    const targetEntry = entries.find((item) => item.id === recording.id)
    if (!targetEntry) {
      cancelRecording()
      return
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey
      ) {
        event.preventDefault()
        event.stopPropagation()
        cancelRecording()
        return
      }
      if (event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      event.stopPropagation()

      if (isModifierKey(event.key)) {
        setHeldModifiers(heldModifiersFromEvent(event))
        setError(null)
        return
      }

      const chord = chordFromEvent(event)
      if (!chord) return
      setHeldModifiers([])

      if (!chord.includes('Ctrl') && !chord.includes('Alt')) {
        setError({ id: recording.id, text: t('Include Ctrl or Alt') })
        return
      }

      const currentChords = activeChords(targetEntry, bindings)
      const duplicateSelf = currentChords.some((existing, index) => {
        if (recording.mode === 'replace' && index === recording.slotIndex) return false
        return sameChord(existing, chord)
      })
      if (duplicateSelf) {
        setError({ id: recording.id, text: t('Already added') })
        return
      }

      const conflict = conflictingShortcut(recording.id, chord, bindings)
      if (conflict) {
        setError({
          id: recording.id,
          text: `${t('Already used by')} ${t(conflict.label)}`
        })
        return
      }

      const nextChords =
        recording.mode === 'add'
          ? [...currentChords, chord]
          : currentChords.map((item, index) => (index === recording.slotIndex ? chord : item))
      saveChords(targetEntry, nextChords)
      cancelRecording()
    }

    const onKeyUp = (event: KeyboardEvent) => {
      if (isModifierKey(event.key)) {
        setHeldModifiers(heldModifiersFromEvent(event))
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('[data-recording-line="true"]')) return
      cancelRecording()
    }

    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('blur', cancelRecording)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('blur', cancelRecording)
    }
  }, [bindings, cancelRecording, entries, recording, saveChords, t])

  const recordingText =
    heldModifiers.length > 0
      ? `${heldModifiers.map((key) => formatPlatformShortcut(key, platform)).join(' + ')} + …`
      : t('Press keys…')

  return (
    <div className="shortcuts-view">
      {searchable ? (
        <div className="shortcuts-search">
          <Search size={15} className="shortcuts-search__icon" aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault()
                event.stopPropagation()
                setQuery('')
              }
            }}
            placeholder={t('Search shortcuts...')}
            aria-label={t('Search shortcuts...')}
          />
          {query ? (
            <button
              type="button"
              className="shortcuts-search__clear"
              onClick={() => {
                setQuery('')
                searchRef.current?.focus()
              }}
              aria-label={t('Clear search')}
              title={t('Clear search')}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      ) : null}

      {groups.length === 0 ? (
        <div className="shortcuts-empty" role="status">
          <span>{t('No shortcuts match')}</span>
          <button
            type="button"
            className="shortcuts-empty__clear"
            onClick={() => {
              setQuery('')
              searchRef.current?.focus()
            }}
          >
            {t('Clear search')}
          </button>
        </div>
      ) : (
        <div className="shortcuts-list">
          {groups.map((group) => {
            const groupEntries = filteredEntries.filter((entry) => entry.group === group)
            const groupHasEditable = editable && groupEntries.some((entry) => Boolean(entry.id))

            return (
              <section className="shortcuts-group" key={group}>
                <h4 className="shortcuts-group__title">{t(group)}</h4>
                <div className="shortcuts-card">
                  {groupEntries.map((entry) => {
                    const id = entry.id
                    const canEdit = Boolean(editable && id)
                    const chords = id ? activeChords(entry, bindings) : [entry.keys]
                    const customized = canEdit && isCustomizedShortcut(entry, bindings)
                    const isRecordingThis = Boolean(id && recording?.id === id)
                    const isAddingThis = Boolean(isRecordingThis && recording?.mode === 'add')

                    return (
                      <div className="shortcut-row" key={`${group}-${entry.label}`}>
                        <span className="shortcut-row__label">{t(entry.label)}</span>

                        {canEdit && id ? (
                          <div className="shortcut-row__controls">
                            {customized ? (
                              <button
                                type="button"
                                className="shortcut-icon-btn shortcut-icon-btn--reset"
                                title={t('Reset to default')}
                                aria-label={`${t('Reset to default')}: ${t(entry.label)}`}
                                onClick={() => resetRow(id)}
                              >
                                <RotateCcw size={13} />
                              </button>
                            ) : null}

                            <div className="shortcut-row__bindings">
                              {chords.map((chord, slotIndex) => {
                                const replacing =
                                  isRecordingThis &&
                                  recording?.mode === 'replace' &&
                                  recording.slotIndex === slotIndex
                                const hasError = replacing && error?.id === id
                                const chordText = formatChord(chord, platform)

                                return (
                                  <div
                                    className="shortcut-binding-line"
                                    key={`${chord.join('+')}-${slotIndex}`}
                                    data-recording-line={replacing || undefined}
                                  >
                                    <button
                                      type="button"
                                      className="shortcut-pill shortcut-pill--editable"
                                      data-recording={replacing || undefined}
                                      data-error={hasError || undefined}
                                      title={t('Change shortcut')}
                                      aria-label={`${t('Change shortcut')}: ${t(entry.label)} (${chordText})`}
                                      onClick={() => startReplace(id, slotIndex)}
                                    >
                                      {replacing ? (
                                        <span className="shortcut-pill__prompt">
                                          {recordingText}
                                        </span>
                                      ) : (
                                        <kbd>{chordText}</kbd>
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      className="shortcut-icon-btn shortcut-icon-btn--remove"
                                      title={t('Remove shortcut')}
                                      aria-label={`${t('Remove shortcut')}: ${t(entry.label)} (${chordText})`}
                                      onClick={() => removeChord(entry, slotIndex)}
                                    >
                                      <Trash2 size={13} />
                                    </button>
                                  </div>
                                )
                              })}

                              {isAddingThis ? (
                                <div className="shortcut-binding-line" data-recording-line="true">
                                  <button
                                    type="button"
                                    className="shortcut-pill shortcut-pill--editable"
                                    data-recording="true"
                                    data-error={error?.id === id || undefined}
                                    aria-label={`${t('Add shortcut')}: ${t(entry.label)}`}
                                    onClick={cancelRecording}
                                  >
                                    <span className="shortcut-pill__prompt">{recordingText}</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="shortcut-icon-btn"
                                    title={t('Cancel')}
                                    aria-label={t('Cancel')}
                                    onClick={cancelRecording}
                                  >
                                    <X size={13} />
                                  </button>
                                </div>
                              ) : null}

                              {chords.length === 0 && !isAddingThis ? (
                                <button
                                  type="button"
                                  className="shortcut-pill shortcut-pill--add-empty"
                                  onClick={() => startAdd(id)}
                                >
                                  <Plus size={12} />
                                  <span>{t('Add shortcut')}</span>
                                </button>
                              ) : null}

                              {isRecordingThis ? (
                                <div
                                  className="shortcut-row__feedback"
                                  data-error={error?.id === id || undefined}
                                  role={error?.id === id ? 'alert' : undefined}
                                >
                                  {error?.id === id ? error.text : t('Esc to cancel')}
                                </div>
                              ) : null}
                            </div>

                            <div className="shortcut-row__add-slot">
                              {chords.length > 0 && !isAddingThis ? (
                                <button
                                  type="button"
                                  className="shortcut-icon-btn shortcut-icon-btn--add"
                                  title={t('Add shortcut')}
                                  aria-label={`${t('Add shortcut')}: ${t(entry.label)}`}
                                  onClick={() => startAdd(id)}
                                >
                                  <Plus size={14} />
                                </button>
                              ) : null}
                            </div>
                          </div>
                        ) : entry.keySeparator === 'or' ? (
                          <div className="shortcut-row__static">
                            {entry.keys.map((key, index) => (
                              <span className="shortcut-row__or-group" key={`${key}-${index}`}>
                                {index > 0 ? (
                                  <span className="shortcut-row__or">{t('or')}</span>
                                ) : null}
                                <span className="shortcut-pill shortcut-pill--static">
                                  <kbd>{formatPlatformShortcut(key, platform)}</kbd>
                                </span>
                              </span>
                            ))}
                          </div>
                        ) : chords.length === 0 ? (
                          <span className="shortcut-row__unbound">{t('Not set')}</span>
                        ) : groupHasEditable ? (
                          <div className="shortcut-row__controls">
                            <div className="shortcut-row__bindings">
                              {chords.map((chord, index) => (
                                <div
                                  className="shortcut-binding-line"
                                  key={`${chord.join('+')}-${index}`}
                                >
                                  <span className="shortcut-pill shortcut-pill--static">
                                    <kbd>{formatChord(chord, platform)}</kbd>
                                  </span>
                                  <span className="shortcut-icon-spacer" aria-hidden="true" />
                                </div>
                              ))}
                            </div>
                            <div className="shortcut-row__add-slot" aria-hidden="true" />
                          </div>
                        ) : (
                          <div className="shortcut-row__bindings">
                            {chords.map((chord, index) => (
                              <span
                                className="shortcut-pill shortcut-pill--static"
                                key={`${chord.join('+')}-${index}`}
                              >
                                <kbd>{formatChord(chord, platform)}</kbd>
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

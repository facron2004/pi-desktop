import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, MessageSquareText, TriangleAlert } from 'lucide-react'
import { useAppStore } from '../store/useAppStore'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'

/**
 * Modal for the blocking half of Pi's extension UI sub-protocol.
 *
 * `select`, `confirm`, `input` and `editor` pause the agent until the user
 * answers, so the dialog stays open until a response is on its way.
 */
export function ExtensionDialog() {
  const request = useAppStore((state) => state.uiRequest)
  const respondUi = useAppStore((state) => state.respondUi)
  const dismissUi = useAppStore((state) => state.dismissUi)
  const t = useT()

  const [value, setValue] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null)
  const optionsRef = useRef<HTMLDivElement>(null)
  const declineRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, () => void dismissUi(), Boolean(request))

  useEffect(() => {
    if (!request) return
    setValue(request.method === 'editor' ? (request.prefill ?? '') : '')
    setSelected(request.options?.length ? request.options[0] : null)
    requestAnimationFrame(() => {
      if (request.method === 'select') {
        optionsRef.current?.focus()
        return
      }
      if (request.method === 'confirm') {
        // A confirmation is often about something destructive, so the safe
        // answer is the one that has the focus.
        declineRef.current?.focus()
        return
      }
      inputRef.current?.focus()
    })
  }, [request])

  // Pi resolves the request on its own once the timeout expires, so the
  // countdown has to run in the client too.
  useEffect(() => {
    if (!request?.timeout) {
      setRemaining(null)
      return
    }
    const deadline = Date.now() + request.timeout
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setRemaining(left)
    }
    tick()
    const timer = window.setInterval(tick, 500)
    return () => window.clearInterval(timer)
  }, [request])

  const timeoutNote = useMemo(() => {
    if (!request?.timeout) return null
    if (remaining === null) return t('Pi resolves this on its own')
    return remaining > 0
      ? `${t('Pi resolves this on its own in')} ${remaining} ${t('seconds')}`
      : t('Pi is resolving this on its own')
  }, [request, remaining, t])

  if (!request) return null

  const title = t(request.title ?? 'Pi is asking for input')
  const selectedIndex = (request.options ?? []).indexOf(selected ?? '')

  const submit = () => {
    if (request.method === 'select') {
      if (selected) void respondUi({ value: selected })
      return
    }
    if (request.method === 'confirm') {
      void respondUi({ confirmed: true })
      return
    }
    void respondUi({ value })
  }

  return (
    <div className="modal-layer" onMouseDown={() => void dismissUi()}>
      <div
        ref={dialogRef}
        className="modal modal--prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal__head modal__head--prompt">
          <span className="modal__icon" data-kind={request.method}>
            {request.method === 'confirm' ? (
              <TriangleAlert size={15} />
            ) : (
              <MessageSquareText size={15} />
            )}
          </span>
          <div className="modal__headings">
            <h2 id="extension-dialog-title" className="modal__title">{title}</h2>
            {request.message ? (
              <p id="extension-dialog-message" className="modal__message">
                {request.message}
              </p>
            ) : null}
          </div>
        </header>

        {request.method === 'select' ? (
          <div
            className="modal__options"
            role="listbox"
            aria-label={title}
            aria-activedescendant={selectedIndex >= 0 ? `extension-option-${selectedIndex}` : undefined}
            tabIndex={0}
            ref={optionsRef}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              const options = request.options ?? []
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const index = options.indexOf(selected ?? '')
                const next =
                  event.key === 'ArrowDown'
                    ? Math.min(options.length - 1, index + 1)
                    : Math.max(0, index - 1)
                setSelected(options[next])
                return
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
          >
            {(request.options ?? []).map((option, index) => (
              <button
                key={option}
                id={`extension-option-${index}`}
                role="option"
                aria-selected={selected === option}
                className="modal__option"
                data-active={selected === option}
                onClick={() => setSelected(option)}
                onDoubleClick={() => void respondUi({ value: option })}
              >
                <span className="modal__option-mark">
                  {selected === option ? <Check size={11} /> : null}
                </span>
                {option}
              </button>
            ))}
          </div>
        ) : null}

        {request.method === 'input' ? (
          <input
            ref={inputRef as React.RefObject<HTMLInputElement>}
            className="input modal__input"
            value={value}
            placeholder={request.placeholder}
            aria-labelledby="extension-dialog-title"
            aria-describedby={request.message ? 'extension-dialog-message' : undefined}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Enter') {
                event.preventDefault()
                submit()
              }
            }}
          />
        ) : null}

        {request.method === 'editor' ? (
          <textarea
            ref={inputRef as React.RefObject<HTMLTextAreaElement>}
            className="modal__editor"
            rows={10}
            value={value}
            placeholder={request.placeholder}
            aria-labelledby="extension-dialog-title"
            aria-describedby={request.message ? 'extension-dialog-message' : undefined}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : null}

        <footer className="modal__foot">
          <span className="modal__note">{timeoutNote ?? ''}</span>
          <button className="btn" onClick={() => void dismissUi()}>
            {t('Cancel')}
          </button>
          {request.method === 'confirm' ? (
            <>
              <button
                ref={declineRef}
                className="btn"
                onClick={() => void respondUi({ confirmed: false })}
              >
                {t('No')}
              </button>
              <button className="btn btn--primary" onClick={submit}>
                {t('Yes')}
              </button>
            </>
          ) : (
            <button
              className="btn btn--primary"
              onClick={submit}
              disabled={request.method === 'select' && !selected}
            >
              {t('Send')}
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

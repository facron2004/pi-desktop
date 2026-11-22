import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Check, ListChecks, MessageSquareText, TriangleAlert } from 'lucide-react'
import { PLAN_REVIEW_TITLE } from '@shared/types'
import { draftKeyOf, useAppStore, type SessionThread } from '../store/useAppStore'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { activeConversationTitle, listPendingUiSessions } from '../lib/live-sessions'
import { basename } from '../lib/path'
import { Markdown } from './Markdown'
import { findSessionMeta } from './RunStatusRow'

function pendingUiSignature(threads: Readonly<Record<string, SessionThread>>): string {
  let sig = ''
  for (const key in threads) {
    const thread = threads[key]
    const count = thread.uiRequests?.length || (thread.uiRequest ? 1 : 0)
    if (count > 0) sig += `${key}:${thread.uiRequests?.[0]?.id ?? thread.uiRequest?.id ?? ''}:${count}|`
  }
  return sig
}

/**
 * Modal for the blocking half of Pi's extension UI sub-protocol.
 *
 * `select`, `confirm`, `input` and `editor` pause the agent until the user
 * answers, so the dialog stays open until a response is on its way.
 */
export function ExtensionDialog() {
  const activeUiRequest = useAppStore((state) => state.uiRequest)
  const activeKey = useAppStore((state) => draftKeyOf(state))
  const pendingSig = useAppStore((state) => pendingUiSignature(state.threads))
  const respondUi = useAppStore((state) => state.respondUi)
  const dismissUi = useAppStore((state) => state.dismissUi)
  const selectSession = useAppStore((state) => state.selectSession)
  const activeTitle = useAppStore((state) =>
    activeConversationTitle(state.sessions, state.threads, state.activeSessionFile ?? state.draftId)
  )
  const t = useT()

  const pendingSessions = useMemo(() => {
    if (!pendingSig) return []
    const state = useAppStore.getState()
    return listPendingUiSessions(state.threads, state.sessions)
  }, [pendingSig])

  const [selectedSessionKey, setSelectedSessionKey] = useState<string | null>(null)
  const activeSessionPending = activeKey
    ? pendingSessions.find((entry) => entry.sessionKey === activeKey)
    : undefined
  const selectedPending =
    (selectedSessionKey
      ? pendingSessions.find((entry) => entry.sessionKey === selectedSessionKey)
      : undefined) ??
    activeSessionPending ??
    pendingSessions[0]

  // Only show the modal when the active conversation is blocked (or while
  // cycling inside an already-open modal across pending sessions).
  const request = activeUiRequest
    ? (selectedPending?.request ?? activeUiRequest)
    : undefined
  const targetSessionKey = selectedPending?.sessionKey || activeKey
  const targetPendingCount =
    selectedPending?.count ?? (activeUiRequest ? 1 : 0)
  const totalPendingCount = pendingSessions.reduce((sum, entry) => sum + entry.count, 0)

  const [value, setValue] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [remaining, setRemaining] = useState<number | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null)
  const optionsRef = useRef<HTMLDivElement>(null)
  const declineRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const planRef = useRef<HTMLDivElement>(null)
  const planReview = request?.method === 'confirm' && request.title === PLAN_REVIEW_TITLE

  const uiTarget = targetSessionKey
    ? { sessionKey: targetSessionKey, requestId: request?.id }
    : request?.id
      ? { requestId: request.id }
      : undefined

  const keepPlanning = async (cancelled = false) => {
    await respondUi(cancelled ? { cancelled: true } : { confirmed: false }, uiTarget)
    requestAnimationFrame(() => {
      const current = useAppStore.getState()
      if (targetSessionKey && draftKeyOf(current) === targetSessionKey && !current.uiRequest) {
        window.dispatchEvent(new CustomEvent('pi:focus-composer'))
      }
    })
  }

  useDialogFocus(dialogRef, () => {
    if (planReview) void keepPlanning(true)
    else void dismissUi(uiTarget)
  }, Boolean(request))

  useEffect(() => {
    if (!activeUiRequest) {
      setSelectedSessionKey(null)
    } else if (selectedSessionKey && !pendingSessions.some((entry) => entry.sessionKey === selectedSessionKey)) {
      setSelectedSessionKey(null)
    }
  }, [activeUiRequest, selectedSessionKey, pendingSessions])

  useEffect(() => {
    if (!request) return
    setValue(request.method === 'editor' ? (request.prefill ?? '') : '')
    setSelected(request.options?.length ? request.options[0] : null)
    const frame = requestAnimationFrame(() => {
      if (planReview && planRef.current) {
        planRef.current.focus({ preventScroll: true })
        return
      }
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
    return () => cancelAnimationFrame(frame)
  }, [request?.id, request?.method, request?.prefill, request?.options, planReview])

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
  }, [request?.id, request?.timeout])

  const timeoutNote = useMemo(() => {
    if (!request?.timeout) return null
    if (remaining === null) return t('Pi resolves this on its own')
    return remaining > 0
      ? `${t('Pi resolves this on its own in')} ${remaining} ${t('seconds')}`
      : t('Pi is resolving this on its own')
  }, [request?.timeout, remaining, t])

  if (!request) return null

  const title = t(request.title ?? 'Pi is asking for input')
  const selectedIndex = (request.options ?? []).indexOf(selected ?? '')
  const originLabel =
    selectedPending?.title ||
    (targetSessionKey === activeKey ? activeTitle : undefined) ||
    (selectedPending?.cwd ? basename(selectedPending.cwd) : undefined) ||
    (request.approval?.cwd ? basename(request.approval.cwd) : undefined) ||
    t('Untitled session')
  const isOtherSession = Boolean(targetSessionKey && targetSessionKey !== activeKey)

  const jumpToSession = () => {
    if (!targetSessionKey) return
    const state = useAppStore.getState()
    const meta = findSessionMeta(
      targetSessionKey,
      state.sessions,
      state.threads,
      selectedPending?.cwd ?? request.approval?.cwd
    )
    if (meta) void selectSession(meta, 'extension-dialog-jump')
  }

  const submit = () => {
    if (request.method === 'select') {
      if (selected) void respondUi({ value: selected }, uiTarget)
      return
    }
    if (request.method === 'confirm') {
      void respondUi({ confirmed: true }, uiTarget)
      return
    }
    void respondUi({ value }, uiTarget)
  }

  return (
    <div className="modal-layer">
      <div
        ref={dialogRef}
        className={planReview ? 'modal modal--prompt modal--plan-review' : 'modal modal--prompt'}
        role="dialog"
        aria-modal="true"
        aria-labelledby="extension-dialog-title"
        aria-describedby={planReview ? 'extension-dialog-plan-note' : undefined}
      >
        <div className="modal__context">
          <span className="modal__context-session" title={selectedPending?.cwd || originLabel}>
            {originLabel}
          </span>
          {totalPendingCount > 1 || targetPendingCount > 1 ? (
            <span className="modal__context-count">
              {pendingSessions.length > 1
                ? `${pendingSessions.length} ${t('sessions waiting')}`
                : `${targetPendingCount} ${t('pending')}`}
            </span>
          ) : null}
          {isOtherSession ? (
            <button
              type="button"
              className="modal__context-jump"
              onClick={jumpToSession}
            >
              <span>{t('Go to conversation')}</span>
              <ArrowUpRight size={12} />
            </button>
          ) : null}
        </div>
        {pendingSessions.length > 1 ? (
          <div className="modal__switcher" role="tablist" aria-label={t('Conversations waiting for input')}>
            {pendingSessions.map((entry) => {
              const label =
                entry.title ||
                (entry.cwd ? basename(entry.cwd) : '') ||
                t('Untitled session')
              const active = entry.sessionKey === targetSessionKey
              return (
                <button
                  key={entry.sessionKey}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className="modal__switcher-tab"
                  data-active={active}
                  title={entry.cwd ? `${label} · ${entry.cwd}` : label}
                  onClick={() => setSelectedSessionKey(entry.sessionKey)}
                >
                  <span className="modal__switcher-name">{label}</span>
                  {entry.count > 1 ? <span className="modal__switcher-badge">{entry.count}</span> : null}
                </button>
              )
            })}
          </div>
        ) : null}
        <header className="modal__head modal__head--prompt">
          <span className="modal__icon" data-kind={planReview ? 'plan-review' : request.method}>
            {planReview ? (
              <ListChecks size={16} />
            ) : request.method === 'confirm' ? (
              <TriangleAlert size={15} />
            ) : (
              <MessageSquareText size={15} />
            )}
          </span>
          <div className="modal__headings">
            <h2 id="extension-dialog-title" className="modal__title">{title}</h2>
            {planReview ? (
              <p id="extension-dialog-plan-note" className="modal__message">
                {t('Approval restores the working tools for this conversation.')}
              </p>
            ) : request.message ? (
              <p
                id="extension-dialog-message"
                className="modal__message"
                data-long={request.message.length > 600 ? 'true' : undefined}
              >
                {request.approval ? t(request.message) : request.message}
              </p>
            ) : null}
          </div>
        </header>

        {planReview && request.message ? (
          <div
            key={request.id}
            ref={planRef}
            className="modal__plan"
            role="region"
            aria-label={t('Implementation plan')}
            tabIndex={0}
          >
            <Markdown>{request.message}</Markdown>
          </div>
        ) : null}

        {request.approval ? (
          <div className="modal__approval">
            <strong>{request.approval.toolName}</strong>
            {request.approval.toolSource !== 'builtin' ? (
              <div className="modal__approval-cwd">
                <span>{t('Tool source')}</span>
                <code>{request.approval.toolSource || t('Unverified')}</code>
              </div>
            ) : null}
            {request.approval.cwd ? (
              <div className="modal__approval-cwd">
                <span>{t('Working directory')}</span>
                <code>{request.approval.cwd}</code>
              </div>
            ) : null}
            <pre>{JSON.stringify(request.approval.input, null, 2)}</pre>
          </div>
        ) : null}

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
                onDoubleClick={() => void respondUi({ value: option }, uiTarget)}
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
          {planReview ? null : (
            <button className="btn" onClick={() => void dismissUi(uiTarget)}>
              {t('Cancel')}
            </button>
          )}
          {request.method === 'confirm' ? (
            <>
              <button
                ref={declineRef}
                className="btn"
                onClick={() => {
                  if (planReview) void keepPlanning()
                  else void respondUi({ confirmed: false }, uiTarget)
                }}
              >
                {t(planReview ? 'Keep planning' : request.approval ? 'Deny' : 'No')}
              </button>
              <button className="btn btn--primary" onClick={submit}>
                {t(planReview ? 'Start implementation' : request.approval ? 'Approve' : 'Yes')}
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronRight, Copy, GitBranch, GitCommit, RefreshCw } from 'lucide-react'
import type { GitCommit as GitCommitEntry, GitFileStatus } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { formatRelativeTime } from '../lib/format'
import { useT } from '../lib/i18n'
import '../styles/commit-history.css'

/** How many commits the dialog reads back from HEAD. */
const HISTORY_LIMIT = 20

/** The conventional prefixes offered above the message box. */
const TEMPLATES = ['feat', 'fix', 'docs', 'refactor', 'test', 'chore'] as const
type Template = (typeof TEMPLATES)[number]

/** A draft survives a failed or cancelled commit, not a successful one. */
const DRAFT_KEY = 'pi-desktop.commit-draft'

function readDraft(): string {
  try {
    return localStorage.getItem(DRAFT_KEY) ?? ''
  } catch {
    // A private window or a full quota; the dialog works without remembering.
    return ''
  }
}

function writeDraft(value: string): void {
  try {
    if (value) localStorage.setItem(DRAFT_KEY, value)
    else localStorage.removeItem(DRAFT_KEY)
  } catch {
    // Nothing to do: the message on screen is still the one that gets committed.
  }
}

/**
 * Review the working tree and commit it.
 *
 * The line counts and the file list come from git rather than from the
 * conversation, so a change the user made by hand is committed along with the
 * ones Pi made — which is what "commit everything" means.
 */
export function CommitDialog({ onClose }: { onClose: () => void }) {
  const git = useAppStore((state) => state.git)
  const commitChanges = useAppStore((state) => state.commitChanges)
  const refreshGit = useAppStore((state) => state.refreshGit)
  const showToast = useAppStore((state) => state.showToast)
  const language = useAppStore((state) => state.settings.language)
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)

  const [message, setMessage] = useState(readDraft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  // `null` means "the default for this index": staged files only when there
  // is something staged, everything otherwise.
  const [includeUnstaged, setIncludeUnstaged] = useState<boolean | null>(null)
  // Replacing the message with a commit subject is destructive, so the old
  // text is kept until the user types again.
  const [undoMessage, setUndoMessage] = useState<string>()
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const [historyOpen, setHistoryOpen] = useState(true)
  const [commits, setCommits] = useState<GitCommitEntry[]>()
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState(false)
  const [copiedHash, setCopiedHash] = useState<string>()
  const historyRequest = useRef(0)
  const copyTimer = useRef<number | null>(null)

  const loadHistory = useCallback(async () => {
    const request = ++historyRequest.current
    setHistoryLoading(true)
    setHistoryError(false)
    try {
      const list = await window.pi.git.log(HISTORY_LIMIT)
      if (request !== historyRequest.current) return
      setCommits(list)
    } catch {
      if (request !== historyRequest.current) return
      setCommits(undefined)
      setHistoryError(true)
    } finally {
      if (request === historyRequest.current) setHistoryLoading(false)
    }
  }, [])

  // The panel may have been opened before the working tree was read.
  useEffect(() => {
    void refreshGit()
  }, [refreshGit])

  // The dialog closes after a commit, so the next open reads the new HEAD.
  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    writeDraft(message)
  }, [message])

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [])

  // The template chips sit before the message in the DOM, so the focus trap
  // would land on a chip; the message is what the dialog is for.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [])

  const files = git?.files ?? []
  const totals = useMemo(
    () =>
      files.reduce(
        (acc, file) => ({ added: acc.added + (file.added ?? 0), removed: acc.removed + (file.removed ?? 0) }),
        { added: 0, removed: 0 }
      ),
    [files]
  )

  const activeTemplate = useMemo<Template | undefined>(
    () => TEMPLATES.find((tag) => message.startsWith(`${tag}: `)),
    [message]
  )

  /** Put `next` in the box and leave the caret at its end. */
  const setMessageAtEnd = (next: string) => {
    setMessage(next)
    requestAnimationFrame(() => {
      const input = inputRef.current
      if (!input) return
      input.focus()
      input.setSelectionRange(next.length, next.length)
    })
  }

  const replaceMessage = (next: string) => {
    setUndoMessage(undefined)
    setMessageAtEnd(next)
  }

  const applyTemplate = (tag: Template) => {
    const prefix = `${tag}: `
    if (activeTemplate === tag) {
      replaceMessage(message.slice(prefix.length))
      return
    }
    // Swap one prefix for another without touching the body of the message.
    const body = activeTemplate ? message.slice(activeTemplate.length + 2) : message
    replaceMessage(`${prefix}${body}`)
  }

  const pickCommit = (commit: GitCommitEntry) => {
    setUndoMessage(message.trim() ? message : undefined)
    setMessageAtEnd(commit.subject)
  }

  const copyHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash)
      setCopiedHash(hash)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopiedHash(undefined), 1400)
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }

  const stagedCount = git?.staged ?? 0
  const unstagedCount = git?.unstaged ?? 0
  const includeAll = includeUnstaged ?? stagedCount === 0

  const canCommit =
    Boolean(git?.isRepo) &&
    files.length > 0 &&
    message.trim().length > 0 &&
    !busy &&
    // Committing what is staged is the default; with nothing staged the
    // toggle has to be on, or the commit would have an empty index.
    (includeAll || stagedCount > 0)

  const submit = async () => {
    if (!canCommit) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await commitChanges(message.trim(), includeAll)
      if (result.ok) {
        writeDraft('')
        onClose()
      } else {
        // A failed commit keeps the message and the list exactly as they are.
        setError(result.error ?? t('The commit failed'))
      }
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t('The commit failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal modal--commit"
        role="dialog"
        aria-modal="true"
        aria-labelledby="commit-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="commit-title" className="modal__title">
            {t('Commit changes')}
          </h2>
          {git?.branch ? (
            <span className="commit__branch" title={t('The branch the commit lands on')}>
              <GitBranch size={12} />
              {git.branch}
            </span>
          ) : null}
        </div>

        <div className="modal__body commit">
          {!git?.isRepo ? (
            <p className="commit__empty">{t('This folder is not a git repository.')}</p>
          ) : null}

          {git?.isRepo && files.length === 0 ? (
            <p className="commit__empty">{t('The working tree is clean.')}</p>
          ) : null}

          {files.length > 0 ? (
            <>
              <div className="commit__summary">
                <span>
                  {files.length} {files.length === 1 ? t('file') : t('files')}
                </span>
                {totals.added ? <span data-kind="add">+{totals.added}</span> : null}
                {totals.removed ? <span data-kind="del">−{totals.removed}</span> : null}
              </div>

              <div className="commit__mode">
                <label className="commit__mode-toggle">
                  <input
                    type="checkbox"
                    checked={includeAll}
                    onChange={(event) => setIncludeUnstaged(event.target.checked)}
                  />
                  <span>{t('Include unstaged changes')}</span>
                </label>
                <span className="commit__mode-counts">
                  {stagedCount} {t('staged')} · {unstagedCount} {t('unstaged')}
                </span>
              </div>
              <p className="commit__mode-hint">
                {includeAll
                  ? t('Everything in the working tree is committed.')
                  : t('Only staged files are committed; the rest stays in the working tree.')}
                {!includeAll && stagedCount === 0 ? ` ${t('Nothing is staged yet.')}` : null}
              </p>

              <ul className="commit__files" aria-label={t('Files in this commit')}>
                {files.map((file) => (
                  <li key={file.path} className="commit__file">
                    <span className="commit__status" data-kind={statusOf(file).kind}>
                      {statusOf(file).label}
                    </span>
                    <span className="commit__path" title={file.path}>
                      {file.path}
                    </span>
                    {file.staged ? (
                      <span className="commit__staged">{t('staged')}</span>
                    ) : null}
                    {file.added || file.removed ? (
                      <span className="commit__stats">
                        {file.added ? <span data-kind="add">+{file.added}</span> : null}
                        {file.removed ? <span data-kind="del">−{file.removed}</span> : null}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>

              <div className="commit__label-row">
                <label className="commit__label" htmlFor="commit-message">
                  {t('Commit message')}
                </label>
                {undoMessage !== undefined ? (
                  <button
                    type="button"
                    className="commit__undo"
                    onClick={() => replaceMessage(undoMessage)}
                  >
                    {t('Undo')}
                  </button>
                ) : null}
              </div>

              <div className="commit__templates" role="group" aria-label={t('Commit message templates')}>
                {TEMPLATES.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className="commit__template"
                    data-active={activeTemplate === tag ? 'true' : undefined}
                    aria-pressed={activeTemplate === tag}
                    onClick={() => applyTemplate(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>

              <textarea
                id="commit-message"
                ref={inputRef}
                className="commit__input"
                rows={3}
                autoFocus
                value={message}
                placeholder={t('What changed, and why?')}
                onChange={(event) => {
                  setUndoMessage(undefined)
                  setMessage(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    void submit()
                  }
                }}
              />

              {error ? <p className="commit__error">{error}</p> : null}

              <section className="commit__history" aria-label={t('Recent commits')}>
                <div className="commit__history-head">
                  <button
                    type="button"
                    className="commit__history-toggle"
                    aria-expanded={historyOpen}
                    aria-controls="commit-history"
                    onClick={() => setHistoryOpen((open) => !open)}
                  >
                    <ChevronRight
                      size={12}
                      className="commit__history-chevron"
                      data-open={historyOpen ? 'true' : undefined}
                    />
                    <span>{t('Recent commits')}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn commit__history-refresh"
                    disabled={historyLoading}
                    title={t('Refresh recent commits')}
                    aria-label={t('Refresh recent commits')}
                    onClick={() => void loadHistory()}
                  >
                    <RefreshCw size={12} className={historyLoading ? 'spin' : undefined} />
                  </button>
                </div>

                <div id="commit-history" hidden={!historyOpen}>
                  {historyError ? (
                    <p className="commit__history-state">{t('The recent commits could not be read.')}</p>
                  ) : !commits ? (
                    <p className="commit__history-state">{t('Reading recent commits…')}</p>
                  ) : commits.length === 0 ? (
                    <p className="commit__history-state">{t('This repository has no commits yet.')}</p>
                  ) : (
                    <ul className="commit__history-list">
                      {commits.map((commit) => (
                        <li key={commit.hash} className="commit__history-row">
                          <button
                            type="button"
                            className="commit__history-pick"
                            title={t('Use this commit message')}
                            aria-label={`${t('Use this commit message')}: ${commit.subject}`}
                            onClick={() => pickCommit(commit)}
                          >
                            <span className="commit__history-hash">{commit.hash.slice(0, 7)}</span>
                            <span className="commit__history-subject">{commit.subject}</span>
                            <span className="commit__history-meta">
                              {commit.author ? (
                                <span className="commit__history-author" title={commit.author}>
                                  {commit.author}
                                </span>
                              ) : null}
                              {commit.date ? (
                                <span>{formatRelativeTime(commit.date, language)}</span>
                              ) : null}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="commit__history-copy"
                            title={copiedHash === commit.hash ? t('Copied') : t('Copy the hash')}
                            aria-label={copiedHash === commit.hash ? t('Copied') : t('Copy the hash')}
                            data-copied={copiedHash === commit.hash ? 'true' : undefined}
                            onClick={() => void copyHash(commit.hash)}
                          >
                            {copiedHash === commit.hash ? <Check size={11} /> : <Copy size={11} />}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </section>
            </>
          ) : null}
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button className="btn btn--primary" disabled={!canCommit} onClick={() => void submit()}>
            <GitCommit size={13} />
            {busy ? t('Committing…') : t('Commit')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** The single letter git itself shows, and the tone it is drawn in. */
function statusOf(file: GitFileStatus): { label: string; kind: 'add' | 'del' | 'edit' | 'rename' } {
  if (file.untracked) return { label: 'A', kind: 'add' }
  if (file.index === 'D' || file.worktree === 'D') return { label: 'D', kind: 'del' }
  if (file.index === 'R' || file.worktree === 'R') return { label: 'R', kind: 'rename' }
  if (file.index === 'A') return { label: 'A', kind: 'add' }
  return { label: 'M', kind: 'edit' }
}

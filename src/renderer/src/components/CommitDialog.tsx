import { useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, GitCommit } from 'lucide-react'
import type { GitFileStatus } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'

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
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)

  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  // The panel may have been opened before the working tree was read.
  useEffect(() => {
    void refreshGit()
  }, [refreshGit])

  const files = git?.files ?? []
  const totals = useMemo(
    () =>
      files.reduce(
        (acc, file) => ({ added: acc.added + (file.added ?? 0), removed: acc.removed + (file.removed ?? 0) }),
        { added: 0, removed: 0 }
      ),
    [files]
  )

  const canCommit = Boolean(git?.isRepo) && files.length > 0 && message.trim().length > 0 && !busy

  const submit = async () => {
    if (!canCommit) return
    setBusy(true)
    setError(undefined)
    const result = await commitChanges(message.trim())
    setBusy(false)
    if (result.ok) onClose()
    else setError(result.error ?? t('The commit failed'))
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

              <ul className="commit__files" aria-label={t('Files in this commit')}>
                {files.map((file) => (
                  <li key={file.path} className="commit__file">
                    <span className="commit__status" data-kind={statusOf(file).kind}>
                      {statusOf(file).label}
                    </span>
                    <span className="commit__path" title={file.path}>
                      {file.path}
                    </span>
                    {file.added || file.removed ? (
                      <span className="commit__stats">
                        {file.added ? <span data-kind="add">+{file.added}</span> : null}
                        {file.removed ? <span data-kind="del">−{file.removed}</span> : null}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>

              <label className="commit__label" htmlFor="commit-message">
                {t('Commit message')}
              </label>
              <textarea
                id="commit-message"
                className="commit__input"
                rows={3}
                autoFocus
                value={message}
                placeholder={t('What changed, and why?')}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault()
                    void submit()
                  }
                }}
              />

              {error ? <p className="commit__error">{error}</p> : null}
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

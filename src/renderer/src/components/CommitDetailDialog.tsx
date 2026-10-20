import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronRight, ClipboardCopy, RefreshCw, X } from 'lucide-react'
import type { GitCommitDetail, GitCommitFile, GitCommitFileDiff } from '@shared/types'
import { buildDiff } from '../lib/diff-fold'
import { formatRelativeTime } from '../lib/format'
import { useAppStore } from '../store/useAppStore'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import { DiffView } from './DiffView'
import '../styles/commit-detail.css'

type LoadState = 'loading' | 'error' | 'ready'
type FileDiffState = GitCommitFileDiff | 'loading' | 'error'

/**
 * One commit, read-only: its message, the files it touched and their diffs.
 *
 * The history list in the commit dialog is the way in; nothing here changes
 * the working tree or the index.
 */
export function CommitDetailDialog({ hash, onClose }: { hash: string; onClose: () => void }) {
  const t = useT()
  const language = useAppStore((state) => state.settings.language)
  const showToast = useAppStore((state) => state.showToast)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)

  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [open, setOpen] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, FileDiffState>>({})

  const load = useCallback(async () => {
    setState('loading')
    try {
      const data = await window.pi.git.commitDetail(hash)
      if (!data) {
        setState('error')
        return
      }
      setDetail(data)
      setState('ready')
    } catch {
      setState('error')
    }
  }, [hash])

  useEffect(() => {
    void load()
  }, [load])

  const expand = useCallback(
    async (file: GitCommitFile) => {
      if (open === file.path) {
        setOpen(null)
        return
      }
      setOpen(file.path)
      if (diffs[file.path]) return
      setDiffs((previous) => ({ ...previous, [file.path]: 'loading' }))
      try {
        const data = await window.pi.git.commitFileDiff(hash, file.path)
        setDiffs((previous) => ({ ...previous, [file.path]: data ?? 'error' }))
      } catch {
        setDiffs((previous) => ({ ...previous, [file.path]: 'error' }))
      }
    },
    [diffs, hash, open]
  )

  const totals = useMemo(
    () =>
      (detail?.files ?? []).reduce(
        (acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }),
        { added: 0, removed: 0 }
      ),
    [detail]
  )

  const copyPatch = useCallback(async () => {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail.patch)
      showToast(t('The patch was copied'))
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }, [detail, showToast, t])

  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal commit-detail"
        role="dialog"
        aria-modal="true"
        aria-labelledby="commit-detail-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <div className="commit-detail__titles">
            <h2 id="commit-detail-title" className="modal__title">
              {detail?.subject ?? t('Commit')}
            </h2>
            <span className="commit-detail__meta">
              {detail ? (
                <>
                  <span className="commit-detail__hash">{detail.hash.slice(0, 7)}</span>
                  <span>{detail.author}</span>
                  <span>{formatRelativeTime(detail.date, language)}</span>
                </>
              ) : (
                <span className="commit-detail__hash">{hash.slice(0, 7)}</span>
              )}
            </span>
          </div>
          <button
            className="icon-btn"
            onClick={() => void copyPatch()}
            title={t('Copy the patch')}
            disabled={!detail}
          >
            <ClipboardCopy size={13} />
          </button>
          <button className="icon-btn" onClick={() => void load()} title={t('Refresh')}>
            <RefreshCw size={13} className={state === 'loading' ? 'spin' : undefined} />
          </button>
          <button className="icon-btn" onClick={onClose} title={t('Close')}>
            <X size={15} />
          </button>
        </div>

        <div className="commit-detail__body">
          {state === 'loading' ? (
            <div className="commit-detail__state">
              <RefreshCw size={13} className="spin" />
              {t('Reading the commit…')}
            </div>
          ) : state === 'error' || !detail ? (
            <div className="commit-detail__state" data-tone="error">
              <AlertTriangle size={13} />
              {t('The commit could not be read.')}
            </div>
          ) : (
            <>
              {detail.body ? <pre className="commit-detail__message">{detail.body}</pre> : null}

              <div className="commit-detail__summary">
                <span>
                  {detail.files.length} {detail.files.length === 1 ? t('file') : t('files')}
                </span>
                {totals.added ? <span data-kind="add">+{totals.added}</span> : null}
                {totals.removed ? <span data-kind="del">−{totals.removed}</span> : null}
              </div>

              {detail.files.length === 0 ? (
                <div className="commit-detail__empty">{t('This commit does not change any files.')}</div>
              ) : (
                <ul className="commit-detail__files">
                  {detail.files.map((file) => {
                    const isOpen = open === file.path
                    const diff = diffs[file.path]
                    return (
                      <li key={file.path} className="commit-detail__file" data-open={isOpen || undefined}>
                        <button
                          className="commit-detail__toggle"
                          onClick={() => void expand(file)}
                          aria-expanded={isOpen}
                        >
                          <ChevronRight size={12} className="commit-detail__chevron" />
                          <span className="commit-detail__status" data-kind={statusKind(file.status)}>
                            {file.status}
                          </span>
                          <span
                            className="commit-detail__path"
                            title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                          >
                            {file.oldPath ? (
                              <>
                                <span className="commit-detail__old">{file.oldPath}</span>
                                <span className="commit-detail__arrow" aria-hidden="true">
                                  →
                                </span>
                              </>
                            ) : null}
                            {file.path}
                          </span>
                          <span className="commit-detail__stats">
                            {file.added ? <span data-kind="add">+{file.added}</span> : null}
                            {file.removed ? <span data-kind="del">−{file.removed}</span> : null}
                          </span>
                        </button>

                        {isOpen ? (
                          <div className="commit-detail__diff">
                            {!diff || diff === 'loading' ? (
                              <div className="commit-detail__state">
                                <RefreshCw size={12} className="spin" />
                                {t('Reading the changes…')}
                              </div>
                            ) : diff === 'error' ? (
                              <div className="commit-detail__state">
                                {t('Could not read the changes of this file.')}
                              </div>
                            ) : diff.binary ? (
                              <div className="commit-detail__state">{t('Binary file changed.')}</div>
                            ) : diff.truncated ? (
                              <div className="commit-detail__state">
                                {t('The file is too large to show in full.')}
                              </div>
                            ) : (
                              <DiffView diffs={[buildDiff(diff.oldText, diff.newText)]} />
                            )}
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}

              {detail.truncated ? (
                <p className="commit-detail__note">{t('The patch is too large to show in full.')}</p>
              ) : null}
            </>
          )}
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={onClose}>
            {t('Close')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Tone of the single letter a commit's file list shows. */
function statusKind(status: string): 'add' | 'del' | 'edit' | 'rename' {
  if (status === 'A') return 'add'
  if (status === 'D') return 'del'
  if (status === 'R' || status === 'C') return 'rename'
  return 'edit'
}

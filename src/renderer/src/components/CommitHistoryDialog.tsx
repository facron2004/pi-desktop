import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, RefreshCw, X } from 'lucide-react'
import type { GitCommit as GitCommitEntry } from '@shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { formatRelativeTime } from '../lib/format'
import { useT } from '../lib/i18n'
import { useAppStore } from '../store/useAppStore'
import { CommitDetailDialog } from './CommitDetailDialog'
import '../styles/commit-history.css'

/** How many commits the change-graph float reads back from HEAD. */
const HISTORY_LIMIT = 50

/**
 * Floating commit log opened from the task rail 「变更图谱」 action.
 * Read-only: lists `git log` and opens CommitDetailDialog for one hash.
 */
export function CommitHistoryDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const language = useAppStore((state) => state.settings.language)
  const git = useAppStore((state) => state.git)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)

  const [commits, setCommits] = useState<GitCommitEntry[]>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [copiedHash, setCopiedHash] = useState<string>()
  const [detailHash, setDetailHash] = useState<string | null>(null)
  const requestId = useRef(0)
  const copyTimer = useRef<number | null>(null)

  const loadHistory = useCallback(async () => {
    const request = ++requestId.current
    setLoading(true)
    setError(false)
    try {
      const list = await window.pi.git.log(HISTORY_LIMIT)
      if (request !== requestId.current) return
      setCommits(list)
    } catch {
      if (request !== requestId.current) return
      setError(true)
      setCommits(undefined)
    } finally {
      if (request === requestId.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    return () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    }
  }, [])

  const copyHash = async (hash: string) => {
    try {
      await navigator.clipboard.writeText(hash)
      setCopiedHash(hash)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopiedHash(undefined), 1200)
    } catch {
      /* clipboard may be denied; ignore */
    }
  }

  return (
    <>
      <div className="modal-layer" onMouseDown={onClose}>
        <div
          ref={dialogRef}
          className="modal modal--commit-history"
          role="dialog"
          aria-modal="true"
          aria-labelledby="commit-history-title"
          tabIndex={-1}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="modal__head">
            <h2 id="commit-history-title" className="modal__title">
              {t('Change graph')}
            </h2>
            <div className="commit-history-float__actions">
              <button
                type="button"
                className="icon-btn"
                disabled={loading}
                title={t('Refresh recent commits')}
                aria-label={t('Refresh recent commits')}
                onClick={() => void loadHistory()}
              >
                <RefreshCw size={14} className={loading ? 'spin' : undefined} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title={t('Close')}
                aria-label={t('Close')}
                onClick={onClose}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="modal__body commit-history-float">
            {!git?.isRepo ? (
              <p className="commit__history-state">{t('This folder is not a git repository.')}</p>
            ) : error ? (
              <p className="commit__history-state">{t('The recent commits could not be read.')}</p>
            ) : !commits ? (
              <p className="commit__history-state">{t('Reading recent commits…')}</p>
            ) : commits.length === 0 ? (
              <p className="commit__history-state">{t('This repository has no commits yet.')}</p>
            ) : (
              <ul className="commit__history-list commit-history-float__list">
                {commits.map((commit) => (
                  <li key={commit.hash} className="commit__history-row commit-history-float__row">
                    <button
                      type="button"
                      className="commit__history-pick commit-history-float__pick"
                      onClick={() => setDetailHash(commit.hash)}
                    >
                      <span className="commit__history-hash">{commit.hash.slice(0, 7)}</span>
                      <span className="commit__history-subject" title={commit.subject}>
                        {commit.subject}
                      </span>
                      <span className="commit-history-float__author" title={commit.author}>
                        {commit.author}
                      </span>
                      <span className="commit-history-float__date">
                        {formatRelativeTime(commit.date, language)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="commit__history-copy commit-history-float__copy"
                      data-copied={copiedHash === commit.hash || undefined}
                      title={copiedHash === commit.hash ? t('Copied') : t('Copy the hash')}
                      aria-label={copiedHash === commit.hash ? t('Copied') : t('Copy the hash')}
                      onClick={() => void copyHash(commit.hash)}
                    >
                      <Copy size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      {detailHash ? (
        <CommitDetailDialog hash={detailHash} onClose={() => setDetailHash(null)} />
      ) : null}
    </>
  )
}

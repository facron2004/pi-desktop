import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  ClipboardCopy,
  ClipboardList,
  Copy,
  CornerUpLeft,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
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

/** The file filter only earns its row when the list is long enough to scan. */
const FILTER_THRESHOLD = 6

/**
 * One commit, read-only: its message, the files it touched and their diffs.
 *
 * The history list in the commit dialog is the way in; nothing here changes
 * the working tree or the index. A commit opens its first parent, so a reader
 * can walk history here without going back to the list.
 */
export function CommitDetailDialog({ hash, onClose }: { hash: string; onClose: () => void }) {
  const t = useT()
  const language = useAppStore((state) => state.settings.language)
  const showToast = useAppStore((state) => state.showToast)
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)

  const [currentHash, setCurrentHash] = useState(hash)
  /** Commits this dialog walked away from, newest last. */
  const [backStack, setBackStack] = useState<string[]>([])
  const [detail, setDetail] = useState<GitCommitDetail | null>(null)
  const [state, setState] = useState<LoadState>('loading')
  const [open, setOpen] = useState<string | null>(null)
  const [diffs, setDiffs] = useState<Record<string, FileDiffState>>({})
  const [filter, setFilter] = useState('')
  /** Read the commit's side against the file on disk instead of its parent. */
  const [worktreeMode, setWorktreeMode] = useState(false)
  const requestRef = useRef(0)
  const hashRef = useRef(currentHash)
  hashRef.current = currentHash
  const worktreeRef = useRef(worktreeMode)
  worktreeRef.current = worktreeMode

  const load = useCallback(async (target: string) => {
    const request = ++requestRef.current
    setState('loading')
    try {
      const data = await window.pi.git.commitDetail(target)
      if (request !== requestRef.current) return
      setDetail(data ?? null)
      setState(data ? 'ready' : 'error')
    } catch {
      if (request !== requestRef.current) return
      setDetail(null)
      setState('error')
    }
  }, [])

  // The dialog may be reused for another commit; start that commit at the top.
  useEffect(() => {
    setCurrentHash(hash)
    setBackStack([])
  }, [hash])

  // A different commit gets fresh state: no old diff, no old fold, no filter.
  useEffect(() => {
    setDetail(null)
    setOpen(null)
    setDiffs({})
    setFilter('')
    void load(currentHash)
  }, [currentHash, load])

  const showCommit = (next: string) => {
    setDetail(null)
    setOpen(null)
    setDiffs({})
    setFilter('')
    setCurrentHash(next)
  }

  const goParent = () => {
    const parent = detail?.parentHash
    if (!parent) return
    setBackStack((previous) => [...previous, currentHash])
    showCommit(parent)
  }

  const goBack = () => {
    const previous = backStack[backStack.length - 1]
    if (previous === undefined) return
    showCommit(previous)
    setBackStack(backStack.slice(0, -1))
  }

  const loadFileDiff = useCallback(
    async (file: GitCommitFile, againstWorktree: boolean) => {
      const requestHash = currentHash
      setDiffs((previous) => ({ ...previous, [file.path]: 'loading' }))
      try {
        const data = againstWorktree
          ? await window.pi.git.commitWorktreeDiff(requestHash, file.path)
          : await window.pi.git.commitFileDiff(requestHash, file.path)
        // A response from another commit or another comparison mode belongs
        // to neither the list nor the cache it would land in.
        if (hashRef.current !== requestHash || worktreeRef.current !== againstWorktree) return
        setDiffs((previous) => ({ ...previous, [file.path]: data ?? 'error' }))
      } catch {
        if (hashRef.current !== requestHash || worktreeRef.current !== againstWorktree) return
        setDiffs((previous) => ({ ...previous, [file.path]: 'error' }))
      }
    },
    [currentHash]
  )

  const expand = useCallback(
    async (file: GitCommitFile) => {
      if (open === file.path) {
        setOpen(null)
        return
      }
      setOpen(file.path)
      if (diffs[file.path]) return
      await loadFileDiff(file, worktreeMode)
    },
    [diffs, loadFileDiff, open, worktreeMode]
  )

  // Switching the comparison drops every cached diff and reloads the file that
  // is on screen, so the row the reader is looking at changes sides with it.
  useEffect(() => {
    setDiffs({})
    if (!open) return
    const file = detail?.files.find((entry) => entry.path === open)
    if (file) void loadFileDiff(file, worktreeMode)
    // Only the mode change matters here; open/detail are read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worktreeMode])

  const copyHash = useCallback(async () => {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail.hash)
      showToast(t('Copied to clipboard'))
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }, [detail, showToast, t])

  const copyMessage = useCallback(async () => {
    if (!detail) return
    const body = detail.body.trim()
    const message = body ? `${detail.subject}\n\n${body}` : detail.subject
    try {
      await navigator.clipboard.writeText(message)
      showToast(t('Copied to clipboard'))
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }, [detail, showToast, t])

  const copyPatch = useCallback(async () => {
    if (!detail) return
    try {
      await navigator.clipboard.writeText(detail.patch)
      showToast(t('The patch was copied'))
    } catch {
      showToast(t('The clipboard is not available'), 'error')
    }
  }, [detail, showToast, t])

  const files = detail?.files ?? []

  const visibleFiles = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return files
    return files.filter((file) => file.path.toLowerCase().includes(needle))
  }, [files, filter])

  const totals = useMemo(
    () =>
      files.reduce(
        (acc, file) => ({ added: acc.added + file.added, removed: acc.removed + file.removed }),
        { added: 0, removed: 0 }
      ),
    [files]
  )

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
                  <span className="commit-detail__hash-group">
                    <span className="commit-detail__hash">{detail.hash.slice(0, 7)}</span>
                    <button
                      className="icon-btn commit-detail__copy-hash"
                      onClick={() => void copyHash()}
                      title={t('Copy the hash')}
                      aria-label={t('Copy the hash')}
                    >
                      <Copy size={11} />
                    </button>
                  </span>
                  <span>{detail.author}</span>
                  <span>{formatRelativeTime(detail.date, language)}</span>
                </>
              ) : (
                <span className="commit-detail__hash">{currentHash.slice(0, 7)}</span>
              )}
            </span>
          </div>

          <div className="commit-detail__actions">
            <button
              className="ghost-btn commit-detail__nav-btn"
              onClick={goBack}
              disabled={backStack.length === 0}
              title={t('Back')}
            >
              <CornerUpLeft size={12} />
              {t('Back')}
            </button>
            <button
              className="ghost-btn commit-detail__nav-btn"
              onClick={goParent}
              disabled={!detail?.parentHash}
              title={t('Parent commit')}
            >
              <ArrowLeft size={12} />
              {t('Parent commit')}
            </button>
            <button
              className="icon-btn"
              onClick={() => void copyMessage()}
              title={t('Copy commit message')}
              aria-label={t('Copy commit message')}
              disabled={!detail}
            >
              <ClipboardList size={13} />
            </button>
            <button
              className="icon-btn"
              onClick={() => void copyPatch()}
              title={t('Copy the patch')}
              aria-label={t('Copy the patch')}
              disabled={!detail}
            >
              <ClipboardCopy size={13} />
            </button>
            <button
              className="icon-btn"
              onClick={() => void load(currentHash)}
              title={t('Refresh')}
              aria-label={t('Refresh')}
            >
              <RefreshCw size={13} className={state === 'loading' ? 'spin' : undefined} />
            </button>
            <button className="icon-btn" onClick={onClose} title={t('Close')} aria-label={t('Close')}>
              <X size={15} />
            </button>
          </div>
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
                <div className="commit-detail__comparison">
                  <span>{t('Compare')}</span>
                  <div
                    className="segmented segmented--tight"
                    role="group"
                    aria-label={t('Diff comparison')}
                  >
                    <button
                      type="button"
                      data-active={!worktreeMode}
                      aria-label={t('Compare with the parent commit')}
                      aria-pressed={!worktreeMode}
                      title={t('Compare with the parent commit')}
                      onClick={() => setWorktreeMode(false)}
                    >
                      {t('Parent commit')}
                    </button>
                    <button
                      type="button"
                      data-active={worktreeMode}
                      aria-label={t('Compare with the current working tree')}
                      aria-pressed={worktreeMode}
                      title={t('Compare with the current working tree')}
                      onClick={() => setWorktreeMode(true)}
                    >
                      {t('Working tree')}
                    </button>
                  </div>
                </div>
              </div>

              {detail.files.length > FILTER_THRESHOLD ? (
                <div className="commit-detail__filter">
                  <Search size={12} />
                  <input
                    value={filter}
                    placeholder={t('Filter files')}
                    aria-label={t('Filter files')}
                    onChange={(event) => setFilter(event.target.value)}
                  />
                  {filter ? (
                    <button
                      className="icon-btn"
                      onClick={() => setFilter('')}
                      title={t('Clear the filter')}
                      aria-label={t('Clear the filter')}
                    >
                      <X size={11} />
                    </button>
                  ) : null}
                </div>
              ) : null}

              {detail.files.length === 0 ? (
                <div className="commit-detail__empty">{t('This commit does not change any files.')}</div>
              ) : visibleFiles.length === 0 ? (
                <div className="commit-detail__empty">{t('No file matches')}</div>
              ) : (
                <ul className="commit-detail__files">
                  {visibleFiles.map((file) => {
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

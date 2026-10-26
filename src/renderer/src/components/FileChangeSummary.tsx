import { memo, useMemo, useState } from 'react'
import { ChevronRight, FileDiff, FilePlus2, Pencil } from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import type { FileChange } from '../lib/changes'
import { diffStats } from '../lib/diff-fold'
import { basename } from '../lib/path'
import { useAppStore } from '../store/useAppStore'
import { DiffView } from './DiffView'
import { useT } from '../lib/i18n'

/**
 * What a turn changed, as one row per file.
 *
 * The row is the summary — path, how many times it was touched, how many
 * lines moved — and the diff is behind the caret. A file that was only
 * written shows its content rather than an invented diff: there is no "old
 * side" to compare against, and a made-up one would be a lie.
 */
export const FileChangeSummary = memo(function FileChangeSummary({
  changes,
  added,
  removed,
  onReview
}: {
  changes: FileChange[]
  added: number
  removed: number
  onReview: () => void
}) {
  const t = useT()
  const [open, setOpen] = useState<Record<string, boolean>>({})

  return (
    <div className="file-changes">
      <div className="file-changes__head">
        <span className="file-changes__icon">
          <FileDiff size={13} />
        </span>
        <span className="file-changes__count">
          {changes.length} {changes.length === 1 ? t('file changed') : t('files changed')}
        </span>
        {added > 0 || removed > 0 ? (
          <span className="file-changes__stats">
            {added > 0 ? <span className="file-changes__add">+{added}</span> : null}
            {removed > 0 ? <span className="file-changes__del">−{removed}</span> : null}
          </span>
        ) : null}
        <button type="button" className="ghost-btn file-changes__review" onClick={onReview}>
          {t('Review changes')}
        </button>
      </div>

      <div className="file-changes__list">
        {changes.map((change) => (
          <FileChangeRow
            key={change.path}
            change={change}
            open={open[change.path] ?? false}
            onToggle={() =>
              setOpen((current) => ({ ...current, [change.path]: !current[change.path] }))
            }
          />
        ))}
      </div>
    </div>
  )
})

function FileChangeRow({
  change,
  open,
  onToggle
}: {
  change: FileChange
  open: boolean
  onToggle: () => void
}) {
  const t = useT()
  const diffSplit = useAppStore((state) => state.settings.diffSplit === true)
  const Icon = change.kind === 'write' ? FilePlus2 : Pencil

  const stats = useMemo(() => {
    let added = 0
    let removed = 0
    for (const block of change.diffs) {
      const value = diffStats(block)
      added += value.added
      removed += value.removed
    }
    return { added, removed }
  }, [change.diffs])

  const openFile = () =>
    window.dispatchEvent(
      new CustomEvent<InspectorRequest>('pi:open-inspector', {
        detail: { tab: 'files', file: change.path }
      })
    )

  return (
    <div className="file-change" data-open={open} data-kind={change.kind}>
      <div className="file-change__head">
        <button
          type="button"
          className="file-change__main"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="file-change__icon">
            <Icon size={12} strokeWidth={2.2} />
          </span>
          <span className="file-change__name" title={change.path}>
            {basename(change.path)}
          </span>
          <span className="file-change__path">{change.path}</span>
          {change.edits > 1 ? (
            <span className="file-change__edits">
              {change.edits} {t('edits')}
            </span>
          ) : null}
          {stats.added > 0 || stats.removed > 0 ? (
            <span className="file-change__stats">
              {stats.added > 0 ? <span className="file-changes__add">+{stats.added}</span> : null}
              {stats.removed > 0 ? (
                <span className="file-changes__del">−{stats.removed}</span>
              ) : null}
            </span>
          ) : null}
          <span className="file-change__caret">
            <ChevronRight size={13} className="caret" data-open={open} />
          </span>
        </button>
        <button
          type="button"
          className="file-change__open"
          title={t('Open this file')}
          aria-label={t('Open this file')}
          onClick={openFile}
        >
          {t('Open')}
        </button>
      </div>

      {open ? (
        <div className="file-change__body">
          {change.diffs.length > 0 ? (
            <DiffView diffs={change.diffs} mode={diffSplit ? 'split' : 'unified'} />
          ) : change.content ? (
            // A file that was created or rewritten has no old side, so the
            // content is what the change is.
            <pre className="tool__pre">{change.content}</pre>
          ) : (
            <pre className="tool__pre">{t('This change has no diff to show.')}</pre>
          )}
        </div>
      ) : null}
    </div>
  )
}

import { useMemo } from 'react'
import { ChevronRight, FilePlus2, Pencil } from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import type { FileChange } from '../../lib/changes'
import { diffStats } from '../../lib/diff-fold'
import { basename } from '../../lib/path'
import { useAppStore } from '../../store/useAppStore'
import { DiffView } from '../DiffView'
import { LogOutput } from './LogOutput'
import { useT } from '../../lib/i18n'

/**
 * One changed file as a row that expands into its diff.
 *
 * A file that was only written shows its content rather than an invented
 * diff: there is no "old side" to compare against, and a made-up one would be
 * a lie. The content is line-paged like any other long output.
 */
export function FileChangeRow({
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
            <LogOutput text={change.content} />
          ) : (
            <pre className="tool__pre">{t('This change has no diff to show.')}</pre>
          )}
        </div>
      ) : null}
    </div>
  )
}

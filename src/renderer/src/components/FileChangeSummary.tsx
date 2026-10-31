import { memo, useState } from 'react'
import { FileDiff } from 'lucide-react'
import type { FileChange } from '../lib/changes'
import { useAppStore } from '../store/useAppStore'
import { readFileOpen, writeFileOpen } from '../lib/view-state'
import { useT } from '../lib/i18n'
import { FileChangeRow } from './conversation/FileChangeRow'

/**
 * What a turn changed, as one row per file.
 *
 * The row is the summary — path, how many times it was touched, how many
 * lines moved — and the diff is behind the caret. The leaf itself lives in
 * `conversation/FileChangeRow`; this container only supplies the header and
 * the open/closed map.
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
  const threadKey = useAppStore((state) => state.activeSessionFile ?? state.draftId ?? 'draft')
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(changes.map((change) => [change.path, readFileOpen(threadKey, change.path)]))
  )
  const toggle = (path: string) =>
    setOpen((current) => {
      const next = !current[path]
      writeFileOpen(threadKey, path, next)
      return { ...current, [path]: next }
    })

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
            onToggle={() => toggle(change.path)}
          />
        ))}
      </div>
    </div>
  )
})

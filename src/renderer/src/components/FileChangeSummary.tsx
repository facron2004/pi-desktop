import { memo, useRef, useState } from 'react'
import { ArrowUpRight, ChevronDown, FileDiff, Undo2 } from 'lucide-react'
import type { FileChange } from '../lib/changes'
import { useAppStore } from '../store/useAppStore'
import { relativePath } from '../lib/path'
import { useT } from '../lib/i18n'
import { ConfirmDialog } from './ConfirmDialog'
import { FileChangePreview, FileChangeRow, previewAnchor } from './conversation/FileChangeRow'

/**
 * What a turn changed, as one row per file.
 *
 * The row names the file and its line counts. Hovering floats the changed
 * lines; clicking opens the file in the side panel.
 */
export const FileChangeSummary = memo(function FileChangeSummary({
  changes,
  onReview
}: {
  changes: FileChange[]
  onReview: () => void
}) {
  const t = useT()
  const workspace = useAppStore((state) => state.workspace?.path)
  const refreshGit = useAppStore((state) => state.refreshGit)
  const showToast = useAppStore((state) => state.showToast)
  const [expanded, setExpanded] = useState(false)
  const [confirmUndo, setConfirmUndo] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [hovered, setHovered] = useState<FileChange | null>(null)
  const [anchor, setAnchor] = useState<ReturnType<typeof previewAnchor> | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const visibleChanges = expanded ? changes : changes.slice(0, 3)
  const hiddenCount = changes.length - visibleChanges.length

  const undo = async () => {
    setConfirmUndo(false)
    setUndoing(true)
    let restored = 0
    try {
      for (const change of changes) {
        const path = relativePath(workspace ?? '', change.path).replace(/\\/g, '/')
        const result = await window.pi.git.revertFile(path)
        if (result.ok) restored += 1
      }
      await refreshGit()
      if (restored > 0) showToast(t('The changes were reverted'))
      else showToast(t('The file could not be reverted'), 'error')
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div
      className="file-changes"
      onMouseLeave={(event) => {
        const next = event.relatedTarget
        if (next instanceof Node && previewRef.current?.contains(next)) return
        setHovered(null)
      }}
    >
      <div className="file-changes__head">
        <span className="file-changes__icon" aria-hidden="true">
          <FileDiff size={14} />
        </span>
        <div className="file-changes__titles">
          <span className="file-changes__count">
            {t(`Edited ${changes.length} ${changes.length === 1 ? 'file' : 'files'}`)}
          </span>
          <button type="button" className="file-changes__sublink" onClick={onReview}>
            {t('View changes')}
            <ArrowUpRight size={12} />
          </button>
        </div>
        <div className="file-changes__actions">
          <button
            type="button"
            className="file-changes__undo"
            onClick={() => setConfirmUndo(true)}
            disabled={undoing}
          >
            {t('Undo')}
            <Undo2 size={13} />
          </button>
          <button type="button" className="file-changes__review" onClick={onReview}>
            {t('View changes')}
          </button>
        </div>
      </div>

      <div className="file-changes__list">
        {visibleChanges.map((change) => (
          <FileChangeRow
            key={change.path}
            change={change}
            onHover={(next, row) => {
              setHovered(next)
              setAnchor(previewAnchor(row))
            }}
          />
        ))}
      </div>

      {changes.length > 3 ? (
        <button
          type="button"
          className="file-changes__more"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>
            {expanded
              ? t('Show fewer files')
              : t(`Show ${hiddenCount} more ${hiddenCount === 1 ? 'file' : 'files'}`)}
          </span>
          <ChevronDown size={13} className="file-changes__more-caret" data-open={expanded} />
        </button>
      ) : null}
      {hovered && anchor ? (
        <div
          ref={previewRef}
          className="file-change__preview"
          role="tooltip"
          style={{
            left: anchor.left,
            bottom: anchor.bottom,
            width: anchor.width,
            maxHeight: anchor.maxHeight
          }}
          onMouseLeave={() => setHovered(null)}
        >
          <FileChangePreview key={hovered.path} change={hovered} />
        </div>
      ) : null}
      {confirmUndo ? (
        <ConfirmDialog
          title={t('Undo these changes')}
          body={t('Discard the uncommitted changes in these files? A file that was never committed is left alone.')}
          confirmLabel={t('Undo')}
          tone="danger"
          onConfirm={() => void undo()}
          onCancel={() => setConfirmUndo(false)}
        />
      ) : null}
    </div>
  )
})

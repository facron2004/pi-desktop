import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { relativePath, resolveAgainst } from '../../lib/path'
import type { InspectorRequest } from '@shared/types'
import type { FileChange } from '../../lib/changes'
import { diffStats, type DiffRow } from '../../lib/diff-fold'
import { useT } from '../../lib/i18n'
import { LOG_PAGE_LINES } from '../../lib/log-output'
import { useAppStore } from '../../store/useAppStore'

const PREVIEW_HOVER_DELAY_MS = 400

/** Line count of a written file, without the synthetic empty tail of a final newline. */
function countContentLines(content: string): number {
  if (!content) return 0
  const lines = content.split(/\r\n|\r|\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * Added/removed lines for one file change.
 *
 * A written file has no old side to diff against, so its whole content is the
 * addition. `collectChanges` already folds every touch of one path into a
 * single entry, so a file written twice is still counted once here; when a
 * later write replaces an earlier edit the write's content wins rather than
 * adding both sets of lines.
 */
export function changeStats(change: FileChange): { added: number; removed: number } {
  if (change.kind === 'write' && change.content) {
    return { added: countContentLines(change.content), removed: 0 }
  }
  let added = 0
  let removed = 0
  for (const block of change.diffs) {
    const value = diffStats(block)
    added += value.added
    removed += value.removed
  }
  return { added, removed }
}

interface PreviewLine {
  kind: 'add' | 'del' | 'ctx' | 'gap'
  text: string
  /** The line number shown in the gutter. Gaps have none. */
  line: number | null
}

/** Every changed line, with the number Git would print. The card scrolls. */
function previewRows(change: FileChange): PreviewLine[] {
  const out: PreviewLine[] = []
  if (change.diffs.length > 0) {
    for (const block of change.diffs) {
      for (const row of block.rows) pushRow(row, out)
    }
    return out
  }
  const lines = (change.content ?? '').split(/\r\n|\r|\n/)
  lines.forEach((text, index) => out.push({ kind: 'add', text, line: index + 1 }))
  return out
}

function pushRow(row: DiffRow, out: PreviewLine[]) {
  if (row.kind === 'gap') {
    out.push({ kind: 'gap', text: '…', line: null })
    return
  }
  out.push({
    kind: row.kind,
    text: row.text,
    line: row.kind === 'del' ? row.oldLine : row.newLine
  })
}

/**
 * One changed file.
 *
 * Resting on the row floats the changed lines beside it. Clicking opens the
 * file in the side panel.
 */
export function FileChangeRow({
  change,
  onHover
}: {
  change: FileChange
  onHover: (change: FileChange, row: HTMLDivElement) => void
}) {
  const workspace = useAppStore((state) => state.workspace?.path)
  const cancelPendingPreview = useRef<(() => void) | null>(null)
  const shownPath = useMemo(
    () => relativePath(workspace ?? '', change.path).replace(/\\/g, '/'),
    [workspace, change.path]
  )
  const stats = useMemo(() => changeStats(change), [change])

  useEffect(() => () => cancelPendingPreview.current?.(), [])

  const schedulePreview = (row: HTMLDivElement) => {
    cancelPendingPreview.current?.()
    const timer = window.setTimeout(() => {
      cancel()
      if (row.isConnected) onHover(change, row)
    }, PREVIEW_HOVER_DELAY_MS)
    const cancel = () => {
      window.clearTimeout(timer)
      window.removeEventListener('scroll', cancel, true)
      window.removeEventListener('resize', cancel)
      cancelPendingPreview.current = null
    }
    cancelPendingPreview.current = cancel
    window.addEventListener('scroll', cancel, { capture: true, passive: true })
    window.addEventListener('resize', cancel)
  }

  const openInPanel = () => {
    cancelPendingPreview.current?.()
    const file = resolveAgainst(workspace, change.path)
    window.dispatchEvent(
      new CustomEvent<InspectorRequest>('pi:open-inspector', {
        detail: { tab: 'files', file }
      })
    )
  }

  return (
    <div
      className="file-change"
      data-kind={change.kind}
      onMouseEnter={(event) => schedulePreview(event.currentTarget)}
      onMouseLeave={() => cancelPendingPreview.current?.()}
    >
      <div className="file-change__head">
        <button type="button" className="file-change__main" onClick={openInPanel}>
          <span className="file-change__name" title={change.path}>
            {shownPath}
          </span>
        </button>
        {stats.added > 0 || stats.removed > 0 ? (
          <span className="file-change__stats">
            {stats.added > 0 ? <span className="file-changes__add">+{stats.added}</span> : null}
            {stats.removed > 0 ? <span className="file-changes__del">-{stats.removed}</span> : null}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/** One preview for the whole list. Swapping files replaces its contents. */
export function FileChangePreview({ change }: { change: FileChange }) {
  const t = useT()
  const [page, setPage] = useState(0)
  const workspace = useAppStore((state) => state.workspace?.path)
  const shownPath = useMemo(
    () => relativePath(workspace ?? '', change.path).replace(/\\/g, '/'),
    [workspace, change.path]
  )
  const stats = useMemo(() => changeStats(change), [change])
  const preview = useMemo(() => previewRows(change), [change])
  const pageCount = Math.ceil(preview.length / LOG_PAGE_LINES)
  const currentPage = Math.min(page, Math.max(0, pageCount - 1))
  const visibleRows = preview.slice(currentPage * LOG_PAGE_LINES, (currentPage + 1) * LOG_PAGE_LINES)
  if (preview.length === 0) return null
  return (
    <>
      <div className="file-change__preview-head">
        <span className="file-change__preview-id">
          <span
            className="file-change__preview-name"
            data-full={change.path === shownPath ? 'true' : undefined}
          >
            {shownPath}
          </span>
          {change.path !== shownPath ? (
            <span className="file-change__preview-path">{change.path}</span>
          ) : null}
        </span>
        <span className="file-change__stats">
          {stats.added > 0 ? <span className="file-changes__add">+{stats.added}</span> : null}
          {stats.removed > 0 ? <span className="file-changes__del">-{stats.removed}</span> : null}
        </span>
      </div>
      <div key={`${change.path}:${currentPage}`} className="file-change__preview-code" onWheel={(event) => event.stopPropagation()}>
        {visibleRows.map((line, index) => (
          <div key={index} className="file-change__preview-line" data-kind={line.kind}>
            <span className="file-change__preview-num">{line.line ?? ''}</span>
            <span className="file-change__preview-mark" />
            <span className="file-change__preview-text">{line.text || ' '}</span>
          </div>
        ))}
      </div>
      {pageCount > 1 ? (
        <div className="file-change__preview-pages">
          <button
            type="button"
            className="icon-btn"
            aria-label={t('Previous page')}
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            <ChevronLeft size={13} />
          </button>
          <span>{currentPage + 1} / {pageCount}</span>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('Next page')}
            disabled={currentPage === pageCount - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            <ChevronRight size={13} />
          </button>
        </div>
      ) : null}
    </>
  )
}

export function previewAnchor(row: HTMLElement): {
  left: number
  bottom: number
  width: number
  maxHeight: number
} {
  const box = row.getBoundingClientRect()
  const card = row.closest('.file-changes')?.getBoundingClientRect()
  const width = Math.min(card?.width ?? 560, window.innerWidth - 24)
  const left = Math.max(12, Math.min(card?.left ?? box.left, window.innerWidth - width - 12))
  const bottom = window.innerHeight - box.top + 6
  const lineBox = 22 * 8 + 36
  const maxHeight = Math.min(lineBox, Math.max(22 * 3 + 36, box.top - 16))
  return { left, bottom, width, maxHeight }
}

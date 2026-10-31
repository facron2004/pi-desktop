import { memo, useMemo } from 'react'
import type { ToolItem } from '../../lib/thread'
import { diffableEdits, writtenContent } from '../../lib/tool-renderers'
import { buildDiff, type DiffBlock } from '../../lib/diff-fold'
import { languageOf } from '../../lib/files'
import { basename } from '../../lib/path'
import { countLines, LOG_PAGE_LINES } from '../../lib/log-output'
import { useAppStore } from '../../store/useAppStore'
import { CodeSnippet } from '../CodeSnippet'
import { DiffView } from '../DiffView'
import { LogOutput } from './LogOutput'
import { useT } from '../../lib/i18n'

/** Result characters shown before the "show more" control. */
export const RESULT_PREVIEW = 1200

export interface ToolResultPanelProps {
  item: ToolItem
  /** The card owns the caret; when false the panel renders nothing. */
  open: boolean
  /** The card owns the "show more" state so it survives body toggles. */
  full?: boolean
  onFullChange?: (full: boolean) => void
  /** Precomputed diff blocks, so the card and the panel do not diff twice. */
  diffs?: DiffBlock[]
  /** Precomputed written content, same reason. */
  content?: string
  /** Opens one line of an edit diff in the file inspector. */
  onOpenLine?: (line: number) => void
}

/**
 * Everything a tool call keeps behind its caret: the diff of an edit, the
 * content of a write, the result of a read or command, and the JSON arguments
 * of a call that produced none of those.
 *
 * The panel is presentation only. The card decides whether it is open and
 * whether the long result has been expanded, so those states do not reset
 * when the body unmounts.
 */
export const ToolResultPanel = memo(function ToolResultPanel({
  item,
  open,
  full = false,
  onFullChange,
  diffs: providedDiffs,
  content: providedContent,
  onOpenLine
}: ToolResultPanelProps) {
  const diffSplit = useAppStore((state) => state.settings.diffSplit === true)
  const t = useT()

  const diffs = useMemo(
    () => providedDiffs ?? diffableEdits(item).map((pair) => buildDiff(pair.oldText, pair.newText)),
    [item, providedDiffs]
  )
  const content = useMemo(() => providedContent ?? writtenContent(item), [item, providedContent])

  const result = item.result ?? ''
  const truncated = result.length > RESULT_PREVIEW
  const visibleResult = truncated && !full ? result.slice(0, RESULT_PREVIEW) : result
  const resultLines = useMemo(() => (open ? countLines(result) : 0), [open, result])
  const contentLines = useMemo(() => (open ? countLines(content) : 0), [open, content])

  const fileName = basename(String(item.args?.path ?? ''))
  const language = languageOf(fileName)

  if (!open) return null

  return (
    <div className="tool__body">
      {item.status === 'error' && visibleResult ? (
        <LogOutput text={visibleResult} className="tool__error" />
      ) : null}

      {diffs.length > 0 ? (
        <DiffView
          diffs={diffs}
          mode={diffSplit ? 'split' : 'unified'}
          onOpenLine={onOpenLine}
        />
      ) : null}

      {content ? (
        contentLines > LOG_PAGE_LINES ? (
          <LogOutput text={content} />
        ) : (
          <CodeSnippet code={content} language={language} />
        )
      ) : null}

      {item.toolName === 'bash' || item.toolName === 'powershell'
        ? String(item.args?.command ?? '').includes('\n') && (
            <pre className="tool__pre">{String(item.args?.command ?? '')}</pre>
          )
        : null}

      {visibleResult && item.status !== 'error' ? (
        item.toolName === 'read' && resultLines <= LOG_PAGE_LINES ? (
          <CodeSnippet code={visibleResult} language={language} />
        ) : (
          <LogOutput text={visibleResult} />
        )
      ) : null}

      {truncated ? (
        <button className="tool__more" onClick={() => onFullChange?.(!full)}>
          {full
            ? t('Show less')
            : `${t('Show')} ${(result.length - RESULT_PREVIEW).toLocaleString()} ${t('more characters')}`}
        </button>
      ) : null}

      {!diffs.length && !visibleResult && !content ? (
        <pre className="tool__pre">{JSON.stringify(item.args ?? {}, null, 2)}</pre>
      ) : null}
    </div>
  )
})

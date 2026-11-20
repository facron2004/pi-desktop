import { lazy, memo, Suspense, useMemo } from 'react'
import type { ToolItem } from '../../lib/thread'
import { diffableEdits, writtenContent } from '../../lib/tool-renderers'
import { buildDiff, type DiffBlock } from '../../lib/diff-fold'
import { languageOf } from '../../lib/files'
import { basename } from '../../lib/path'
import { countLines, LOG_PAGE_LINES } from '../../lib/log-output'
import { CodeSnippet } from '../CodeSnippet'
import { Markdown } from '../Markdown'
import { ImageButton } from '../Lightbox'
import { LogOutput } from './LogOutput'
import { useThreadEnv } from './ThreadEnvContext'
import { useT } from '../../lib/i18n'

const DiffView = lazy(() => import('../DiffView').then((m) => ({ default: m.DiffView })))

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
  /** The reply already quotes this image prompt; do not print it a second time. */
  hideImagePrompt?: boolean
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
  onOpenLine,
  hideImagePrompt = false
}: ToolResultPanelProps) {
  const { diffSplit } = useThreadEnv()
  const t = useT()

  const diffs = useMemo(
    () => providedDiffs ?? diffableEdits(item).map((pair) => buildDiff(pair.oldText, pair.newText)),
    [item, providedDiffs]
  )
  const content = useMemo(() => providedContent ?? writtenContent(item), [item, providedContent])

  const result = item.result ?? ''
  const truncated = result.length > RESULT_PREVIEW
  const visibleResult = truncated && !full ? result.slice(0, RESULT_PREVIEW) : result
  const visibleResultLines = useMemo(
    () => (open && visibleResult ? countLines(visibleResult) : 0),
    [open, visibleResult]
  )
  const contentLines = useMemo(() => (open ? countLines(content) : 0), [open, content])
  const shellCommand =
    item.toolName === 'bash' || item.toolName === 'powershell' ? String(item.args?.command ?? '') : ''
  const shellCommandLines = useMemo(
    () => (open && shellCommand ? countLines(shellCommand) : 0),
    [open, shellCommand]
  )

  const fileName = basename(String(item.args?.path ?? ''))
  const language = languageOf(fileName)
  // A submitted plan is prose, not a JSON argument. Render the document the
  // agent wrote; the approval result still appears below it as ordinary text.
  const plan = item.toolName === 'exit_plan_mode' && typeof item.args?.plan === 'string'
    ? item.args.plan
    : ''
  const shot = computerShot(item.details)
  // The prompt belongs to the picture's fold: the card keeps its one-line
  // header for the verb, and this is where the reader finds the words again.
  const imagePrompt =
    item.toolName === 'generate_image' && typeof item.args?.prompt === 'string'
      ? item.args.prompt.trim()
      : ''
  // A successful image call already renders its pictures in the card strip and
  // its prompt above; the tool's text summary of saved paths is for the model.
  const suppressResult = item.toolName === 'generate_image' && item.status !== 'error'

  if (!open) return null

  return (
    <div className="tool__body">
      {item.status === 'error' && visibleResult ? (
        <LogOutput text={visibleResult} className="tool__error" />
      ) : null}

      {imagePrompt && !hideImagePrompt ? (
        <div className="tool__image-prompt">
          <span className="tool__image-prompt-label">{t('Prompt')}</span>
          <p>{imagePrompt}</p>
        </div>
      ) : null}

      {plan ? (
        <div className="tool__plan">
          <Markdown>{plan}</Markdown>
        </div>
      ) : null}

      {shot ? (
        <ImageButton
          src={`data:${shot.mimeType};base64,${shot.data}`}
          alt={t('Desktop screenshot')}
          inline={shot}
        />
      ) : null}

      {diffs.length > 0 ? (
        <Suspense fallback={null}>
          <DiffView
            diffs={diffs}
            mode={diffSplit ? 'split' : 'unified'}
            onOpenLine={onOpenLine}
          />
        </Suspense>
      ) : null}

      {content ? (
        contentLines > LOG_PAGE_LINES ? (
          <LogOutput text={content} />
        ) : (
          <CodeSnippet code={content} language={language} />
        )
      ) : null}

      {shellCommand ? (
        shellCommandLines > LOG_PAGE_LINES ? (
          <LogOutput text={shellCommand} />
        ) : (
          <CodeSnippet
            code={shellCommand}
            language={item.toolName === 'powershell' ? 'powershell' : 'bash'}
          />
        )
      ) : null}

      {visibleResult && item.status !== 'error' && !suppressResult ? (
        item.toolName === 'read' && visibleResultLines <= LOG_PAGE_LINES ? (
          <CodeSnippet code={visibleResult} language={language} />
        ) : item.toolName === 'subagent' ? (
          <div className="tool__plan">
            <Markdown>{visibleResult}</Markdown>
          </div>
        ) : (
          <LogOutput text={visibleResult} />
        )
      ) : null}

      {truncated && !suppressResult ? (
        <button className="tool__more" onClick={() => onFullChange?.(!full)}>
          {full
            ? t('Show less')
            : `${t('Show')} ${(result.length - RESULT_PREVIEW).toLocaleString()} ${t('more characters')}`}
        </button>
      ) : null}

      {!diffs.length && !visibleResult && !content && !plan && !shot && !shellCommand && !imagePrompt ? (
        <pre className="tool__pre">{JSON.stringify(item.args ?? {}, null, 2)}</pre>
      ) : null}
    </div>
  )
})

/** The screenshot a computer action attached for the reader, not the model. */
function computerShot(details: unknown): { data: string; mimeType: string } | null {
  if (!details || typeof details !== 'object') return null
  const image = (details as { image?: { data?: unknown; mimeType?: unknown } }).image
  if (!image || typeof image.data !== 'string' || !image.data) return null
  const mimeType = typeof image.mimeType === 'string' && image.mimeType.startsWith('image/')
    ? image.mimeType
    : 'image/png'
  return { data: image.data, mimeType }
}

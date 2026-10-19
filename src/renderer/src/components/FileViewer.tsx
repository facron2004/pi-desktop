import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, File as FileIcon } from 'lucide-react'
import type { FileContent } from '@shared/types'
import { fileTone } from '../lib/files'
import { formatBytes } from '../lib/format'
import { basename, relativePath } from '../lib/path'
import { CodeSnippet } from './CodeSnippet'

interface FileViewerProps {
  file: string
  root?: string
  /** Scroll to this line and mark it, when the file was opened from a diff. */
  line?: number
}

export function FileViewer({ file, root, line }: FileViewerProps) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  const codeRef = useRef<HTMLElement | null>(null)
  const lineRef = useRef(line)
  lineRef.current = line

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setError(false)
    window.pi.fs
      .read(file)
      .then((result) => {
        if (cancelled) return
        if (!result) {
          setError(true)
          return
        }
        setContent(result)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [file])

  // Bring the line the reader came from into view and mark it. The code is
  // highlighted after it is shown, so this runs again once the highlighted
  // version is in place.
  const jumpToLine = useCallback(() => {
    const wanted = lineRef.current
    if (!wanted) return
    const lines = codeRef.current?.querySelectorAll<HTMLElement>('.line')
    const target = lines?.[wanted - 1]
    if (!target) return
    target.scrollIntoView({ block: 'center' })
    target.setAttribute('data-marked', 'true')
    window.setTimeout(() => target.removeAttribute('data-marked'), 2400)
  }, [])

  const copy = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content.content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard may be unavailable */
    }
  }

  if (error) {
    return <div className="drawer__empty">That file could not be read.</div>
  }
  if (!content) {
    return (
      <div className="drawer__empty">
        <span className="spinner" />
      </div>
    )
  }

  const lineCount = content.content ? content.content.split('\n').length : 0

  return (
    <div className="viewer">
      <div className="viewer__bar">
        <span className="viewer__crumb">
          <span className="viewer__crumb-root">{root ? basename(root) : ''}</span>
          <span className="viewer__crumb-path" title={content.path}>
            <span className="tree__icon" data-tone={fileTone(content.path.split(/[\\/]/).pop() ?? '')}>
              <FileIcon />
            </span>
            {relativePath(root ?? '', content.path)}
          </span>
        </span>
        {content.truncated ? <span className="change__badge">truncated</span> : null}
        {line ? <span className="change__badge">line {line}</span> : null}
        <span className="viewer__meta">
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
          {content.size ? ` · ${formatBytes(content.size)}` : ''}
        </span>
        <button className="ghost-btn" onClick={() => void copy()} title="Copy the file">
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <button
          className="ghost-btn"
          title="Reveal in the file manager"
          onClick={() => void window.pi.fs.reveal(content.path)}
        >
          <ExternalLink size={12} />
        </button>
      </div>

      <CodeSnippet
        code={content.content}
        language={content.language}
        className="viewer__code"
        onHost={(node) => {
          codeRef.current = node
        }}
        onReady={jumpToLine}
      />
    </div>
  )
}

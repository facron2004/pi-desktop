import { useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, File as FileIcon } from 'lucide-react'
import type { FileContent } from '@shared/types'
import { highlightCode } from '../lib/highlight'
import { fileTone } from '../lib/files'
import { basename, relativePath } from '../lib/path'
import { useIsDark } from '../lib/theme'

interface FileViewerProps {
  file: string
  root?: string
  /** Scroll to this line and mark it, when the file was opened from a diff. */
  line?: number
}

export function FileViewer({ file, root, line }: FileViewerProps) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  const isDark = useIsDark()
  const codeRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let cancelled = false
    setContent(null)
    setHtml(null)
    setError(false)
    window.pi.fs
      .read(file)
      .then(async (result) => {
        if (cancelled) return
        if (!result) {
          setError(true)
          return
        }
        setContent(result)
        try {
          const rendered = await highlightCode(result.content, result.language, isDark)
          if (!cancelled) setHtml(rendered)
        } catch (error) {
          console.error('[pi-desktop] highlighting failed:', error)
          if (!cancelled) setHtml(null)
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [file, isDark])

  // Bring the line the reader came from into view and mark it.
  useEffect(() => {
    if (!line || !html) return
    const host = codeRef.current
    if (!host) return
    const lines = host.querySelectorAll<HTMLElement>('.line')
    const target = lines[line - 1]
    if (!target) return
    target.scrollIntoView({ block: 'center' })
    target.setAttribute('data-marked', 'true')
    const timer = window.setTimeout(() => target.removeAttribute('data-marked'), 2400)
    return () => window.clearTimeout(timer)
  }, [html, line, content])

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
        <button className="ghost-btn" onClick={() => void copy()} title="Copy the file">
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <button
          className="ghost-btn"
          title="Reveal in the file manager"
          onClick={() => void window.pi.sessions.reveal(content.path)}
        >
          <ExternalLink size={12} />
        </button>
      </div>

      {html ? (
        <div
          className="viewer__code shiki-host"
          ref={(node) => {
            codeRef.current = node
          }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        // Without a grammar the file still needs line numbers, so the lines
        // are wrapped by hand.
        <pre
          className="tool__pre viewer__code viewer__code--plain"
          ref={(node) => {
            codeRef.current = node
          }}
        >
          {content.content.split('\n').map((text, index) => (
            <span className="line" key={index}>
              {text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Check, Copy, ExternalLink } from 'lucide-react'
import type { FileContent } from '@shared/types'
import { highlightCode } from '../lib/highlight'

interface FileViewerProps {
  file: string
}

export function FileViewer({ file }: FileViewerProps) {
  const [content, setContent] = useState<FileContent | null>(null)
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)

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
          const rendered = await highlightCode(result.content, result.language, true)
          if (!cancelled) setHtml(rendered)
        } catch {
          if (!cancelled) setHtml(null)
        }
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [file])

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
        <span className="viewer__path" title={content.path}>
          {content.path}
        </span>
        {content.truncated ? <span className="change__badge">truncated</span> : null}
        <button className="ghost-btn" onClick={() => void copy()}>
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
        <div className="viewer__code shiki-host" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="tool__pre viewer__code">{content.content}</pre>
      )}
    </div>
  )
}

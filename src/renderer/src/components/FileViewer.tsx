import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, ExternalLink, File as FileIcon, Link2, MessageSquarePlus } from 'lucide-react'
import type { FileContent } from '@shared/types'
import { fileTone } from '../lib/files'
import { formatBytes } from '../lib/format'
import { basename, relativePath } from '../lib/path'
import { useAppStore } from '../store/useAppStore'
import { CodeSnippet } from './CodeSnippet'
import { useT } from '../lib/i18n'

interface FileViewerProps {
  file: string
  root?: string
  /** Scroll to this line and mark it, when the file was opened from a diff. */
  line?: number
}

export function FileViewer({ file, root, line }: FileViewerProps) {
  const t = useT()
  const [content, setContent] = useState<FileContent | null>(null)
  const [copied, setCopied] = useState<'file' | 'path' | null>(null)
  const [error, setError] = useState(false)
  const codeRef = useRef<HTMLElement | null>(null)
  const lineRef = useRef(line)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
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

  /**
   * Copy the file or the place it lives.
   *
   * The crumb shows the path inside the project, but a command that needs the
   * file wants the whole path, so both are one click away.
   */
  const copy = async (what: 'file' | 'path') => {
    if (!content) return
    const text = what === 'file' ? content.content : content.path
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      window.setTimeout(() => setCopied((current) => (current === what ? null : current)), 1600)
    } catch {
      /* clipboard may be unavailable */
    }
  }

  if (error) {
    return <div className="drawer__empty">{t('That file could not be read.')}</div>
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
        {content.truncated ? <span className="change__badge">{t('truncated')}</span> : null}
        {line ? <span className="change__badge">{t('line')} {line}</span> : null}
        <span className="viewer__meta">
          {lineCount} {lineCount === 1 ? t('line') : t('lines')}
          {content.size ? ` · ${formatBytes(content.size)}` : ''}
        </span>
        <button className="ghost-btn" onClick={() => void copy('file')} title={t('Copy the file')}>
          {copied === 'file' ? <Check size={12} /> : <Copy size={12} />}
        </button>
        <button
          className="ghost-btn"
          onClick={() => void copy('path')}
          title={t('Copy the path of the file')}
        >
          {copied === 'path' ? <Check size={12} /> : <Link2 size={12} />}
        </button>
        <button
          className="ghost-btn"
          title={t('Ask Pi about this file')}
          onClick={() =>
            insertIntoComposer(
              t('Take a look at {file} and tell me').replace(
                '{file}',
                relativePath(root ?? '', content.path)
              )
            )
          }
        >
          <MessageSquarePlus size={12} />
        </button>
        <button
          className="ghost-btn"
          title={t('Reveal in the file manager')}
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

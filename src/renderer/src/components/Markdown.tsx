import { isValidElement, memo, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Code, Copy, Eye, FileCode2, MessageSquarePlus } from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import { highlightCode } from '../lib/highlight'
import { resolveAgainst } from '../lib/path'
import { useSearchQuery } from '../lib/search-context'
import { useIsDark } from '../lib/theme'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { ImageButton } from './Lightbox'

const FILE_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'css',
  'scss',
  'less',
  'html',
  'md',
  'mdx',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'yml',
  'yaml',
  'toml',
  'sql',
  'vue',
  'svelte',
  'astro',
  'svg',
  'xml',
  'txt'
])

function parseFileReference(raw: string): { path: string; line?: number } | null {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > 180 || /\s/.test(trimmed)) return null
  if (/^(https?:|mailto:|\/\/)/i.test(trimmed) || trimmed.includes('..')) return null
  const match =
    /^([a-zA-Z0-9_@.-]+(?:[\\/][a-zA-Z0-9_@.-]+)*\.([a-zA-Z0-9]{1,8}))(?::(\d+)|#L(\d+)(?:-L?\d+)?)?$/.exec(
      trimmed
    )
  if (!match) return null
  const filePath = match[1]
  const ext = match[2].toLowerCase()
  if (!FILE_EXTS.has(ext)) return null
  // Bare filenames without directory separators must be well-known or have a line number,
  // or be a common source file name so ordinary object properties (`foo.js` vs `window.pi`) are distinguished.
  const hasSlash = filePath.includes('/') || filePath.includes('\\')
  const lineStr = match[3] ?? match[4]
  const line = lineStr ? Number.parseInt(lineStr, 10) : undefined
  if (!hasSlash && !line && !/^[A-Za-z0-9_-]+\.[a-z0-9]+$/.test(filePath)) return null
  return { path: filePath, line: Number.isFinite(line) ? line : undefined }
}

/** Wrap every occurrence of the search query in a `<mark>`. */
function Highlight({ children, query }: { children?: ReactNode; query: string }) {
  if (!query || typeof children !== 'string') return <>{children}</>
  const needle = query.toLowerCase()
  const parts = children.split(new RegExp(`(${escapeRegExp(query)})`, 'ig'))
  if (parts.length === 1) return <>{children}</>
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === needle ? (
          // The text is re-split on every streamed delta, so the match itself
          // is the stable part of the key; the index only keeps two identical
          // matches apart.
          <mark key={`${part}-${index}`}>{part}</mark>
        ) : (
          part
        )
      )}
    </>
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface CodeBlockProps {
  code: string
  language?: string
}

function Marked({ children }: { children?: ReactNode }) {
  return <Highlight query={useSearchQuery()}>{children}</Highlight>
}

const markdownComponents: Components = {
  // Keep renderer component identities stable while streamed text grows.
  pre({ children: content }: { children?: ReactNode }) {
    const child = Array.isArray(content) ? content[0] : content
    if (
      isValidElement<{ className?: string; children?: ReactNode }>(child) &&
      child.type === 'code'
    ) {
      const match = /language-([\w+-]+)/.exec(child.props.className ?? '')
      const text = String(child.props.children ?? '').replace(/\n$/, '')
      return <CodeBlock code={text} language={match?.[1]} />
    }
    return <pre>{content}</pre>
  },
  code({ className, children, ...rest }) {
    const raw = String(children ?? '')
    if (!className && !raw.includes('\n')) {
      const ref = parseFileReference(raw)
      if (ref) {
        return (
          <button
            type="button"
            className="md-file-link"
            title={ref.line ? `${ref.path}:${ref.line}` : ref.path}
            onClick={() => {
              const root = useAppStore.getState().workspace?.path
              const resolved = resolveAgainst(root, ref.path)
              window.dispatchEvent(
                new CustomEvent<InspectorRequest>('pi:open-inspector', {
                  detail: { tab: 'files', file: resolved, line: ref.line }
                })
              )
            }}
          >
            <FileCode2 size={11} />
            <span>
              <Marked>{raw}</Marked>
            </span>
          </button>
        )
      }
    }
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    )
  },
  p({ children: content, ...rest }) {
    return (
      <p {...rest}>
        <Marked>{content}</Marked>
      </p>
    )
  },
  li({ children: content, ...rest }) {
    return (
      <li {...rest}>
        <Marked>{content}</Marked>
      </li>
    )
  },
  h1({ children: content, ...rest }) {
    return (
      <h1 {...rest}>
        <Marked>{content}</Marked>
      </h1>
    )
  },
  h2({ children: content, ...rest }) {
    return (
      <h2 {...rest}>
        <Marked>{content}</Marked>
      </h2>
    )
  },
  h3({ children: content, ...rest }) {
    return (
      <h3 {...rest}>
        <Marked>{content}</Marked>
      </h3>
    )
  },
  h4({ children: content, ...rest }) {
    return (
      <h4 {...rest}>
        <Marked>{content}</Marked>
      </h4>
    )
  },
  strong({ children: content, ...rest }) {
    return (
      <strong {...rest}>
        <Marked>{content}</Marked>
      </strong>
    )
  },
  em({ children: content, ...rest }) {
    return (
      <em {...rest}>
        <Marked>{content}</Marked>
      </em>
    )
  },
  a({ children, href, ...rest }) {
    return (
      <a
        href={href}
        onClick={(event) => {
          if (href && /^https?:\/\//i.test(href)) {
            event.preventDefault()
            void window.pi.shell.openExternal(href)
          }
        }}
        {...rest}
      >
        {children}
      </a>
    )
  },
  img({ src, alt, title }) {
    if (!src) return null
    return <ImageButton src={src} alt={alt} title={title} />
  }
}

const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const [rendered, setRendered] = useState<{
    code: string
    language: string
    isDark: boolean
    html: string
  } | null>(null)
  const [copied, setCopied] = useState(false)
  const [preview, setPreview] = useState(false)
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const isDark = useIsDark()
  const t = useT()

  const lang = (language ?? '').toLowerCase()
  const isSvg = lang === 'svg' || (lang === 'xml' && code.trimStart().startsWith('<svg'))
  const isHtml = lang === 'html'
  const canPreview = isSvg || isHtml
  const previewDoc = isSvg
    ? `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:transparent;font-family:system-ui,sans-serif;}svg{max-width:100%;max-height:280px;height:auto;}</style></head><body>${code}</body></html>`
    : code

  useEffect(() => {
    let cancelled = false
    highlightCode(code, language ?? 'text', isDark)
      .then((value) => {
        if (!cancelled) setRendered({ code, language: language ?? 'text', isDark, html: value })
      })
      .catch(() => {
        if (!cancelled) setRendered(null)
      })
    return () => {
      cancelled = true
    }
  }, [code, language, isDark])
  const html =
    rendered?.code === code &&
    rendered.language === (language ?? 'text') &&
    rendered.isDark === isDark
      ? rendered.html
      : null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard may be unavailable */
    }
  }

  // A fenced block with four backticks survives a snippet that contains a
  // fence of its own.
  const ask = () => {
    insertIntoComposer(`\`\`\`\`${language ?? 'text'}\n${code}\n\`\`\`\``)
  }

  return (
    <div className="code-block">
      <div className="code-block__bar">
        <span className="code-block__lang">{language ?? 'text'}</span>
        <span className="code-block__tools">
          {canPreview ? (
            <button
              className="code-block__tool"
              data-active={preview ? 'true' : undefined}
              onClick={() => setPreview((value) => !value)}
              title={preview ? t('Show source code') : t('Preview rendered output')}
            >
              {preview ? <Code size={11} /> : <Eye size={11} />}
              {preview ? t('Code') : t('Preview')}
            </button>
          ) : null}
          <button className="code-block__tool" onClick={ask} title={t('Ask Pi about this code')}>
            <MessageSquarePlus size={11} />
            {t('Ask Pi')}
          </button>
          <button className="code-block__tool" onClick={() => void copy()} title={t('Copy code')}>
            {copied ? <Check size={11} /> : <Copy size={11} />}
            {copied ? t('Copied') : t('Copy')}
          </button>
        </span>
      </div>
      {preview && canPreview ? (
        <div className="code-block__preview-wrap">
          <iframe
            className="code-block__preview"
            sandbox=""
            title={t('Preview')}
            srcDoc={previewDoc}
          />
        </div>
      ) : html ? (
        <div className="shiki-host" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre>
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
})

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})

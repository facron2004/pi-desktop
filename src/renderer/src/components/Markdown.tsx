import { createContext, useContext, isValidElement, memo, useEffect, useState, type ReactNode } from 'react'
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
import { ErrorBoundary } from './ErrorBoundary'

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
    if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
      // `pre` always wraps the `code` element in Markdown. Use the element's
      // own className to recover the fence language; comparing `child.type`
      // to the string 'code' fails because the renderer maps it to the custom
      // component below.
      const match = /language-([\w+-]+)/.exec(child.props.className ?? '')
      const text = String(child.props.children ?? '').replace(/\n$/, '')
      return <CodeBlock code={text} language={match?.[1]} />
    }
    return <pre>{content}</pre>
  },
  code({ className, children, node: _node, ...rest }) {
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
  p({ children: content, node: _node, ...rest }) {
    return (
      <p {...rest}>
        <Marked>{content}</Marked>
      </p>
    )
  },
  li({ children: content, node: _node, ...rest }) {
    return (
      <li {...rest}>
        <Marked>{content}</Marked>
      </li>
    )
  },
  h1({ children: content, node: _node, ...rest }) {
    return (
      <h1 {...rest}>
        <Marked>{content}</Marked>
      </h1>
    )
  },
  h2({ children: content, node: _node, ...rest }) {
    return (
      <h2 {...rest}>
        <Marked>{content}</Marked>
      </h2>
    )
  },
  h3({ children: content, node: _node, ...rest }) {
    return (
      <h3 {...rest}>
        <Marked>{content}</Marked>
      </h3>
    )
  },
  h4({ children: content, node: _node, ...rest }) {
    return (
      <h4 {...rest}>
        <Marked>{content}</Marked>
      </h4>
    )
  },
  strong({ children: content, node: _node, ...rest }) {
    return (
      <strong {...rest}>
        <Marked>{content}</Marked>
      </strong>
    )
  },
  em({ children: content, node: _node, ...rest }) {
    return (
      <em {...rest}>
        <Marked>{content}</Marked>
      </em>
    )
  },
  a({ children, href, node: _node, ...rest }) {
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
    return <MarkdownImage src={src} alt={alt} title={title} />
  }
}

const StreamingContext = createContext<boolean>(false)

/**
 * Resolves an image src the page cannot load by itself — a project-relative
 * path in a document read from disk — into a data URL.
 */
const ImageResolverContext = createContext<((src: string) => Promise<string | null>) | null>(null)

function MarkdownImage({ src, alt, title }: { src: string; alt?: string; title?: string }) {
  const resolve = useContext(ImageResolverContext)
  const [resolved, setResolved] = useState<string | null>(null)
  useEffect(() => {
    setResolved(null)
    if (!resolve) return
    let cancelled = false
    resolve(src)
      .then((url) => {
        if (!cancelled && url) setResolved(url)
      })
      .catch(() => {
        /* the raw src is shown instead; it may still work */
      })
    return () => {
      cancelled = true
    }
  }, [src, resolve])
  return <ImageButton src={resolved ?? src} alt={alt} title={title} />
}

const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const isStreaming = useContext(StreamingContext)
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
    let timer: number | undefined

    if (isStreaming) {
      // While actively streaming, debounce Shiki highlighting by 250ms to prevent
      // expensive regex tokenization on every single delta animation frame.
      timer = window.setTimeout(() => {
        highlightCode(code, language ?? 'text', isDark)
          .then((value) => {
            if (!cancelled) setRendered({ code, language: language ?? 'text', isDark, html: value })
          })
          .catch(() => {
            if (!cancelled) setRendered(null)
          })
      }, 250)
      return () => {
        cancelled = true
        if (timer) window.clearTimeout(timer)
      }
    }

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
  }, [code, language, isDark, isStreaming])
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

export interface MarkdownProps {
  children: string
  streaming?: boolean
  /**
   * Render the Markdown tree without its own `.md` wrapper.
   *
   * StreamingText splits a reply into several Markdown segments and puts them
   * under one `.md` container so block spacing still behaves like a single
   * document; each segment must then render bare.
   */
  bare?: boolean
  /**
   * Turns an image src the page cannot load by itself — a path relative to the
   * document on disk — into a data URL. Without it, the src is used as written.
   */
  resolveImage?: (src: string) => Promise<string | null>
  /**
   * Drop raw-HTML tags instead of showing them as text — the reading mode for
   * a document whose HTML is layout, not content.
   */
  stripHtml?: boolean
}

const REMARK_PLUGINS = [remarkGfm]

/** A Markdown tree node, as far as this module needs to see it. */
interface MarkdownNode {
  type?: string
  children?: MarkdownNode[]
}

/**
 * Remove raw-HTML nodes from the tree before it is rendered.
 *
 * react-markdown renders an `html` node as its literal text, which is right
 * for a conversation (the model that *talks about* a tag is quoting it) and
 * wrong for a document read from disk: a README's `<div align="center">` is
 * layout, not words. The file viewer opts in; the tags drop out and the
 * Markdown around them keeps reading as a document.
 */
function remarkStripHtml(): (tree: MarkdownNode) => void {
  const strip = (node: MarkdownNode): void => {
    if (!Array.isArray(node.children)) return
    node.children = node.children.filter((child) => {
      if (child.type === 'html') return false
      strip(child)
      return true
    })
  }
  return strip
}

const REMARK_PLUGINS_STRIPPED = [remarkStripHtml, remarkGfm]

export const Markdown = memo(function Markdown({
  children,
  streaming = false,
  bare = false,
  resolveImage,
  stripHtml = false
}: MarkdownProps) {
  const body = (
    <ImageResolverContext.Provider value={resolveImage ?? null}>
      <ReactMarkdown
        remarkPlugins={stripHtml ? REMARK_PLUGINS_STRIPPED : REMARK_PLUGINS}
        components={markdownComponents}
      >
        {children}
      </ReactMarkdown>
    </ImageResolverContext.Provider>
  )
  return (
    <ErrorBoundary inline scope="Markdown">
      <StreamingContext.Provider value={streaming}>
        {bare ? body : <div className="md">{body}</div>}
      </StreamingContext.Provider>
    </ErrorBoundary>
  )
})

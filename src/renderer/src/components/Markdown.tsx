import { createContext, useContext, isValidElement, lazy, memo, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Globe, Check, Code, Copy, Eye, FileCode2 } from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import { highlightCode, readHighlightedCodeSync } from '../lib/highlight'
import { resolveAgainst } from '../lib/path'
import { SearchContext, useSearchQuery } from '../lib/search-context'
import { useIsDark } from '../lib/theme'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { isMermaidLanguage } from '../lib/mermaid'
import { looksLikeUrl } from '../lib/url-link'
import { openResolvedUrl } from '../lib/open-link'
import { ImageButton } from './Lightbox'
import { ErrorBoundary } from './ErrorBoundary'
import { useThreadEnv } from './conversation/ThreadEnvContext'
import { SideChatActionCard } from './side-chat/SideChatTurnActions'

const MermaidDiagram = lazy(() =>
  import('./MermaidDiagram').then((m) => ({ default: m.MermaidDiagram }))
)

const FILE_EXTS = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'jsonc',
  'json5',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'md',
  'mdx',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'kts',
  'c',
  'cpp',
  'cc',
  'cxx',
  'h',
  'hpp',
  'hh',
  'hxx',
  'cs',
  'rb',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'nu',
  'awk',
  'ps1',
  'psm1',
  'psd1',
  'ps1xml',
  'bat',
  'cmd',
  'btm',
  'reg',
  'yml',
  'yaml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'lua',
  'pl',
  'pm',
  'r',
  'scala',
  'dart',
  'zig',
  'nix',
  'ex',
  'exs',
  'tf',
  'tfvars',
  'hcl',
  'proto',
  'cmake',
  'groovy',
  'gradle',
  'diff',
  'patch',
  'graphql',
  'gql',
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
  // A bare `example.com/page.html` matches the filename shape below — its last
  // segment even ends in a known extension — but it is a link, not a project
  // file. Treating it as a file opened the files panel on a URL click.
  if (looksLikeUrl(trimmed)) return null
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

const StreamingContext = createContext<boolean>(false)

function Marked({ children }: { children?: ReactNode }) {
  return <Highlight query={useSearchQuery()}>{children}</Highlight>
}

/**
 * A fenced block. Mermaid fences become a live diagram; every other language
 * keeps the existing syntax-highlighted CodeBlock behaviour untouched.
 */
function flattenNodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenNodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return flattenNodeText(node.props.children)
  return ''
}

function PreBlock({ children: content }: { children?: ReactNode }) {
  const streaming = useContext(StreamingContext)
  const { surface } = useThreadEnv()
  const child = Array.isArray(content) ? content[0] : content
  if (isValidElement<{ className?: string; children?: ReactNode }>(child)) {
    // `pre` always wraps the `code` element in Markdown. Use the element's
    // own className to recover the fence language; comparing `child.type`
    // to the string 'code' fails because the renderer maps it to the custom
    // component below. Keep dots, slashes and colons so tags like `deploy.ps1`
    // or `scripts/run.ps1` pass intact to the grammar resolver.
    const match = /(?:^|\s)language-([^\s]+)/.exec(child.props.className ?? '')
    const text = flattenNodeText(child.props.children).replace(/\n$/, '')
    if (isMermaidLanguage(match?.[1])) {
      // One bad diagram must not take down the rest of the Markdown tree.
      return (
        <ErrorBoundary inline scope="Mermaid diagram">
          <Suspense fallback={<pre className="md-mermaid-loading"><code>{text}</code></pre>}>
            <MermaidDiagram code={text} streaming={streaming} />
          </Suspense>
        </ErrorBoundary>
      )
    }
    if (surface === 'side' && match?.[1]?.toLowerCase() === 'prompt' && text.trim()) {
      return <SideChatActionCard code={text} />
    }
    return <CodeBlock code={text} language={match?.[1]} />
  }
  return <pre>{content}</pre>
}

const markdownComponents: Components = {
  // Keep renderer component identities stable while streamed text grows.
  pre: PreBlock,
  code({ className, children, node: _node, ...rest }) {
    const raw = String(children ?? '')
    if (!className && !raw.includes('\n')) {
      if (looksLikeUrl(raw)) {
        // A URL a model wrote inside backticks is still a link. Without this
        // it fell through to the file-reference branch and opened the files
        // panel, which reads as "the file manager opened instead of a browser".
        return (
          <a
            className="md-link md-link--url"
            href={raw.trim()}
            title={raw.trim()}
            onClick={(event) => {
              event.preventDefault()
              openResolvedUrl(raw)
            }}
          >
            <Globe size={11} strokeWidth={1.8} className="md-link__icon" aria-hidden="true" />
            <Marked>{raw}</Marked>
          </a>
        )
      }
      const ref = parseFileReference(raw)
      if (ref) {
        return (
          <button
            type="button"
            className="md-file-link"
            onClick={(event) => {
              const root = useAppStore.getState().workspace?.path
              const resolved = resolveAgainst(root, ref.path)
              window.dispatchEvent(
                new CustomEvent<InspectorRequest>('pi:open-inspector', {
                  detail: { tab: event.altKey ? 'changes' : 'files', file: resolved, line: ref.line }
                })
              )
            }}
          >
            <FileCode2 size={11} aria-hidden="true" />
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
    const external = Boolean(href && looksLikeUrl(href))
    return (
      <a
        href={href}
        onClick={(event) => {
          if (external && href) {
            event.preventDefault()
            openResolvedUrl(href)
          }
        }}
        {...rest}
      >
        {external ? (
          <Globe
            size={11}
            strokeWidth={1.8}
            className="md-link__icon"
            aria-hidden="true"
          />
        ) : null}
        {children}
      </a>
    )
  },
  img({ src, alt, title }) {
    if (!src) return null
    return <MarkdownImage src={src} alt={alt} title={title} />
  }
}

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
  const isDark = useIsDark()
  const t = useT()

  const lang = (language ?? '').toLowerCase()
  const isSvg = lang === 'svg' || (lang === 'xml' && code.trimStart().startsWith('<svg'))
  const isHtml = lang === 'html'
  const canPreview = isSvg || isHtml
  const previewDoc = isSvg
    ? `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:grid;place-items:center;background:transparent;font-family:system-ui,sans-serif;}svg{max-width:100%;max-height:280px;height:auto;}</style></head><body>${code}</body></html>`
    : code

  const langKey = language ?? 'text'
  const syncHtml = readHighlightedCodeSync(code, langKey, isDark)

  useEffect(() => {
    // Keep transient streaming partials out of the Shiki LRU; finalized chunks
    // and settled blocks render with `isStreaming === false` and highlight once.
    if (isStreaming || readHighlightedCodeSync(code, langKey, isDark) !== null) return
    let cancelled = false

    highlightCode(code, langKey, isDark)
      .then((value) => {
        if (!cancelled) setRendered({ code, language: langKey, isDark, html: value })
      })
      .catch(() => {
        if (!cancelled) setRendered(null)
      })
    return () => {
      cancelled = true
    }
  }, [code, langKey, isDark, isStreaming])
  const html =
    syncHtml ??
    (rendered?.code === code &&
    rendered.language === langKey &&
    rendered.isDark === isDark
      ? rendered.html
      : null)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard may be unavailable */
    }
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
          <button
            className="code-block__tool"
            onClick={() => void copy()}
            title={copied ? t('Copied') : t('Copy code')}
            aria-label={copied ? t('Copied') : t('Copy code')}
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
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

/**
 * A fenced code block drawn straight from its text, with no Markdown pass.
 *
 * `StreamingText` uses it while a fence is still open: the fence's content is
 * literal, so `Markdown` would re-parse the whole growing block on every frame
 * without producing anything a `CodeBlock` does not already show. The markup is
 * the one `Markdown`'s `pre` renderer produces, so closing the fence swaps in
 * the parsed block without a visual change.
 */
export const OpenFenceBlock = memo(function OpenFenceBlock({
  code,
  language,
  streaming
}: {
  code: string
  language?: string
  streaming: boolean
}) {
  return (
    <StreamingContext.Provider value={streaming}>
      <CodeBlock code={code} language={language} />
    </StreamingContext.Provider>
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
  const rawSearchQuery = useSearchQuery()
  const activeSearchQuery = useMemo(() => {
    const trimmed = rawSearchQuery.trim()
    if (!trimmed) return ''
    return children.toLowerCase().includes(trimmed.toLowerCase()) ? rawSearchQuery : ''
  }, [rawSearchQuery, children])
  const body = useMemo(
    () => (
      <SearchContext.Provider value={activeSearchQuery}>
        <ImageResolverContext.Provider value={resolveImage ?? null}>
          <ReactMarkdown
            remarkPlugins={stripHtml ? REMARK_PLUGINS_STRIPPED : REMARK_PLUGINS}
            components={markdownComponents}
          >
            {children}
          </ReactMarkdown>
        </ImageResolverContext.Provider>
      </SearchContext.Provider>
    ),
    [children, resolveImage, stripHtml, activeSearchQuery]
  )
  return (
    <ErrorBoundary inline scope="Markdown">
      <StreamingContext.Provider value={streaming}>
        {bare ? body : <div className="md">{body}</div>}
      </StreamingContext.Provider>
    </ErrorBoundary>
  )
})

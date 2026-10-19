import { memo, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { highlightCode } from '../lib/highlight'
import { useSearchQuery } from '../lib/search-context'

/** Wrap every occurrence of the search query in a `<mark>`. */
function Highlight({ children, query }: { children?: ReactNode; query: string }) {
  if (!query || typeof children !== 'string') return <>{children}</>
  const needle = query.toLowerCase()
  const parts = children.split(new RegExp(`(${escapeRegExp(query)})`, 'ig'))
  if (parts.length === 1) return <>{children}</>
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === needle ? <mark key={index}>{part}</mark> : part
      )}
    </>
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== 'light')

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setDark(document.documentElement.dataset.theme !== 'light')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return dark
}

interface CodeBlockProps {
  code: string
  language: string
}

const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const isDark = useIsDark()

  useEffect(() => {
    let cancelled = false
    highlightCode(code, language, isDark)
      .then((value) => {
        if (!cancelled) setHtml(value)
      })
      .catch(() => {
        if (!cancelled) setHtml(null)
      })
    return () => {
      cancelled = true
    }
  }, [code, language, isDark])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard may be unavailable */
    }
  }

  if (!html) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    )
  }

  return (
    <div className="code-block">
      <button className="code-block__copy" onClick={() => void copy()} title="Copy code">
        {copied ? <Check size={11} /> : <Copy size={11} />}
        {copied ? 'Copied' : 'Copy'}
      </button>
      <div className="shiki-host" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
})

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  const query = useSearchQuery()
  const marked = (label: ReactNode) => <Highlight query={query}>{label}</Highlight>

  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children: content, ...rest }) {
            const match = /language-([\w+-]+)/.exec(className ?? '')
            const text = String(content ?? '').replace(/\n$/, '')
            if (match) {
              return <CodeBlock code={text} language={match[1]} />
            }
            return (
              <code className={className} {...rest}>
                {content}
              </code>
            )
          },
          p({ children: content, ...rest }) {
            return <p {...rest}>{marked(content)}</p>
          },
          li({ children: content, ...rest }) {
            return <li {...rest}>{marked(content)}</li>
          },
          h1({ children: content, ...rest }) {
            return <h1 {...rest}>{marked(content)}</h1>
          },
          h2({ children: content, ...rest }) {
            return <h2 {...rest}>{marked(content)}</h2>
          },
          h3({ children: content, ...rest }) {
            return <h3 {...rest}>{marked(content)}</h3>
          },
          h4({ children: content, ...rest }) {
            return <h4 {...rest}>{marked(content)}</h4>
          },
          strong({ children: content, ...rest }) {
            return <strong {...rest}>{marked(content)}</strong>
          },
          em({ children: content, ...rest }) {
            return <em {...rest}>{marked(content)}</em>
          },
          a({ children: label, href, ...rest }) {
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
                {label as ReactNode}
              </a>
            )
          }
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})

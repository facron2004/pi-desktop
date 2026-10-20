import { isValidElement, memo, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy, MessageSquarePlus } from 'lucide-react'
import { highlightCode } from '../lib/highlight'
import { useSearchQuery } from '../lib/search-context'
import { useIsDark } from '../lib/theme'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'

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
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const isDark = useIsDark()
  const t = useT()

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
      {html ? (
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

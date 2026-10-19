import { memo, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { highlightCode } from '../lib/highlight'

function useIsDark(): boolean {
  return document.documentElement.dataset.theme !== 'light'
}

interface CodeBlockProps {
  code: string
  language: string
}

const CodeBlock = memo(function CodeBlock({ code, language }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null)
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

  if (!html) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    )
  }

  return <div className="shiki-host" dangerouslySetInnerHTML={{ __html: html }} />
})

export const Markdown = memo(function Markdown({ children }: { children: string }) {
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

import { memo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useAppStore } from '../../store/useAppStore'
import { useT } from '../../lib/i18n'

/**
 * A button that copies a text and says so for a moment.
 *
 * Tool output is often worth keeping, and copying it by hand out of a long log
 * is a nuisance.
 */
export const CopyButton = memo(function CopyButton({
  text,
  label,
  className = 'tool__reuse-icon'
}: {
  text: string | (() => string)
  label: string
  /** A row with its own action styles can give the button its own class. */
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const showToast = useAppStore((state) => state.showToast)
  const t = useT()
  if (!text) return null
  return (
    <button
      className={className}
      title={t(label)}
      aria-label={t(label)}
      onClick={() => {
        const payload = typeof text === 'function' ? text() : text
        if (!payload) return
        void navigator.clipboard
          .writeText(payload)
          .then(() => {
            setCopied(true)
            window.setTimeout(() => setCopied(false), 1600)
          })
          .catch(() => {
            showToast(t('The clipboard is not available'), 'error')
          })
      }}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  )
})

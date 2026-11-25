import { memo } from 'react'
import {
  CircleAlert,
  CornerDownRight,
  FileDiff,
  Quote,
  Wrench,
  X
} from 'lucide-react'
import type { InspectorRequest } from '@shared/types'
import type { SideChatReference } from '@shared/side-chat'
import { basename } from '../../lib/path'
import { useT } from '../../lib/i18n'
import { dispatchJumpMainTurn } from '../../lib/side-chat-context'

export interface SideChatRefChipProps {
  reference: SideChatReference
  onRemove?: (id: string) => void
  compact?: boolean
}

function summarizeReference(
  ref: SideChatReference,
  t: (key: string) => string
): { label: string; title: string } {
  switch (ref.kind) {
    case 'selection': {
      const compact = ref.snippet.replace(/\s+/g, ' ').trim()
      const label = compact.length > 72 ? `${compact.slice(0, 71)}…` : compact
      return {
        label: label || t('Selected text'),
        title: compact || t('Selected text')
      }
    }
    case 'turn': {
      const prefix = `${t('Turn')} #${ref.turnOrdinal}`
      const preview = ref.preview.replace(/\s+/g, ' ').trim()
      const full = preview ? `${prefix} · ${preview}` : prefix
      return {
        label: full,
        title: ref.turnId ? `${full} — ${t('Jump to main conversation')}` : full
      }
    }
    case 'tool': {
      const summary = ref.summary.replace(/\s+/g, ' ').trim()
      const full = summary ? `${ref.toolName} · ${summary}` : ref.toolName
      return {
        label: full,
        title: ref.turnId ? `${full} — ${t('Jump to main conversation')}` : full
      }
    }
    case 'error': {
      const msg = ref.message.replace(/\s+/g, ' ').trim()
      const full = ref.title ? `${ref.title}: ${msg}` : msg
      return {
        label: full || t('Error'),
        title: full || t('Error')
      }
    }
    case 'file-diff': {
      const name = basename(ref.filePath) || ref.filePath
      const range = ref.lineRange
        ? ref.lineRange.start === ref.lineRange.end
          ? `:${ref.lineRange.start}`
          : `:${ref.lineRange.start}-${ref.lineRange.end}`
        : ''
      return {
        label: `${name}${range}`,
        title: `${ref.filePath}${range}`
      }
    }
  }
}

export const SideChatRefChip = memo(function SideChatRefChip({
  reference,
  onRemove,
  compact = false
}: SideChatRefChipProps) {
  const t = useT()
  const { label, title } = summarizeReference(reference, t)

  const Icon =
    reference.kind === 'selection'
      ? Quote
      : reference.kind === 'turn'
        ? CornerDownRight
        : reference.kind === 'tool'
          ? Wrench
          : reference.kind === 'error'
            ? CircleAlert
            : FileDiff

  const canNavigate =
    reference.kind === 'file-diff' || Boolean(reference.turnId)

  const handleActivate = () => {
    if (reference.kind === 'file-diff') {
      window.dispatchEvent(
        new CustomEvent<InspectorRequest>('pi:open-inspector', {
          detail: {
            tab: 'changes',
            file: reference.filePath,
            line: reference.lineRange?.start
          }
        })
      )
      return
    }
    if (reference.turnId) {
      dispatchJumpMainTurn(reference.turnId)
    }
  }

  return (
    <span
      className={compact ? 'side-ref-chip side-ref-chip--compact' : 'side-ref-chip'}
      data-kind={reference.kind}
    >
      {canNavigate ? (
        <button
          type="button"
          className="side-ref-chip__main"
          onClick={handleActivate}
          title={title}
          aria-label={title}
        >
          <Icon size={12} className="side-ref-chip__icon" aria-hidden="true" />
          <span className="side-ref-chip__label">{label}</span>
        </button>
      ) : (
        <span className="side-ref-chip__main side-ref-chip__main--static" title={title}>
          <Icon size={12} className="side-ref-chip__icon" aria-hidden="true" />
          <span className="side-ref-chip__label">{label}</span>
        </span>
      )}
      {onRemove ? (
        <button
          type="button"
          className="side-ref-chip__remove"
          onClick={() => onRemove(reference.id)}
          title={t('Remove reference')}
          aria-label={t('Remove reference')}
        >
          <X size={11} aria-hidden="true" />
        </button>
      ) : null}
    </span>
  )
})

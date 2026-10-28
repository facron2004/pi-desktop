import { Check, ChevronDown } from 'lucide-react'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'

export function DiffScope({
  value,
  onChange
}: {
  value: 'local' | 'conversation'
  onChange: (value: 'local' | 'conversation') => void
}) {
  const t = useT()
  const label = (scope: 'local' | 'conversation') =>
    t(scope === 'local' ? 'Local changes' : 'Conversation changes')

  return (
    <Popover
      width={180}
      renderTrigger={({ open, toggle }) => (
        <button className="review__scope review__scope--button" type="button" aria-label={t('Change source')} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
          {label(value)} <ChevronDown size={12} />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" aria-label={t('Change source')}>
          {(['local', 'conversation'] as const).map((scope) => (
            <button
              key={scope}
              className="popover__item"
              type="button"
              role="menuitemradio"
              aria-checked={value === scope}
              onClick={() => { close(); onChange(scope) }}
            >
              <span className="popover__item-text">{label(scope)}</span>
              {value === scope ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}

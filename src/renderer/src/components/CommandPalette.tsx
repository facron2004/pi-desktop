import { useEffect, useRef } from 'react'
import { Command as CommandIcon } from 'lucide-react'
import type { PiCommand } from '@shared/types'
import { COMMAND_SOURCE } from '../lib/command-source'
import { useT } from '../lib/i18n'

interface CommandPaletteProps {
  commands: PiCommand[]
  query: string
  activeIndex: number
  onActiveChange: (index: number) => void
  onSelect: (command: PiCommand) => void
}

export function CommandPalette({
  commands,
  query,
  activeIndex,
  onActiveChange,
  onSelect
}: CommandPaletteProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const t = useT()

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div className="palette" ref={listRef} role="listbox" aria-label={t('Commands')}>
      <div className="palette__head">
        <CommandIcon size={12} />
        <span>
          {query ? (
            <>
              {t('Commands matching')} <code>/{query}</code>
            </>
          ) : (
            t('Commands')
          )}
        </span>
        <span className="palette__count">{commands.length}</span>
      </div>

      {commands.length === 0 ? (
        <div className="palette__empty">
          {t('No command matches')} <code>/{query}</code>.
          <br />
          {t('Try')} <code>/help</code> {t('or')} <code>/model</code>.
        </div>
      ) : (
        <div className="palette__list">
          {commands.map((command, index) => {
            const meta = COMMAND_SOURCE[command.source] ?? COMMAND_SOURCE.extension
            const Icon = meta.Icon
            const desc = command.description
              ? command.source === 'app'
                ? t(command.description)
                : command.description
              : undefined
            const tooltip = desc ? `/${command.name} — ${desc}` : `/${command.name}`

            return (
              <button
                key={`${command.source}-${command.name}`}
                className="palette__item"
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex}
                onMouseEnter={() => onActiveChange(index)}
                onClick={() => onSelect(command)}
                title={tooltip}
              >
                <span className="palette__icon">
                  <Icon size={12} />
                </span>
                <span className="palette__name">/{command.name}</span>
                {desc ? (
                  <span className="palette__desc" title={desc}>
                    {desc}
                  </span>
                ) : null}
                <span className={`palette__badge ${meta.className}`}>{meta.label}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="palette__foot">
        <kbd>↑</kbd>
        <span>{t('or')}</span>
        <kbd>↓</kbd>
        <span>{t('to navigate')}</span>
        <kbd>↵</kbd>
        <span>{t('to select')}</span>
        <kbd>Esc</kbd>
        <span>{t('to dismiss')}</span>
      </div>
    </div>
  )
}

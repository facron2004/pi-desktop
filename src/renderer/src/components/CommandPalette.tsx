import { useEffect, useRef } from 'react'
import { Command as CommandIcon } from 'lucide-react'
import type { AppLanguage, PiCommand } from '@shared/types'
import { appCommandName } from '../lib/app-commands'
import { COMMAND_SOURCE, commandIcon } from '../lib/command-source'
import { useT } from '../lib/i18n'

interface CommandPaletteProps {
  id?: string
  commands: PiCommand[]
  query: string
  activeIndex: number
  language: AppLanguage
  loading?: boolean
  onActiveChange: (index: number) => void
  onSelect: (command: PiCommand) => void
}

export function CommandPalette({
  id,
  commands,
  query,
  activeIndex,
  language,
  loading = false,
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
    <div className="palette" ref={listRef} id={id} role="listbox" aria-label={t('Commands')} aria-busy={loading}>
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
        <span className="palette__count">{loading ? '…' : commands.length}</span>
      </div>

      {commands.length === 0 ? (
        <div className="palette__empty">
          {loading ? (
            t('Loading skills…')
          ) : (
            <>
              {t('No command matches')} <code>/{query}</code>.
              <br />
              {t('Try')} <code>/help</code> {t('or')} <code>/model</code>.
            </>
          )}
        </div>
      ) : (
        <div className="palette__list">
          {commands.map((command, index) => {
            const meta = COMMAND_SOURCE[command.source] ?? COMMAND_SOURCE.extension
            const Icon = commandIcon(command)
            const desc = command.description ? t(command.description) : undefined
            const isLocalizedName = command.source === 'app' && language === 'zh-CN'
            const name = isLocalizedName
              ? appCommandName(command.name, language)
              : `/${command.name}`
            const tooltip = desc ? `${name} — ${desc}` : name

            return (
              <button
                key={`${command.source}-${command.name}`}
                id={id ? `${id}-option-${index}` : undefined}
                className="palette__item"
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex}
                onMouseEnter={() => onActiveChange(index)}
                onClick={() => onSelect(command)}
                title={tooltip}
              >
                <span className="palette__icon" data-source={command.source}>
                  <Icon size={12} />
                </span>
                <span className="palette__text">
                  <span
                    className="palette__name"
                    data-localized={isLocalizedName ? 'true' : undefined}
                  >
                    {name}
                  </span>
                  {desc ? (
                    <span className="palette__desc" title={desc}>
                      {desc}
                    </span>
                  ) : null}
                </span>
                <span className={`palette__badge ${meta.className}`}>{t(meta.label)}</span>
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

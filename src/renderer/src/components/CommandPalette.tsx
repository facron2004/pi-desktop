import { useEffect, useRef } from 'react'
import { AppWindow, Command as CommandIcon, FileText, Sparkles, Wrench } from 'lucide-react'
import type { PiCommand } from '@shared/types'

const SOURCE_META = {
  skill: { label: 'Skill', Icon: Sparkles, className: 'palette__badge--skill' },
  prompt: { label: 'Prompt', Icon: FileText, className: 'palette__badge--prompt' },
  extension: { label: 'Extension', Icon: Wrench, className: 'palette__badge--extension' },
  app: { label: 'App', Icon: AppWindow, className: 'palette__badge--app' }
} as const

export function filterCommands(commands: PiCommand[], query: string): PiCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return commands
  return commands.filter((command) => {
    if (command.name.toLowerCase().includes(needle)) return true
    return command.description?.toLowerCase().includes(needle) ?? false
  })
}

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

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  return (
    <div className="palette" ref={listRef} role="listbox" aria-label="Commands">
      <div className="palette__head">
        <CommandIcon size={12} />
        <span>
          {query ? (
            <>
              Commands matching <code>/{query}</code>
            </>
          ) : (
            'Commands'
          )}
        </span>
        <span className="palette__count">{commands.length}</span>
      </div>

      {commands.length === 0 ? (
        <div className="palette__empty">
          No command matches <code>/{query}</code>.
          <br />
          Try <code>/help</code> or <code>/model</code>.
        </div>
      ) : (
        <div className="palette__list">
          {commands.map((command, index) => {
            const meta = SOURCE_META[command.source] ?? SOURCE_META.extension
            const Icon = meta.Icon
            return (
              <button
                key={`${command.source}-${command.name}`}
                className="palette__item"
                role="option"
                aria-selected={index === activeIndex}
                data-active={index === activeIndex}
                onMouseEnter={() => onActiveChange(index)}
                onClick={() => onSelect(command)}
              >
                <span className="palette__icon">
                  <Icon size={12} />
                </span>
                <span className="palette__name">/{command.name}</span>
                {command.description ? (
                  <span className="palette__desc">{command.description}</span>
                ) : null}
                <span className={`palette__badge ${meta.className}`}>{meta.label}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="palette__foot">
        <kbd>↑</kbd>
        <kbd>↓</kbd>
        <span>to navigate</span>
        <kbd>↵</kbd>
        <span>to select</span>
        <kbd>esc</kbd>
        <span>to dismiss</span>
      </div>
    </div>
  )
}

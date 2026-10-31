import { useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ListChecks, Paperclip, Plus, Sparkles, Target, Wrench } from 'lucide-react'
import type { AgentMode, PiCommand } from '@shared/types'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'
import '../styles/add-menu.css'

type AddMenuPage = 'actions' | 'skills' | 'plugins'

const MODES = [
  { value: 'goal', label: 'Goal Mode', icon: Target, description: 'Continue until the goal is complete or blocked' },
  { value: 'plan', label: 'Plan Mode', icon: ListChecks, description: 'Explore and plan without changing files' }
] as const

const PAGES = [
  { page: 'plugins', label: 'Plugins', icon: Wrench },
  { page: 'skills', label: 'Skills', icon: Sparkles }
] as const

export function AddMenu({ ready, busy, mode, skillCommands, pluginCommands, onModeChange, onPickFiles, onInsertCommand }: {
  ready: boolean
  busy: boolean
  mode: AgentMode
  skillCommands: PiCommand[]
  pluginCommands: PiCommand[]
  onModeChange: (mode: AgentMode) => Promise<void>
  onPickFiles: () => Promise<void>
  onInsertCommand: (command: PiCommand) => void
}) {
  const t = useT()
  const [page, setPage] = useState<AddMenuPage>('actions')
  const panelRef = useRef<HTMLDivElement>(null)
  const returnPage = useRef<AddMenuPage>('actions')
  const commands = page === 'skills' ? skillCommands : pluginCommands

  const navigate = (next: AddMenuPage) => {
    if (next !== 'actions') returnPage.current = next
    setPage(next)
  }

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const target = page === 'actions'
      ? panel.querySelector<HTMLButtonElement>('[data-page="' + returnPage.current + '"]') ?? panel.querySelector<HTMLButtonElement>('button')
      : panel.querySelector<HTMLButtonElement>('.composer__add-back')
    target?.focus()
  }, [page])

  return (
    <Popover
      placement="top"
      width={280}
      className="composer__add-popover"
      renderTrigger={({ open, toggle }) => (
        <button
          type="button"
          className="icon-btn composer__add-trigger"
          aria-label={t('Add to message')}
          title={t('Add to message')}
          aria-expanded={open}
          disabled={!ready}
          onClick={(event) => {
            if (!open) {
              returnPage.current = 'actions'
              setPage('actions')
            }
            toggle(event)
          }}
        >
          <Plus size={17} />
        </button>
      )}
    >
      {(close) => (
        <div ref={panelRef} role="menu" aria-label={t('Add to message')} onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' && page !== 'actions') {
            event.preventDefault()
            event.stopPropagation()
            navigate('actions')
          }
        }}>
          {page === 'actions' ? (
            <>
              {MODES.map((entry) => {
                const Icon = entry.icon
                return (
                  <button key={entry.value} type="button" className="popover__item" role="menuitemcheckbox" aria-checked={mode === entry.value} disabled={busy} title={t(entry.description)} onClick={() => { close(); void onModeChange(mode === entry.value ? 'default' : entry.value) }}>
                    <Icon size={15} />
                    <span className="popover__item-text">{t(entry.label)}</span>
                    {mode === entry.value ? <Check size={14} /> : null}
                  </button>
                )
              })}
              <div className="composer__add-sep" role="separator" />
              <button type="button" className="popover__item" role="menuitem" onClick={() => { close(); void onPickFiles() }}>
                <Paperclip size={15} />
                <span className="popover__item-text">{t('Add files')}</span>
              </button>
              {PAGES.map((entry) => {
                const Icon = entry.icon
                return (
                  <button key={entry.page} type="button" className="popover__item" role="menuitem" data-page={entry.page} onClick={() => navigate(entry.page)}>
                    <Icon size={15} />
                    <span className="popover__item-text">{t(entry.label)}</span>
                    <ChevronRight size={13} />
                  </button>
                )
              })}
            </>
          ) : (
            <>
              <div className="composer__add-head">
                <button type="button" className="icon-btn composer__add-back" aria-label={t('Back')} title={t('Back')} onClick={() => navigate('actions')}>
                  <ChevronLeft size={15} />
                </button>
                <div className="popover__label">{t(page === 'skills' ? 'Skills' : 'Plugins')}</div>
              </div>
              {commands.length ? (
                <div className="composer__add-list">
                  {commands.map((command) => (
                    <button key={command.source + '-' + command.name} type="button" className="popover__item composer__add-command" role="menuitem" title={command.description} onClick={() => { close(); onInsertCommand(command) }}>
                      <span className="composer__add-command-name">/{command.name}</span>
                      {command.description ? <span className="composer__add-command-description">{command.description}</span> : null}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="composer__add-empty">{t(page === 'skills' ? 'No skills available' : 'No plugins available')}</div>
              )}
            </>
          )}
        </div>
      )}
    </Popover>
  )
}

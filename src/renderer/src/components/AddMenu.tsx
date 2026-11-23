import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ListChecks, Paperclip, Plus, Sparkles, WandSparkles, Workflow, Wrench } from 'lucide-react'
import type { AgentMode, PiCommand } from '@shared/types'
import { useT } from '../lib/i18n'
import type { mermaidTemplateList } from '../lib/mermaid-templates'
import { useAppStore } from '../store/useAppStore'
import { GoalTargetIcon } from './GoalTargetIcon'
import { Popover } from './Popover'
import '../styles/add-menu.css'

type AddMenuPage = 'actions' | 'skills' | 'plugins' | 'diagrams'
type DiagramTemplateItem = ReturnType<typeof mermaidTemplateList>[number]

const ACTIONS = [
  { key: 'files', label: 'Add files', description: 'Attach files from this project', icon: Paperclip },
  { key: 'goal', label: 'Goal', description: 'Set a goal to keep working toward', icon: GoalTargetIcon },
  { key: 'plan', label: 'Plan Mode', description: 'Explore read-only, then review a plan', icon: ListChecks },
  { key: 'image', label: 'Image generation', description: 'Generate a picture in the composer', icon: WandSparkles },
  { key: 'diagrams', label: 'Diagrams', description: 'Insert a Mermaid diagram template', icon: Workflow },
  { key: 'skills', label: 'Skills', description: 'Insert a Pi skill command', icon: Sparkles }
] as const

export const AddMenu = memo(function AddMenu({ ready, busy, imageMode, skillCommands, pluginCommands, onModeChange, onPickFiles, onInsertCommand, onEnterImageMode }: {
  ready: boolean
  busy: boolean
  imageMode?: boolean
  skillCommands: PiCommand[]
  pluginCommands: PiCommand[]
  onModeChange: (mode: AgentMode) => Promise<void>
  onPickFiles: () => Promise<void>
  onInsertCommand: (command: PiCommand) => void
  onEnterImageMode: () => void
}) {
  const t = useT()
  const language = useAppStore((state) => state.settings.language ?? 'en')
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const [diagramTemplates, setDiagramTemplates] = useState<DiagramTemplateItem[]>([])
  const [page, setPage] = useState<AddMenuPage>('actions')
  const panelRef = useRef<HTMLDivElement>(null)
  const returnPage = useRef<AddMenuPage>('actions')
  const commands = page === 'skills' ? skillCommands : pluginCommands
  const pageLabel = page === 'skills' ? 'Skills' : page === 'plugins' ? 'Plugins' : 'Diagrams'

  useEffect(() => {
    if (page !== 'diagrams') return
    let active = true
    void import('../lib/mermaid-templates').then((mod) => {
      if (active) setDiagramTemplates(mod.mermaidTemplateList(language))
    })
    return () => {
      active = false
    }
  }, [page, language])

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
      width={620}
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
              <div className="popover__label composer__add-section">{t('Add')}</div>
              <div className="composer__add-actions">
                {ACTIONS.map((entry) => {
                  const Icon = entry.icon
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      className="popover__item composer__add-action"
                      role="menuitem"
                      data-page={entry.key}
                      disabled={busy && (entry.key === 'goal' || entry.key === 'plan')}
                      title={t(entry.description)}
                      onClick={() => {
                        close()
                        if (entry.key === 'files') void onPickFiles()
                        else if (entry.key === 'goal') void onModeChange('goal')
                        else if (entry.key === 'plan') void onModeChange('plan')
                        else if (entry.key === 'image') onEnterImageMode()
                        else navigate(entry.key as AddMenuPage)
                      }}
                    >
                      <Icon size={16} className="composer__add-action-icon" />
                      <span className="composer__add-action-copy">
                        <span className="composer__add-action-label">{t(entry.label)}</span>
                        <span className="composer__add-action-description">{t(entry.description)}</span>
                      </span>
                      {(entry.key === 'diagrams' || entry.key === 'skills') ? <ChevronRight size={13} /> : null}
                      {entry.key === 'image' && imageMode ? <Check size={14} /> : null}
                    </button>
                  )
                })}
              </div>

              {pluginCommands.length ? (
                <>
                  <div className="composer__add-sep" role="separator" />
                  <div className="popover__label composer__add-section">{t('Plugins')}</div>
                  <div className="composer__add-list">
                    {pluginCommands.map((command) => (
                      <button key={command.source + '-' + command.name} type="button" className="popover__item composer__add-command" role="menuitem" title={command.description ? t(command.description) : undefined} onClick={() => { close(); onInsertCommand(command) }}>
                        <Wrench size={15} className="composer__add-command-icon" />
                        <span className="composer__add-command-copy">
                          <span className="composer__add-command-name">/{command.name}</span>
                          {command.description ? <span className="composer__add-command-description">{t(command.description)}</span> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <>
              <div className="composer__add-head">
                <button type="button" className="icon-btn composer__add-back" aria-label={t('Back')} title={t('Back')} onClick={() => navigate('actions')}>
                  <ChevronLeft size={15} />
                </button>
                <div className="popover__label">{t(pageLabel)}</div>
              </div>
              {page === 'diagrams' ? (
                <div className="composer__add-list">
                  {diagramTemplates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      className="popover__item composer__add-command composer__add-template"
                      role="menuitem"
                      data-template={template.id}
                      title={template.description}
                      onClick={() => { close(); insertIntoComposer(template.prompt) }}
                    >
                      <span className="composer__add-command-name">{template.name}</span>
                      <span className="composer__add-command-description">{template.description}</span>
                    </button>
                  ))}
                </div>
              ) : commands.length ? (
                <div className="composer__add-list">
                  {commands.map((command) => (
                    <button key={command.source + '-' + command.name} type="button" className="popover__item composer__add-command" role="menuitem" title={command.description ? t(command.description) : undefined} onClick={() => { close(); onInsertCommand(command) }}>
                      <span className="composer__add-command-name">/{command.name}</span>
                      {command.description ? <span className="composer__add-command-description">{t(command.description)}</span> : null}
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
})

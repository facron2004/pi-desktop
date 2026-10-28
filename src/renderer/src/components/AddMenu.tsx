import { useState, type RefObject } from 'react'
import {
  ChevronLeft,
  FolderOpen,
  Paperclip,
  Plus,
  Settings2,
  Sparkles,
  Terminal,
  Wrench
} from 'lucide-react'
import type { PiCommand } from '@shared/types'
import { useT } from '../lib/i18n'
import { Popover } from './Popover'

type AddMenuPage = 'actions' | 'skills' | 'plugins'

/**
 * Everything that is added to a message, behind one button on the left of the
 * composer bar.
 *
 * The trigger is a gear: the same menu also leads to the app's own settings,
 * which is where the user goes for the rest of the machinery. Files, images,
 * commands, skills and plugins all insert into the message and are one page
 * away.
 */
export function AddMenu({
  ready,
  fileRef,
  skillCommands,
  pluginCommands,
  onBrowseCommands,
  onInsertFile,
  onInsertCommand,
  onOpenSettings
}: {
  ready: boolean
  fileRef: RefObject<HTMLInputElement | null>
  skillCommands: PiCommand[]
  pluginCommands: PiCommand[]
  onBrowseCommands: () => void
  onInsertFile: () => void
  onInsertCommand: (command: PiCommand) => void
  onOpenSettings: () => void
}) {
  const t = useT()
  const [page, setPage] = useState<AddMenuPage>('actions')

  const commands = page === 'skills' ? skillCommands : pluginCommands

  return (
    <Popover
      placement="top"
      width={268}
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
            if (!open) setPage('actions')
            toggle(event)
          }}
        >
          <Plus size={16} />
        </button>
      )}
    >
      {(close) =>
        page === 'actions' ? (
          <div>
            <button
              className="popover__item"
              onClick={() => {
                close()
                onInsertFile()
              }}
            >
              <FolderOpen size={14} />
              <span className="popover__item-text">{t('Insert a project file')}</span>
            </button>
            <button
              className="popover__item"
              onClick={() => {
                close()
                fileRef.current?.click()
              }}
            >
              <Paperclip size={14} />
              <span className="popover__item-text">{t('Add image attachment')}</span>
            </button>
            <button
              className="popover__item"
              onClick={() => {
                close()
                onBrowseCommands()
              }}
            >
              <Terminal size={14} />
              <span className="popover__item-text">{t('Browse commands')}</span>
            </button>
            <button className="popover__item" onClick={() => setPage('skills')}>
              <Sparkles size={14} />
              <span className="popover__item-text">{t('Skills')}</span>
              <span className="composer__add-count">{skillCommands.length}</span>
            </button>
            <button className="popover__item" onClick={() => setPage('plugins')}>
              <Wrench size={14} />
              <span className="popover__item-text">{t('Plugins')}</span>
              <span className="composer__add-count">{pluginCommands.length}</span>
            </button>
            <div className="composer__add-sep" />
            <button
              className="popover__item"
              onClick={() => {
                close()
                onOpenSettings()
              }}
            >
              <Settings2 size={14} />
              <span className="popover__item-text">{t('Settings')}</span>
            </button>
          </div>
        ) : (
          <div>
            <div className="composer__add-head">
              <button
                className="icon-btn composer__add-back"
                aria-label={t('Back')}
                title={t('Back')}
                onClick={() => setPage('actions')}
              >
                <ChevronLeft size={14} />
              </button>
              <div className="popover__label">{t(page === 'skills' ? 'Skills' : 'Plugins')}</div>
              <span className="composer__add-count">{commands.length}</span>
            </div>
            {commands.length ? (
              <div className="composer__add-list">
                {commands.map((command) => (
                  <button
                    key={`${command.source}-${command.name}`}
                    className="popover__item composer__add-command"
                    title={command.description}
                    onClick={() => {
                      close()
                      onInsertCommand(command)
                    }}
                  >
                    <span className="composer__add-command-name">/{command.name}</span>
                    {command.description ? (
                      <span className="composer__add-command-description">
                        {command.description}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="composer__add-empty">
                {t(page === 'skills' ? 'No skills available' : 'No plugins available')}
              </div>
            )}
          </div>
        )
      }
    </Popover>
  )
}

import { memo, useState } from 'react'
import { ChevronRight, CornerDownLeft, Play, SquareTerminal } from 'lucide-react'
import type { BashItem } from '../../lib/thread'
import { useAppStore } from '../../store/useAppStore'
import { useT } from '../../lib/i18n'
import { CopyButton } from './CopyButton'
import { LogOutput } from './LogOutput'
import { runInTerminal } from './tool-actions'

/**
 * A command Pi ran itself, rather than through a tool call.
 *
 * The output arrives in chunks while the command runs, so the card keeps the
 * body closed until it is asked for. The body is line-paged: a build log can
 * be thousands of lines, and the transcript must not carry them all at once.
 */
export const CommandOutput = memo(function CommandOutput({ item }: { item: BashItem }) {
  const [manualOpen, setManualOpen] = useState<boolean>()
  const insertIntoComposer = useAppStore((state) => state.insertIntoComposer)
  const t = useT()
  const running = item.exitCode === undefined
  const failed = item.exitCode !== undefined && item.exitCode !== 0
  const status = failed ? 'error' : running ? 'running' : 'ok'
  const open = manualOpen ?? failed
  const toggleOpen = () => setManualOpen(!open)

  return (
    <div className="tool" data-tone="command" data-status={status}>
      <div className="tool__head">
        <button className="tool__head-main" aria-expanded={open} onClick={toggleOpen}>
          <span className="tool__icon">
            <SquareTerminal size={12} strokeWidth={2.2} />
          </span>
          <span className="tool__name">{item.excludeFromContext ? '!!bash' : 'bash'}</span>
          <span className="tool__summary">{item.command || t('running…')}</span>
          {item.excludeFromContext ? (
            <span className="tool__status" title={t('Excluded from model context')}>
              {t('no context')}
            </span>
          ) : null}
          {running ? (
            <span className="spinner" />
          ) : failed ? (
            <span className="tool__status">
              {t('exit')} {item.exitCode}
            </span>
          ) : null}
          <span className="tool__state" data-state={status}>
            {t(failed ? 'Failed' : running ? 'Running' : 'Completed')}
          </span>
        </button>
        {item.command ? (
          <>
            <button
              className="tool__reuse-icon"
              title={t('Reuse this command')}
              aria-label={t('Reuse this command')}
              onClick={() =>
                insertIntoComposer(
                  item.excludeFromContext ? `!!${item.command}` : `!${item.command}`
                )
              }
            >
              <CornerDownLeft size={12} />
            </button>
            <button
              className="tool__reuse-icon"
              title={t('Run in terminal')}
              aria-label={t('Run in terminal')}
              onClick={() => runInTerminal(item.command)}
            >
              <Play size={12} />
            </button>
          </>
        ) : null}
        <CopyButton text={item.output} label="Copy the output" />
        <button
          className="tool__caret"
          onClick={toggleOpen}
          aria-label={open ? t('Collapse') : t('Expand')}
          aria-expanded={open}
        >
          <ChevronRight size={13} className="caret" data-open={open} />
        </button>
      </div>

      {open ? (
        <div className="tool__body">
          {item.output ? (
            <LogOutput text={item.output} className={failed ? 'tool__error' : undefined} />
          ) : (
            <pre className="tool__pre">{t('No output.')}</pre>
          )}
        </div>
      ) : null}
    </div>
  )
})

/** The historical name: a bash execution card is a command output card. */
export const BashCard = CommandOutput

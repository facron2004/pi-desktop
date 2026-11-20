import { memo, useState } from 'react'
import { ChevronRight, CircleAlert, CornerDownLeft, Play, SquareTerminal } from 'lucide-react'
import type { BashItem } from '../../lib/thread'
import { commandSummary } from '../../lib/tools'
import { useT } from '../../lib/i18n'
import { CopyButton } from './CopyButton'
import { LogOutput } from './LogOutput'
import { useThreadEnv } from './ThreadEnvContext'
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
  const { insertIntoComposer } = useThreadEnv()
  const t = useT()
  const running = item.exitCode === undefined
  const failed = item.exitCode !== undefined && item.exitCode !== 0
  const status = failed ? 'error' : running ? 'running' : 'ok'
  const open = manualOpen ?? failed
  const toggleOpen = () => setManualOpen(!open)
  const Icon = failed ? CircleAlert : SquareTerminal

  return (
    <div className="tool tool--link" data-tone="command" data-status={status}>
      <div className="tool-link">
        <button
          type="button"
          className="tool-link__toggle"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          <ChevronRight size={13} className="caret" data-open={open} />
          <span className="tool-link__icon">
            <Icon size={12} strokeWidth={2.2} />
          </span>
          <span className="tool-link__verb">
            {t(failed ? 'Command failed' : running ? 'Running command' : 'Ran command')}
          </span>
        </button>
        {item.command ? (
          <button
            type="button"
            className="tool-link__target"
            title={item.command}
            onClick={toggleOpen}
          >
            {commandSummary(item.command)}
          </button>
        ) : null}
        {item.excludeFromContext ? (
          <span className="tool-link__state" title={t('Excluded from model context')}>
            {t('no context')}
          </span>
        ) : null}
        {failed && item.exitCode !== undefined ? (
          <span className="tool-link__state" data-state="error">
            {t('exit')} {item.exitCode}
          </span>
        ) : null}
      </div>

      {open ? (
        <div className="tool__body">
          {item.command ? <pre className="tool__pre">{item.command}</pre> : null}
          {item.command || item.output ? (
            <div className="tool__command-actions">
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
            </div>
          ) : null}
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

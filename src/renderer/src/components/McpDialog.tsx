import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, FileJson, RefreshCw, Server, ShieldOff, X } from 'lucide-react'
import type { McpConfig, McpServerInfo } from '@shared/types'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useT } from '../lib/i18n'
import '../styles/mcp.css'

type LoadState = 'loading' | 'error' | 'ready'

/**
 * The MCP servers the Pi process would load, read from both configuration
 * files. The dialog is deliberately read-only and never connects to a server:
 * the runtime owns connections, this only shows what is configured.
 */
export function McpDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogFocus(dialogRef, onClose)
  const [config, setConfig] = useState<McpConfig | null>(null)
  const [state, setState] = useState<LoadState>('loading')

  const load = useCallback(async () => {
    setState('loading')
    try {
      setConfig(await window.pi.mcp.read())
      setState('ready')
    } catch {
      setState('error')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const servers = config?.servers ?? []
  const enabled = servers.filter((server) => server.enabled).length
  const projectServers = servers.filter((server) => server.scope !== 'user').length

  return (
    <div className="modal-layer" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="modal mcp-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="mcp-title" className="modal__title">
            {t('MCP servers')}
          </h2>
          {state === 'ready' ? (
            <span className="mcp__stats">
              {enabled}/{servers.length} {t('enabled')}
              {projectServers > 0 ? ` · ${projectServers} ${t('from the project')}` : ''}
            </span>
          ) : null}
          <span style={{ flex: 1 }} />
          <button
            className="icon-btn"
            onClick={() => void load()}
            aria-label={t('Refresh')}
            title={t('Refresh')}
          >
            <RefreshCw size={13} className={state === 'loading' ? 'spin' : undefined} />
          </button>
          <button className="icon-btn" onClick={onClose} aria-label={t('Close')} title={t('Close')}>
            <X size={15} />
          </button>
        </div>

        <div className="mcp__body">
          {state === 'loading' ? (
            <div className="mcp__state">
              <RefreshCw size={13} className="spin" />
              {t('Reading the MCP configuration…')}
            </div>
          ) : state === 'error' || !config ? (
            <div className="mcp__state" data-tone="error">
              <AlertTriangle size={13} />
              {t('Could not read the MCP configuration.')}
            </div>
          ) : (
            <>
              <div className="mcp__files">
                <div className="mcp__file" data-missing={!config.userExists || undefined}>
                  <FileJson size={12} />
                  <span className="mcp__file-scope">{t('User configuration')}</span>
                  <span className="mcp__file-path" title={config.userPath}>
                    {config.userPath}
                  </span>
                  {!config.userExists ? (
                    <span className="mcp__file-badge">{t('not found')}</span>
                  ) : null}
                </div>
                <div className="mcp__file" data-missing={!config.projectExists || undefined}>
                  <FileJson size={12} />
                  <span className="mcp__file-scope">{t('Project configuration')}</span>
                  <span className="mcp__file-path" title={config.projectPath}>
                    {config.projectPath || '—'}
                  </span>
                  {!config.projectExists ? (
                    <span className="mcp__file-badge">{t('not found')}</span>
                  ) : null}
                </div>
              </div>

              {config.projectIgnored ? (
                <p className="mcp__trust">
                  <ShieldOff size={12} />
                  {t('The project MCP configuration is ignored while project trust is off.')}
                </p>
              ) : null}

              {config.errors.map((error) => (
                <p className="mcp__error" key={error}>
                  <AlertTriangle size={12} />
                  {error}
                </p>
              ))}

              {servers.length === 0 ? (
                <div className="mcp__empty">
                  <p>{t('No MCP servers are configured.')}</p>
                  <p className="mcp__empty-hint">
                    {t('Add servers with “pi mcp add …” or edit the JSON files above.')}
                  </p>
                </div>
              ) : (
                <ul className="mcp__list">
                  {servers.map((server) => (
                    <McpServerRow key={server.name} server={server} />
                  ))}
                </ul>
              )}

              <p className="mcp__note">
                {t('Read-only view: the dialog never connects to a server.')}
              </p>
            </>
          )}
        </div>

        <div className="modal__foot">
          <button className="btn" onClick={onClose}>
            {t('Close')}
          </button>
        </div>
      </div>
    </div>
  )
}

function McpServerRow({ server }: { server: McpServerInfo }) {
  const t = useT()
  const commandLine = [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
  const meta = [
    server.timeout ? `${t('timeout')} ${server.timeout}s` : null,
    server.envKeys.length > 0 ? `${t('env')}: ${server.envKeys.join(', ')}` : null,
    server.headerKeys.length > 0 ? `${t('headers')}: ${server.headerKeys.join(', ')}` : null
  ].filter((part): part is string => Boolean(part))

  return (
    <li className="mcp__server" data-disabled={!server.enabled || undefined}>
      <div className="mcp__server-head">
        <Server size={13} className="mcp__server-icon" />
        <span className="mcp__server-name">{server.name}</span>
        <span className="mcp__badge" data-kind="scope">
          {server.scope === 'both'
            ? t('project override')
            : server.scope === 'project'
              ? t('project')
              : t('user')}
        </span>
        <span className="mcp__badge" data-kind="transport">
          {server.transport === 'unknown' ? t('unknown') : server.transport}
        </span>
        {!server.enabled ? (
          <span className="mcp__badge" data-kind="disabled">
            {t('disabled')}
          </span>
        ) : null}
        {server.overrideOnly ? (
          <span className="mcp__badge" data-kind="override">
            {t('options only')}
          </span>
        ) : null}
      </div>
      {server.description ? <p className="mcp__server-desc">{server.description}</p> : null}
      <div className="mcp__server-cmd" title={server.url ?? commandLine}>
        {server.transport === 'http' && server.url ? server.url : commandLine || '—'}
      </div>
      {meta.length > 0 ? <div className="mcp__server-meta">{meta.join(' · ')}</div> : null}
    </li>
  )
}

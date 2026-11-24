import { useCallback, useEffect, useMemo, useState } from 'react'
import { MessageSquare, Plus, Trash2 } from 'lucide-react'
import type { ImChannelConfig, ImChannelStatus, RemoteWorkspace } from '@shared/types'
import type { SessionMeta } from '@shared/types'
import { useAppStore } from '../store/useAppStore'
import { useT } from '../lib/i18n'
import { Switch } from './Switch'
import type { ImChannelKind } from '@shared/types'
import '../styles/remote-access-settings.css'

type EditState = {
  kind: ImChannelKind
  id?: string
  /** Editing keeps the channel's own switch; it does not imply "on". */
  enabled: boolean
  appId: string
  appSecret: string
  allowedChatIds: string
  bridgeUrl: string
  bridgeToken: string
  listenPort: number
  receiveToken: string
  sendTo: string
  sendToIsRoom: boolean
  workspaceId: string
  sessionId: string
}

const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:3001'
const DEFAULT_LISTEN_PORT = 8740

function emptyEdit(kind: ImChannelKind): EditState {
  return {
    kind,
    enabled: true,
    appId: '',
    appSecret: '',
    allowedChatIds: '',
    bridgeUrl: kind === 'wechat' ? DEFAULT_BRIDGE_URL : '',
    bridgeToken: '',
    listenPort: DEFAULT_LISTEN_PORT,
    receiveToken: '',
    sendTo: '',
    sendToIsRoom: false,
    workspaceId: '',
    sessionId: ''
  }
}

function editFromStatus(status: ImChannelStatus): EditState {
  const base = emptyEdit(status.kind)
  return {
    ...base,
    id: status.id,
    enabled: status.enabled,
    appId: status.feishu?.appId ?? '',
    allowedChatIds: (status.feishu?.allowedChatIds ?? []).join('\n'),
    bridgeUrl: status.wechat?.bridgeUrl ?? DEFAULT_BRIDGE_URL,
    listenPort: status.wechat?.listenPort ?? DEFAULT_LISTEN_PORT,
    sendTo: status.wechat?.sendTo ?? '',
    sendToIsRoom: status.wechat?.sendToIsRoom ?? false,
    workspaceId: status.binding.workspaceId,
    sessionId: status.binding.sessionId
  }
}

function stateLabel(status: ImChannelStatus, t: (text: string) => string): string {
  if (!status.enabled) return t('Disabled')
  switch (status.state) {
    case 'connected': return t('Connected')
    case 'connecting': return t('Connecting')
    case 'error': return t('Connection error')
    default: return t('Disabled')
  }
}

export function ImChannelSettings() {
  const t = useT()
  const workspaces = useAppStore((state) => state.settings.workspaces)
  const [channels, setChannels] = useState<ImChannelStatus[]>([])
  const [editing, setEditing] = useState<EditState | null>(null)
  const [formSessions, setFormSessions] = useState<SessionMeta[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    try {
      setChannels(await window.pi.imChannels.status())
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Could not read IM channel status'))
    }
  }, [t])

  useEffect(() => {
    void refresh()
    return window.pi.imChannels.onChanged((next) => setChannels(next))
  }, [refresh])

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === editing?.workspaceId),
    [workspaces, editing?.workspaceId]
  )

  useEffect(() => {
    if (!selectedWorkspace) {
      setFormSessions([])
      return
    }
    let cancelled = false
    void window.pi.sessions.list(selectedWorkspace.path).then((sessions) => {
      if (!cancelled) setFormSessions(sessions)
    }).catch(() => {
      if (!cancelled) setFormSessions([])
    })
    return () => { cancelled = true }
  }, [selectedWorkspace])

  const openEditor = (status?: ImChannelStatus) => {
    setConfirmRemove(null)
    setTestResult({})
    setEditing(status ? editFromStatus(status) : emptyEdit('feishu'))
  }

  const saveChannel = async () => {
    if (!editing) return
    setBusy(true)
    setError('')
    try {
      const config: ImChannelConfig = {
        id: editing.id ?? '',
        kind: editing.kind,
        enabled: editing.enabled,
        binding: { workspaceId: editing.workspaceId, sessionId: editing.sessionId },
        ...(editing.kind === 'feishu'
          ? {
              feishu: {
                appId: editing.appId,
                appSecret: editing.appSecret,
                allowedChatIds: editing.allowedChatIds.split('\n').map((id) => id.trim()).filter(Boolean)
              }
            }
          : {
              wechat: {
                bridgeUrl: editing.bridgeUrl,
                bridgeToken: editing.bridgeToken,
                listenPort: editing.listenPort,
                receiveToken: editing.receiveToken,
                sendTo: editing.sendTo,
                sendToIsRoom: editing.sendToIsRoom
              }
            })
      }
      const next = await window.pi.imChannels.save(config)
      setChannels(next)
      setEditing(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Could not save the channel'))
    } finally {
      setBusy(false)
    }
  }

  const setChannelEnabled = async (status: ImChannelStatus, enabled: boolean) => {
    setBusy(true)
    setError('')
    try {
      const next = await window.pi.imChannels.save({
        id: status.id,
        kind: status.kind,
        enabled,
        binding: status.binding,
        ...(status.kind === 'feishu'
          ? { feishu: { appId: status.feishu?.appId ?? '', appSecret: '', allowedChatIds: status.feishu?.allowedChatIds ?? [] } }
          : {
              wechat: {
                bridgeUrl: status.wechat?.bridgeUrl ?? DEFAULT_BRIDGE_URL,
                bridgeToken: '',
                listenPort: status.wechat?.listenPort ?? DEFAULT_LISTEN_PORT,
                receiveToken: '',
                sendTo: status.wechat?.sendTo ?? '',
                sendToIsRoom: status.wechat?.sendToIsRoom ?? false
              }
            })
      })
      setChannels(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Could not change the channel'))
    } finally {
      setBusy(false)
    }
  }

  const removeChannel = async (id: string) => {
    setBusy(true)
    setError('')
    try {
      setChannels(await window.pi.imChannels.remove(id))
      setConfirmRemove(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('Could not remove the channel'))
    } finally {
      setBusy(false)
    }
  }

  const runTest = async (id: string) => {
    try {
      const result = await window.pi.imChannels.test(id)
      setTestResult((current) => ({
        ...current,
        [id]: result.ok ? t('Connection is working') : (result.error ?? t('Connection failed'))
      }))
    } catch (cause) {
      setTestResult((current) => ({
        ...current,
        [id]: cause instanceof Error ? cause.message : t('Connection failed')
      }))
    }
  }

  const copyCallbackUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      setError(t('Could not copy the address'))
    }
  }

  const workspaceName = (id: string): string =>
    workspaces.find((workspace: RemoteWorkspace) => workspace.id === id)?.name ?? id

  const sessionName = (channel: ImChannelStatus): string => {
    if (formSessions.length && editing?.id === channel.id) {
      const hit = formSessions.find((session) => session.id === channel.binding.sessionId)
      if (hit) return hit.name || hit.preview || hit.id
    }
    return channel.binding.sessionId
  }

  return (
    <div className="settings-page settings-page--compact remote-access-settings">
      <header className="settings-page-head">
        <h3>{t('IM channels')}</h3>
        <p>{t('Bridge Feishu and WeChat to a conversation: messages drive the agent, answers come back, and runs push their results.')}</p>
      </header>

      <section className="settings-group">
        <div className="settings-group__head"><h4>{t('Channels')}</h4></div>
        <div className="settings-fields">
          {channels.map((channel) => (
            <div className="settings-item-row settings-item-row--agent" key={channel.id}>
              <div className="settings-item-row__info remote-access-device">
                <MessageSquare size={16} />
                <span>
                  <strong>{channel.kind === 'feishu' ? t('Feishu') : t('WeChat')}</strong>
                  <small>
                    {workspaceName(channel.binding.workspaceId)} · {sessionName(channel)} · {stateLabel(channel, t)}
                    {channel.error ? ` · ${channel.error}` : ''}
                  </small>
                  {testResult[channel.id] ? <small>{testResult[channel.id]}</small> : null}
                </span>
              </div>
              <div className="im-channel-row-actions">
                <button type="button" className="btn btn--sm" disabled={busy || !channel.enabled} onClick={() => void runTest(channel.id)}>
                  {t('Test')}
                </button>
                <button type="button" className="btn btn--sm" disabled={busy} onClick={() => openEditor(channel)}>
                  {t('Edit')}
                </button>
                {confirmRemove === channel.id ? (
                  <button type="button" className="btn btn--sm btn--danger" disabled={busy} onClick={() => void removeChannel(channel.id)}>
                    {t('Confirm removal')}
                  </button>
                ) : (
                  <button
                    type="button"
                    className="icon-btn remote-access-revoke"
                    aria-label={t('Remove channel')}
                    title={t('Remove channel')}
                    disabled={busy}
                    onClick={() => setConfirmRemove(channel.id)}
                  ><Trash2 size={15} /></button>
                )}
                <Switch
                  checked={channel.enabled}
                  disabled={busy}
                  label={t('Enable channel')}
                  onChange={(value) => void setChannelEnabled(channel, value)}
                />
              </div>
            </div>
          ))}
          {!channels.length ? <p className="remote-access-empty">{t('No IM channels yet. Add Feishu or WeChat to start.')}</p> : null}
        </div>
      </section>

      {!editing ? (
        <section className="settings-group">
          <div className="remote-access-new-pairing">
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => setEditing(emptyEdit('feishu'))}>
              <Plus size={13} /> {t('Add Feishu channel')}
            </button>
            <button type="button" className="btn btn--sm" disabled={busy} onClick={() => setEditing(emptyEdit('wechat'))}>
              <Plus size={13} /> {t('Add WeChat channel')}
            </button>
          </div>
        </section>
      ) : (
        <section className="settings-group">
          <div className="settings-group__head">
            <h4>{editing.id ? t('Edit channel') : (editing.kind === 'feishu' ? t('Add Feishu channel') : t('Add WeChat channel'))}</h4>
          </div>
          <div className="settings-fields im-channel-form">
            <label className="settings-item-row__info im-channel-field">
              <span className="settings-item-row__title">{t('Project')}</span>
              <select
                value={editing.workspaceId}
                onChange={(event) => setEditing({ ...editing, workspaceId: event.target.value, sessionId: '' })}
              >
                <option value="">{t('Pick a project…')}</option>
                {workspaces.map((workspace: RemoteWorkspace) => (
                  <option value={workspace.id} key={workspace.id}>{workspace.name}</option>
                ))}
              </select>
            </label>
            <label className="settings-item-row__info im-channel-field">
              <span className="settings-item-row__title">{t('Conversation')}</span>
              <select
                value={editing.sessionId}
                disabled={!editing.workspaceId}
                onChange={(event) => setEditing({ ...editing, sessionId: event.target.value })}
              >
                <option value="">{t('Pick a conversation…')}</option>
                {formSessions.map((session) => (
                  <option value={session.id} key={session.id}>{session.name || session.preview || session.id}</option>
                ))}
              </select>
            </label>

            {editing.kind === 'feishu' ? (
              <>
                <label className="settings-item-row__info im-channel-field">
                  <span className="settings-item-row__title">App ID</span>
                  <input value={editing.appId} onChange={(event) => setEditing({ ...editing, appId: event.target.value })} />
                </label>
                <label className="settings-item-row__info im-channel-field">
                  <span className="settings-item-row__title">App Secret</span>
                  <input
                    type="password"
                    value={editing.appSecret}
                    placeholder={editing.id ? t('Already set — leave empty to keep') : ''}
                    onChange={(event) => setEditing({ ...editing, appSecret: event.target.value })}
                  />
                </label>
                <label className="settings-item-row__info im-channel-field">
                  <span className="settings-item-row__title">{t('Allowed chat IDs (optional, one per line)')}</span>
                  <textarea
                    rows={2}
                    value={editing.allowedChatIds}
                    onChange={(event) => setEditing({ ...editing, allowedChatIds: event.target.value })}
                  />
                </label>
                <p className="im-channel-hint">
                  {t('Create a custom app on the Feishu open platform, enable the bot, subscribe to the im.message.receive_v1 event in long-connection mode, grant im:message and im:message:send_as_bot, then publish the version.')}
                </p>
              </>
            ) : (
              <>
                <label className="settings-item-row__info im-channel-field">
                  <span className="settings-item-row__title">{t('Bridge URL')}</span>
                  <input
                    value={editing.bridgeUrl}
                    placeholder={DEFAULT_BRIDGE_URL}
                    onChange={(event) => setEditing({ ...editing, bridgeUrl: event.target.value })}
                  />
                </label>
                <label className="settings-item-row__info im-channel-field">
                  <span className="settings-item-row__title">{t('Bridge personal token')}</span>
                  <input
                    type="password"
                    value={editing.bridgeToken}
                    placeholder={editing.id ? t('Already set — leave empty to keep') : ''}
                    onChange={(event) => setEditing({ ...editing, bridgeToken: event.target.value })}
                  />
                </label>
                <label className="settings-item-row__info im-channel-field">
                  <span className="settings-item-row__title">{t('Listen port')}</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={editing.listenPort}
                    onChange={(event) => setEditing({ ...editing, listenPort: Number(event.target.value) })}
                  />
                </label>
                <label className="settings-item-row__info im-channel-field">
                  <span className="settings-item-row__title">{t('Receive token')}</span>
                  <input
                    type="password"
                    value={editing.receiveToken}
                    placeholder={editing.id ? t('Already set — leave empty to keep') : ''}
                    onChange={(event) => setEditing({ ...editing, receiveToken: event.target.value })}
                  />
                </label>
                <label className="settings-item-row__info im-channel-field">
                  <span className="settings-item-row__title">{t('Reply target (optional)')}</span>
                  <input
                    value={editing.sendTo}
                    placeholder={t('Contact or group name — empty tracks the last sender')}
                    onChange={(event) => setEditing({ ...editing, sendTo: event.target.value })}
                  />
                  <span className="settings-item-row__desc">
                    <input
                      type="checkbox"
                      checked={editing.sendToIsRoom}
                      onChange={(event) => setEditing({ ...editing, sendToIsRoom: event.target.checked })}
                    />{' '}
                    {t('The reply target is a group chat')}
                  </span>
                </label>
                {editing.id && channels.find((channel) => channel.id === editing.id)?.wechat ? (
                  <div className="remote-access-address">
                    <code>{channels.find((channel) => channel.id === editing.id)?.wechat?.callbackUrl}</code>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => void copyCallbackUrl(channels.find((channel) => channel.id === editing.id)?.wechat?.callbackUrl ?? '')}
                    >
                      {t('Copy address')}
                    </button>
                  </div>
                ) : null}
                <p className="im-channel-hint">
                  {t('Run the open-source wechatbot-webhook bridge (npx wechatbot-webhook), scan the QR code to log in, set the copied address above as the bridge RECVD_MSG_API environment variable, and fill in the bridge personal token. Pi Desktop never hooks the WeChat client; the web protocol is a third-party open-source project with account-limit risks — assess them yourself.')}
                </p>
              </>
            )}

            <div className="remote-access-new-pairing">
              <button type="button" className="btn btn--sm" disabled={busy || !editing.workspaceId || !editing.sessionId} onClick={() => void saveChannel()}>
                {busy ? t('Saving…') : t('Save')}
              </button>
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => setEditing(null)}>
                {t('Cancel')}
              </button>
            </div>
          </div>
        </section>
      )}

      {error ? <div className="remote-access-error">{error}</div> : null}
    </div>
  )
}

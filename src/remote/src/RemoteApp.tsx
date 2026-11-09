import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { ChevronLeft, ChevronRight, Folder, MessageSquare, Monitor, MoreHorizontal, Send } from 'lucide-react'
import {
  MAX_REMOTE_MESSAGE_CHARS,
  type AgentMessage,
  type PiEvent,
  type RemoteAccessDevice,
  type RemoteSession,
  type RemoteWorkspace
} from '@shared/types'
import { applyEvent, itemsFromMessages, type ThreadItem } from '@renderer/lib/thread'
import { beginStream } from '@renderer/lib/stream-events'

const TOKEN_KEY = 'pi-desktop.remote.token'

interface ApiError extends Error {
  status?: number
}

interface SessionDetail {
  messages: AgentMessage[]
  truncated: boolean
  isRunning: boolean
}

async function api<T>(path: string, token?: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, headers, cache: 'no-store' })
  const value = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) {
    const error = new Error(value.error || `Request failed (${response.status})`) as ApiError
    error.status = response.status
    throw error
  }
  return value
}

function mobileName(): string {
  const agent = navigator.userAgent
  if (/iPad|iPhone|iPod/i.test(agent)) return 'iPhone'
  if (/Android/i.test(agent)) return 'Android phone'
  return 'Mobile device'
}

function sessionTitle(session: RemoteSession): string {
  return session.name?.trim() || session.preview || 'New conversation'
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(timestamp)
}

export function RemoteApp() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) ?? '')
  const activeToken = useRef(token)
  activeToken.current = token
  const [pairSecret, setPairSecret] = useState(() => new URLSearchParams(location.hash.slice(1)).get('pair') ?? '')
  const [pairing, setPairing] = useState(false)
  const [pairingError, setPairingError] = useState('')
  const [workspaces, setWorkspaces] = useState<RemoteWorkspace[]>([])
  const [workspace, setWorkspace] = useState<RemoteWorkspace | null>(null)
  const [sessions, setSessions] = useState<RemoteSession[]>([])
  const [session, setSession] = useState<RemoteSession | null>(null)
  const [items, setItems] = useState<ThreadItem[]>([])
  const [truncated, setTruncated] = useState(false)
  const [running, setRunning] = useState(false)
  const [waitingForDesktop, setWaitingForDesktop] = useState(false)
  const [loading, setLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [streamConnected, setStreamConnected] = useState(false)
  const [view, setView] = useState<'projects' | 'sessions' | 'conversation'>('projects')
  const transcriptRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const navigationLoad = useRef<AbortController | null>(null)
  const activeConversationKey = useRef<string | null>(null)
  activeConversationKey.current = workspace && session
    ? JSON.stringify([workspace.id, session.id])
    : null

  const cancelNavigationLoad = useCallback(() => {
    navigationLoad.current?.abort()
    navigationLoad.current = null
  }, [])

  const beginNavigationLoad = useCallback(() => {
    cancelNavigationLoad()
    const controller = new AbortController()
    navigationLoad.current = controller
    return controller
  }, [])

  const clearPairing = useCallback(() => {
    cancelNavigationLoad()
    activeToken.current = ''
    activeConversationKey.current = null
    localStorage.removeItem(TOKEN_KEY)
    setToken('')
    setPairSecret('')
    setWorkspaces([])
    setWorkspace(null)
    setSessions([])
    setSession(null)
    setItems([])
    setWaitingForDesktop(false)
    setLoading(false)
    setView('projects')
  }, [cancelNavigationLoad])

  const clearPairingForToken = useCallback((accessToken: string) => {
    if (activeToken.current === accessToken) clearPairing()
  }, [clearPairing])

  const loadWorkspaces = useCallback(async (accessToken: string) => {
    const controller = beginNavigationLoad()
    try {
      const result = await api<{ workspaces: RemoteWorkspace[] }>('/api/workspaces', accessToken, {
        signal: controller.signal
      })
      if (controller.signal.aborted || activeToken.current !== accessToken) return
      setWorkspaces(result.workspaces)
      setError('')
    } catch (cause) {
      if (controller.signal.aborted || activeToken.current !== accessToken) return
      if ((cause as ApiError).status === 401) clearPairingForToken(accessToken)
      else setError(cause instanceof Error ? cause.message : 'Could not load projects.')
    } finally {
      if (navigationLoad.current === controller) navigationLoad.current = null
    }
  }, [beginNavigationLoad, clearPairingForToken])

  const loadSession = useCallback(async (
    accessToken: string,
    selectedWorkspace: RemoteWorkspace,
    selectedSession: RemoteSession
  ) => {
    const controller = beginNavigationLoad()
    setLoading(true)
    try {
      const query = new URLSearchParams({ workspaceId: selectedWorkspace.id, sessionId: selectedSession.id })
      const result = await api<SessionDetail>(`/api/session?${query}`, accessToken, {
        signal: controller.signal
      })
      if (controller.signal.aborted || activeToken.current !== accessToken) return
      setItems(itemsFromMessages(result.messages))
      setTruncated(result.truncated)
      setRunning(result.isRunning)
      setError('')
    } catch (cause) {
      if (controller.signal.aborted || activeToken.current !== accessToken) return
      if ((cause as ApiError).status === 401) clearPairingForToken(accessToken)
      else setError(cause instanceof Error ? cause.message : 'Could not load the conversation.')
    } finally {
      if (navigationLoad.current === controller) {
        navigationLoad.current = null
        setLoading(false)
      }
    }
  }, [beginNavigationLoad, clearPairingForToken])

  useEffect(() => () => cancelNavigationLoad(), [cancelNavigationLoad])

  const connectPhone = async () => {
    if (!pairSecret || pairing) return
    setPairing(true)
    setPairingError('')
    try {
      const result = await api<{ accessToken: string; device: RemoteAccessDevice }>('/api/pair', undefined, {
      method: 'POST',
        body: JSON.stringify({ secret: pairSecret, deviceName: mobileName() })
      })
      localStorage.setItem(TOKEN_KEY, result.accessToken)
      activeToken.current = result.accessToken
      history.replaceState(null, '', `${location.pathname}${location.search}`)
      setPairSecret('')
      setToken(result.accessToken)
    } catch (cause) {
      setPairingError(cause instanceof Error ? cause.message : 'Pairing failed.')
    } finally {
      setPairing(false)
    }
  }

  useEffect(() => {
    if (token) void loadWorkspaces(token)
  }, [token, loadWorkspaces])

  useEffect(() => {
    if (!token || !workspace || !session) return
    const controller = new AbortController()
    const conversationKey = JSON.stringify([workspace.id, session.id])
    const isActive = () => !controller.signal.aborted
      && activeToken.current === token
      && activeConversationKey.current === conversationKey
    let refreshTimer: number | undefined
    const query = new URLSearchParams({ workspaceId: workspace.id, sessionId: session.id })
    beginStream(session.id)

    const consume = async () => {
      let connectedBefore = false

      const applyFrame = (frame: string) => {
        if (!isActive()) return
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart()).join('\n')
        if (!data) return
        try {
          const event = JSON.parse(data) as { type?: string }
          if (event.type === 'agent_start') setRunning(true)
          if (event.type === 'remote_waiting_for_desktop') setWaitingForDesktop(true)
          if (event.type === 'tool_execution_start') setWaitingForDesktop(false)
          if (event.type === 'agent_settled') {
            setRunning(false)
            setWaitingForDesktop(false)
            if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
            refreshTimer = window.setTimeout(() => {
              refreshTimer = undefined
              if (isActive()) void loadSession(token, workspace, session)
            }, 250)
          }
          setItems((current) => applyEvent(current, event as PiEvent, { sessionKey: session.id }))
        } catch {
          /* a malformed frame does not interrupt the remaining stream */
        }
      }

      while (!controller.signal.aborted) {
        try {
          if (connectedBefore) {
            const detailQuery = new URLSearchParams({ workspaceId: workspace.id, sessionId: session.id })
            const snapshot = await api<SessionDetail>(`/api/session?${detailQuery}`, token, {
              signal: controller.signal
            })
            if (!isActive()) break
            if (!snapshot.isRunning) {
              setItems(itemsFromMessages(snapshot.messages))
              setRunning(false)
              setWaitingForDesktop(false)
            }
          }
          const response = await fetch(`/api/events?${query}`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
            signal: controller.signal
          })
          if (response.status === 401) {
            clearPairingForToken(token)
            return
          }
          if (!response.ok || !response.body) throw new Error('Live updates are unavailable.')
          connectedBefore = true
          setStreamConnected(true)
          setError('')
          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read()
            if (!isActive()) break
            buffer += decoder.decode(value, { stream: !done })
            let split = buffer.indexOf('\n\n')
            while (split >= 0) {
              applyFrame(buffer.slice(0, split))
              buffer = buffer.slice(split + 2)
              split = buffer.indexOf('\n\n')
            }
            if (done) break
          }
        } catch (cause) {
          if (!isActive()) break
          if ((cause as ApiError).status === 401) {
            clearPairingForToken(token)
            return
          }
          setError(cause instanceof Error ? cause.message : 'Live updates disconnected.')
        }
        if (isActive()) setStreamConnected(false)
        if (!isActive()) break
        await new Promise<void>((resolve) => {
          const retry = () => {
            window.clearTimeout(timer)
            controller.signal.removeEventListener('abort', retry)
            resolve()
          }
          const timer = window.setTimeout(retry, 1500)
          controller.signal.addEventListener('abort', retry, { once: true })
        })
      }
    }

    void consume()
    return () => {
      controller.abort()
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
      setStreamConnected(false)
    }
  }, [token, workspace, session, clearPairingForToken, loadSession])

  useEffect(() => {
    const transcript = transcriptRef.current
    if (transcript && stickToBottom.current) transcript.scrollTop = transcript.scrollHeight
  }, [items, loading])

  const title = useMemo(() => {
    if (view === 'conversation' && session) return sessionTitle(session)
    if (view === 'sessions' && workspace) return workspace.name
    return '项目'
  }, [session, view, workspace])

  const goBack = () => {
    setError('')
    cancelNavigationLoad()
    setLoading(false)
    if (view === 'conversation') {
      setView('sessions')
      setSession(null)
      setItems([])
      setWaitingForDesktop(false)
    } else if (view === 'sessions') {
      setView('projects')
      setWorkspace(null)
      setSessions([])
    }
  }

  const openWorkspace = async (selected: RemoteWorkspace) => {
    const controller = beginNavigationLoad()
    setLoading(true)
    setError('')
    try {
      const result = await api<{ sessions: RemoteSession[] }>(
        `/api/workspaces/${encodeURIComponent(selected.id)}/sessions`, token, {
          signal: controller.signal
        }
      )
      if (controller.signal.aborted || activeToken.current !== token) return
      setWorkspace(selected)
      setSessions(result.sessions)
      setView('sessions')
    } catch (cause) {
      if (controller.signal.aborted || activeToken.current !== token) return
      if ((cause as ApiError).status === 401) clearPairingForToken(token)
      else setError(cause instanceof Error ? cause.message : 'Could not load conversations.')
    } finally {
      if (navigationLoad.current === controller) {
        navigationLoad.current = null
        setLoading(false)
      }
    }
  }

  const openSession = (selected: RemoteSession) => {
    if (!workspace) return
    setSession(selected)
    setItems([])
    setWaitingForDesktop(false)
    setView('conversation')
    void loadSession(token, workspace, selected)
  }

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!workspace || !session || !message.trim() || sending) return
    const conversationKey = JSON.stringify([workspace.id, session.id])
    const submittedMessage = message.trim()
    const requestToken = token
    setSending(true)
    setError('')
    try {
      await api('/api/message', token, {
        method: 'POST',
        body: JSON.stringify({ workspaceId: workspace.id, sessionId: session.id, message: submittedMessage })
      })
      if (activeToken.current === requestToken && activeConversationKey.current === conversationKey) {
        setMessage((current) => current === submittedMessage ? '' : current)
        setError('')
      }
    } catch (cause) {
      if ((cause as ApiError).status === 401) clearPairingForToken(requestToken)
      else if (activeToken.current === requestToken && activeConversationKey.current === conversationKey) {
        setError(cause instanceof Error ? cause.message : 'Could not send the message.')
      }
    } finally {
      setSending(false)
    }
  }

  if (!token) {
    return (
      <main className="remote-shell remote-pair">
        <div className="remote-brand">Pi Desktop</div>
        <h1>{pairing ? '正在连接…' : '连接到 Pi Desktop'}</h1>
        <p className="remote-lead">通过同一 Wi-Fi 网络查看项目对话并发送消息。</p>
        <div className="remote-device">
          <span className="remote-device__glyph"><Monitor size={21} /></span>
          <span><strong>工作电脑</strong><small>Pi Desktop · 局域网</small></span>
          <span className="remote-online" />
        </div>
        {pairingError ? <div className="remote-error">{pairingError}</div> : null}
        {pairing ? <div className="remote-loading">正在验证一次性配对码</div> : null}
        {!pairing && !pairingError && !pairSecret ? (
          <p className="remote-muted">请在 Pi Desktop 的“远程访问”设置中扫描配对二维码。</p>
        ) : null}
        {pairSecret ? (
          <button className="remote-primary" onClick={() => void connectPhone()} disabled={pairing}>
            {pairing ? '正在连接…' : pairingError ? '重试连接' : '连接'}
          </button>
        ) : null}
      </main>
    )
  }

  return (
    <main className="remote-shell">
      <header className="remote-header">
        {view !== 'projects' ? <button className="remote-back" onClick={goBack} aria-label="返回"><ChevronLeft size={22} /></button> : null}
        <div className="remote-header__title">
          {view === 'conversation' ? <span className="remote-brand-small">Pi Desktop</span> : <h1>{title}</h1>}
          {view === 'conversation' && workspace ? <small>{workspace.name} / {session?.name || '对话'}</small> : null}
        </div>
        {view === 'projects' ? (
          <button className="remote-menu" onClick={clearPairing} aria-label="断开手机连接" title="断开连接"><MoreHorizontal size={20} /></button>
        ) : null}
      </header>

      {view === 'projects' ? (
        <section className="remote-list-view remote-list-view--projects">
          {workspaces.map((item) => (
            <button className="remote-row remote-project" key={item.id} onClick={() => void openWorkspace(item)}>
              <span className="remote-project-icon">{item.icon || <Folder size={19} />}</span>
              <span className="remote-row__body"><strong>{item.name}</strong><small>查看最近的对话</small></span>
              <span className="remote-chevron"><ChevronRight size={18} /></span>
            </button>
          ))}
          {!workspaces.length && !error ? <div className="remote-empty">桌面端还没有登记的项目。</div> : null}
        </section>
      ) : null}

      {view === 'sessions' ? (
        <section className="remote-list-view">
          <div className="remote-section-title">最近对话</div>
          {sessions.map((item) => (
            <button className="remote-row remote-session" key={item.id} onClick={() => openSession(item)}>
              <span className="remote-session-icon"><MessageSquare size={16} /></span>
              <span className="remote-row__body"><strong>{sessionTitle(item)}</strong>
                <small>{item.isRunning ? '正在运行' : formatTime(item.updatedAt)} · {item.messageCount} 条消息</small>
              </span>
              <span className={item.isRunning ? 'remote-dot remote-dot--running' : 'remote-dot'} />
            </button>
          ))}
          {!sessions.length && !loading && !error ? <div className="remote-empty">这个项目还没有对话。</div> : null}
        </section>
      ) : null}

      {view === 'conversation' ? (
        <>
          <div
            className="remote-transcript"
            ref={transcriptRef}
            onScroll={(event) => {
              const element = event.currentTarget
              stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100
            }}
          >
            {truncated ? <div className="remote-history-note">已省略较早的对话记录</div> : null}
            {items.map((item) => <RemoteMessage key={item.id} item={item} />)}
            {loading ? <div className="remote-loading">正在加载对话…</div> : null}
            {waitingForDesktop ? <div className="remote-running remote-running--notice">Pi 需要在桌面端确认后才能继续。</div> : null}
            {running && !waitingForDesktop ? <div className="remote-running"><span className="remote-spinner" />{streamConnected ? 'Pi 正在工作' : 'Pi 正在工作 · 等待连接'}</div> : null}
          </div>
          <form className="remote-composer" onSubmit={(event) => void send(event)}>
            <textarea
              aria-label="输入消息"
              maxLength={MAX_REMOTE_MESSAGE_CHARS}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="输入消息…"
              rows={1}
            />
            <button className="remote-send" type="submit" disabled={!message.trim() || sending} aria-label="发送">
              {sending ? <span className="remote-spinner remote-spinner--light" /> : <Send size={18} />}
            </button>
          </form>
        </>
      ) : null}

      {error ? <div className="remote-error remote-error--floating">{error}</div> : null}
      {loading && view !== 'conversation' ? <div className="remote-loading remote-loading--overlay">正在加载…</div> : null}
    </main>
  )
}

function RemoteMessage({ item }: { item: ThreadItem }) {
  if (item.kind === 'user') {
    return (
      <article className="remote-message remote-message--user">
        <div className="remote-message__meta">你 <time>{formatTime(item.timestamp)}</time></div>
        <div className="remote-message__body">{item.text || (item.images.length ? '图片' : '')}</div>
      </article>
    )
  }
  if (item.kind === 'assistant') {
    return (
      <article className="remote-message remote-message--assistant">
        <div className="remote-message__meta"><span className="remote-assistant-mark">›</span> Pi Desktop <time>{formatTime(item.timestamp)}</time></div>
        {item.blocks.map((block, index) => {
          if (block.type === 'thinking') return <div className="remote-thinking" key={`${item.id}-${index}`}>思考中</div>
          if (block.type === 'toolCall') return <div className="remote-tool-call" key={block.id}>{block.name}</div>
          if (block.type === 'image') return <div className="remote-muted" key={`${item.id}-${index}`}>图片</div>
          return (
            <div className="remote-markdown" key={`${item.id}-${index}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
            </div>
          )
        })}
      </article>
    )
  }
  if (item.kind === 'tool') {
    const label = item.toolName.replace(/[_-]+/g, ' ')
    return (
      <details className="remote-tool" key={item.id}>
        <summary><span className="remote-tool__icon">›</span><strong>{label}</strong>
          <span className={`remote-tool__state remote-tool__state--${item.status}`}>{item.status === 'ok' ? '完成' : item.status === 'error' ? '错误' : item.status === 'running' ? '运行中' : '等待'}</span>
        </summary>
        {item.progress || item.result ? <pre>{(item.progress || item.result || '').slice(0, 8_000)}</pre> : null}
      </details>
    )
  }
  if (item.kind === 'bash') {
    return <details className="remote-tool"><summary><strong>命令行</strong><span className="remote-tool__state">已完成</span></summary><pre>{item.command}{item.output ? `\n${item.output.slice(0, 8_000)}` : ''}</pre></details>
  }
  return <div className={`remote-notice remote-notice--${item.level}`}>{item.text}</div>
}

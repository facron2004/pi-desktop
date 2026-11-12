/** Run after npm run build; exercises the real renderer with isolated app data. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = process.env.PI_DESKTOP_UI_OUTPUT
  ? path.resolve(process.env.PI_DESKTOP_UI_OUTPUT)
  : path.join(root, 'output', 'playwright', 'ui-regressions')
mkdirSync(output, { recursive: true })
const profile = mkdtempSync(path.join(output, 'profile-'))
const markerFile = path.join(profile, 'terminal-requests.txt')
const workspace = path.join(profile, 'workspace')
mkdirSync(workspace)
writeFileSync(path.join(workspace, 'note.txt'), 'hello from the workspace\n')
writeFileSync(path.join(workspace, 'old-only-result.txt'), 'old query result\n')
writeFileSync(path.join(workspace, 'new-only-result.txt'), 'new query result\n')
const nestedWorkspace = path.join(workspace, 'nested-project')
mkdirSync(nestedWorkspace)
writeFileSync(path.join(nestedWorkspace, 'nested-only.txt'), 'nested workspace file\n')
// A 1×1 PNG so the Images page has something real to list.
writeFileSync(
  path.join(workspace, 'shot.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
)
const agent = path.join(profile, 'home', '.pi', 'agent')
mkdirSync(agent, { recursive: true })
const requests = []
const fixture = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  try {
    const payload = JSON.parse(body)
    const user = payload.messages?.findLast((message) => message.role === 'user')
    const prompt = JSON.stringify(user?.content)
    requests.push({ path: req.url, model: payload.model, prompt: prompt?.slice(0, 100) })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
      id: 'ui-subagent', object: 'chat.completion.chunk', created: 1, model: payload.model,
      choices: [{ index: 0, delta, finish_reason }]
    })}\n\n`)
    const finish = (text) => {
      send({ role: 'assistant', content: text })
      send({}, 'stop')
      res.end('data: [DONE]\n\n')
    }
    if (prompt?.includes('UI_TREE_CHILD')) {
      setTimeout(() => finish('Child task verified'), 1500)
    } else if (prompt?.includes('UI_TREE_PARENT') && !payload.messages.some((message) => message.role === 'tool')) {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: 'ui-live-agents', type: 'function', function: {
        name: 'subagent', arguments: JSON.stringify({ tasks: [{ task: 'UI_TREE_CHILD inspect' }, { task: 'UI_TREE_CHILD verify' }] })
      } }] })
      send({}, 'tool_calls')
      res.end('data: [DONE]\n\n')
    } else finish('All delegated work verified')
  } catch (error) {
    if (!res.headersSent) res.writeHead(500)
    res.end(String(error))
  }
})
await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve))
writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${fixture.address().port}/v1`, apiKey: 'local-test',
  models: [{ id: 'sidebar-test', contextWindow: 32000, maxTokens: 1024, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
} } }))
writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  model: 'fixture/sidebar-test', thinkingLevel: 'off', permissionMode: 'full', trustProject: false, desktopNotifications: false
}))

async function checkRenderer(markerFile, nestedWorkspace) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const setInputValue = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const until = async (read, message, timeout = 10000) => {
    const deadline = performance.now() + timeout
    while (performance.now() < deadline) {
      const value = read()
      if (value) return value
      await pause(25)
    }
    const state = window.__piDesktopStore.getState()
    const tools = Object.values(state.threads).flatMap((thread) => thread.items.filter((item) => item.kind === 'tool').map((item) => ({
      name: item.toolName, status: item.status, result: item.result?.slice(0, 200), details: item.details
    })))
    throw new Error(`${message}: ${JSON.stringify({ error: state.error, phase: state.run.phase, tools })}`)
  }
  const store = window.__piDesktopStore
  await store.getState().updateSettings({ language: 'en', terminalShell: 'cmd' })
  const passed = []

  // The OS font registry can point at nothing even when the emoji file exists;
  // the bridge hands the renderer the bytes and App registers a real FontFace.
  await until(
    () => [...document.fonts].some((face) =>
      face.family.replace(/['"]/g, '') === 'Pi Desktop Emoji' && face.status === 'loaded'),
    'The platform emoji font did not register',
    15000
  )
  passed.push('the platform emoji font registers for project icons and text')

  const logoBlue = document.querySelector('.pi-logo rect')
  check(logoBlue, 'The Pi mark is missing from the sidebar')
  const originalTheme = document.documentElement.dataset.theme
  document.documentElement.dataset.theme = 'dark'
  const darkLogoBlue = getComputedStyle(logoBlue).fill
  document.documentElement.dataset.theme = 'light'
  const lightLogoBlue = getComputedStyle(logoBlue).fill
  if (originalTheme) document.documentElement.dataset.theme = originalTheme
  else delete document.documentElement.dataset.theme
  check(
    darkLogoBlue === 'rgb(63, 111, 224)' && lightLogoBlue === 'rgb(0, 32, 144)',
    `The Pi mark did not use its theme-specific blue: dark=${darkLogoBlue}, light=${lightLogoBlue}`
  )
  passed.push('the Pi mark uses the light and dark theme colours')

  // A page opens the way the panel does it: the `+` creates a new tab, and its
  // start page turns that tab into the chosen page. A page already open is only
  // focused, never added twice.
  const openToolPage = async (view, label) => {
    if (!document.querySelector('.tool-panel')) {
      const toggle = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === 'Show tools panel')
      toggle?.click()
    }
    await until(() => document.querySelector('.tool-panel__new-tab'), 'The workspace panel did not open')
    const tab = [...document.querySelectorAll('.tool-panel__tab')].find((node) => node.textContent?.includes(label))
    if (tab) {
      tab.click()
      return
    }
    document.querySelector('.tool-panel__new-tab').click()
    const card = await until(
      () => document.querySelector(`.tool-start .tool-menu__card[data-tool="${view}"]`),
      `The new-tab page has no ${label} card`
    )
    card.click()
  }

  // Subagents live in the right panel now, behind the browser-like Tools tab.
  // Open that page through the same navigation a user would use.
  const openSubagentsPage = async () => {
    await openToolPage('subagents', 'Subagents')
    await until(() => document.querySelector('.subagent-panel'), 'Subagents page did not render')
  }

  const modes = []
  const childStates = []
  const offMode = window.pi.runtime.onEvent(({ event }) => {
    if (event.type === 'extension_ui_request' && event.method === 'setStatus' && event.statusKey === 'pi-desktop-mode') {
      modes.push(event.statusText)
    }
    if (event.type === 'tool_execution_update' && event.toolName === 'subagent') {
      childStates.push(event.partialResult?.details?.results?.map((result) => result.status) ?? [])
    }
  })
  try {
    for (const mode of ['subagent', 'plan', 'goal', 'default']) {
      await store.getState().setAgentMode(mode)
      const state = store.getState()
      const sessionKey = state.activeSessionFile ?? state.draftId
      const runtimeIsLive = sessionKey ? await window.pi.runtime.has(sessionKey) : false
      check(!state.error, `Pi rejected ${mode}: ${state.error} (session=${sessionKey}, runtimeLive=${runtimeIsLive})`)
      check(state.status.phase === 'ready' && state.agentMode === mode && modes.at(-1) === mode, `Pi did not confirm ${mode}`)
    }
    passed.push('task modes round-trip through the bundled Pi CLI')
    await openSubagentsPage()
    await store.getState().send('UI_TREE_PARENT delegate the two independent checks', [])
    await until(() => document.querySelectorAll('.subagent-tree__task').length === 2, 'Real child processes did not appear in the right panel', 45000)
    await store.getState().newChat()
    check(document.querySelectorAll('.subagent-tree__task').length === 2, 'Switching chats hid live child processes')
    await until(() => document.querySelectorAll('.subagent-tree__task[data-status="completed"]').length === 2, 'Real child completion did not reach the right panel', 45000)
    check(childStates.some((states) => states.includes('running')), 'Pi did not publish child startup progress')
    await until(() => Object.values(store.getState().threads).every((thread) => !thread.isStreaming), 'Parent did not settle')
    passed.push('real Pi subagents stay visible in background in the right panel')

  } finally {
    offMode()
    const workspacePath = store.getState().workspace?.path ?? store.getState().status.cwd
    if (workspacePath) await window.pi.runtime.stopCwd(workspacePath)
    await store.getState().newChat()
  }

  if (store.getState().info.platform === 'win32') {
    const outputs = new Map()
    const off = window.pi.terminal.onData(({ id, data }) => outputs.set(id, (outputs.get(id) ?? '') + data))
    const executions = () => [...outputs.values()].map((value) => (value.match(/PI_UI_HANDOFF_347/g) ?? []).length)
    const command = `echo PI_UI_HANDOFF_347 & echo execution>>"${markerFile}"`
    try {
      window.dispatchEvent(new Event('pi:toggle-terminal'))
      const add = await until(() => document.querySelector('.terminal__new'), 'Terminal did not open')
      await until(() => outputs.size === 1, 'First shell did not start')
      add.click()
      await until(() => outputs.size === 2, 'Second shell did not start')
      const tabs = document.querySelectorAll('.terminal__tab-main')
      tabs[0].click()
      await pause(50)
      window.dispatchEvent(new CustomEvent('pi:terminal-run', { detail: { command } }))
      await until(() => executions().some((count) => count >= 2), 'Handed-over command did not execute')
      await pause(100)
      tabs[1].click()
      await pause(400)
      check(executions().filter((count) => count > 0).length === 1, 'Switching terminal tabs replayed a command')
      window.dispatchEvent(new CustomEvent('pi:terminal-run', { detail: { command } }))
      await until(() => executions().every((count) => count >= 2), 'A second explicit request did not execute')
      await pause(100)
      tabs[0].click()
      await pause(400)
      passed.push('terminal requests run once in their target tab')
    } finally {
      off()
      document.querySelector('.shell__panel-toggle button').click()
      await until(() => !document.querySelector('.terminal'), 'Terminal did not close')
    }
  }

  const calls = []
  const goal = (text) => [{ key: 'pi-desktop-goal', text: JSON.stringify({ text, status: 'active' }) }]
  store.setState({
    activeSessionFile: 'ui-goal-A',
    uiStatuses: goal('Goal A'),
    runTaskCommand: async (command) => calls.push({ owner: store.getState().activeSessionFile, command })
  })
  const edit = await until(() => document.querySelector('.goal-bar__actions button[title="Edit"]'), 'Goal did not render')
  edit.click()
  await until(() => document.querySelector('.goal-bar__input'), 'Goal editor did not open')
  store.setState({ activeSessionFile: 'ui-goal-B', uiStatuses: goal('Goal B') })
  await pause(50)
  check(!document.querySelector('.goal-bar__input'), 'Goal editor retained a different conversation draft')
  document.querySelector('.goal-bar__actions button[title="Edit"]').click()
  const input = await until(() => document.querySelector('.goal-bar__input'), 'Second goal editor did not open')
  check(input.value === 'Goal B', 'Second goal editor used the first conversation text')
  document.querySelector('.goal-bar__action[data-tone="primary"]').click()
  await until(() => calls.length === 1, 'Goal was not saved')
  check(calls[0].owner === 'ui-goal-B' && calls[0].command === '/desktop-goal edit Goal B', 'Goal saved to the wrong conversation')
  passed.push('goal drafts stay in their conversation')

  await store.getState().newChat()
  localStorage.removeItem('pi-desktop.plan-strip')
  store.setState({
    activeSessionFile: undefined,
    draftId: 'draft:ui-status-plan',
    items: [{
      id: 'ui-plan', kind: 'assistant', streaming: false, timestamp: 1, order: 1,
      blocks: [{ type: 'text', text: '- [ ] Inspect the extension status\n- [ ] Restore the conversation controls' }]
    }],
    uiStatuses: [{ key: 'fixture-extension', text: 'Extension ready' }],
    uiWidgets: []
  })
  // The plan lives in the task rail; extension statuses belong to their own
  // surfaces, not to a permanent strip above the composer.
  await until(
    () => document.querySelector('.task-panel__check')?.textContent.includes('Inspect the extension status'),
    'Plan progress did not render in the task rail'
  )
  check(!document.querySelector('.status-strip, .plan-strip'), 'A status or plan strip returned above the composer')
  // A desk page owns the content row: the tools panel closes with it, and the
  // corner toggle is not drawn over the page's own header.
  if (!document.querySelector('.tool-panel')) {
    document.querySelector('.shell__panel-toggle button').click()
    await until(() => document.querySelector('.tool-panel'), 'The tools panel did not open')
  }
  document.querySelector('.sidebar__plugin-entry button').click()
  await until(() => document.querySelector('.desk-page'), 'Plugins desk page did not open')
  await until(() => !document.querySelector('.tool-panel'), 'The tools panel stayed open over the desk page')
  check(
    !document.querySelector('.goal-bar, .widget, .task-rail, .shell__panel-toggle'),
    'Conversation controls remained underneath the desk page'
  )
  document.querySelector('.sidebar__plugin-entry button').click()
  await until(() => !document.querySelector('.desk-page'), 'Plugins desk page did not close')
  await until(
    () => document.querySelector('.task-panel__check')?.textContent.includes('Inspect the extension status'),
    'Plan progress did not return with the conversation'
  )
  check(document.querySelector('.shell__panel-toggle'), 'The tools-panel toggle did not come back with the conversation')
  check(!document.querySelector('.status-strip, .plan-strip'), 'A status or plan strip returned with the conversation')
  passed.push('plan progress stays in the task rail and leaves desk pages clear')

  await store.getState().newChat()
  await openSubagentsPage()
  const baseThread = store.getState().threads[store.getState().draftId]
  const owner = 'draft:subagents-A'
  const other = 'draft:subagents-B'
  const results = [
    { task: 'Inspect repository', status: 'running', activity: 'Running a tool', toolName: 'read', startedAt: Date.now() },
    { task: 'Verify changes', status: 'queued' },
    { task: 'Review documentation and verify migration notes in the working directory', status: 'completed', output: 'Reviewed' }
  ]
  const delegation = {
    id: 'ui-agents', kind: 'tool', toolCallId: 'ui-agents', toolName: 'subagent',
    args: { tasks: results.map((result) => ({ task: result.task })) },
    status: 'running', details: { mode: 'parallel', results }, timestamp: 2, order: 2
  }
  store.setState((state) => ({
    activeSessionFile: undefined, draftId: owner, items: [], uiStatuses: [],
    threads: {
      ...state.threads,
      [owner]: { ...baseThread, isStreaming: true, items: [delegation], piState: { isStreaming: true, isCompacting: false, sessionName: 'Primary task A' } },
      [other]: { ...baseThread, items: [] }
    }
  }))
  const branch = await until(() => document.querySelector(`.subagent-tree__branch[data-session-file="${owner}"]`), 'Subagent tree did not render')
  check(branch.querySelectorAll('.subagent-tree__task').length === 3, 'Subagent tree lost tasks')
  check(branch.querySelector('[data-status="running"]') && branch.querySelector('[data-status="queued"]'), 'Subagent states are missing')
  check([...branch.querySelectorAll('.subagent-tree__task-row')].every((row) => row.getBoundingClientRect().right <= branch.getBoundingClientRect().right + 1), 'Long task labels overflowed the right panel')
  const originalCancelSubagentTask = store.getState().cancelSubagentTask
  const cancelledTasks = []
  store.setState({ cancelSubagentTask: async (taskId, sessionKey) => cancelledTasks.push({ taskId, sessionKey }) })
  await until(() => branch.querySelectorAll('.subagent-tree__task-stop').length === 2, 'Active tasks did not show stop controls')
  branch.querySelector('[data-status="running"] .subagent-tree__task-stop').click()
  check(cancelledTasks.length === 1 && cancelledTasks[0].taskId && cancelledTasks[0].sessionKey === owner, 'The stop control did not cancel its task in the owning conversation')
  store.setState({ cancelSubagentTask: originalCancelSubagentTask })
  await store.getState().selectSession({ id: other, file: other, cwd: baseThread.status.cwd, preview: 'Another conversation', updatedAt: 1, messageCount: 0 })
  await pause(50)
  check(document.querySelector(`.subagent-tree__branch[data-session-file="${owner}"]`) === branch, 'Background subagent tree disappeared')
  const finalResults = [
    { ...results[0], status: 'completed', output: 'Inspected', finishedAt: Date.now() },
    { ...results[1], status: 'failed', errorMessage: 'Fixture verification failed' },
    { ...results[2], status: 'aborted' }
  ]
  store.setState((state) => ({ threads: { ...state.threads, [owner]: {
    ...state.threads[owner], isStreaming: false,
    items: [{ ...delegation, status: 'ok', details: { mode: 'parallel', results: finalResults } }]
  } } }))
  const failedTask = await until(() => branch.querySelector('[data-status="failed"] button'), 'Background task state did not update')
  check(branch.querySelector('[data-status="completed"]') && branch.querySelector('[data-status="aborted"]'), 'Final child states were lost')
  failedTask.click()
  await until(() => document.querySelector('.subagent-conversation')?.textContent.includes('Fixture verification failed'), 'Task conversation did not show the failure')
  document.querySelector('.subagent-conversation__back').click()
  const reopenedBranch = await until(() => document.querySelector(`.subagent-tree__branch[data-session-file="${owner}"]`), 'Subagent tree did not return from its conversation')
  reopenedBranch.querySelector('.subagent-tree__toggle').click()
  await pause(50)
  check(reopenedBranch.querySelectorAll('.subagent-tree__task').length === 0, 'Subagent tree did not collapse')
  reopenedBranch.querySelector('.subagent-tree__toggle').click()
  await until(() => reopenedBranch.querySelectorAll('.subagent-tree__task').length === 3, 'Subagent tree did not expand')
  passed.push('right-panel subagents keep their states and results across conversation switches')

  const content = Array.from({ length: 10000 }, (_, index) => `line ${index}`).join('\n')
  const write = (id, name, text, order) => ({
    id, kind: 'tool', toolCallId: id, toolName: 'write', args: { path: name, content: text }, status: 'ok', timestamp: order, order
  })
  store.setState({
    activeSessionFile: undefined,
    draftId: 'draft:ui-preview',
    uiStatuses: [],
    items: [
      { id: 'ui-user', kind: 'user', text: 'Write generated files', images: [], timestamp: 1, order: 1 },
      write('ui-large', 'large-generated.txt', content, 2),
      write('ui-small', 'small.txt', 'small', 3)
    ]
  })
  // The change summary is a turn's closing statement, so the previews below it
  // only exist once the run has settled.
  store.setState((state) => ({ run: { ...state.run, phase: 'idle', settled: true } }))
  const row = await until(() => document.querySelector('.file-change'), 'File change did not render')
  const hover = (node) => node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  hover(row)
  await until(() => document.querySelector('.file-change__preview-line'), 'File preview did not open')
  check(document.querySelectorAll('.file-change__preview-line').length === 200, 'Large preview rendered more than one page')
  const next = document.querySelector('.file-change__preview-pages button[aria-label="Next page"]')
  check(next && !next.disabled, 'Preview has no next-page control')
  next.click()
  await until(() => document.querySelector('.file-change__preview-text')?.textContent === 'line 200', 'Preview did not advance')
  check(document.querySelectorAll('.file-change__preview-line').length === 200, 'Second preview page exceeded the limit')
  hover(document.querySelectorAll('.file-change')[1])
  await until(() => document.querySelector('.file-change__preview-text')?.textContent === 'small', 'File switch did not reset the preview page')
  hover(row)
  await until(() => document.querySelector('.file-change__preview-text')?.textContent === 'line 0', 'Returning to the file did not reset paging')
  passed.push('file previews page by 200 lines and reset between files')

  // A turn folds its progress prose and tools together, keeping only the
  // final reply on the reading column. The same fold survives a view switch.
  const beforeStream = store.getState()
  await store.getState().newChat()
  const streamItems = [
    { id: 'stream-user', kind: 'user', text: 'Inspect the stream', images: [], timestamp: 1, order: 1 },
    { id: 'stream-progress', kind: 'assistant', streaming: false, timestamp: 2, order: 2, blocks: [
      { type: 'text', text: 'STREAM_PROGRESS checking the renderer' },
      { type: 'toolCall', id: 'stream-read', name: 'read', argsText: '{}', args: { path: 'note.txt' } }
    ] },
    { id: 'stream-tool', kind: 'tool', toolCallId: 'stream-read', toolName: 'read',
      args: { path: 'note.txt' }, status: 'ok', result: 'STREAM_TOOL_RESULT', timestamp: 3, order: 3 },
    { id: 'stream-reply', kind: 'assistant', streaming: false, stopReason: 'stop', timestamp: 4, order: 4,
      blocks: [{ type: 'text', text: 'STREAM_FINAL the renderer is ready' }] }
  ]
  const streamRun = { phase: 'idle', turns: 2, settled: true, outcome: 'completed', durationMs: 9000 }
  const showStream = (draftId, items = streamItems, run = streamRun, extra = {}) => store.setState((state) => ({
    draftId, activeSessionFile: undefined, items, run, isStreaming: !run.settled,
    error: undefined, retry: undefined, transport: 'connected',
    settings: { ...state.settings, autoFoldProcess: true, ...extra },
    threads: { ...state.threads, [draftId]: { ...baseThread, items, run, isStreaming: !run.settled } }
  }))
  showStream('draft:stream-a')
  await until(() => document.querySelector('.run-outcome[data-foldable="true"]'), 'The stream has no process fold')
  const streamBody = () => document.querySelector('.assistant__body')
  check(!streamBody().textContent.includes('STREAM_PROGRESS'), 'Folded process leaked progress into the reply')
  check(streamBody().textContent.includes('STREAM_FINAL'), 'Folded process hid the final reply')
  document.querySelector('.run-outcome').click()
  await until(() => streamBody().textContent.includes('STREAM_PROGRESS'), 'Process expansion did not reveal progress')
  check(document.querySelector('.tool-link'), 'Expanding the process required a second fold to reach the tool row')
  document.querySelector('.tool-link__toggle').click()
  await until(() => streamBody().textContent.includes('STREAM_TOOL_RESULT'), 'The tool result did not expand')
  showStream('draft:stream-b')
  await until(() => !streamBody().textContent.includes('STREAM_PROGRESS'), 'A different conversation inherited the fold')
  showStream('draft:stream-a')
  await until(() => streamBody().textContent.includes('STREAM_TOOL_RESULT'), 'The process/tool fold was forgotten on return')
  document.querySelector('.run-outcome').click()
  await until(() => !streamBody().textContent.includes('STREAM_PROGRESS'), 'The process did not fold again')

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
  const streamSearch = await until(() => document.querySelector('.thread-search input'), 'Conversation search did not open')
  const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setInput.call(streamSearch, 'STREAM_PROGRESS')
  streamSearch.dispatchEvent(new Event('input', { bubbles: true }))
  await until(() => streamBody().textContent.includes('STREAM_PROGRESS'), 'A search hit stayed hidden in the process')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until(() => !streamBody().textContent.includes('STREAM_PROGRESS'), 'Closing search lost the manual fold')

  showStream('draft:stream-live', streamItems.slice(0, 3), {
    phase: 'working', turns: 1, settled: false, startedAt: Date.now() - 2000
  })
  await until(() => document.querySelector('.run-outcome[data-running="true"]'), 'Live elapsed summary did not render')
  check(document.querySelector('.run-outcome').textContent.includes('Working'), 'Live elapsed summary claimed the run was finished')
  check(streamBody().textContent.includes('STREAM_PROGRESS'), 'The live partial progress disappeared')
  showStream('draft:stream-stopped', streamItems.slice(0, 3), {
    phase: 'idle', turns: 1, settled: true, outcome: 'aborted'
  })
  await until(() => document.querySelector('.run-outcome[data-outcome="aborted"]'), 'Stopped summary did not render')
  check(streamBody().textContent.includes('STREAM_PROGRESS'), 'Stopping lost the partial progress')

  // A command is an argument, not the newest output: the live footer says what
  // kind of work is running but never prints the shell line itself.
  showStream('draft:stream-command', [
    { id: 'cmd-user', kind: 'user', text: 'Run the check', images: [], timestamp: 1, order: 1 },
    { id: 'cmd-tool', kind: 'tool', toolCallId: 'cmd-tool', toolName: 'bash',
      args: { command: 'cd /e/Program/Coffee && grep -ril pressure' }, status: 'running', timestamp: 2, order: 2 }
  ], { phase: 'tool_running', turns: 1, settled: false, startedAt: Date.now() - 3000 })
  const commandStatus = await until(
    () => document.querySelector('.run-status__activity'),
    'A live command status did not render'
  )
  check(commandStatus.textContent.includes('Running a command'), 'The live status lost its tool label')
  check(!document.querySelector('.run-status__activity-detail'), 'The shell command leaked into the live status')

  showStream('draft:stream-replay', streamItems, { phase: 'idle', turns: 0, settled: true })
  await until(() => document.querySelector('.run-outcome[data-foldable="true"]'), 'Replayed turn lost its process fold without saved timing')
  check(Boolean(document.querySelector('.run-outcome__meta')), 'Replayed turn lost its worked-for duration')
  check(!streamBody().textContent.includes('STREAM_PROGRESS') && streamBody().textContent.includes('STREAM_FINAL'), 'Replayed turn does not match the completed stream')

  // `toolCallSummary` gathers a live stretch into one line even when it holds a
  // single call: a running command stays out of the flowing output until the
  // reader opens the fold.
  showStream('draft:stream-summary', streamItems.slice(0, 3), {
    phase: 'working', turns: 1, settled: false, startedAt: Date.now() - 2000
  }, { toolCallSummary: true })
  const liveSummary = await until(
    () => document.querySelector('.process[data-live] .process__head'),
    'A live tool summary did not render'
  )
  check(!streamBody().querySelector('.tool-link'), 'A live tool row leaked below its summary')
  liveSummary.click()
  await until(() => streamBody().querySelector('.tool-link'), 'Opening the live summary did not reveal the tool row')
  store.setState(beforeStream)
  passed.push('stream process folds commentary and tools, preserves view state, and reveals search hits')

  // The task rail beside the conversation: the environment of the folder, the
  // tasks running in the background, the plan and the files the run produced.
  await store.getState().newChat()
  const railItems = [
    { id: 'rail-user', kind: 'user', text: 'Ship the panel', images: [], timestamp: 1, order: 1 },
    {
      id: 'rail-assistant',
      kind: 'assistant',
      blocks: [{ type: 'text', text: '- [x] Read the reference\n- [x] Rewrite the panel\n- [ ] Verify the build' }],
      streaming: false,
      timestamp: 2,
      order: 2
    },
    {
      id: 'rail-write',
      kind: 'tool',
      toolCallId: 'rail-write',
      toolName: 'write',
      args: { path: 'audit/shot.png', content: 'x' },
      status: 'ok',
      timestamp: 3,
      order: 3
    },
    {
      id: 'rail-write2',
      kind: 'tool',
      toolCallId: 'rail-write2',
      toolName: 'write',
      args: { path: 'audit/hover-check.mjs', content: 'x' },
      status: 'ok',
      timestamp: 4,
      order: 4
    },
    {
      id: 'rail-write3',
      kind: 'tool',
      toolCallId: 'rail-write3',
      toolName: 'write',
      args: { path: 'note.md', content: 'x' },
      status: 'ok',
      timestamp: 5,
      order: 5
    },
    {
      id: 'rail-write4',
      kind: 'tool',
      toolCallId: 'rail-write4',
      toolName: 'write',
      // The shape that read as a misaligned row: a folder with one file in it,
      // beside files that stand at the root of the project.
      args: { path: 'docs/status.md', content: 'x' },
      status: 'ok',
      timestamp: 6,
      order: 6
    },
    {
      id: 'rail-write5',
      kind: 'tool',
      toolCallId: 'rail-write5',
      toolName: 'write',
      // Two files that share a name: the one case where a row has to say which
      // folder it came from.
      args: { path: 'server/store.js', content: 'x' },
      status: 'ok',
      timestamp: 7,
      order: 7
    },
    {
      id: 'rail-write6',
      kind: 'tool',
      toolCallId: 'rail-write6',
      toolName: 'write',
      args: { path: 'web/store.js', content: 'x' },
      status: 'ok',
      timestamp: 8,
      order: 8
    },
    {
      id: 'rail-sub',
      kind: 'tool',
      toolCallId: 'rail-sub',
      toolName: 'subagent',
      args: { tasks: [{ task: 'Run the gate' }] },
      status: 'running',
      details: { mode: 'parallel', results: [{ task: 'Run the gate', status: 'running' }] },
      timestamp: 9,
      order: 9
    }
  ]
  store.setState({
    activeSessionFile: undefined,
    draftId: 'draft:task-rail',
    uiStatuses: [],
    items: railItems
  })
  await until(() => document.querySelector('.task-panel'), 'Task rail did not render')
  const titles = [...document.querySelectorAll('.task-panel__section-title')].map((node) => node.textContent)
  for (const title of ['Environment info', 'Background tasks', 'Progress', 'Deliverables']) {
    check(titles.includes(title), `The task rail is missing the ${title} section: ${titles.join(' | ')}`)
  }
  // A folder outside Git has nothing to review or commit: the environment
  // section keeps its "No Git repository" subtitle and drops the Git rows.
  const gitBefore = store.getState().git
  const noRepoGit = {
    isRepo: false, detached: false, ahead: 0, behind: 0, files: [], staged: 0, unstaged: 0, clean: true
  }
  store.setState({ git: noRepoGit })
  await until(
    () => document.querySelector('.task-panel__section-subtitle')?.textContent === 'No Git repository',
    'The task rail did not read the non-repo status'
  )
  check(!document.querySelector('.task-panel__rows'), 'A non-repo folder still shows the Git rows')
  const environmentSection = [...document.querySelectorAll('.task-panel__section')].find((node) =>
    node.querySelector('.task-panel__section-title')?.textContent === 'Environment info'
  )
  const environmentToggle = environmentSection?.querySelector('.task-panel__section-toggle')
  const environmentHeadHeight = environmentSection?.querySelector('.task-panel__section-head')?.getBoundingClientRect().height
  environmentToggle?.click()
  await pause(250)
  check(environmentToggle?.getAttribute('aria-expanded') === 'false', 'The environment section did not fold shut')
  check(
    environmentSection && environmentHeadHeight !== undefined &&
      environmentSection.getBoundingClientRect().height <= environmentHeadHeight + 1,
    'The non-repo subtitle still occupies space after folding the environment section'
  )
  environmentToggle?.click()
  await pause(250)
  const workspacePath = store.getState().workspace?.path
  check(typeof workspacePath === 'string' && workspacePath.length > 0, 'The active workspace path is missing')
  store.setState({ git: { ...noRepoGit, isRepo: true, root: workspacePath, branch: 'main', head: 'abcdef123456' } })
  await until(() => document.querySelectorAll('.task-panel__row').length === 3, 'The Git rows did not return for a repository')
  check(
    [...document.querySelectorAll('.task-panel__row-label')].map((node) => node.textContent).join('|') ===
      'Changes|Commit or Push|Change graph',
    'The repository environment rows changed'
  )
  store.setState({ git: gitBefore })
  check(document.querySelectorAll('.task-panel__task').length === 1, 'The background task row is missing')
  const originalTaskRailCancel = store.getState().cancelSubagentTask
  let taskRailCancelledId
  store.setState({ cancelSubagentTask: async (taskId) => { taskRailCancelledId = taskId } })
  const taskRailStop = await until(() => document.querySelector('.task-panel__task-stop'), 'The running task has no stop control in the task rail')
  taskRailStop.click()
  check(Boolean(taskRailCancelledId), 'The task rail stop control did not dispatch task cancellation')
  store.setState({ cancelSubagentTask: originalTaskRailCancel })
  check(document.querySelectorAll('.task-panel__check').length === 3, 'The plan checklist is missing a step')
  check(document.querySelectorAll('.task-panel__check[data-done]').length === 2, 'A finished step is not marked as done')
  check(document.querySelectorAll('.task-panel__folder').length === 0, 'The deliverables still draw folder rows')
  check(document.querySelectorAll('.task-panel__file').length === 6, 'The deliverables files are missing')
  // The deliverables are a list of files, not a directory tree: no folder rows,
  // no indent, no path on the row. Every row is one tile slot plus one name, so
  // every name starts on the same column and every row is the same height.
  const left = (node) => Math.round(node.getBoundingClientRect().left)
  const fileRows = [...document.querySelectorAll('.task-panel__file')]
  const rowNamed = (name) =>
    fileRows.find((row) => row.querySelector('.task-panel__file-name')?.textContent === name)
  check(fileRows.length === 6, 'A deliverables row is missing')
  const column = left(fileRows[0].querySelector('.task-panel__file-name'))
  for (const row of fileRows) {
    check(
      left(row.querySelector('.task-panel__file-name')) === column,
      `${row.querySelector('.task-panel__file-name').textContent} is not on the deliverables column`
    )
    check(row.querySelector('.task-panel__tile').getBoundingClientRect().width === 20, 'A deliverable lost its tile slot')
    check(Math.round(row.getBoundingClientRect().height) === 28, 'Deliverables rows are not the same height')
  }
  // The path is not shown — except where two files share a name and the row has
  // to say which one it is.
  const dirHint = (name) => rowNamed(name)?.querySelector('.task-panel__file-dir')?.textContent ?? ''
  const serverStore = fileRows.filter((row) => row.querySelector('.task-panel__file-name')?.textContent === 'store.js')
  check(serverStore.length === 2, 'The two files that share a name are not both listed')
  check(
    serverStore.map((row) => row.querySelector('.task-panel__file-dir')?.textContent).join('|') === 'server/|web/',
    'Files sharing a name do not say which folder each one is in'
  )
  check(dirHint('status.md') === '', 'A deliverable shows its path')
  check(dirHint('note.md') === '', 'A file at the project root claims a folder')
  check(rowNamed('status.md').getAttribute('title') === 'docs/status.md', 'The row lost the path its tooltip carries')
  // What a turn changed is its closing statement: the summary waits for the run
  // to settle, while the tool rows above already show every edit as it happens.
  store.setState((state) => ({ run: { ...state.run, phase: 'tool_running', settled: false } }))
  await pause(150)
  check(!document.querySelector('.file-changes'), 'The file-change summary appeared while the run was still going')
  store.setState((state) => ({ run: { ...state.run, phase: 'idle', settled: true } }))
  await until(() => document.querySelector('.file-changes'), 'The file-change summary did not appear once the run settled')
  const progress = [...document.querySelectorAll('.task-panel__section')].find((node) =>
    node.querySelector('.task-panel__section-title')?.textContent === 'Progress'
  )
  progress.querySelector('.task-panel__section-toggle').click()
  await pause(250)
  check(
    progress.querySelector('.task-panel__section-body').getAttribute('data-open') === null,
    'The section did not fold shut'
  )
  progress.querySelector('.task-panel__section-toggle').click()
  await pause(250)
  check(
    progress.querySelector('.task-panel__section-body').getAttribute('data-open') !== null,
    'The section did not fold open again'
  )
  passed.push('the task rail reads the environment, the background tasks, the plan and the deliverables')

  // The workspace panel follows MCode's page strip: fixed-width tabs, an add
  // menu, a start page when nothing is open, a maximized state, and the file
  // tree beside the preview on the Files page.
  const panelToggle = () => [...document.querySelectorAll('button')].find((node) =>
    node.getAttribute('aria-label') === 'Show tools panel' || node.getAttribute('aria-label') === 'Hide tools panel')
  if (!document.querySelector('.tool-panel')) panelToggle()?.click()
  await until(() => document.querySelector('.tool-panel'), 'Workspace panel did not open')
  while (true) {
    const pageTab = [...document.querySelectorAll('.tool-panel__tab-shell')].find(
      (tab) => !tab.querySelector('.tool-panel__tab-label')?.textContent?.includes('New tab')
    )
    if (!pageTab) break
    pageTab.querySelector('.tool-panel__tab-close').click()
    await pause(30)
  }
  // Closing the last page closes the panel. Wait out its exit before using
  // the fresh start page; the closing instance is still in the DOM briefly.
  if (!document.querySelector('.tool-panel') || document.querySelector('.tool-panel--closing')) {
    await until(() => !document.querySelector('.tool-panel'), 'The last page did not close the panel')
    panelToggle()?.click()
  }
  await until(() => document.querySelector('.tool-start'), 'The panel start page did not render')
  check(document.querySelectorAll('.tool-start .tool-menu__card').length === 6, 'The start page does not list every page')
  const filesCard = [...document.querySelectorAll('.tool-start .tool-menu__card')].find((node) => node.textContent?.includes('Files'))
  check(filesCard, 'The start page has no Files entry')
  filesCard.click()
  await until(() => document.querySelector('.file-workspace'), 'Files page did not render')
  const firstTab = document.querySelector('.tool-panel__tab-shell')
  const tabWidth = firstTab?.getBoundingClientRect().width ?? 0
  check(tabWidth >= 120 && tabWidth <= 160, `A page tab is not MCode-sized: ${tabWidth}`)
  check(firstTab?.getBoundingClientRect().height === 30, 'A page tab is not 30px high')
  check(document.querySelector('.tool-panel__tabs')?.getBoundingClientRect().height === 46, 'The panel header is not 46px high')
  // The corner controls are one family: the panel's `+` and maximize buttons and
  // the shell's pinned toggle share a box, a radius and a centre line.
  const corner = ['.tool-panel__new-tab', '.tool-panel__action', '.shell__panel-toggle button']
    .map((selector) => document.querySelector(selector))
  check(corner.every(Boolean), 'A corner control is missing')
  const cornerBoxes = corner.map((node) => {
    const box = node.getBoundingClientRect()
    return {
      size: `${Math.round(box.width)}x${Math.round(box.height)}`,
      centre: Math.round((box.y + box.height / 2) * 10) / 10,
      radius: getComputedStyle(node).borderRadius
    }
  })
  check(
    new Set(cornerBoxes.map((box) => box.size)).size === 1,
    `The corner controls are not one size: ${JSON.stringify(cornerBoxes)}`
  )
  check(
    new Set(cornerBoxes.map((box) => box.radius)).size === 1,
    `The corner controls are not one shape: ${JSON.stringify(cornerBoxes)}`
  )
  const cornerLines = cornerBoxes.map((box) => box.centre)
  check(
    Math.max(...cornerLines) - Math.min(...cornerLines) <= 0.5,
    `The corner controls are not on one line: ${JSON.stringify(cornerLines)}`
  )
  check(![...document.querySelectorAll('.tool-panel__tab')].some((node) => node.textContent?.trim() === 'Tools'), 'The old permanent Tools tab is still there')
  const workspaceFile = await until(() => [...document.querySelectorAll('.tree__item')].find((node) => node.textContent?.includes('note.txt')), 'Workspace file did not appear in the tree')
  workspaceFile.click()
  await until(() => document.querySelector('.file-workspace .viewer'), 'The file preview did not open beside the tree')
  check(document.querySelector('.file-workspace__tree'), 'Opening a file removed the file tree')
  // The session rail hangs at the conversation's left edge, above the thread at
  // the popover layer so its tooltip can cross into it. The maximized panel owns
  // the whole work area, so the rail must be covered by it instead of printing
  // its ticks over the panel's edge.
  const railItemsBefore = store.getState().items
  store.setState({
    items: [
      ...railItemsBefore,
      { id: 'ui-rail-second-user', kind: 'user', text: 'A second turn', images: [], timestamp: 10, order: 10 },
      {
        id: 'ui-rail-second-assistant',
        kind: 'assistant',
        blocks: [{ type: 'text', text: 'A second answer' }],
        streaming: false,
        timestamp: 11,
        order: 11
      }
    ]
  })
  await until(() => document.querySelector('.session-rail'), 'The session rail did not render for the maximize check')
  check(
    getComputedStyle(document.querySelector('.session-rail')).visibility === 'visible',
    'The session rail is hidden before the panel is maximized'
  )
  document.querySelector('.tool-panel__action').click()
  await until(() => document.querySelector('.tool-panel--maximized'), 'The panel did not maximize')
  await pause(50)
  const railTickBox = document.querySelector('.session-rail__tick').getBoundingClientRect()
  check(
    !document.elementFromPoint(
      railTickBox.x + railTickBox.width / 2,
      railTickBox.y + railTickBox.height / 2
    )?.closest('.session-rail'),
    'The maximized panel leaves the session rail painted over its edge'
  )
  // Maximizing must not outrank the controls that undo it. The fixed panel once
  // sat above the shell's corner toggle and above its own menus, so every way
  // out of the state was covered by the state.
  const cornerToggle = document.querySelector('.shell__panel-toggle button')
  const cornerBox = cornerToggle.getBoundingClientRect()
  check(
    Boolean(document.elementFromPoint(
      cornerBox.x + cornerBox.width / 2, cornerBox.y + cornerBox.height / 2
    )?.closest('.shell__panel-toggle')),
    'The maximized panel covers the shell toggle, leaving no way out'
  )
  // The panel's own menus ride above it too: the tab context menu is portalled
  // with the popover level, and a maximized panel used to swallow it.
  const tabForMenu = document.querySelector('.tool-panel__tab-shell')
  const menuBox = tabForMenu.getBoundingClientRect()
  tabForMenu.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true, clientX: menuBox.x + menuBox.width / 2, clientY: menuBox.y + menuBox.height / 2
  }))
  const menuItem = await until(
    () => document.querySelector('.tool-tab-menu__item'),
    'The tab menu did not open while the panel was maximized'
  )
  const itemBox = menuItem.getBoundingClientRect()
  check(
    Boolean(document.elementFromPoint(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2)?.closest('.tool-tab-menu')),
    'The maximized panel covers the tab menu'
  )
  const pressEscape = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  pressEscape()
  await until(() => !document.querySelector('.tool-tab-menu'), 'Escape did not close the tab menu')
  check(document.querySelector('.tool-panel--maximized'), 'Escape left the menu and the maximized state at once')
  pressEscape()
  await until(() => !document.querySelector('.tool-panel--maximized'), 'Escape did not restore the maximized panel')
  document.querySelector('.tool-panel__action').click()
  await until(() => document.querySelector('.tool-panel--maximized'), 'The panel did not maximize again')
  document.querySelector('.tool-panel__action').click()
  await until(() => !document.querySelector('.tool-panel--maximized'), 'The panel did not restore')
  check(
    getComputedStyle(document.querySelector('.session-rail')).visibility === 'visible',
    'The session rail stayed hidden after restoring the panel'
  )
  store.setState({ items: railItemsBefore })
  passed.push('the maximized panel keeps its own escape routes on top of it')
  passed.push('the workspace panel uses MCode page tabs, start page, maximize and the file split view')

  // The docked panel is narrow, and the labelled "reveal in the file manager"
  // button wrapped its text to three lines. The action is an icon now, so the
  // tooltip has to carry the explanation and the row has to stay one line.
  await openToolPage('images', 'Images')
  const meta = await until(() => document.querySelector('.image-viewer__meta'), 'The Images page did not list the project picture')
  const reveal = meta.querySelector('button')
  check(reveal, 'The Images meta line has no reveal control')
  check(!reveal.textContent?.trim(), `The reveal control still carries a label: ${reveal.textContent?.trim()}`)
  check(Boolean(reveal.title), 'The reveal control has no tooltip to explain the icon')
  check(meta.getBoundingClientRect().height < 48, `The picture's meta line wrapped: ${meta.getBoundingClientRect().height}px`)
  passed.push('the image viewer reveals a picture with a tooltip-only icon')

  // The jump controls float centred on the composer's own axis, directly above
  // the box. They are placed by `.scroll-jumps`, and a stray `}` in the
  // stylesheet once swallowed that whole rule and left the container
  // `position: static`, parked at the top of the thread. Probe the rule with a
  // throwaway element so the check does not depend on where the reader is.
  const frame = await until(() => document.querySelector('.thread-frame'), 'No conversation thread to measure')
  const composer = await until(() => document.querySelector('.composer'), 'No composer to align the jump controls with')
  const probe = document.createElement('div')
  probe.className = 'scroll-jumps'
  frame.appendChild(probe)
  try {
    const style = getComputedStyle(probe)
    const box = probe.getBoundingClientRect()
    const area = frame.getBoundingClientRect()
    const input = composer.getBoundingClientRect()
    check(style.position === 'absolute', `The jump controls are not positioned: ${style.position}`)
    const centre = (box.left + box.right) / 2
    const inputCentre = (input.left + input.right) / 2
    check(Math.abs(centre - inputCentre) <= 1, `The jump controls are not centred on the composer: ${centre} vs ${inputCentre}`)
    check(box.bottom <= area.bottom && input.top >= box.bottom, `The jump controls are not above the composer: bottom ${box.bottom}, composer top ${input.top}`)
    check(style.pointerEvents === 'none', 'The jump band must not swallow clicks across the column')
  } finally {
    probe.remove()
  }
  passed.push('the scroll-to-top and scroll-to-bottom controls float centred above the composer')
  // A conversation's mark hangs in the row's indent, out of the flow: a row that
  // is running must not slide its title right of a row that has nothing to say,
  // and every title starts on the project's own text column.
  await until(() => document.querySelector('.session-item'), 'The sidebar has no conversation rows to measure')
  const sessionRows = [...document.querySelectorAll('.session-item')]
  const titleColumn = (row) => Math.round(row.querySelector('.session-item__title')?.getBoundingClientRect().x ?? -1)
  const idleColumns = new Set(sessionRows.map(titleColumn))
  check(idleColumns.size === 1, `Conversation titles do not share a column: ${[...idleColumns].join(', ')}`)
  const runningMark = document.createElement('span')
  runningMark.className = 'session-item__status'
  const unreadMark = document.createElement('span')
  unreadMark.className = 'session-item__dot'
  sessionRows[0].querySelector('.session-item__main').appendChild(runningMark)
  sessionRows[1]?.querySelector('.session-item__main')?.appendChild(unreadMark)
  try {
    const markedColumns = new Set(sessionRows.map(titleColumn))
    check(
      markedColumns.size === 1 && markedColumns.values().next().value === idleColumns.values().next().value,
      `A mark moved a conversation title: ${[...markedColumns].join(', ')}`
    )
    const icon = document.querySelector('.project__icon').getBoundingClientRect()
    const markBox = runningMark.getBoundingClientRect()
    const dotBox = unreadMark.getBoundingClientRect()
    check(
      Math.abs(markBox.x + markBox.width / 2 - (icon.x + icon.width / 2)) <= 1,
      'The running mark is not centred in the project icon column'
    )
    check(
      Math.round(markBox.x) === Math.round(dotBox.x) && Math.round(markBox.width) === Math.round(dotBox.width),
      'The spinner and the dot do not share one slot'
    )
  } finally {
    runningMark.remove()
    unreadMark.remove()
  }
  passed.push('a conversation mark hangs in the indent without moving the title')

  store.setState((state) => ({
    activeSessionFile: undefined, draftId: 'draft:task-rail', items: railItems,
    threads: { ...state.threads, 'draft:task-rail': { ...baseThread, items: railItems } }
  }))
  if (document.querySelector('.tool-panel')) {
    document.querySelector('.shell__panel-toggle button').click()
    await until(() => !document.querySelector('.tool-panel'), 'The workspace panel did not close')
  }
  const backgroundTask = await until(
    () => document.querySelector('.task-panel__task button'),
    'The background task row has no clickable control'
  )
  backgroundTask.click()
  await until(() => document.querySelector('.subagent-conversation__identity')?.textContent === 'Run the gate', 'The background task did not open its child conversation')
  check(document.querySelector('.subagent-conversation [role="status"]'), 'The running task did not show its waiting state')
  check(store.getState().draftId === 'draft:task-rail', 'Opening a background task switched the parent conversation')
  const completedRailItems = railItems.map((item) => item.id !== 'rail-sub' ? item : {
    ...item, status: 'ok', details: { mode: 'parallel', results: [{
      task: 'Run the gate', status: 'completed', output: 'Gate verified live',
      messages: [
        { role: 'user', content: 'Run the gate', timestamp: 9 },
        { role: 'assistant', content: [{ type: 'text', text: 'Gate verified live' }], timestamp: 10 }
      ]
    }] }
  })
  store.setState((state) => ({
    items: completedRailItems,
    threads: { ...state.threads, 'draft:task-rail': { ...state.threads['draft:task-rail'], items: completedRailItems } }
  }))
  await until(() => document.querySelector('.subagent-conversation__assistant')?.textContent.includes('Gate verified live'), 'The open background task did not receive its latest output')
  check(document.querySelector('.subagent-conversation__meta [data-status="completed"]'), 'The open task kept its old running state')
  document.querySelector('.subagent-conversation__back').click()
  await until(() => document.querySelector('.subagent-tree'), 'Back did not return to the subagent catalog')
  backgroundTask.click()
  await until(() => document.querySelector('.subagent-conversation__assistant')?.textContent.includes('Gate verified live'), 'The same background task could not be reopened')
  check([...document.querySelectorAll('.tool-panel__tab')].filter((tab) => tab.textContent.includes('Subagents')).length === 1, 'Opening a task duplicated the Subagents page')
  document.querySelector('.subagent-conversation__back').click()
  await until(() => document.querySelector('.subagent-tree'), 'Back did not restore the catalog after reopening')
  passed.push('background task rows open their live child conversation and can be reopened')

  await openToolPage('files', 'Files')
  const fileSearch = await until(
    () => document.querySelector('.tree__search input[aria-label="Find files"]'),
    'The Files page did not render its search field'
  )
  const flatFileNames = () => [...document.querySelectorAll('.tree__item--flat .tree__name')].map((node) => node.textContent)
  setInputValue(fileSearch, 'old-only')
  await until(() => flatFileNames().includes('old-only-result.txt'), 'The first file search did not find its fixture')
  setInputValue(fileSearch, 'new-only')
  await pause(20)
  check(document.querySelector('.tree__results-head')?.textContent === 'Searching…', 'The updated file search did not show its pending state')
  check(!flatFileNames().includes('old-only-result.txt'), 'The previous file search results stayed visible under a new query')
  await until(() => flatFileNames().includes('new-only-result.txt'), 'The updated file search did not find its fixture')
  passed.push('file search clears stale matches while the next query is running')

  setInputValue(fileSearch, '')
  const nestedFolder = await until(
    () => [...document.querySelectorAll('.tree__item')].find((node) => node.querySelector('.tree__name')?.textContent === 'nested-project'),
    'The nested project folder did not appear in the parent tree'
  )
  nestedFolder.click()
  await until(
    () => [...document.querySelectorAll('.tree__item .tree__name')].some((node) => node.textContent === 'nested-only.txt'),
    'The nested folder did not load before switching projects'
  )
  await store.getState().switchProject(nestedWorkspace)
  await until(
    () => store.getState().workspace?.path === nestedWorkspace,
    'The nested project did not become the active workspace'
  )
  await until(
    () => [...document.querySelectorAll('.tree__item .tree__name')].some((node) => node.textContent === 'nested-only.txt'),
    'The file tree did not reload when a previously expanded folder became the workspace root'
  )
  passed.push('the file tree reloads a folder when it becomes the active workspace root')

  // The usage caption is one evenly spaced, vertically centred line: all three
  // controls share a height and a centre line, and the ring no longer towers
  // over the digits. Mixing baselines with a taller icon once made the middle
  // of the line read as a ragged gap.
  store.setState((state) => ({
    items: [
      { id: 'usage-u', kind: 'user', text: 'hello', images: [], timestamp: 1, order: 1 },
      {
        id: 'usage-a', kind: 'assistant', streaming: false, stopReason: 'stop', timestamp: 2, order: 2,
        blocks: [{ type: 'text', text: 'done' }],
        usage: { input: 300, output: 120, cacheRead: 700, cacheWrite: 0, totalTokens: 1120 }
      }
    ],
    stats: {
      userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
      tokens: { input: 300, output: 120, cacheRead: 700, cacheWrite: 0, total: 1120 }, cost: 0,
      contextUsage: { tokens: 18400, contextWindow: 200000, percent: 9 }
    },
    run: { phase: 'idle', turns: 1, settled: true, outcome: 'completed' },
    settings: { ...state.settings, showContextUsage: true }
  }))
  const usageBar = await until(() => document.querySelector('.usage-bar'), 'The usage line did not render')
  const usageBoxes = [...usageBar.children].map((node) => node.getBoundingClientRect())
  const usageHeights = new Set(usageBoxes.map((box) => Math.round(box.height)))
  const usageCentres = new Set(usageBoxes.map((box) => Math.round(box.top + box.height / 2)))
  check(usageHeights.size === 1, `Usage controls do not share a height: ${[...usageHeights].join(', ')}`)
  check(usageCentres.size === 1, `Usage controls are not vertically centred: ${[...usageCentres].join(', ')}`)
  const usageComposer = document.querySelector('.composer')?.getBoundingClientRect()
  const usageBarBox = usageBar.getBoundingClientRect()
  const usageCentre = (usageBarBox.left + usageBarBox.right) / 2
  check(
    usageComposer && Math.abs(usageCentre - (usageComposer.left + usageComposer.right) / 2) <= 1,
    'The usage line is not centred on the composer'
  )
  const ringSvg = usageBar.querySelector('.context-ring__svg')?.getBoundingClientRect()
  const usageLabel = usageBar.querySelector('.context-ring__label')?.getBoundingClientRect()
  check(
    ringSvg && usageLabel &&
      Math.abs((ringSvg.top + ringSvg.height / 2) - (usageLabel.top + usageLabel.height / 2)) <= 2,
    'The context ring is not centred with its percentage label'
  )
  passed.push('the usage line shares one height and centre on the composer axis')

  // A sidebar row explains itself in a card, not in the native tooltip: the
  // card carries a label column and the details the row cannot show, and it
  // sits beside the row instead of covering it.
  const hoveredSession = await until(
    () => [...document.querySelectorAll('.session-item')].find((row) =>
      row.querySelector('.session-item__title')?.textContent?.trim()
    ),
    'No conversation row rendered for the hover card'
  )
  const hoveredMain = hoveredSession.querySelector('.session-item__main')
  check(!hoveredMain.getAttribute('title'), 'A conversation row still uses the native title tooltip')
  // `focusin` is what React's `onFocus` is delegated from; a bare `focus`
  // event does not bubble and never reaches the handler.
  hoveredMain.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  const sessionTip = await until(() => document.querySelector('.sidebar-tip'), 'The conversation hover card did not open')
  const sessionLabels = [...sessionTip.querySelectorAll('.sidebar-tip__label')].map((node) => node.textContent)
  check(
    ['Created', 'Path', 'Status'].every((label) => sessionLabels.includes(label)),
    `The conversation card is missing a row: ${sessionLabels.join(', ')}`
  )
  const sessionTipBox = sessionTip.getBoundingClientRect()
  const hoveredBox = hoveredSession.getBoundingClientRect()
  check(sessionTipBox.width > 0 && sessionTipBox.height > 0, 'The conversation hover card has no size')
  check(
    sessionTipBox.left >= hoveredBox.right - 1 || sessionTipBox.right <= hoveredBox.left + 1,
    'The conversation hover card covers the row it describes'
  )
  check(
    sessionTipBox.right <= innerWidth + 1 && sessionTipBox.bottom <= innerHeight + 1,
    'The conversation hover card runs outside the window'
  )
  // The path wraps instead of being clipped: a half path answers nothing.
  const pathValue = [...sessionTip.querySelectorAll('.sidebar-tip__value')]
    .find((node) => node.dataset.path === 'true')
  check(
    pathValue && pathValue.scrollWidth <= pathValue.clientWidth + 1,
    'The conversation card clips its path instead of wrapping it'
  )
  hoveredMain.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  await pause(200)

  const hoveredProject = await until(
    () => document.querySelector('.project__main'),
    'No project row rendered for the hover card'
  )
  check(!hoveredProject.getAttribute('title'), 'A project row still uses the native title tooltip')
  hoveredProject.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  const projectTip = await until(
    () => document.querySelector('.sidebar-tip'),
    'The project hover card did not open'
  )
  const projectLabels = [...projectTip.querySelectorAll('.sidebar-tip__label')].map((node) => node.textContent)
  check(
    ['Created', 'Conversations', 'Path'].every((label) => projectLabels.includes(label)),
    `The project card is missing a row: ${projectLabels.join(', ')}`
  )
  hoveredProject.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  await pause(200)
  passed.push('sidebar rows explain themselves in a card instead of a native tooltip')

  // Leave the environment section folded in the harness screenshot so the
  // collapsed state remains visible for visual review.
  const finalEnvironmentToggle = [...document.querySelectorAll('.task-panel__section')]
    .find((node) => node.querySelector('.task-panel__section-title')?.textContent === 'Environment info')
    ?.querySelector('.task-panel__section-toggle')
  if (finalEnvironmentToggle?.getAttribute('aria-expanded') !== 'false') finalEnvironmentToggle?.click()
  await pause(250)
  check(finalEnvironmentToggle?.getAttribute('aria-expanded') === 'false', 'The final environment screenshot is not folded')

  return passed
}

const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.startsWith('PI_DESKTOP_')) delete env[key]
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
Object.assign(env, {
  PI_DESKTOP_SCREENSHOT: path.join(output, 'renderer.png'),
  PI_DESKTOP_USER_DATA: profile,
  PI_DESKTOP_WORKSPACE: workspace,
  PI_CODING_AGENT_DIR: agent,
  PI_CODING_AGENT_SESSION_DIR: path.join(agent, 'sessions'),
  PI_DESKTOP_SCREENSHOT_DELAY: '1000',
  PI_DESKTOP_EVAL_DELAY: '100',
  PI_DESKTOP_RPC_TRACE: '0',
  PI_DESKTOP_EVAL: `(${checkRenderer.toString()})(${JSON.stringify(markerFile)}, ${JSON.stringify(nestedWorkspace)})`
})
try {
  const { stdout, stderr } = await promisify(execFile)(require('electron'), [root], {
    cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024
  })
  const rendererErrors = stdout.split(/\r?\n/).filter((line) => line.includes('[pi-desktop] renderer error:'))
  assert.deepEqual(rendererErrors, [], `Renderer console errors:\n${rendererErrors.join('\n')}`)
  const match = /\[pi-desktop\] eval result: (.+)/.exec(stdout)
  assert.ok(match, `Renderer regressions failed:\n${stdout}\n${stderr}\nRequests: ${JSON.stringify(requests)}`)
  const passed = JSON.parse(match[1])
  assert.equal(passed.length, process.platform === 'win32' ? 21 : 20)
  if (process.platform === 'win32') {
    // ConPTY may redraw old output on resize; the file counts actual executions.
    assert.equal(readFileSync(markerFile, 'utf8').trim().split(/\r?\n/).length, 2, 'Terminal replayed a request')
  }
  for (const name of passed) console.log(`PASS ${name}`)
} finally {
  fixture.closeAllConnections()
  await new Promise((resolve) => fixture.close(resolve))
  assert.equal(path.dirname(profile), output)
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

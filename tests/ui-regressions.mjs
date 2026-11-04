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
const output = path.join(root, 'output', 'playwright', 'ui-regressions')
mkdirSync(output, { recursive: true })
const profile = mkdtempSync(path.join(output, 'profile-'))
const markerFile = path.join(profile, 'terminal-requests.txt')
const workspace = path.join(profile, 'workspace')
mkdirSync(workspace)
writeFileSync(path.join(workspace, 'note.txt'), 'hello from the workspace\n')
// A 1×1 PNG so the Images page has something real to list.
writeFileSync(
  path.join(workspace, 'shot.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
)
const agent = path.join(profile, 'agent')
mkdirSync(agent)
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

async function checkRenderer(markerFile) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
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
      check(!state.error, `Pi rejected ${mode}: ${state.error}`)
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
    await window.pi.runtime.stop()
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
      args: { path: 'audit/nested/one.md', content: 'x' },
      status: 'ok',
      timestamp: 7,
      order: 7
    },
    {
      id: 'rail-write6',
      kind: 'tool',
      toolCallId: 'rail-write6',
      toolName: 'write',
      args: { path: 'audit/nested/two.md', content: 'x' },
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
  check(document.querySelectorAll('.task-panel__task').length === 1, 'The background task row is missing')
  check(document.querySelectorAll('.task-panel__check').length === 3, 'The plan checklist is missing a step')
  check(document.querySelectorAll('.task-panel__check[data-done]').length === 2, 'A finished step is not marked as done')
  check(document.querySelectorAll('.task-panel__folder').length === 2, 'The deliverables folders are missing')
  check(document.querySelectorAll('.task-panel__file').length === 6, 'The deliverables files are missing')
  // Every deliverable is on one column, whatever folder it sits under: a file
  // row says where it came from on its own right, and only a folder header uses
  // the indent, because that row's job is structure. A folder also keeps the
  // 20px tile slot a file wears, so its name starts on the same column.
  const nameLeft = (node) => Math.round(node.getBoundingClientRect().left)
  const fileNamed = (name) =>
    [...document.querySelectorAll('.task-panel__file')].find(
      (row) => row.querySelector('.task-panel__file-name')?.textContent === name
    )
  const folderNamed = (name) =>
    [...document.querySelectorAll('.task-panel__folder')].find(
      (row) => row.querySelector('.task-panel__folder-name')?.textContent === name
    )
  const column = (node) => nameLeft(node.querySelector('.task-panel__file-name, .task-panel__folder-name'))
  const topFolder = folderNamed('audit')
  const subFolder = folderNamed('nested')
  const rootFile = fileNamed('note.md')
  const insideFolder = fileNamed('hover-check.mjs')
  const insideSub = fileNamed('one.md')
  // A folder that holds one file is a path, not a group: the file stands on the
  // root column and names its folder itself.
  const soloFile = fileNamed('status.md')
  check(
    Boolean(topFolder && subFolder && rootFile && insideFolder && insideSub && soloFile),
    'The deliverables tree is missing a row'
  )
  for (const row of [rootFile, insideFolder, insideSub, soloFile]) {
    check(
      column(row) === column(topFolder),
      `${row.querySelector('.task-panel__file-name').textContent} is not on the deliverables column: ${column(row)} vs ${column(topFolder)}`
    )
  }
  check(
    column(subFolder) - column(topFolder) === 14,
    `A sub-folder header is not one indent step in from its parent: ${column(subFolder) - column(topFolder)}`
  )
  const dirHint = (row) => row.querySelector('.task-panel__file-dir')?.textContent ?? ''
  check(dirHint(insideFolder) === 'audit/', `A file inside a folder does not name it: "${dirHint(insideFolder)}"`)
  check(dirHint(insideSub) === 'audit/nested/', `A file in a sub-folder does not name it: "${dirHint(insideSub)}"`)
  check(dirHint(soloFile) === 'docs/', `A file alone in its folder does not name it: "${dirHint(soloFile)}"`)
  check(dirHint(rootFile) === '', 'A file at the project root claims a folder')
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
  while (document.querySelector('.tool-panel__tab-close')) {
    document.querySelector('.tool-panel__tab-close').click()
    await pause(30)
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
  await until(() => [...document.querySelectorAll('.tree__item')].find((node) => node.textContent?.includes('note.txt')), 'Workspace file did not appear in the tree')
  ;[...document.querySelectorAll('.tree__item')].find((node) => node.textContent?.includes('note.txt')).click()
  await until(() => document.querySelector('.file-workspace .viewer'), 'The file preview did not open beside the tree')
  check(document.querySelector('.file-workspace__tree'), 'Opening a file removed the file tree')
  document.querySelector('.tool-panel__action').click()
  await until(() => document.querySelector('.tool-panel--maximized'), 'The panel did not maximize')
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
  PI_DESKTOP_EVAL: `(${checkRenderer.toString()})(${JSON.stringify(markerFile)})`
})
try {
  const { stdout, stderr } = await promisify(execFile)(require('electron'), [root], {
    cwd: root, env, windowsHide: true, timeout: 120000, maxBuffer: 2 * 1024 * 1024
  })
  const match = /\[pi-desktop\] eval result: (.+)/.exec(stdout)
  assert.ok(match, `Renderer regressions failed:\n${stdout}\n${stderr}\nRequests: ${JSON.stringify(requests)}`)
  const passed = JSON.parse(match[1])
  assert.equal(passed.length, process.platform === 'win32' ? 13 : 12)
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

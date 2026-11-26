/** Run after npm run build; exercises the real renderer with isolated app data. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
writeFileSync(path.join(nestedWorkspace, 'index.html'), '<!doctype html>\n')
writeFileSync(path.join(nestedWorkspace, 'main.py'), 'print("hello")\n')
writeFileSync(path.join(nestedWorkspace, 'main.rs'), 'fn main() {}\n')
writeFileSync(path.join(nestedWorkspace, 'build.mjs'), 'export {}\n')
writeFileSync(path.join(nestedWorkspace, 'types.gql'), 'query { name }\n')
// A 1×1 PNG so the Images page has something real to list.
writeFileSync(
  path.join(workspace, 'shot.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
)
writeFileSync(
  path.join(workspace, 'shot-two.png'),
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
)
const agent = path.join(profile, 'home', '.pi', 'agent')
mkdirSync(agent, { recursive: true })
const searchFixtureDir = path.join(agent, 'sessions', `--${workspace.replace(/^[\\/]+/, '').replace(/[\\/:]/g, '-')}--`)
mkdirSync(searchFixtureDir, { recursive: true })
const archivedFixtureFile = path.join(searchFixtureDir, 'archive-search-archived.jsonl')
const savedGoal = {
  text: 'Check the saved objective\n  Keep the original indentation',
  status: 'blocked',
  summary: 'The verification file is missing.\n  Attach the original fixture, then resume.'
}
for (const scope of ['active', 'archived']) {
  const timestamp = new Date(Date.now() - (scope === 'archived' ? 60_000 : 0))
  const name = `Archive scope fixture ${scope}`
  const file = path.join(searchFixtureDir, `archive-search-${scope}.jsonl`)
  const records = [
    { type: 'session', version: 3, id: `archive-search-${scope}`, cwd: workspace, timestamp: timestamp.toISOString() },
    { type: 'session_info', id: 'session-name', parentId: null, name },
    { type: 'message', id: 'prompt', parentId: 'session-name', message: { role: 'user', content: `${name} text`, timestamp: +timestamp } }
  ]
  if (scope === 'active') records.push({
    type: 'custom', id: 'saved-goal', parentId: 'prompt', timestamp: timestamp.toISOString(),
    customType: 'pi-desktop-mode', data: { mode: 'goal', goal: savedGoal }
  })
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`)
  utimesSync(file, timestamp, timestamp)
}
const requests = []
const questionFixture = {
  prompts: {
    normal: 'UI_QUESTION_NORMAL Arrange the report',
    plan: 'UI_QUESTION_PLAN Plan the report',
    cancel: 'UI_QUESTION_CANCEL Continue the report'
  },
  question: 'Which report should I prepare?',
  options: ['Summary only', 'Summary and verification'],
  prematureFile: 'should-wait-for-an-answer.txt',
  reply: 'Report choice applied'
}
const questionRequests = { normal: 0, plan: 0, cancel: 0 }
const planFixture = {
  original: 'UI_PLAN_REVIEW Draft a verification plan',
  revision: 'UI_PLAN_REVIEW Revise the verification plan',
  plan: '# Verification plan\n\n' + Array.from({ length: 40 }, (_, index) => `- [ ] Check section ${index + 1}`).join('\n'),
  revisedPlan: '# Revised verification plan\n\n- [ ] Write the result\n- [ ] Verify the file',
  file: 'plan-implementation.txt',
  result: 'Implemented after plan approval'
}
const planRequests = { original: 0, revision: 0, implementation: 0 }
const goalFixture = {
  original: 'UI_GOAL_FLOW Original objective',
  revised: 'UI_GOAL_FLOW Revised  objective\n  Verify both branches',
  started: 'Working on the original objective',
  automatic: 'Verified the revised objective in the automatic round',
  summary: 'Updated objective verified',
  saved: savedGoal
}
const thinkingFixture = {
  prompt: 'Check the thinking disclosure',
  first: 'Read the fixture before answering.\n  Keep the original line break.',
  second: 'The read confirms the fixture.',
  reply: 'The fixture has been checked.'
}
const backgroundFixture = {
  prompt: 'UI_TASK_RAIL_COMMAND',
  tool: process.platform === 'win32' ? 'powershell' : 'bash',
  command: process.platform === 'win32' ? 'Start-Sleep -Seconds 5' : 'sleep 5'
}
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
    const callTools = (calls) => {
      send({ role: 'assistant', tool_calls: calls.map(({ id, name, args }, index) => ({
        index, id, type: 'function', function: { name, arguments: JSON.stringify(args) }
      })) })
      send({}, 'tool_calls')
      res.end('data: [DONE]\n\n')
    }
    const callTool = (id, name, args) => callTools([{ id, name, args }])
    const holdResponse = (text, duration) => {
      send({ role: 'assistant', content: text })
      const timer = setTimeout(() => {
        send({}, 'stop')
        res.end('data: [DONE]\n\n')
      }, duration)
      res.once('close', () => clearTimeout(timer))
    }
    const userHistory = (payload.messages ?? []).filter((message) => message.role === 'user')
      .map(({ content }) => Array.isArray(content) ? content.map((part) => part.text).join('\n') : content)
      .join('\n')
    const latestUserText = Array.isArray(user?.content) ? user.content.map((part) => part.text).join('\n') : user?.content
    const planRound = userHistory.includes(planFixture.revision) ? 'revision'
      : userHistory.includes(planFixture.original) ? 'original' : undefined
    const questionRound = Object.keys(questionFixture.prompts).find((round) =>
      userHistory.includes(questionFixture.prompts[round]))
    if (questionRound) {
      const activeTools = new Set(payload.tools?.map((tool) => tool.function.name))
      assert.ok(activeTools.has('desktop_ask_user'), 'The model did not receive the question tool')
      if (questionRound === 'plan') assert.equal(activeTools.has('write'), false)
      if (++questionRequests[questionRound] === 1) {
        const args = { question: questionFixture.question, options: questionFixture.options }
        if (questionRound === 'normal') {
          callTools([
            { id: 'ui-premature-write', name: 'write', args: { path: questionFixture.prematureFile, content: 'Premature work' } },
            { id: 'ui-ask', name: 'desktop_ask_user', args },
            { id: 'ui-ask-duplicate', name: 'desktop_ask_user', args }
          ])
        } else callTool('ui-ask', 'desktop_ask_user', args)
      } else {
        assert.ok(payload.messages.some((message) => message.role === 'tool' &&
          JSON.stringify(message.content).includes(`The user selected: ${questionFixture.options[1]}`)), 'Pi continued without the selected answer')
        finish(questionFixture.reply)
      }
    } else if (planRound) {
      const tools = new Set(payload.tools?.map((tool) => tool.function.name))
      if (tools.has('exit_plan_mode')) {
        assert.equal(tools.has('write'), false, 'Planning exposed the write tool')
        assert.equal(userHistory.split('Plan Mode is active.').length - 1, 1, 'The request repeated its planning guidance')
        if (++planRequests[planRound] === 1) {
          const markdown = planRound === 'revision' ? planFixture.revisedPlan : planFixture.plan
          send({ role: 'assistant', content: markdown })
          callTool(`ui-plan-${planRound}`, 'exit_plan_mode', { plan: markdown })
        } else finish('Unexpected planning request')
      } else {
        assert.equal(planRound, 'revision', 'Pi left Plan Mode before approval')
        assert.doesNotMatch(userHistory, /Plan Mode is active\./)
        assert.ok(tools.has('write'), 'Approval did not restore the write tool')
        if (++planRequests.implementation === 1) {
          callTool('ui-plan-write', 'write', { path: planFixture.file, content: planFixture.result })
        } else finish(planFixture.result)
      }
    } else if (latestUserText === thinkingFixture.prompt) {
      const readFinished = payload.messages.some((message) => message.role === 'tool')
      if (readFinished) {
        send({ role: 'assistant', reasoning_content: thinkingFixture.second })
        finish(thinkingFixture.reply)
      } else {
        send({ role: 'assistant', reasoning_content: thinkingFixture.first })
        const timer = setTimeout(() => callTool('ui-thinking-read', 'read', { path: 'note.txt' }), 3000)
        res.once('close', () => clearTimeout(timer))
      }
    } else if (userHistory.includes(goalFixture.original)) {
      const finished = payload.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes(goalFixture.summary))
      if (finished) {
        finish('Goal complete')
      } else if (userHistory.includes('Goal Mode is still active.')) {
        assert.ok(userHistory.includes('Goal: ' + goalFixture.revised), 'The automatic round used a stale objective')
        holdResponse(goalFixture.automatic, 20_000)
      } else if (userHistory.includes('Continue toward the active goal.')) {
        assert.ok(userHistory.includes('Goal: ' + goalFixture.revised), 'The resumed round used a stale objective')
        callTool('ui-finish-goal', 'desktop_goal_finish', { status: 'complete', summary: goalFixture.summary })
      } else {
        assert.ok(userHistory.includes('Goal: ' + goalFixture.original), 'The first request omitted the goal')
        holdResponse(goalFixture.started, 5_000)
      }
    } else if (latestUserText === backgroundFixture.prompt && !payload.messages.some((message) => message.role === 'tool')) {
      callTool('ui-background-command', backgroundFixture.tool, { command: backgroundFixture.command })
    } else if (prompt?.includes('UI_TREE_CHILD')) {
      setTimeout(() => finish('Child task verified'), 1500)
    } else if (prompt?.includes('UI_TREE_PARENT') && !payload.messages.some((message) => message.role === 'tool')) {
      callTool('ui-live-agents', 'subagent', { tasks: [{ task: 'UI_TREE_CHILD inspect' }, { task: 'UI_TREE_CHILD verify' }] })
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
  model: 'fixture/sidebar-test', thinkingLevel: 'off', permissionMode: 'full', trustProject: false, desktopNotifications: false,
  archivedSessions: [process.platform === 'win32' ? archivedFixtureFile.replaceAll('\\', '/').toLowerCase() : archivedFixtureFile]
}))

async function checkRenderer(markerFile, nestedWorkspace, workspace, goalFixture, thinkingFixture, backgroundFixture, planFixture, questionFixture) {
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const setInputValue = (input, value) => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  // A paused animation frame or a paint throttled by an occluded window shows
  // up here first, so the wait is generous and the failure says where focus was.
  const until = async (read, message, timeout = 15000) => {
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
    const active = document.activeElement
    const focus = active instanceof HTMLElement
      ? `${active.tagName.toLowerCase()}${active.className ? `.${String(active.className).trim().split(/\s+/).join('.')}` : ''}`
      : String(active)
    const modals = document.querySelectorAll('[aria-modal="true"]').length
    const visible = document.visibilityState
    throw new Error(`${message}: ${JSON.stringify({ error: state.error, phase: state.run.phase, focus, modals, visible, tools })}`)
  }
  const store = window.__piDesktopStore
  await store.getState().updateSettings({ language: 'en', terminalShell: 'cmd' })
  const passed = []
  const railSection = (title) => [...document.querySelectorAll('.task-panel__section')].find((section) =>
    section.querySelector('.task-panel__section-title')?.textContent === title
  )

  await until(() => !document.getElementById('startup-screen'), 'The startup screen did not leave after bootstrap')
  // The transcript is painted once per animation frame, and Chromium stops
  // those frames for a hidden window. The harness disables backgrounding for
  // its own window (app-main.ts); if that ever stops working, say so here
  // instead of letting an unrelated check time out minutes later.
  check(document.visibilityState === 'visible', `The harness window is ${document.visibilityState}: painting is paused`)
  check(!document.getElementById('root').inert, 'The interface stayed inert after startup')
  check(!document.getElementById('root').hasAttribute('aria-hidden'), 'The interface stayed hidden from assistive technology')
  passed.push('the startup screen reveals the interactive interface after bootstrap')

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

  // App messages float below the title bar, not inside the composer: a
  // confirmation must never push the box the user is typing in.
  const composerBeforeToast = document.querySelector('.composer')?.getBoundingClientRect()
  check(composerBeforeToast, 'The composer is missing while checking the app toast')
  store.getState().showToast('Toast placement check')
  const appToast = await until(() => document.querySelector('.app-toast'), 'The app toast did not render')
  // The card fades in while rising a few pixels, so the settled position is
  // what "centred" means — measure once the animation has finished rather than
  // on its first frame.
  const appToastBox = await until(() => {
    const box = document.querySelector('.app-toast')?.getBoundingClientRect()
    if (!box || box.width === 0) return undefined
    const dx = Math.abs(box.left + box.width / 2 - innerWidth / 2)
    const dy = Math.abs(box.top + box.height / 2 - innerHeight / 2)
    return dx <= 2 && dy <= 2 ? box : undefined
  }, 'The app toast is not centred in the window')
  check(appToast.closest('.composer') === null, 'The app toast is rendered inside the composer')
  check(appToastBox.width > 0 && appToastBox.height > 0, 'The app toast has no size')
  // The notice is centred: a confirmation belongs where the reader is looking,
  // and an edge-anchored card read as something sliding in from the side.
  check(
    appToastBox.top >= 0 && appToastBox.right <= innerWidth + 1,
    'The app toast runs outside the window'
  )
  const composerAfterToast = document.querySelector('.composer').getBoundingClientRect()
  check(
    Math.abs(composerAfterToast.top - composerBeforeToast.top) <= 1 &&
      Math.abs(composerAfterToast.height - composerBeforeToast.height) <= 1,
    'The app toast moved the composer'
  )
  appToast.querySelector('.app-toast__close')?.click()
  await until(() => !document.querySelector('.app-toast'), 'The app toast did not dismiss')
  passed.push('app messages appear in the middle of the window without moving the composer')

  const visibleToolPanel = () => document.querySelector('.tool-panel:not([hidden])')
  // A page opens the way the panel does it: the `+` creates a new tab, and its
  // start page turns that tab into the chosen page. A page already open is only
  // focused, never added twice.
  const openToolPage = async (view, label) => {
    if (!visibleToolPanel()) {
      const toggle = [...document.querySelectorAll('button')].find((node) => node.getAttribute('aria-label') === 'Show tools panel')
      toggle?.click()
    }
    await until(() => visibleToolPanel()?.querySelector('.tool-panel__new-tab'), 'The workspace panel did not open')
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
    for (const mode of ['plan', 'goal', 'swarm', 'default']) {
      await store.getState().setAgentMode(mode)
      const state = store.getState()
      const sessionKey = state.activeSessionFile ?? state.draftId
      const runtimeIsLive = sessionKey ? await window.pi.runtime.has(sessionKey) : false
      check(!state.error, `Pi rejected ${mode}: ${state.error} (session=${sessionKey}, runtimeLive=${runtimeIsLive})`)
      check(state.status.phase === 'ready' && state.agentMode === mode && modes.at(-1) === mode, `Pi did not confirm ${mode}`)
    }
    passed.push('task modes round-trip through the bundled Pi CLI')

    await store.getState().updateSettings({ permissionMode: 'ask' })
    // Each round asks the same question with the same options, so a dialog left
    // over from the previous round satisfies every content check below — and its
    // list is not the one that will take focus. Hold this round's own dialog:
    // the wait refuses a node it already saw.
    let previousDialog = null
    for (const [round, mode] of [['normal', 'default'], ['plan', 'plan'], ['cancel', 'goal']]) {
      if (store.getState().agentMode !== mode) await store.getState().setAgentMode(mode)
      await store.getState().send(questionFixture.prompts[round], [])
      const choice = await until(() => {
        const dialog = document.querySelector('.modal--prompt')
        return dialog && dialog !== previousDialog ? dialog : null
      }, 'The user question did not open')
      previousDialog = choice
      const options = choice.querySelector('[role="listbox"]')
      check(options && choice.querySelector('.modal__title').textContent === questionFixture.question,
        'The user question was replaced by a different dialog')
      check([...options.querySelectorAll('[role="option"]')].map((option) => option.textContent.trim()).join('|') === questionFixture.options.join('|'),
        'The dialog did not show the model’s choices')
      check(store.getState().run.phase === 'waiting_approval', 'Pi did not pause while waiting for an answer')
      if (round === 'cancel') {
        const cancel = [...choice.querySelectorAll('.modal__foot button')].find((button) => button.textContent.trim() === 'Cancel')
        cancel.click()
        await until(() => !choice.isConnected && !store.getState().isStreaming, 'Cancelling the question did not settle the run')
        check(document.querySelector('.goal-bar[data-status="blocked"]'), 'The cancelled question did not pause the goal')
      } else {
        // Re-read the list on every poll: a re-render hands focus to the node
        // that is on screen now, which is not always the one captured above.
        const focusedOptions = await until(() => {
          const dialog = document.querySelector('.modal--prompt')
          const list = dialog?.querySelector('[role="listbox"]')
          return list && document.activeElement === list ? list : null
        }, 'The choice list did not receive keyboard focus')
        focusedOptions.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
        await until(() => focusedOptions.querySelector('[aria-selected="true"]')?.textContent.trim() === questionFixture.options[1],
          'Keyboard navigation did not select the second option')
        focusedOptions.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        await until(() => !choice.isConnected && !store.getState().isStreaming && store.getState().items.some((item) =>
          item.kind === 'assistant' && item.blocks.some((block) => block.type === 'text' && block.text.includes(questionFixture.reply))
        ), 'The selected answer did not resume the requesting conversation')
        check(store.getState().items.some((item) => item.kind === 'tool' && item.toolName === 'desktop_ask_user' &&
          item.details?.answer === questionFixture.options[1]), 'The conversation did not record the selected option')
      }
      check(store.getState().agentMode === mode, 'The question changed the conversation’s mode')
      await store.getState().newChat()
    }
    await store.getState().updateSettings({ permissionMode: 'full' })
    passed.push('user questions wait, route choices to Pi and settle cleanly when cancelled')

    await store.getState().setAgentMode('plan')
    await store.getState().send(planFixture.original, [])
    const planReview = () => document.querySelector('.modal--plan-review')
    const review = await until(planReview, 'Pi did not open the plan review')
    // Re-read on every poll, like the question dialog above: focus lands on the
    // node that is on screen, and a re-render can hand the review a new one.
    const planBody = await until(() => {
      const body = planReview()?.querySelector('.modal__plan')
      return body && document.activeElement === body ? body : null
    }, 'The plan document did not receive keyboard focus')
    check(planBody.scrollHeight > planBody.clientHeight && planBody.textContent.includes('Check section 40'), 'The long plan did not scroll inside the review')
    const reviewDialog = planBody.closest('.modal--plan-review')
    const footer = reviewDialog.querySelector('.modal__foot').getBoundingClientRect()
    check(footer.top >= planBody.getBoundingClientRect().bottom - 1 && footer.bottom <= innerHeight, 'The review actions fell outside the window')
    planBody.scrollTop = planBody.scrollHeight
    check(planBody.scrollTop > 0, 'The plan content cannot be scrolled')
    const action = (label) => [...planReview().querySelectorAll('.modal__foot button')].find((button) => button.textContent.trim() === label)
    action('Keep planning').click()
    await until(() => !planReview() && !store.getState().isStreaming, 'Continuing planning did not settle the turn')
    check(store.getState().agentMode === 'plan', 'Continuing planning left Plan Mode')
    await until(() => document.activeElement === document.querySelector('.composer__input'), 'Revision focus did not return to the composer')

    await store.getState().send(planFixture.revision, [])
    await until(() => planReview()?.querySelector('.modal__plan')?.textContent.includes('Revised verification plan'), 'The revised plan was not submitted for review')
    check(planReview().querySelector('.modal__plan').scrollTop === 0, 'The revised plan inherited the previous scroll position')
    action('Start implementation').click()
    await until(() => !store.getState().isStreaming && store.getState().items.some((item) =>
      item.kind === 'tool' && item.toolCallId === 'ui-plan-write' && item.status === 'ok'
    ), 'Pi did not implement the approved revision')
    check(store.getState().agentMode === 'default', 'Approval did not leave Plan Mode')
    passed.push('plan review supports reading, revision and explicit approval through the bundled Pi CLI')
    await store.getState().newChat()

    const goalButton = (title) => document.querySelector(`.goal-bar__actions button[title="${title}"]`)
    const goalReplyIncludes = (text) => store.getState().items.some((item) =>
      item.kind === 'assistant' && item.blocks.some((block) => block.type === 'text' && block.text.includes(text))
    )
    // The mode chip only exists while a task mode is on, so it must grow to the
    // right of the permission control instead of pushing 完全访问 sideways.
    const permissionBeforeMode = document.querySelector('.permission-picker')?.getBoundingClientRect()
    check(permissionBeforeMode, 'The permission control is missing while checking the composer bar')
    await store.getState().setAgentMode('goal')
    const modeChipBox = await until(
      () => document.querySelector('.composer__mode')?.getBoundingClientRect(),
      'The goal mode chip did not render'
    )
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const permissionAfterMode = document.querySelector('.permission-picker')?.getBoundingClientRect()
    check(
      permissionAfterMode && Math.abs(permissionAfterMode.left - permissionBeforeMode.left) <= 1,
      'Picking a mode moved the permission control'
    )
    check(
      modeChipBox.left >= permissionAfterMode.right - 0.5,
      'The mode chip sits in front of the permission control instead of after it'
    )
    await store.getState().send(goalFixture.original, [])
    await until(() => goalReplyIncludes(goalFixture.started), 'The first goal request did not reach the model')
    await until(() => document.querySelector('.goal-bar'), 'The goal bar did not appear for a live goal')
    // The bar states the goal, its run state and how to pause, edit or clear it,
    // so the composer must not repeat "Goal Mode" underneath it.
    check(
      !document.querySelector('.composer__mode'),
      'The composer still wears the goal mode chip while the goal bar already says it'
    )
    const activeDetails = await until(() => store.getState().isStreaming && goalButton('Goal details'), 'A running goal has no details')
    activeDetails.click()
    const activeEdit = await until(() => document.querySelector('.goal-details__head button'), 'A running goal could not be edited')
    check(document.querySelector('.goal-details__duration'), 'An active goal has no run duration in its details')
    activeEdit.click()
    const goalEditor = await until(() => document.querySelector('.goal-bar__input'), 'Goal editor did not open while running')
    check(!document.querySelector('.goal-details') && document.activeElement === goalEditor, 'Opening the goal editor did not move focus from the details')
    setInputValue(goalEditor, goalFixture.revised)
    document.querySelector('.goal-bar__action[data-tone="primary"]').click()
    await until(() => document.querySelector('.goal-bar__objective')?.textContent === goalFixture.revised, 'Pi did not confirm the exact multiline edit')
    await until(() => goalReplyIncludes(goalFixture.automatic), 'The edited objective did not reach the automatic round', 15000)
    goalButton('Pause').click()
    await until(() => !store.getState().isStreaming && document.querySelector('.goal-bar[data-status="paused"]'), 'Pausing did not settle the goal')
    await until(() => goalButton('Resume') && !goalButton('Resume').disabled, 'Resume stayed disabled after pause')
    goalButton('Resume').click()
    // A finished goal leaves the composer for the end of the transcript: the
    // bar was a header for work that is over, so the closing row carries the
    // objective and its summary instead.
    const goalDone = await until(() => {
      const row = document.querySelector('.goal-done')
      return row && !store.getState().isStreaming ? row : null
    }, 'The finished goal did not become a closing row')
    check(!document.querySelector('.goal-bar'), 'A finished goal kept its bar above the composer')
    check(goalDone.querySelector('.goal-done__objective')?.textContent === goalFixture.revised,
      'The completed row lost the objective')
    check(goalDone.querySelector('.goal-done__summary')?.textContent?.trim(), 'The completed row lost the completion summary')
    const threadInner = document.querySelector('.thread__inner')
    check(threadInner?.contains(goalDone), 'The completed row did not sit at the end of the conversation')
    await until(() => [...document.querySelectorAll('.run-outcome__label')].some((label) => label.textContent.includes('Resumed goal')), 'The manually resumed round did not have its own summary')

    const goalFile = store.getState().activeSessionFile
    const originalPrompt = await until(() => store.getState().forkTargets.find(({ text }) => text === goalFixture.original), 'Pi did not offer the original goal prompt for editing')
    // Editing a completed goal is not offered any more, so the rewind is made
    // from the request that created it; the restored branch brings the live
    // objective back, which is what the bar has to agree with.
    await store.getState().editMessageFrom(originalPrompt.entryId, goalFixture.original)
    await until(() => document.querySelector('.goal-bar__objective')?.textContent === goalFixture.original, 'Rewinding kept the goal or edit draft from the branch that was left')
    check(store.getState().activeSessionFile === goalFile && store.getState().agentMode === 'goal', 'Rewinding failed to restore Goal Mode in the same conversation')
    await store.getState().setAgentMode('plan')
    goalButton('Delete').click()
    await until(() => !document.querySelector('.goal-bar'), 'The retained goal did not clear')
    check(store.getState().agentMode === 'plan', 'Clearing the goal left Plan Mode')
    passed.push('the bundled Pi CLI edits, continues, pauses, resumes and rewinds a goal')

    const cold = await until(() => store.getState().sessions.find(({ name }) => name === 'Archive scope fixture active'), 'The saved goal fixture was missing')
    // Skip speculative prewarming here so this exercises the verified disk read.
    await store.getState().selectSession({ ...cold, messageCount: 0 })
    const detailTrigger = await until(() => document.querySelector('.goal-bar[data-status="blocked"] .goal-bar__details-trigger'), 'The saved blocker did not render')
    check(!(await window.pi.runtime.has(cold.file)), 'Reading goal details started a Pi process')
    detailTrigger.focus()
    detailTrigger.click()
    const details = await until(() => document.querySelector('.goal-details[role="dialog"]'), 'Goal details did not open')
    check(document.activeElement === details && detailTrigger.getAttribute('aria-expanded') === 'true', 'Goal details did not receive accessible focus')
    check([...details.querySelectorAll('.goal-details__text')].map((node) => node.textContent).join('\n') ===
      [goalFixture.saved.text, goalFixture.saved.summary].join('\n'), 'Goal details lost the full objective or blocker')
    const detailsRect = details.getBoundingClientRect()
    const barRect = document.querySelector('.goal-bar').getBoundingClientRect()
    const composerRect = document.querySelector('.composer').getBoundingClientRect()
    check(Math.abs(barRect.left - composerRect.left) <= 1 && Math.abs(barRect.right - composerRect.right) <= 1 && barRect.bottom < composerRect.top,
      'The goal bar does not share the composer column and keep a gap')
    check(detailsRect.left >= 0 && detailsRect.right <= innerWidth && detailsRect.bottom <= barRect.top, 'Goal details did not fit above the bar')
    details.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await until(() => !document.querySelector('.goal-details'), 'Escape did not close the goal details')
    check(document.activeElement === detailTrigger, 'Closing goal details did not return focus to the trigger')
    passed.push('cold goals show their full blocker before Pi starts and return keyboard focus on close')

    await store.getState().newChat()
    await store.getState().send(thinkingFixture.prompt, [])
    const thinkingHead = () => document.querySelector('.thinking__head')
    const liveThinking = await until(thinkingHead, 'Readable streamed thinking has no disclosure')
    check(liveThinking.textContent.trim() === 'Thinking content' && liveThinking.querySelectorAll('svg').length === 1,
      'The thinking header has extra text or icons')
    check(liveThinking.getAttribute('aria-expanded') === 'false' && !document.querySelector('.thinking__body'),
      'The thinking body was visible by default')
    liveThinking.click()
    await until(() => document.querySelector('.thinking__body')?.textContent.includes(thinkingFixture.first),
      'The disclosure did not show the live thinking')
    // Each reasoning step is its own paragraph; the fold must keep both, in
    // order, with the gap between them carried by the paragraph spacing.
    const thinkingSteps = () => [...document.querySelectorAll('.thinking__body .thinking__text')]
      .map((node) => node.textContent)
    const joinedThinking = [thinkingFixture.first, thinkingFixture.second].join('\n\n')
    await until(() => !store.getState().isStreaming && thinkingSteps().join('\n\n') === joinedThinking,
      'The thought fold did not survive the tool call with both fragments in order')
    check(document.querySelectorAll('.thinking__head').length === 1, 'One turn rendered multiple thinking headers')
    // The gap between two reasoning steps is the paragraph spacing, not the
    // blank line a pre-wrapped "\n\n" used to reserve.
    const stepGap = (() => {
      const steps = [...document.querySelectorAll('.thinking__body .thinking__text')]
      if (steps.length < 2) return null
      const first = steps[0].getBoundingClientRect()
      const second = steps[1].getBoundingClientRect()
      return Math.round(second.top - first.bottom)
    })()
    check(stepGap !== null && stepGap >= 0 && stepGap <= 14,
      `Thinking steps are spaced like blank lines, not paragraphs (gap ${stepGap}px)`)
    const stepLineHeight = (() => {
      const step = document.querySelector('.thinking__body .thinking__text')
      return step ? Number.parseFloat(getComputedStyle(step).lineHeight) : 0
    })()
    check(stepGap !== null && stepLineHeight > 0 && stepGap < stepLineHeight,
      `Thinking steps are farther apart than their own line height (${stepGap}px vs ${stepLineHeight}px)`)
    const thinkingFile = await until(() => store.getState().activeSessionFile, 'Pi did not assign the thinking session a file')
    await window.pi.runtime.stop(thinkingFile)
    await store.getState().newChat()
    store.setState((state) => {
      const threads = { ...state.threads }
      delete threads[thinkingFile]
      return { threads }
    })
    await store.getState().selectSession({
      id: 'thinking-replay', file: thinkingFile, cwd: workspace,
      preview: thinkingFixture.prompt, updatedAt: Date.now(), messageCount: 0
    })
    const replayedThinking = await until(thinkingHead, 'Replayed thinking has no disclosure')
    check(replayedThinking.getAttribute('aria-expanded') === 'false' && !document.querySelector('.thinking__body'),
      'Replayed thinking did not start folded')
    replayedThinking.click()
    await until(() => thinkingSteps().join('\n\n') === joinedThinking,
      'Replayed thinking lost a fragment')
    passed.push('one folded thinking row keeps readable content through live tool calls and replay')

  // The transcript is a scroll region a keyboard reader can enter: Tab reaches
  // it before its rows, and PageDown then scrolls the conversation.
  const threadRegion = document.querySelector('.main__body .thread')
  check(threadRegion, 'The conversation did not render a transcript region')
  check(threadRegion.getAttribute('role') === 'region', 'The transcript is not a labelled region')
  check(threadRegion.tabIndex === 0, 'The transcript cannot take keyboard focus for scrolling')
  threadRegion.focus()
  await until(() => document.activeElement === threadRegion, 'The transcript did not take focus')
  passed.push('the transcript is a focusable scroll region')

    await store.getState().newChat()
    await store.getState().send(backgroundFixture.prompt, [])
    const liveCommand = await until(() => store.getState().items.find((item) =>
      item.toolCallId === 'ui-background-command' && item.status === 'running'
    ), 'Pi did not start the shell command')
    await until(() => railSection('Background tasks')?.querySelector('.task-panel__task-label')?.textContent === backgroundFixture.command,
      'The quiet shell command did not appear by name while running')
    check(Date.now() - liveCommand.startedAt >= 2000, 'A shell command appeared during its grace period')
    await until(() => !railSection('Background tasks') && store.getState().items.some((item) =>
      item.toolCallId === 'ui-background-command' && item.status === 'ok'
    ), 'Finishing the real shell command did not clear its row')
    passed.push('background tasks show a quiet live shell command by name and remove it on exit')

    await store.getState().newChat()
    await openSubagentsPage()
    await store.getState().send('UI_TREE_PARENT delegate the two independent checks', [])
    await until(() => document.querySelectorAll('.subagent-tree__task').length === 2, 'Real child processes did not appear in the right panel', 45000)
    // The children live in the catalog in the right panel. Its rows carry each
    // child's status and avatar, and a row opens that child's transcript in the
    // panel that is already open here. (The title bar carries no subagent badge:
    // the rail and this panel are the two places a child is reachable.)
    const avatarSources = (rows) => [...rows].map((row) => row.querySelector('img.subagent-avatar')?.src)
    const catalogRows = () => document.querySelectorAll('.subagent-tree__task')
    // `data-status` is the row's own contract (the styles and the completion
    // check below read it); the visible summary line only exists once the child
    // has reported something.
    check(
      [...catalogRows()].every((row) => row.getAttribute('data-status')),
      'A subagent catalog row did not carry its status'
    )
    const catalogAvatars = avatarSources(catalogRows())
    check(catalogAvatars.every(Boolean) && new Set(catalogAvatars).size === 2, 'A batch of subagents did not have distinct avatars')
    catalogRows()[0].querySelector('.subagent-tree__task-row').click()
    await until(() => document.querySelector('.subagent-conversation'), 'A subagent catalog row did not open the child conversation in the right panel')
    check(
      document.querySelector('.subagent-conversation__identity .subagent-avatar')?.src === catalogAvatars[0],
      'The child conversation header changed its avatar'
    )
    document.querySelector('.subagent-conversation__back')?.click()
    await until(() => document.querySelector('.subagent-tree'), 'The subagent catalog did not return after the child conversation')
    passed.push('a subagent catalog row opens a child conversation in the right panel')
    await store.getState().newChat()
    check(document.querySelectorAll('.subagent-tree__task').length === 2, 'Switching chats hid live child processes')
    await until(() => document.querySelectorAll('.subagent-tree__task[data-status="completed"]').length === 2, 'Real child completion did not reach the right panel', 45000)
    check(
      avatarSources(document.querySelectorAll('.subagent-tree__task')).join('|') === catalogAvatars.join('|'),
      'Completing a subagent changed its avatar'
    )
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
      // The terminal tabs are one tablist: a single Tab stop and the arrows.
      const terminalTabs = [...document.querySelectorAll('.terminal__tab-main')]
      check(
        terminalTabs.filter((tab) => tab.tabIndex === 0).length === 1,
        'The terminal tab strip has more than one Tab stop'
      )
      const activeTerminalTab = terminalTabs.find((tab) => tab.tabIndex === 0)
      const otherTerminalTab = terminalTabs.find((tab) => tab !== activeTerminalTab)
      activeTerminalTab.focus()
      activeTerminalTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
      await until(
        () => document.activeElement === otherTerminalTab,
        'ArrowRight did not move to the other terminal tab'
      )
      check(
        otherTerminalTab.getAttribute('aria-selected') === 'true',
        'The arrow keys did not activate the terminal tab'
      )
      passed.push('the terminal tabs form one keyboard tablist')
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

      // A terminal belongs to the project it was opened in. Switching projects
      // is a view change, so it must not restart (and thereby kill) the shells —
      // a build or an ssh session has to survive browsing another folder. The
      // workspace path is moved directly here so this check owns only the view
      // change, not the process work a real project switch also does.
      const shellIds = [...outputs.keys()]
      check(shellIds.length === 2, 'The terminal test lost track of its shells')
      const workspaceBefore = store.getState().workspace
      store.setState({ workspace: { ...workspaceBefore, path: nestedWorkspace } })
      await pause(300)
      check([...outputs.keys()].join(',') === shellIds.join(','), 'Changing the project restarted the terminal')
      window.dispatchEvent(new CustomEvent('pi:terminal-run', {
        detail: { command: 'echo scoped>terminal-scope-marker.txt & echo PI_UI_SCOPED_HANDOFF_586' }
      }))
      await until(() => [...outputs].some(([id, value]) =>
        !shellIds.includes(id) && (value.match(/PI_UI_SCOPED_HANDOFF_586/g) ?? []).length >= 2
      ), 'The hand-off did not open a shell in the new project')
      const allShellIds = [...outputs.keys()]
      store.setState({ workspace: workspaceBefore })
      await pause(300)
      check([...outputs.keys()].join(',') === allShellIds.join(','), 'Changing the project back restarted the terminal')
      passed.push('terminal hand-offs follow the selected project while existing terminals survive')

      const terminalText = () => document.querySelector('.terminal__pane[data-active="true"] .xterm-rows')?.textContent ?? ''
      document.querySelector('.terminal__tab-main').click()
      await until(() => terminalText().includes('PI_UI_HANDOFF_347'), 'Existing terminal output was not visible before changing settings')
      try {
        await store.getState().updateSettings({ terminalShell: 'powershell' })
        window.dispatchEvent(new CustomEvent('pi:terminal-run', {
          detail: { command: 'echo PI_UI_SHELL_STAYS_847' }
        }))
        await until(() => (outputs.get(shellIds[0])?.match(/PI_UI_SHELL_STAYS_847/g) ?? []).length >= 2,
          'Changing the default shell replaced the existing CMD process', 8000)
        await until(() => terminalText().includes('PI_UI_SHELL_STAYS_847'), 'The existing CMD stopped painting output')
        check(terminalText().includes('PI_UI_HANDOFF_347'), 'Changing the default shell cleared the existing terminal output')
        check([...outputs.keys()].join(',') === allShellIds.join(','), 'Changing the default shell restarted a background terminal')

        document.querySelector('.terminal__new').click()
        await until(() => document.querySelector('.terminal__tab[data-active="true"] .terminal__tab-label')?.textContent === 'PowerShell',
          'A new terminal ignored the updated default shell')
        passed.push('the default shell applies to new tabs while open terminals keep their process and output')
      } finally {
        await store.getState().updateSettings({ terminalShell: 'cmd' })
      }

      document.querySelector('.terminal__tab-main').click()
      window.dispatchEvent(new CustomEvent('pi:terminal-run', { detail: { command: 'exit 0' } }))
      await until(() => document.querySelector('.terminal__pane[data-active="true"] .terminal__notice-title')?.textContent === 'The shell has exited',
        'The original CMD did not exit')
      const beforeReplacement = new Set(outputs.keys())
      const markers = ['PI_UI_REPLACE_SHELL_A_481', 'PI_UI_REPLACE_SHELL_B_481']
      for (const marker of markers) {
        window.dispatchEvent(new CustomEvent('pi:terminal-run', { detail: { command: `echo ${marker}` } }))
      }
      const replacement = await until(() => [...outputs].find(([id, output]) =>
        !beforeReplacement.has(id) && markers.every((marker) => (output.split(marker).length - 1) === 2)
      ), 'Commands handed off to an exited terminal did not run once each in a replacement', 8000)
      check([...outputs.keys()].filter((id) => !beforeReplacement.has(id)).join(',') === replacement[0],
        'A single terminal hand-off batch opened multiple replacements')
      check(replacement[1].indexOf(markers[0]) < replacement[1].indexOf(markers[1]),
        'The replacement received the two hand-offs out of order')
      check(document.querySelectorAll('.terminal__tab-main').length === beforeReplacement.size + 1,
        'Opening the replacement discarded the exited tab')
      document.querySelector('.terminal__tab-main').click()
      await until(() => terminalText().includes('PI_UI_HANDOFF_347'), 'The exited terminal lost its previous output')
      passed.push('rapid terminal hand-offs queue in order and replace an exited shell without discarding its tab')
    } finally {
      off()
      const panel = visibleToolPanel()
      if (panel) {
        const terminal = panel.querySelector('.terminal')
        document.querySelector('.shell__panel-toggle button').click()
        await until(() => !visibleToolPanel(), 'The terminal panel did not fold')
        if (terminal) {
          check(terminal.isConnected && terminal.getClientRects().length === 0, 'Folding the panel did not preserve the hidden terminal')
        }
      }
    }
  }

  const calls = []
  const goal = (text) => [{ key: 'pi-desktop-goal', text: JSON.stringify({ text, status: 'active' }) }]
  const runTaskCommand = store.getState().runTaskCommand
  let acceptGoalEdit = false
  store.setState({
    activeSessionFile: 'ui-goal-A',
    uiStatuses: goal('Goal A'),
    agentMode: 'goal',
    isStreaming: false,
    runTaskCommand: async (command) => {
      calls.push({ owner: store.getState().activeSessionFile, command })
      await pause(50)
      if (acceptGoalEdit) store.setState({ uiStatuses: goal(command.slice('/desktop-goal edit '.length)) })
      return store.getState().uiStatuses[0]?.text
    }
  })
  const resume = await until(() => document.querySelector('.goal-bar__actions button[title="Resume"]'), 'An idle active goal did not offer Resume')
  check(!resume.disabled, 'An idle active goal could not resume')
  await until(() => document.querySelector('.goal-bar__objective'), 'Goal did not render')
  // The objective is a label; the pencil in the actions row is the editor.
  const editPencil = await until(() => {
    const button = document.querySelector('.goal-bar__actions button[title="Edit"]')
    return button && !button.disabled ? button : null
  }, 'An idle active goal had no edit pencil')
  editPencil.click()
  await until(() => document.querySelector('.goal-bar__input'), 'Goal editor did not open')
  store.setState({ activeSessionFile: 'ui-goal-B', uiStatuses: goal('Goal B') })
  await pause(50)
  check(!document.querySelector('.goal-bar__input'), 'Goal editor retained a different conversation draft')
  const secondPencil = await until(() => {
    const button = document.querySelector('.goal-bar__actions button[title="Edit"]')
    return button && !button.disabled ? button : null
  }, 'Goal B had no edit pencil')
  secondPencil.click()
  const input = await until(() => document.querySelector('.goal-bar__input'), 'Second goal editor did not open')
  check(input.value === 'Goal B', 'Second goal editor used the first conversation text')
  const updatedGoal = 'Goal B revised\n  Keep indentation'
  setInputValue(input, updatedGoal)
  const saveGoal = document.querySelector('.goal-bar__action[data-tone="primary"]')
  saveGoal.click()
  await until(() => saveGoal.disabled, 'Goal save accepted a second submission while pending')
  await until(() => calls.length === 1, 'Goal was not saved')
  check(calls[0].owner === 'ui-goal-B' && calls[0].command === '/desktop-goal edit ' + updatedGoal, 'Goal saved to the wrong conversation')
  await until(() => !saveGoal.disabled, 'Goal save did not become retryable')
  check(input.isConnected && input.value === updatedGoal, 'An unconfirmed save discarded the goal draft')
  acceptGoalEdit = true
  saveGoal.click()
  await until(() => !document.querySelector('.goal-bar__input'), 'The confirmed save did not close the goal editor')
  store.setState({ runTaskCommand })
  passed.push('idle goals offer Resume and goal drafts stay in their conversation until Pi confirms the save')

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
  if (!visibleToolPanel()) {
    document.querySelector('.shell__panel-toggle button').click()
    await until(visibleToolPanel, 'The tools panel did not open')
  }
  document.querySelector('.sidebar__plugin-entry button').click()
  await until(() => document.querySelector('.desk-page'), 'Plugins desk page did not open')
  await until(
    () => !visibleToolPanel(),
    'The tools panel stayed open over the desk page'
  )
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

  const todo = {
    id: 'ui-todo', kind: 'tool', toolCallId: 'ui-todo', toolName: 'desktop_todo', status: 'ok', timestamp: 2, order: 2,
    args: { items: [
      { text: 'Inspect the report', status: 'completed' },
      { text: 'Run the tests', status: 'in_progress' }
    ] }
  }
  const todoProgress = () => railSection('Progress')
  const unconfirmed = () => todoProgress()?.querySelector('.task-panel__empty')?.textContent === 'Some steps are still unconfirmed'
  store.setState({ items: [todo], isStreaming: true })
  await until(() => todoProgress()?.querySelector('.task-panel__check[data-active]'), 'The running todo lost its active step')
  check(!unconfirmed(), 'An active run showed the unconfirmed progress notice')

  const finalReport = {
    id: 'ui-todo-final', kind: 'assistant', streaming: false, stopReason: 'stop', timestamp: 3, order: 3,
    blocks: [{ type: 'text', text: 'The report is ready.' }]
  }
  store.setState({ items: [todo, finalReport], isStreaming: false })
  await until(unconfirmed, 'A settled run did not explain its remaining todo steps')
  check(todoProgress()?.querySelector('.task-panel__count')?.textContent === '1/2', 'Plain final prose changed the todo count')
  check(!todoProgress()?.querySelector('.task-panel__check[data-active]'), 'A settled todo still looked active')

  store.setState({ items: [todo, {
    ...finalReport,
    blocks: [{ type: 'text', text: '- [x] Inspect the report\n- [x] Run the tests' }]
  }] })
  await until(() => todoProgress()?.querySelector('.task-panel__count')?.textContent === '2/2', 'The final checklist did not fill in progress')
  check(!unconfirmed(), 'The complete todo still showed the unconfirmed progress notice')
  passed.push('plan progress stays in the task rail, explains missing updates and recovers confirmed steps')

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
  const fileChanges = await until(() => document.querySelector('.file-changes'), 'The file change card did not render')
  const head = fileChanges.querySelector('.file-changes__head')
  check(head?.querySelector('.file-changes__count')?.textContent === 'Edited 2 files', 'The card header lost its file count')
  check(head.querySelector('.file-changes__review') && head.querySelector('.file-changes__undo'), 'File actions moved outside the card header')
  const row = await until(() => fileChanges.querySelector('.file-changes__list .file-change'), 'The card did not show its files directly')
  const hover = (node) => node.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  // The card re-renders as the turn settles, which replaces the row node; a
  // mouseover dispatched on the old node never reaches the new one and the
  // deliberate hover delay never starts. Re-hover whichever row is on screen,
  // at most every ~500 ms so the delay can elapse.
  const fileRowNames = () => [...document.querySelectorAll('.file-changes__list .file-change')]
    .map((row) => ({ row, name: row.querySelector('.file-change__name')?.textContent?.trim() ?? '' }))
  // Pick the row by name, not by index: a row can be replaced between the query
  // and the hover, and an index says nothing about which file it now is.
  const hoverFileMatching = async (matches, read, message) => {
    const deadline = performance.now() + 15000
    let polls = 0
    while (performance.now() < deadline) {
      const value = read()
      if (value) return value
      const target = fileRowNames().find((entry) => matches(entry.name))?.row
      if (target && polls++ % 20 === 0) hover(target)
      await pause(25)
    }
    throw new Error(message)
  }
  hover(row)
  await pause(100)
  check(!document.querySelector('.file-change__preview'), 'File preview opened during a brief hover')
  row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: head }))
  await pause(450)
  check(!document.querySelector('.file-change__preview'), 'Leaving the file row did not cancel its preview')

  hover(row)
  await pause(100)
  fileChanges.dispatchEvent(new Event('scroll'))
  await pause(450)
  check(!document.querySelector('.file-change__preview'), 'Scrolling did not cancel the pending file preview')

  await hoverFileMatching(() => true, () => document.querySelector('.file-change__preview-line'), 'File preview did not open')
  const firstFileName = document.querySelector('.file-change__preview-name')?.textContent?.trim() ?? ''
  check(document.querySelectorAll('.file-change__preview-line').length === 200, 'Large preview rendered more than one page')
  const next = document.querySelector('.file-change__preview-pages button[aria-label="Next page"]')
  check(next && !next.disabled, 'Preview has no next-page control')
  next.click()
  await until(() => document.querySelector('.file-change__preview-text')?.textContent === 'line 200', 'Preview did not advance')
  check(document.querySelectorAll('.file-change__preview-line').length === 200, 'Second preview page exceeded the limit')
  // Switching files is what the hover does; that paging was reset is proved by
  // the next step, which returns to the first file (left on page 2) and requires
  // its first line. Asserting the second file's text here only repeated the
  // hover timing and flaked at it.
  await hoverFileMatching((name) => Boolean(name) && name !== firstFileName,
    () => {
      const shown = document.querySelector('.file-change__preview-name')?.textContent?.trim() ?? ''
      return shown && shown !== firstFileName ? true : null
    },
    'Hovering another file did not switch the preview')
  await hoverFileMatching((name) => name === firstFileName,
    () => document.querySelector('.file-change__preview-text')?.textContent === 'line 0' ? true : null,
    'Returning to the file did not reset paging')
  passed.push('file previews wait for a deliberate hover and page by 200 lines')

  // Finished tool groups stay beside their commentary. The group and the
  // individual tool remember their expansions across a view switch.
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
    settings: { ...state.settings, autoFoldProcess: true, toolCallSummary: true, ...extra },
    threads: { ...state.threads, [draftId]: { ...baseThread, items, run, isStreaming: !run.settled } }
  }))
  showStream('draft:stream-a')
  await until(() => document.querySelector('.run-outcome[data-foldable="true"]'), 'The stream has no process fold')
  const streamBody = () => document.querySelector('.assistant__body')
  const readGroup = await until(() => streamBody().querySelector('.process__head'), 'The finished tool summary is missing')
  check(readGroup.getAttribute('aria-expanded') === 'false', 'The finished tool group opened by default')
  check(streamBody().textContent.includes('STREAM_PROGRESS'), 'The tool summary lost its commentary')
  check(streamBody().textContent.includes('STREAM_FINAL'), 'The tool summary hid the final reply')
  check(!streamBody().querySelector('.tool-link'), 'The finished tool row leaked below its summary')
  readGroup.click()
  await until(() => streamBody().querySelector('.tool-link'), 'Expanding the group did not reveal the tool')
  document.querySelector('.tool-link__toggle').click()
  await until(() => streamBody().textContent.includes('STREAM_TOOL_RESULT'), 'The tool result did not expand')
  showStream('draft:stream-b')
  await until(() => streamBody().querySelector('.process__head[aria-expanded="false"]'), 'A different conversation inherited the expansion')
  showStream('draft:stream-a')
  await until(() => streamBody().textContent.includes('STREAM_TOOL_RESULT'), 'The process/tool fold was forgotten on return')
  document.querySelector('.run-outcome').click()
  await until(() => !streamBody().textContent.includes('STREAM_PROGRESS'), 'The process did not fold again')

  // The copy/edit row must sit flush under the bubble and above the run
  // summary: a visual gap used to drop the hover state before the pointer
  // reached the buttons, so neither action could be clicked.
  const userActions = await until(
    () => document.querySelector('.user-msg__actions'),
    'The message actions did not render'
  )
  const userBubble = document.querySelector('.user-msg__bubble')
  const actionBox = userActions.getBoundingClientRect()
  check(
    Math.abs(actionBox.top - userBubble.getBoundingClientRect().bottom) <= 1,
    'A gap separates the message actions from the bubble'
  )
  userActions.style.opacity = '1'
  userActions.style.pointerEvents = 'auto'
  const copyButton = userActions.querySelector('button')
  check(!copyButton.hasAttribute('title'), 'The message action still draws a native title bubble')
  check(
    copyButton.hasAttribute('aria-label'),
    'The message action has no accessible name for the hover tip'
  )
  check(
    !copyButton.hasAttribute('data-pi-tip-ignore'),
    'The message action is still opted out of the hover tip'
  )
  const copyBox = copyButton.getBoundingClientRect()
  const copyHit = document.elementFromPoint(copyBox.left + copyBox.width / 2, copyBox.top + copyBox.height / 2)
  check(
    copyHit === copyButton || copyButton.contains(copyHit),
    'The message action is covered by the run below it'
  )
  const hoverBridge = document.elementFromPoint(actionBox.right - 4, actionBox.top + 1)
  check(
    hoverBridge === userActions || userActions.contains(hoverBridge),
    'The message action row has no hover bridge'
  )
  userActions.style.opacity = ''
  userActions.style.pointerEvents = ''
  passed.push('message copy and edit actions stay reachable under the bubble')

  // A reply has its own copy control, and it copies the answer's Markdown —
  // not the painted text and not the progress commentary above the tool calls.
  const replyCopy = await until(
    () => document.querySelector('.assistant__copy'),
    'The reply has no copy control'
  )
  check(replyCopy.getAttribute('aria-label') === 'Copy this answer', 'The reply copy control has no name')
  check(
    !replyCopy.hasAttribute('title'),
    'The reply copy control draws a native title bubble instead of the hover tip'
  )
  check(
    Math.round(replyCopy.getBoundingClientRect().width) === 20,
    'The reply copy control does not keep its 20px line'
  )
  const clipboardBefore = navigator.clipboard
  let copiedReply = ''
  const clipboardStub = {
    writeText: async (text) => { copiedReply = text },
    readText: async () => copiedReply
  }
  try {
    Object.defineProperty(navigator, 'clipboard', { value: clipboardStub, configurable: true })
  } catch {
    navigator.clipboard.writeText = clipboardStub.writeText
  }
  replyCopy.click()
  await until(() => copiedReply, 'Clicking the reply copy control wrote nothing')
  check(
    copiedReply === 'STREAM_FINAL the renderer is ready',
    `The reply copy carried the wrong text: ${JSON.stringify(copiedReply)}`
  )
  await until(
    () => document.querySelector('.assistant__copy')?.getAttribute('aria-label') === 'Copied',
    'The reply copy control did not acknowledge the copy'
  )
  try {
    Object.defineProperty(navigator, 'clipboard', { value: clipboardBefore, configurable: true })
  } catch {
    /* the browser kept its own clipboard; nothing to put back */
  }
  passed.push('a reply can be copied as Markdown from its own row')

  // The File menu carries the Markdown export beside the HTML one, so the
  // capability is not launcher-only.
  const fileMenu = [...document.querySelectorAll('.app-menu__trigger')]
    .find((node) => node.textContent?.trim() === 'File')
  fileMenu?.click()
  const fileItems = await until(() => {
    const menu = document.querySelector('[role="menu"][aria-label="File"]')
    return menu ? [...menu.querySelectorAll('[role="menuitem"]')] : null
  }, 'The File menu did not open')
  const markdownExport = fileItems.find((node) => node.textContent?.includes('Export as Markdown'))
  check(Boolean(markdownExport), 'The File menu has no Markdown export')
  check(markdownExport && !markdownExport.disabled, 'The Markdown export is disabled with a conversation on screen')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until(
    () => !document.querySelector('[role="menu"][aria-label="File"]'),
    'The File menu did not close'
  )
  passed.push('the File menu offers the Markdown export beside the HTML one')

  // Settings has twelve pages; the search field finds a page by a setting's
  // name and says which setting matched. Escape clears the field before it
  // closes the dialog, so a typed filter is not the only way out.
  const settingsButton = [...document.querySelectorAll('.sidebar__foot-btn')]
    .find((node) => node.textContent?.trim() === 'Settings')
  settingsButton?.click()
  const settingsNav = await until(() => document.querySelector('.settings-nav'), 'The settings dialog did not open')
  const settingsSearch = settingsNav.querySelector('.settings-nav__search input')
  check(Boolean(settingsSearch), 'The settings navigation has no search field')
  const setSettingsField = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setSettingsField.call(settingsSearch, 'auto-generate title')
  settingsSearch.dispatchEvent(new Event('input', { bubbles: true }))
  await until(
    () => document.querySelectorAll('.settings-nav > button').length === 1,
    'Searching a setting did not narrow the navigation'
  )
  const settingHit = document.querySelector('.settings-nav > button')
  check(settingHit.textContent.includes('Agent and conversation'), 'The setting search did not find its page')
  check(settingHit.textContent.includes('Auto-generate title'), 'The search result does not name the setting it matched')
  check(
    document.querySelector('.settings-nav .sr-only')?.textContent?.includes('1'),
    'The settings search did not announce its result count'
  )
  // ArrowDown walks from the field into the results; ArrowUp returns.
  settingsSearch.focus()
  settingsSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await until(
    () => document.activeElement === settingHit,
    'ArrowDown did not enter the settings results'
  )
  settingHit.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await until(
    () => document.activeElement === settingsSearch,
    'ArrowUp did not return to the search field'
  )
  settingHit.click()
  await until(
    () => document.querySelector('.settings-content')?.textContent?.includes('Auto-generate title'),
    'Clicking a search result did not open the page'
  )
  check(settingsSearch.value === '', 'Choosing a result left the query behind')
  const markedSetting = await until(
    () => [...document.querySelectorAll('.settings-hit')].find((node) => node.textContent?.trim() === 'Auto-generate title'),
    'Opening a search result did not mark the setting it named'
  )
  await until(() => {
    const box = markedSetting.getBoundingClientRect()
    const view = document.querySelector('.settings-content')?.getBoundingClientRect()
    return Boolean(view && box.top >= view.top - 1 && box.bottom <= view.bottom + 1)
  }, 'The matched setting was not scrolled into view', 4000)
  // Ctrl+F reaches the settings search while the dialog owns the keyboard.
  document.querySelector('.settings-content').dispatchEvent(
    new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })
  )
  await until(() => document.activeElement === settingsSearch, 'Ctrl+F did not focus the settings search')
  await until(
    () => !document.querySelector('.settings-hit'),
    'The matched setting kept its highlight after the flash',
    4000
  )
  settingsSearch.focus()
  setSettingsField.call(settingsSearch, 'font')
  settingsSearch.dispatchEvent(new Event('input', { bubbles: true }))
  await until(
    () => document.querySelectorAll('.settings-nav > button').length === 1,
    'The second search did not narrow the navigation'
  )
  // Enter takes the top result.
  settingsSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until(
    () => document.querySelector('.settings-content')?.textContent?.includes('Font'),
    'Enter did not open the top search result'
  )
  check(settingsSearch.value === '', 'Enter left the query behind')
  // At the minimum window height the page list scrolls. Its search field must
  // keep the control height and stay at the top of the list; flex-shrink used
  // to squeeze the field to 21px of its 28.
  const settingsModal = document.querySelector('.settings-modal')
  const settingsNavEl = document.querySelector('.settings-nav')
  const searchFieldBox = () => document.querySelector('.settings-nav__search').getBoundingClientRect()
  settingsModal.style.height = '420px'
  const searchTopBefore = searchFieldBox().top
  check(
    Math.round(searchFieldBox().height) >= 27,
    `The settings search field shrank to ${Math.round(searchFieldBox().height)}px at the minimum height`
  )
  settingsNavEl.scrollTop = settingsNavEl.scrollHeight
  await pause(120)
  check(
    Math.abs(searchFieldBox().top - searchTopBefore) <= 1,
    'The settings search scrolled away with the page list'
  )
  settingsModal.style.height = ''
  await pause(80)
  // …and Escape still clears a filter before closing.
  settingsSearch.focus()
  setSettingsField.call(settingsSearch, 'font')
  settingsSearch.dispatchEvent(new Event('input', { bubbles: true }))
  await until(
    () => document.querySelectorAll('.settings-nav > button').length === 1,
    'The third search did not narrow the navigation'
  )
  settingsSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until(
    () => settingsSearch.value === '' && Boolean(document.querySelector('.settings-nav')),
    'Escape did not clear the field before closing the dialog'
  )
  settingsSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until(
    () => !document.querySelector('.settings-nav'),
    'The second Escape did not close the settings dialog'
  )
  passed.push('settings search finds a page by a setting name, and Escape clears it first')

  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
  const streamSearch = await until(() => document.querySelector('.thread-search input'), 'Conversation search did not open')
  const setInput = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setInput.call(streamSearch, 'STREAM_PROGRESS')
  streamSearch.dispatchEvent(new Event('input', { bubbles: true }))
  await until(() => streamBody().textContent.includes('STREAM_PROGRESS'), 'A search hit stayed hidden in the process')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until(() => !streamBody().textContent.includes('STREAM_PROGRESS'), 'Closing search lost the manual fold')

  // A folded history opens to the beginning in one action. The chain walks a
  // page per frame, so a long conversation fills in instead of freezing the
  // window while hundreds of turns mount together.
  const historyBefore = {
    draftId: store.getState().draftId,
    activeSessionFile: store.getState().activeSessionFile,
    items: store.getState().items,
    run: store.getState().run,
    isStreaming: store.getState().isStreaming
  }
  const longItems = []
  for (let index = 0; index < 60; index += 1) {
    longItems.push({
      id: `long-user-${index}`,
      kind: 'user',
      text: `Long question ${index}`,
      images: [],
      timestamp: index * 2 + 1,
      order: index * 2 + 1
    })
    longItems.push({
      id: `long-reply-${index}`,
      kind: 'assistant',
      streaming: false,
      timestamp: index * 2 + 2,
      order: index * 2 + 2,
      blocks: [{ type: 'text', text: `Long answer ${index}` }]
    })
  }
  store.setState({
    draftId: 'draft:long-history',
    activeSessionFile: undefined,
    items: longItems,
    isStreaming: false,
    run: { phase: 'idle', turns: 60, settled: true, outcome: 'completed' },
    error: undefined,
    retry: undefined
  })
  const loadAll = await until(
    () => [...document.querySelectorAll('.thread__history button')].find((node) => node.textContent?.trim() === 'Load all'),
    'The folded history has no load-all control'
  )
  loadAll.click()
  await until(
    () => document.querySelector('.thread')?.textContent?.includes('Long question 0'),
    'Load all did not reach the beginning of the history',
    20000
  )
  check(!document.querySelector('.thread__history'), 'The history row stayed after the whole history loaded')
  const longTurns = document.querySelectorAll('.turn').length
  check(longTurns === 60, `Load all rendered ${longTurns} of 60 turns`)
  store.setState(historyBefore)
  passed.push('a folded history opens to the beginning in one action')

  const waitDraft = 'draft:stream-model-wait'
  const waitItems = [{ ...streamItems[0], id: 'model-wait-user' }]
  const waitSummary = () => document.querySelector('[data-turn="model-wait-user"] .run-outcome[data-running="true"]')
  showStream(waitDraft, waitItems, { phase: 'queued', turns: 0, settled: false })
  await until(() => waitSummary()?.textContent.includes('Preparing request…'), 'The queued request has no preparation status')

  const modelStartedAt = performance.now()
  const waitingRun = {
    phase: 'working', runId: 'model-wait-run', turns: 1, settled: false,
    startedAt: Date.now() - 13_000, startedMonotonicAt: modelStartedAt - 13_000,
    modelTurnStartedAt: modelStartedAt
  }
  showStream(waitDraft, waitItems, waitingRun)
  await until(() => waitSummary()?.textContent.startsWith('Waiting for model response…'), 'A fresh model turn inherited the total run wait')

  const slowRun = { ...waitingRun, modelTurnStartedAt: performance.now() - 8_000 }
  showStream(waitDraft, waitItems, slowRun)
  await until(() => waitSummary()?.textContent.includes('Still waiting for model response…'), 'The waiting status did not update on its own during model silence')
  check(waitSummary()?.querySelector('.run-outcome__meta') && !document.querySelector('.run-status'), 'Model waiting did not share the existing elapsed row')

  showStream(waitDraft, waitItems, { ...slowRun, messageGenerationStartedAt: performance.now() })
  await until(() => waitSummary()?.textContent.startsWith('Working'), 'The waiting status stayed after the model started streaming a block')

  showStream(waitDraft, waitItems, { ...slowRun, phase: 'retrying' })
  store.setState({ retry: { attempt: 1, maxAttempts: 3, delayMs: 60_000, retryAt: Date.now() + 60_000 } })
  await until(() => document.querySelector('.run-status[data-phase="retrying"]'), 'The retry status did not appear')
  check(waitSummary() && !waitSummary().textContent.toLowerCase().includes('waiting for model response'), 'The model wait status conflicted with a retry')
  passed.push('the live summary shows request preparation and model waiting until the first output or retry')

  // The wait label answers an empty screen. Once the turn has text (or a tool
  // row), a wait for the *next* block — after a tool, say — must not print the
  // label back on top of an answer the reader can already read.
  store.setState({ retry: undefined })
  const waitWithOutput = () => document.querySelector('.run-outcome[data-running="true"]')
  showStream(waitDraft, streamItems.slice(0, 2), { ...waitingRun, turns: 2, roundTurns: 2 })
  await until(
    () => waitWithOutput() && !waitWithOutput().textContent.toLowerCase().includes('waiting for model response'),
    'The model wait label outlived the turn first output'
  )
  check(
    waitWithOutput().textContent.includes('Working'),
    'A turn with output lost its running status instead of reading as work in progress'
  )
  passed.push('the wait label only describes a turn that has not produced anything yet')

  showStream('draft:stream-live', streamItems.slice(0, 3), {
    phase: 'working', turns: 1, settled: false, startedAt: Date.now() - 2000
  })
  await until(() => document.querySelector('.run-outcome[data-running="true"]'), 'Live elapsed summary did not render')
  check(document.querySelector('.run-outcome').textContent.includes('Working'), 'Live elapsed summary claimed the run was finished')
  check(streamBody().textContent.includes('STREAM_PROGRESS'), 'The live partial progress disappeared')
  check(!document.querySelector('.run-status'), 'A routine working status repeated below the live output')
  const processBox = document.querySelector('.process').getBoundingClientRect()
  const progressBox = document.querySelector('.assistant__text').getBoundingClientRect()
  check(Math.abs(processBox.left - progressBox.left) <= 1, 'The process does not share the reply column')
  store.setState((state) => ({ run: { ...state.run, phase: 'generating' } }))
  await pause(50)
  check(!document.querySelector('.run-status'), 'A writing status repeated below the live output')
  showStream('draft:stream-stopped', streamItems.slice(0, 3), {
    phase: 'idle', turns: 1, settled: true, outcome: 'aborted'
  })
  await until(() => document.querySelector('.run-outcome[data-outcome="aborted"]'), 'Stopped summary did not render')
  check(streamBody().textContent.includes('STREAM_PROGRESS'), 'Stopping lost the partial progress')

  // The command's own row carries its running state; there is no second
  // activity line beneath the output, with either tool-summary setting.
  showStream('draft:stream-command', [
    { id: 'cmd-user', kind: 'user', text: 'Run the check', images: [], timestamp: 1, order: 1 },
    { id: 'cmd-tool', kind: 'tool', toolCallId: 'cmd-tool', toolName: 'bash',
      args: { command: 'cd /e/Program/Coffee && grep -ril pressure' }, status: 'running', timestamp: 2, order: 2 }
  ], { phase: 'tool_running', turns: 1, settled: false, startedAt: Date.now() - 3000 }, { toolCallSummary: false })
  const commandRow = await until(
    () => document.querySelector('.tool--link[data-status="running"] .tool-link'),
    'A live command row did not render'
  )
  check(!commandRow.querySelector('.spinner'), 'A running command row still renders a spinner instead of pulsing text')
  check(
    getComputedStyle(commandRow.querySelector('.tool-link__verb')).animationName === 'stream-running-pulse',
    'The command row lost its running pulse state'
  )
  check(!document.querySelector('.run-status'), 'A tool status repeated below the live output')

  showStream('draft:stream-replay', streamItems, { phase: 'idle', turns: 0, settled: true })
  await until(() => document.querySelector('.run-outcome[data-foldable="true"]'), 'Replayed turn lost its process fold without saved timing')
  check(Boolean(document.querySelector('.run-outcome__meta')), 'Replayed turn lost its worked-for duration')
  check(streamBody().textContent.includes('STREAM_PROGRESS') && streamBody().textContent.includes('STREAM_FINAL'), 'Replayed turn lost its commentary or reply')
  check(streamBody().querySelector('.process__head[aria-expanded="false"]'), 'Replayed tool group did not start folded')

  showStream('draft:stream-thinking-only', [
    streamItems[0],
    { ...streamItems[3], blocks: [
      { type: 'thinking', text: 'Thinking even without tools' },
      ...streamItems[3].blocks
    ] }
  ])
  await until(() => streamBody().querySelector('.thinking__head[aria-expanded="false"]'),
    'A finished response without tools hid the thinking disclosure')

  // The live edit and command share one row below the next commentary. Its
  // expansion and the edit diff survive the transition to a finished turn.
  const editArgs = { path: 'note.txt', edits: [{ oldText: 'before the change', newText: 'STREAM_EDIT_DIFF' }] }
  const commandArgs = { command: 'npm run check' }
  const commandTool = { id: 'group-command', kind: 'tool', toolCallId: 'group-cmd', toolName: 'bash',
    args: commandArgs, status: 'running', timestamp: 6, order: 6 }
  const groupItems = [
    ...streamItems.slice(0, 3),
    { ...streamItems[1], id: 'group-progress', timestamp: 4, order: 4, blocks: [
      { type: 'text', text: 'STREAM_EDIT_PROGRESS updating the workspace' },
      { type: 'toolCall', id: 'group-edit', name: 'edit', argsText: '{}', args: editArgs },
      { type: 'toolCall', id: 'group-cmd', name: 'bash', argsText: '{}', args: commandArgs }
    ] },
    { id: 'group-edit-row', kind: 'tool', toolCallId: 'group-edit', toolName: 'edit',
      args: editArgs, status: 'ok', timestamp: 5, order: 5 },
    commandTool
  ]
  showStream('draft:stream-summary', groupItems, {
    phase: 'working', turns: 1, settled: false, startedAt: Date.now() - 2000
  })
  const liveSummary = await until(
    () => document.querySelector('.process[data-live] .process__head'),
    'A live tool summary did not render'
  )
  check(!document.querySelector('.run-status'), 'Gathered tool calls left a duplicate working status')
  check(streamBody().querySelectorAll('.process__head').length === 2, 'Commentary did not split the tool groups')
  check(liveSummary.closest('.process').previousElementSibling.textContent.includes('STREAM_EDIT_PROGRESS'), 'The tool group moved away from its commentary')
  check(!streamBody().querySelector('.tool-link'), 'A live tool row leaked below its summary')
  liveSummary.click()
  const editToggle = await until(() => streamBody().querySelector('.tool--link[data-tone="edit"] .tool-link__toggle'), 'Opening the group did not reveal the edit')
  editToggle.click()
  const editDiff = () => streamBody().querySelector('.tool--link[data-tone="edit"] .tool__body')
  await until(() => editDiff()?.textContent.includes('STREAM_EDIT_DIFF'), 'The edit diff did not expand')
  showStream('draft:stream-summary', [
    ...groupItems.slice(0, -1),
    { ...commandTool, status: 'ok', result: 'STREAM_COMMAND_OUTPUT' },
    { ...streamItems[3], timestamp: 7, order: 7 }
  ])
  const mixedSummary = await until(
    () => [...streamBody().querySelectorAll('.process__head')].find((head) => head.textContent.includes('Edited file · Ran command')),
    'The finished edit and command did not share one action summary'
  )
  check(mixedSummary.getAttribute('aria-expanded') === 'true' && editDiff()?.textContent.includes('STREAM_EDIT_DIFF'), 'The edit diff closed when the run finished')
  streamBody().querySelector('.tool--link[data-tone="command"] .tool-link__toggle').click()
  await until(() => streamBody().textContent.includes('STREAM_COMMAND_OUTPUT'), 'The command output did not expand')
  mixedSummary.click()
  await until(() => !streamBody().querySelector('.tool-link'), 'Refolding left a command or edit visible')

  // Reopening a failed run keeps its reason in the conversation and its tool
  // output in the fold, with the first expansion showing the group summaries.
  const stopReason = '429: The model request rate limit was reached'
  const toolError = 'EISDIR: expected a file path'
  showStream('draft:stream-failed', [
    ...streamItems.slice(0, 2),
    { ...streamItems[2], status: 'error', result: toolError },
    { ...streamItems[3], stopReason: 'error', error: stopReason, blocks: [] }
  ], { phase: 'idle', turns: 0, settled: true }, { toolCallSummary: true })
  const failedRun = await until(() => document.querySelector('.run-outcome[data-outcome="failed"]'), 'The failed run has no summary')
  check(failedRun.getAttribute('aria-expanded') === 'false', 'The failed run did not start folded')
  const failureNotice = () => streamBody().querySelector('.notice[data-level="error"]')
  check(failedRun.nextElementSibling === failureNotice() && failureNotice()?.textContent.includes('Model rate limit reached'), 'The run summary lost its rate limit notice')
  check(failureNotice()?.title === stopReason, 'The original provider error is unavailable')
  check(!streamBody().querySelector('.tool-link'), 'A failed run opened all of its tool calls')
  failedRun.click()
  const failedGroup = await until(() => streamBody().querySelector('.process__head'), 'The failed tool group did not appear')
  check(failedGroup.textContent.includes('1 failed call'), 'The group lost its failure count')
  check(!streamBody().querySelector('.tool-link'), 'Opening a failed run expanded every tool group')
  failedGroup.click()
  const failedTarget = await until(() => streamBody().querySelector('.tool-link__target'), 'The failed tool row did not appear')
  check(failedTarget.textContent.includes(toolError), 'The failed read has no inline error reason')
  failedTarget.click()
  await until(() => streamBody().querySelector('.tool__error')?.textContent.includes(toolError), 'The failed read did not open its output')
  failedRun.click()
  await until(() => !streamBody().querySelector('.process__head'), 'The failed run cannot be folded again')
  check(failureNotice()?.title === stopReason, 'Refolding hid the failure reason')

  showStream('draft:stream-error-only', [
    { ...streamItems[0], id: 'error-only-user' },
    { ...streamItems[3], stopReason: 'error', error: stopReason, blocks: [] },
    { id: 'duplicate-error', kind: 'notice', level: 'error', text: `Provider failed: ${stopReason}`, timestamp: 5, order: 5 }
  ], { phase: 'idle', turns: 0, settled: true })
  const errorOnlyRun = await until(
    () => document.querySelector('[data-turn="error-only-user"] .run-outcome[data-outcome="failed"]'),
    'The error-only run did not render'
  )
  check(errorOnlyRun.disabled && !errorOnlyRun.hasAttribute('aria-expanded'), 'The failed summary offers an empty execution fold')
  check(failureNotice()?.title === stopReason, 'The error-only run lost its provider failure reason')

  showStream('draft:stream-empty-error', [
    { ...streamItems[0], id: 'empty-error-user' },
    { ...streamItems[3], stopReason: 'error', error: ' ', blocks: [] }
  ], { phase: 'idle', turns: 0, settled: true })
  await until(() => document.querySelector('[data-turn="empty-error-user"] .notice[data-level="error"]'), 'The blank provider error lost its failure notice')
  check(failureNotice()?.textContent.includes('This run failed.'), 'A blank provider error produced a blank failure notice')

  showStream('draft:stream-goal-rounds', [
    { ...streamItems[0], id: 'goal-u1', order: 0, timestamp: 1_000_000 },
    {
      id: 'goal-t1',
      kind: 'tool',
      toolCallId: 'goal-call-1',
      toolName: 'edit',
      args: { path: 'src/scorer.py', oldText: 'a', newText: 'b' },
      status: 'ok',
      order: 1,
      timestamp: 1_002_000,
      startedAt: 1_002_000,
      finishedAt: 1_004_000,
    },
    {
      ...streamItems[3],
      id: 'goal-a1',
      blocks: [{ type: 'text', text: 'Round 1 improvements applied.' }],
      streaming: false,
      stopReason: 'stop',
      error: undefined,
      model: 'claude-sonnet-4',
      usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      order: 2,
      timestamp: 1_008_000,
    },
    { id: 'goal-rb1', kind: 'roundBreak', entryId: 'goal-entry-rb1', order: 3, timestamp: 1_010_000 },
    {
      ...streamItems[3],
      id: 'goal-a2',
      blocks: [{ type: 'text', text: 'Round 2 running...' }],
      streaming: true,
      stopReason: undefined,
      error: undefined,
      model: undefined,
      usage: undefined,
      order: 4,
      timestamp: 1_012_000,
    },
  ], {
    phase: 'generating',
    turns: 1,
    roundTurns: 0,
    settled: false,
    startedAt: Date.now() - 3_000,
  })
  await until(() => document.querySelector('[data-turn="goal-u1"] .run-outcome'), 'Completed Goal Mode round did not render RunSummary')
  const round1 = document.querySelector('[data-turn="goal-u1"]')
  const round2 = document.querySelector('[data-turn="goal-rb1"]')
  check(round1 && !round1.querySelector('.run-outcome[data-running="true"]'), 'Completed Goal Mode round stayed marked as running')
  check(round1?.querySelector('.file-changes'), 'Completed Goal Mode round did not render edited files summary')
  check(round1?.querySelector('.assistant__footer .assistant__usage'), 'Completed Goal Mode round did not render token usage footer')
  check(round2?.querySelector('.run-outcome[data-running="true"]'), 'Active Goal Mode round did not render its live RunSummary')
  check(!round2?.querySelector('.file-changes'), 'Active Goal Mode round prematurely rendered FileChangeSummary')
  check(!round2?.querySelector('.assistant__footer'), 'Active Goal Mode round prematurely rendered assistant footer')

  store.setState(beforeStream)
  passed.push('tool activity stays inline, groups edits with commands, and preserves expansion and search')

  // The task rail beside the conversation, with a command and subagents in separate sections.
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
      args: { tasks: [
        { task: 'Run the full verification gate and report the output', label: 'Run the gate' },
        { task: 'Inspect startup' },
        { task: 'Review screenshots' }
      ] },
      status: 'running',
      details: { mode: 'parallel', results: [
        { status: 'running' },
        { status: 'completed' },
        { status: 'failed' }
      ] },
      timestamp: 9,
      order: 9
    },
    {
      id: 'rail-bash',
      kind: 'tool',
      toolCallId: 'rail-bash',
      toolName: 'bash',
      args: { command: 'npm run build' },
      status: 'running',
      startedAt: Date.now() - 3000,
      timestamp: 10,
      order: 10
    },
    {
      id: 'rail-grep',
      kind: 'tool',
      toolCallId: 'rail-grep',
      toolName: 'grep',
      args: { pattern: 'TODO' },
      status: 'running',
      startedAt: Date.now() - 3000,
      timestamp: 11,
      order: 11
    }
  ]
  const setRailItems = (items, draftId = 'draft:task-rail') => store.setState((state) => ({
    activeSessionFile: undefined, draftId, items, uiStatuses: [],
    activeToolsRevision: state.activeToolsRevision + 1,
    threads: { ...state.threads, [draftId]: { ...baseThread, items } }
  }))
  setRailItems(railItems)
  // A docked tool panel narrows the main stage, and the app folds the task rail
  // to protect the reading column. Open it from its toggle before asserting.
  if (!railSection('Environment info')) {
    // The rail toggle renders only after the injected items paint; wait for it
    // instead of querying once, which found nothing while React was still folding.
    const railToggle = await until(
      () => [...document.querySelectorAll('button[aria-label]')].find(
        (node) => /task status/i.test(node.getAttribute('aria-label') ?? '') &&
          node.getBoundingClientRect().width > 0
      ),
      'The task rail toggle never appeared'
    )
    railToggle.click()
  }
  await until(() => railSection('Environment info'), 'The task rail did not open from its toggle')
  for (const title of ['Environment info', 'Background tasks', 'Subagents', 'Progress', 'Deliverables']) {
    await until(() => railSection(title), `The task rail is missing the ${title} section`)
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
  const environmentSection = railSection('Environment info')
  const environmentToggle = environmentSection?.querySelector('.task-panel__section-toggle')
  environmentToggle?.click()
  await until(
    () => railSection('Environment info')?.querySelector('.task-panel__section-toggle')?.getAttribute('aria-expanded') === 'false',
    'The environment section did not fold shut',
    5000
  )
  // The body collapses with a 180 ms grid-template-rows transition. Assert the
  // end state and let the frame land, instead of assuming 250 ms is always
  // enough on a loaded machine (that assumption flaked once).
  await until(() => {
    const section = railSection('Environment info')
    const head = section?.querySelector('.task-panel__section-head')?.getBoundingClientRect().height
    return Boolean(section && head !== undefined && section.getBoundingClientRect().height <= head + 1)
  }, 'The non-repo subtitle still occupies space after folding the environment section', 5000)
  railSection('Environment info')?.querySelector('.task-panel__section-toggle')?.click()
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
  const commandRows = [...railSection('Background tasks').querySelectorAll('.task-panel__task')]
  check(commandRows.length === 1 && commandRows[0].textContent === 'npm run build',
    'The background section did not show just the running command name')
  const taskRows = [...railSection('Subagents').querySelectorAll('.task-panel__task')]
  check(
    taskRows.map((row) => row.querySelector('.task-panel__task-label')?.textContent).join('|') ===
      'Run the gate|Inspect startup|Review screenshots',
    'The subagent list has tool commands or is missing task titles'
  )
  check(
    taskRows.map((row) => row.dataset.status).join('|') === 'running|completed|failed',
    'The subagent list lost the task outcomes'
  )
  check(
    commandRows.every((row) =>
      row.querySelector('.task-panel__dot').getBoundingClientRect().left >=
        row.querySelector('.task-panel__task-label').getBoundingClientRect().right
    ),
    'A background task row did not put its status at the end of the row'
  )
  // A subagent row wears the same 20px tile a deliverable wears, at the start
  // of the row — its state is the tile's colour, not a dot at the far edge.
  check(
    taskRows.every((row) => {
      const tile = row.querySelector('.task-panel__tile--subagent')
      const label = row.querySelector('.task-panel__task-label')
      if (!tile || !label) return false
      const tileBox = tile.getBoundingClientRect()
      return Math.round(tileBox.width) === 20 && tileBox.right <= label.getBoundingClientRect().left
    }),
    'A subagent row did not lead with its 20px state tile'
  )
  const railAvatars = taskRows.map((row) => row.querySelector('img.subagent-avatar'))
  await until(() => railAvatars.every((avatar) => avatar?.complete && avatar.naturalWidth > 0), 'The task rail avatars did not load')
  check(new Set(railAvatars.map((avatar) => avatar.src)).size === taskRows.length, 'The task rail repeated an avatar within a batch')
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
  const statusTitle = rowNamed('status.md')?.getAttribute('title')
  check(statusTitle === 'docs/status.md',
    `The row lost the path its tooltip carries (saw ${JSON.stringify(statusTitle)}, rows ${JSON.stringify(fileRows.map((row) => row.querySelector('.task-panel__file-name')?.textContent))})`)
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
  // State attributes land on a commit, not on a fixed delay: poll them so a
  // busy frame cannot fail a fold that did happen.
  const progressState = () => [...document.querySelectorAll('.task-panel__section')]
    .find((node) => node.querySelector('.task-panel__section-title')?.textContent === 'Progress')
    ?.querySelector('.task-panel__section-body')?.getAttribute('data-open') ?? null
  const progressToggle = () => [...document.querySelectorAll('.task-panel__section')]
    .find((node) => node.querySelector('.task-panel__section-title')?.textContent === 'Progress')
    ?.querySelector('.task-panel__section-toggle')
  progressToggle().click()
  await until(() => progressState() === null, 'The section did not fold shut', 5000)
  progressToggle().click()
  await until(() => progressState() !== null, 'The section did not fold open again', 5000)
  passed.push('the task rail separates background commands and subagents beside environment, plan and deliverables')

  // The workspace panel follows MCode's page strip: fixed-width tabs, an add
  // menu, a start page when nothing is open, a maximized state, and the file
  // tree beside the preview on the Files page.
  const panelToggle = () => [...document.querySelectorAll('button')].find((node) =>
    node.getAttribute('aria-label') === 'Show tools panel' || node.getAttribute('aria-label') === 'Hide tools panel')
  if (!visibleToolPanel()) panelToggle()?.click()
  await until(visibleToolPanel, 'Workspace panel did not open')
  while (true) {
    const pageTab = [...document.querySelectorAll('.tool-panel__tab-shell')].find(
      (tab) => !tab.querySelector('.tool-panel__tab-label')?.textContent?.includes('New tab')
    )
    if (!pageTab) break
    pageTab.querySelector('.tool-panel__tab-close').click()
    await pause(30)
  }
  // Closing the last page folds the panel away. It stays mounted (its tabs and
  // pages survive a later open) but must not keep covering the conversation.
  const panelIsFolded = () => !visibleToolPanel()
  if (panelIsFolded() || document.querySelector('.tool-panel--closing')) {
    await until(panelIsFolded, 'The last page did not close the panel')
    panelToggle()?.click()
  }
  await until(() => document.querySelector('.tool-start'), 'The panel start page did not render')
  check(document.querySelectorAll('.tool-start .tool-menu__card').length === 8, 'The start page does not list every page')
  const filesCard = [...document.querySelectorAll('.tool-start .tool-menu__card')].find((node) => node.textContent?.includes('Files'))
  check(filesCard, 'The start page has no Files entry')
  check(
    [...document.querySelectorAll('.tool-start .tool-menu__card')].some((node) => node.textContent?.includes('Images')),
    'The start page has no Images entry'
  )
  filesCard.click()
  await until(() => document.querySelector('.file-workspace'), 'Files page did not render')
  const firstTab = document.querySelector('.tool-panel__tab-shell')
  const tabWidth = firstTab?.getBoundingClientRect().width ?? 0
  check(tabWidth >= 120 && tabWidth <= 160, `A page tab is not MCode-sized: ${tabWidth}`)
  check(firstTab?.getBoundingClientRect().height === 30, 'A page tab is not 30px high')
  check(document.querySelector('.tool-panel__tabs')?.getBoundingClientRect().height === 46, 'The panel header is not 46px high')
  // The corner controls share a box and a centre line. The shell toggle uses
  // the same medium radius as the sidebar toggle.
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
  const radii = getComputedStyle(document.documentElement)
  const smallRadius = radii.getPropertyValue('--r-sm').trim()
  const mediumRadius = radii.getPropertyValue('--r-md').trim()
  check(
    cornerBoxes[0].radius === smallRadius && cornerBoxes[1].radius === smallRadius && cornerBoxes[2].radius === mediumRadius,
    `The corner controls use the wrong radii: ${JSON.stringify(cornerBoxes)}`
  )
  const cornerLines = cornerBoxes.map((box) => box.centre)
  const panelLines = cornerLines.slice(0, 2)
  // The fixed shell toggle band matches the panel's 46px header.
  check(
    Math.max(...panelLines) - Math.min(...panelLines) <= 0.5,
    `The panel corner controls are not on one line: ${JSON.stringify(cornerLines)}`
  )
  check(
    Math.abs(cornerLines[2] - panelLines[0]) <= 0.6,
    `The shell toggle is not on the panel header's centre line: ${JSON.stringify(cornerLines)}`
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
  // The maximized panel covers the conversation, so nothing behind it may keep
  // the keyboard or a click.
  check(document.querySelector('.main__body')?.inert, 'The maximized panel left the conversation interactive behind it')
  const hiddenRailMarker = document.querySelector('[data-rail-marker]')
  hiddenRailMarker.focus()
  check(
    document.activeElement !== hiddenRailMarker,
    'The maximized panel left a covered control focusable'
  )
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
  check(!document.querySelector('.main__body')?.inert, 'Restoring the panel left the conversation inert')
  check(
    getComputedStyle(document.querySelector('.session-rail')).visibility === 'visible',
    'The session rail stayed hidden after restoring the panel'
  )
  // The rail is one keyboard column: Up/Down walk its turn ticks.
  const railMarkers = [...document.querySelectorAll('[data-rail-marker]')]
  check(railMarkers.length >= 2, 'The session rail exposed fewer than two turn ticks')
  railMarkers[0].focus()
  railMarkers[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await until(() => document.activeElement === railMarkers[1], 'ArrowDown did not move to the next rail tick')
  railMarkers[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await until(() => document.activeElement === railMarkers[0], 'ArrowUp did not move back to the previous rail tick')
  passed.push('the session rail walks with the arrow keys')
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
  // The strip is one listbox Tab stop with arrow navigation.
  const imageThumbs = [...document.querySelectorAll('.image-viewer__thumb')]
  check(imageThumbs.length >= 2, 'The Images page listed fewer than two pictures')
  check(
    imageThumbs.filter((thumb) => thumb.tabIndex === 0).length === 1,
    'The image strip has more than one Tab stop'
  )
  const activeThumbIndex = imageThumbs.findIndex((thumb) => thumb.tabIndex === 0)
  const nextIndex = activeThumbIndex + 1 < imageThumbs.length ? activeThumbIndex + 1 : activeThumbIndex - 1
  const activeThumb = imageThumbs[activeThumbIndex]
  const nextThumb = imageThumbs[nextIndex]
  const forward = nextIndex > activeThumbIndex ? 'ArrowRight' : 'ArrowLeft'
  const backward = forward === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight'
  activeThumb.focus()
  activeThumb.dispatchEvent(new KeyboardEvent('keydown', { key: forward, bubbles: true }))
  await until(() => document.activeElement === nextThumb, 'The arrows did not move to the next picture')
  await until(
    () => nextThumb.getAttribute('aria-selected') === 'true',
    'The arrows did not select the next picture'
  )
  nextThumb.dispatchEvent(new KeyboardEvent('keydown', { key: backward, bubbles: true }))
  await until(() => document.activeElement === activeThumb, 'The arrows did not return to the previous picture')
  passed.push('the image strip walks with the arrow keys')
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

  setRailItems([], 'draft:other-task-rail')
  await until(() => !railSection('Background tasks') && !railSection('Subagents'),
    'Switching conversations kept the previous conversation tasks')
  setRailItems(railItems)
  await until(() => railSection('Background tasks'), 'Returning to the conversation did not restore the running command')
  const subagentButton = await until(
    () => railSection('Subagents')?.querySelector('.task-panel__task[data-status="running"] button'),
    'Returning to the conversation did not restore the running subagent'
  )
  subagentButton.click()
  await until(() => document.querySelector('.subagent-conversation__identity strong')?.textContent === 'Run the gate',
    'The subagent row did not open its own task')
  check(store.getState().draftId === 'draft:task-rail', 'Opening a subagent switched the parent conversation')
  const completedRailItems = railItems.map((item) => item.id === 'rail-sub' ? {
    ...item,
    status: 'ok',
    details: {
      ...item.details,
      results: item.details.results.map((result, index) => index === 0
        ? { status: 'completed', output: 'The verification gate passed.' }
        : result)
    }
  } : item)
  setRailItems(completedRailItems)
  await until(() => document.querySelector('.subagent-conversation__body')?.textContent.includes('The verification gate passed.'),
    'The open task did not receive the finished output')
  await until(() => [...railSection('Subagents').querySelectorAll('.task-panel__task[data-status="completed"]')].some(
    (row) => row.querySelector('.task-panel__task-label')?.textContent === 'Run the gate'
  ), 'The completed subagent disappeared or kept its running status')
  document.querySelector('.subagent-conversation__back').click()
  await until(() => !document.querySelector('.subagent-conversation'), 'The subagent detail did not return to the catalog')
  passed.push('the task rail follows the conversation and subagent rows open live details and retain their outcome')

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

  // Enter in the file search opens the top result; the arrows walk the flat
  // results and return to the field.
  fileSearch.focus()
  fileSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  const firstFileResult = await until(
    () => document.querySelector('[data-tree-result]'),
    'The file search rendered no keyboard-visible result'
  )
  await until(() => document.activeElement === firstFileResult, 'ArrowDown did not enter the file search results')
  firstFileResult.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await until(() => document.activeElement === fileSearch, 'ArrowUp did not return to the file search field')
  fileSearch.focus()
  fileSearch.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until(
    () => document.querySelector('.file-workspace')?.textContent?.includes('new query result'),
    'Enter in the file search did not open the top result'
  )
  passed.push('the file search opens its top result with Enter')
  // The opened file occupies the preview; the Files page's empty state is what
  // the full-text-search check below expects, so put it back through the same
  // door the app uses for "show the Changes/Files page".
  window.dispatchEvent(new CustomEvent('pi:open-inspector', { detail: { tab: 'files' } }))
  await until(
    () => document.querySelector('.file-workspace__text-search'),
    'The Files page did not return to its empty preview'
  )
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

  // The tree proper is one keyboard column: Right opens or enters, Left closes
  // or climbs, and Down/Up walk the visible rows.
  nestedFolder.focus()
  nestedFolder.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await until(() => nestedFolder.getAttribute('aria-expanded') === 'false', 'ArrowLeft did not close the folder')
  nestedFolder.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await until(
    () => nestedFolder.getAttribute('aria-expanded') === 'true' && document.querySelector('[data-tree-row][data-depth="1"]'),
    'ArrowRight did not reopen the folder'
  )
  nestedFolder.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  const firstChild = await until(
    () => document.querySelector('[data-tree-row][data-depth="1"]'),
    'ArrowDown did not enter the folder'
  )
  await until(() => document.activeElement === firstChild, 'ArrowDown did not focus the first child row')
  firstChild.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  await until(() => document.activeElement === nestedFolder, 'ArrowLeft on a child did not return to its folder')
  passed.push('the file tree walks with the arrow keys')

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

  // The project tree uses the reference editor's row design: every file
  // carries a type tile, every row is the same height, and a nested level
  // keeps a single name column so the hierarchy reads as one ladder. The old
  // Files/Text segmented control is replaced by the two file indexes.
  check(
    document.querySelectorAll('.file-workspace__tree-head .segmented').length === 0,
    'The old Files/Text switcher is still present'
  )
  const treeTabs = [...document.querySelectorAll('.tree__index-row')].map((node) => node.textContent?.trim() ?? '')
  check(treeTabs.some((label) => label.includes('Changed files')), 'The changed-files index is missing')
  check(treeTabs.some((label) => label.includes('All files')), 'The all-files index is missing')
  check(treeTabs.length === 2, `The tree has ${treeTabs.length} indexes, expected 2`)
  const treeRows = [...document.querySelectorAll('.file-workspace .tree__item')]
  check(treeRows.length > 0, 'The project tree rendered no rows')
  const treeFileRow = treeRows.find((node) => node.dataset.kind === 'file')
  check(treeFileRow, 'The project tree rendered no file row')
  check(treeFileRow.querySelector('.tree__file-icon'), 'A file row lost its type icon')
  check(
    !treeFileRow.querySelector('.tree__badge'),
    'The file row still wears a text badge instead of an icon'
  )
  const treeHeights = new Set(treeRows.map((node) => Math.round(node.getBoundingClientRect().height)))
  check(treeHeights.size === 1, `The tree rows have different heights: ${[...treeHeights].join(', ')}`)
  const nameColumns = new Set(
    treeRows
      .filter((node) => node.dataset.kind === 'file')
      .map((node) => Math.round(node.querySelector('.tree__name').getBoundingClientRect().left))
  )
  check(nameColumns.size === 1, `File names sit on ${nameColumns.size} columns: ${[...nameColumns].join(', ')}`)
  for (const [name, mark] of [
    ['index.html', '<>'], ['main.py', 'PY'], ['main.rs', 'RS'], ['build.mjs', 'JS'], ['types.gql', '</>']
  ]) {
    const row = treeRows.find((node) => node.querySelector('.tree__name')?.textContent === name)
    check(row?.querySelector('.file-icon__mark')?.textContent === mark, `${name} did not show its code icon`)
  }
  // The tree toggle lives in the panel header (a folder button), not in the
  // tree's own filter row: it stays in the same corner either way.
  const treeToggle = [...document.querySelectorAll('.tool-panel__action')].find(
    (node) => node.getAttribute('aria-label') === 'Hide file tree' || node.getAttribute('aria-label') === 'Show file tree'
  )
  check(treeToggle, 'The panel header lost its file-tree toggle')
  check(!document.querySelector('.tree__search-fold'), 'The old filter-row toggle is still present')
  treeToggle.click()
  await until(
    () => document.querySelector('.file-workspace')?.dataset.tree === 'closed',
    'The tree toggle did not fold the tree away',
    5000
  )
  const showTree = [...document.querySelectorAll('.tool-panel__action')].find(
    (node) => node.getAttribute('aria-label') === 'Show file tree'
  )
  check(showTree, 'The panel header lost its way to bring the tree back')
  showTree.click()
  await until(
    () => document.querySelector('.file-workspace')?.dataset.tree === 'open',
    'The tree toggle did not bring the tree back'
  )
  // Full-text search moved off the tree header into the preview pane; the
  // entry point must still exist now that the Files/Text switcher is gone.
  const textSearchButton = document.querySelector('.file-workspace__text-search')
  check(textSearchButton, 'The preview pane lost its full-text search entry')
  textSearchButton.click()
  const textSearch = await until(() => document.querySelector('.text-search'), 'Full-text search did not open in the preview pane')
  // Enter opens the top hit, and the arrows walk the hit list.
  const textSearchInput = textSearch.querySelector('input')
  setInput.call(textSearchInput, 'nested')
  textSearchInput.dispatchEvent(new Event('input', { bubbles: true }))
  const firstTextHit = await until(
    () => document.querySelector('[data-text-search-hit]'),
    'Full-text search found no fixture hit'
  )
  textSearchInput.focus()
  textSearchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await until(() => document.activeElement === firstTextHit, 'ArrowDown did not enter the text search hits')
  firstTextHit.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await until(() => document.activeElement === textSearchInput, 'ArrowUp did not return to the text search field')
  textSearchInput.focus()
  textSearchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until(
    () => !document.querySelector('.text-search') &&
      document.querySelector('.file-workspace')?.textContent?.includes('nested workspace file'),
    'Enter did not open the top full-text hit'
  )
  passed.push('the full-text search opens its top hit with Enter')
  document.querySelector('.text-search .icon-btn[title]')?.click()
  await pause(120)
  const pythonRow = [...document.querySelectorAll('.tree__item')]
    .find((node) => node.querySelector('.tree__name')?.textContent === 'main.py')
  pythonRow.click()
  await until(
    () => document.querySelector('.viewer__crumb-path .file-icon__mark')?.textContent === 'PY',
    'The file preview did not show the same Python icon as the tree'
  )
  passed.push('the project tree and file preview share language icons, with evenly spaced tree rows')

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

  // Queued prompts are not a read-only list: while the run keeps going, the
  // reader can take them back to the editor or discard them. A queue that can
  // only be emptied by stopping the turn makes the reader throw work away.
  const queueBefore = store.getState().queue
  store.setState({ queue: { steering: ['UI_QUEUED_STEER_610'], followUp: ['UI_QUEUED_FOLLOW_UP_610'] } })
  await until(
    () => document.querySelectorAll('.composer__queue-item').length === 2,
    'Queued prompts did not render'
  )
  const queueActions = [...document.querySelectorAll('.composer__queue-action')]
  check(queueActions.length === 2, 'The queued prompts have no recall or discard control')
  check(
    queueActions[0]?.getAttribute('title') === 'Recall queued messages to editor',
    'The recall control does not say what it does'
  )
  check(
    queueActions[1]?.getAttribute('title') === 'Clear queued messages',
    'The discard control does not say what it does'
  )
  // The icon sits on the first row's own 20px line, so it does not inflate the
  // row it belongs to.
  const queueRowBox = document.querySelector('.composer__queue-item')?.getBoundingClientRect()
  const queueActionBox = queueActions[1]?.getBoundingClientRect()
  check(
    queueRowBox && queueRowBox.height <= 24,
    `The queue controls made their row taller than its text (${queueRowBox?.height}px)`
  )
  check(
    queueActionBox && queueActionBox.height <= 20,
    `The queue controls are larger than their 20px line (${queueActionBox?.height}px)`
  )
  queueActions[1].click()
  const discardBody = await until(
    () => document.querySelector('.modal-layer .confirm__body'),
    'Discarding the queue asked nothing'
  )
  check(
    discardBody.textContent === 'They will not be sent and will not return to the editor.',
    'The discard confirmation does not say the prompts are lost'
  )
  const cancelDiscard = [...document.querySelectorAll('.modal-layer .modal__foot .btn')]
    .find((button) => !button.classList.contains('btn--danger'))
  cancelDiscard?.click()
  await until(() => !document.querySelector('.modal-layer'), 'Cancelling the discard left the dialog open')
  store.setState({ queue: queueBefore })
  passed.push('queued prompts can be taken back or discarded without stopping the run')

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
  // The path answers "where does this work live": the project folder. It must
  // never be Pi's own session file under `~/.pi/agent/sessions`.
  check(
    pathValue && !/\.jsonl$/i.test(pathValue.textContent?.trim() ?? ''),
    `The conversation card points at the transcript file: ${pathValue?.textContent}`
  )
  check(
    pathValue && !/[\\/]\.pi[\\/]agent[\\/]sessions[\\/]/i.test(pathValue.textContent ?? ''),
    `The conversation card points into Pi's cache: ${pathValue?.textContent}`
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

  // Image generation lives in the composer: `/image` loads the reference tile,
  // the blue mode label and the compact model/parameter chips in place.
  await store.getState().send('/image a lighthouse at dusk', [])
  const imageMode = await until(
    () => document.querySelector('.composer__image-context'),
    'The /image command did not open the composer image controls'
  )
  check(imageMode.querySelector('.composer__image-ref-add'), 'The image reference tile is missing')
  const imageChips = [...document.querySelectorAll('.composer__image-chip')]
  check(imageChips.length === 2, `Expected a model and a parameter chip, got ${imageChips.length}`)
  await until(
    () => document.querySelector('.composer__input')?.value === 'a lighthouse at dusk',
    'The /image command did not fill the composer prompt'
  )
  imageChips[1].click()
  const paramsPanel = await until(
    () => document.querySelector('.image-params'),
    'The image parameter popover did not open'
  )
  check(
    paramsPanel.querySelectorAll('.image-params__ratio').length === 6,
    'The ratio grid is missing options'
  )
  check(
    paramsPanel.querySelectorAll('.image-params__segments').length === 2,
    'The quality and count segments are missing'
  )
  imageChips[1].click()
  passed.push('the /image command loads the image controls in the composer')

  // A generate_image result shows its picture inline: not inside the process
  // fold and not in a side panel, and its picture can be handed back to the
  // composer as a reference image or reused with its parameters.
  const imageItems = [
    { id: 'img-user', kind: 'user', text: 'Draw a lighthouse', images: [], timestamp: 1, order: 1 },
    {
      id: 'img-assistant', kind: 'assistant', streaming: false, timestamp: 2, order: 2,
      blocks: [{
        type: 'toolCall', id: 'img-call', name: 'generate_image', argsText: '{}',
        args: { prompt: 'a lighthouse at dusk', model: 'codex/gpt-image-2', size: '1536x1024' }
      }]
    },
    {
      id: 'img-tool', kind: 'tool', toolCallId: 'img-call', toolName: 'generate_image',
      args: { prompt: 'a lighthouse at dusk', model: 'codex/gpt-image-2', size: '1536x1024' },
      status: 'ok', result: 'Generated 1 image(s)',
      details: { paths: [`${workspace}/shot.png`], model: 'codex/gpt-image-2' }, timestamp: 3, order: 3
    }
  ]
  showStream('draft:ui-image', imageItems, {
    phase: 'idle', turns: 1, settled: true, outcome: 'completed'
  })
  const imageCard = await until(
    () => document.querySelector('.tool[data-tone="image"]'),
    'The generate_image card did not render'
  )
  check(
    imageCard.querySelector('.tool__summary')?.textContent?.includes('GPT Image 2 · 3:2'),
    'The generate_image card did not summarise the model and ratio'
  )
  const inlineImage = await until(
    () => imageCard.querySelector('.tool__images img'),
    'The generated picture did not render inline'
  )
  check(
    inlineImage.getAttribute('src')?.startsWith('data:image/png;base64,'),
    'The inline picture is not drawn from the verified image bridge'
  )
  const useRefBtn = imageCard.querySelector('.tool__image-action')
  check(useRefBtn, 'The generated picture has no Use as reference action')
  useRefBtn.click()
  await until(
    () => document.querySelector('.composer__image-ref img'),
    'Clicking Use as reference did not attach the generated picture in the composer'
  )
  const reusePromptBtn = imageCard.querySelector('.tool__reuse-icon')
  check(reusePromptBtn, 'The generate_image card has no Reuse prompt action')
  reusePromptBtn.click()
  await until(
    () => document.querySelector('.composer__input')?.value === 'a lighthouse at dusk',
    'Clicking Reuse did not restore the prompt into the composer'
  )
  passed.push('a generated picture renders inline and can be reused as a reference or prompt')

  // The preview's close control must clear the native caption buttons; the
  // header used to sit high enough that the window buttons covered it.
  const previewCanvas = document.createElement('canvas')
  previewCanvas.width = 1535
  previewCanvas.height = 1024
  const previewContext = previewCanvas.getContext('2d')
  previewContext.fillStyle = '#6b8e23'
  previewContext.fillRect(0, 0, previewCanvas.width, previewCanvas.height)
  const previewData = previewCanvas.toDataURL('image/png').split(',')[1]
  showStream('draft:lightbox', [
    {
      id: 'lightbox-user', kind: 'user', text: 'Preview', timestamp: 1, order: 1,
      images: [{ data: previewData, mimeType: 'image/png' }]
    }
  ], { phase: 'idle', turns: 1, settled: true, outcome: 'completed' })
  const previewTrigger = await until(
    () => document.querySelector('.user-msg__images .lightbox-trigger'),
    'The message image did not render'
  )
  previewTrigger.click()
  await until(() => document.querySelector('.lightbox'), 'The image preview did not open')
  const previewClose = document.querySelector('.lightbox__btn--icon')
  const previewCloseBox = previewClose.getBoundingClientRect()
  const titlebarHeight =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--titlebar-h')) || 36
  check(
    previewCloseBox.top >= titlebarHeight,
    `The preview close control starts under the caption buttons: ${previewCloseBox.top}`
  )
  previewClose.click()
  await until(
    () => !document.querySelector('.lightbox'),
    'The preview close control did not close the preview'
  )
  passed.push('the image preview close control clears the caption buttons and closes')

  const archiveQuery = 'Archive scope fixture'
  const activeTitle = `${archiveQuery} active`
  const archivedTitle = `${archiveQuery} archived`
  async function setArchiveFilter(label, mode) {
    document.querySelector('button[aria-label="View options"]').click()
    const option = await until(() => [...document.querySelectorAll('.view-option-menu [role="menuitemradio"]')]
      .find((node) => node.textContent.trim() === label), `Archive filter option ${label} is missing`)
    option.click()
    await until(() => store.getState().settings.sidebarArchiveFilter === mode, `Archive filter did not switch to ${mode}`)
  }
  async function checkArchiveSearch(mode, expected) {
    document.querySelector('button[aria-label="Search projects and conversations"]').click()
    const dialog = await until(() => document.getElementById('conversation-search-dialog'), 'The conversation search did not open')
    const titles = (selector) => [...dialog.querySelectorAll(selector)].map((node) => node.textContent.trim()).sort().join(',')
    setInputValue(dialog.querySelector('input'), archiveQuery)
    await until(() => titles('section[aria-label="Search conversations"] .search-dialog__result-title') === expected, `Title search ignored the ${mode} archive filter`)
    await until(() => titles('.session-search__title') === expected, `Full-text search ignored the ${mode} archive filter`)
    dialog.querySelector('button[aria-label="Close"]').click()
    await until(() => !dialog.isConnected, 'The conversation search did not close')
  }
  for (const [label, mode, expected] of [
    ['Hide archived', 'hidden', activeTitle],
    ['All conversations (show archived)', 'all', [activeTitle, archivedTitle].join(',')],
    ['Archived only', 'archived', archivedTitle]
  ]) {
    await setArchiveFilter(label, mode)
    await checkArchiveSearch(mode, expected)
  }
  // The flat column has no project rows at all, so an archived conversation has
  // nothing around it to say which folder it came from. It leaves the column and
  // comes back under its own project instead.
  // The menu re-renders and a menu item captured a moment ago can be gone by the
  // time a click is dispatched. Re-open and re-query instead of trusting nodes.
  const setGroupBy = async (label, mode) => {
    const deadline = performance.now() + 15000
    while (performance.now() < deadline) {
      if (store.getState().settings.sidebarGroupBy === mode) return
      if (!document.querySelector('.view-option-menu [role="menuitemradio"]')) {
        document.querySelector('button[aria-label="View options"]')?.click()
      }
      const option = [...document.querySelectorAll('.view-option-menu [role="menuitemradio"]')]
        .find((node) => node.textContent.trim() === label)
      if (option) option.click()
      else await pause(50)
      await pause(50)
    }
    throw new Error(`Grouping did not switch to ${mode}`)
  }
  const archivedGroups = () => [...document.querySelectorAll('.sidebar__archive-group')].map((node) => ({
    name: node.querySelector('.sidebar__archive-group-name')?.textContent.trim() ?? '',
    titles: [...node.querySelectorAll('.session-item__title')].map((title) => title.textContent.trim())
  }))
  await setGroupBy('Single list', 'flat')
  const grouped = await until(() => {
    const list = archivedGroups()
    return list.some((group) => group.titles.includes(archivedTitle)) ? list : null
  }, 'The archived conversation was not grouped under its project')
  check(grouped.every((group) => group.name.length > 0), 'An archived group lost its project name')
  // The archived block lives inside the same project section, so the column is
  // the section's own direct session list — the groups are further down.
  const flatColumnTitles = [...document.querySelectorAll('.sidebar__projects > .session-list .session-item__title')]
    .map((node) => node.textContent.trim())
  check(!flatColumnTitles.includes(archivedTitle), 'An archived conversation stayed in the flat column')

  // The「对话」head is a fold control: it hides the list it names and stays on
  // screen itself, because the caret is the only way back.
  const sectionToggle = () => document.querySelector('.sidebar__projects .sidebar__section-toggle')
  await until(() => sectionToggle(), 'The chat section head has no fold control')
  check(sectionToggle().getAttribute('aria-expanded') === 'true', 'The chat section started folded')
  const visibleRows = () => [...document.querySelectorAll('.sidebar__projects .session-item')]
    .filter((row) => row.getClientRects().length > 0).length
  check(visibleRows() > 0, 'The chat section listed no rows to fold')
  // Re-query the toggle on every step: a fold re-renders the head.
  sectionToggle()?.click()
  await until(() => sectionToggle()?.getAttribute('aria-expanded') === 'false',
    'Folding the chat section did not collapse it')
  await until(() => visibleRows() === 0, 'The folded chat section still draws its rows')
  check(sectionToggle()?.getClientRects().length > 0, 'Folding the chat section hid the caret that unfolds it')
  sectionToggle()?.click()
  await until(() => sectionToggle()?.getAttribute('aria-expanded') === 'true',
    'Unfolding the chat section did not restore it')
  await until(() => visibleRows() > 0, 'The unfolded chat section drew no rows')
  passed.push('the chat section head folds its list and keeps its caret')

  await setGroupBy('By workspace', 'workspace')
  passed.push('the flat column groups archived conversations under their project')

  const limitedHits = await window.pi.sessions.search(archiveQuery, 1)
  check(limitedHits.length === 1 && limitedHits[0].name === archivedTitle, 'A newer active hit used the archived search result limit')
  const archivedRow = () => [...document.querySelectorAll('.session-item')].find(
    (row) => row.querySelector('.session-item__title')?.textContent.trim() === archivedTitle
  )
  await until(() => archivedRow(), 'The archived conversation was not listed')
  // The row and its action menu are replaced by a re-render; open the menu from
  // whichever row is on screen and re-read the item before clicking it.
  const restore = await until(() => {
    const item = [...document.querySelectorAll('.session-actions-menu [role="menuitem"]')]
      .find((node) => node.textContent.trim() === 'Restore')
    if (item) return item
    if (!document.querySelector('.session-actions-menu')) archivedRow()?.querySelector('.session-item__more')?.click()
    return null
  }, 'The archived conversation has no Restore action')
  restore.click()
  await until(() => store.getState().settings.archivedSessions?.length === 0, 'Restore did not remove the archive status')
  // A restored row leaves the archived list; the awaited value is the title, not
  // the element captured before the click.
  await until(() => !archivedRow(), 'Restoring a conversation left it in the archived list')
  await setArchiveFilter('Hide archived', 'hidden')
  await checkArchiveSearch('restored', [activeTitle, archivedTitle].join(','))
  passed.push('title and text search honor the archive filter, and the sidebar restores archived conversations')

  // Leave the environment section folded in the harness screenshot so the
  // collapsed state remains visible for visual review.
  const finalEnvironmentToggle = [...document.querySelectorAll('.task-panel__section')]
    .find((node) => node.querySelector('.task-panel__section-title')?.textContent === 'Environment info')
    ?.querySelector('.task-panel__section-toggle')
  if (finalEnvironmentToggle?.getAttribute('aria-expanded') !== 'false') finalEnvironmentToggle?.click()
  await pause(250)
  check(finalEnvironmentToggle?.getAttribute('aria-expanded') === 'false', 'The final environment screenshot is not folded')

  // A model pick must leave the picker at once: the switch itself can wait on
  // a busy Pi, and an open menu that stays put while it waits reads as a freeze.
  store.setState({
    models: [
      { provider: 'fixture', id: 'sidebar-test', name: 'Fixture model', contextWindow: 32000 },
      { provider: 'fixture', id: 'second-model', name: 'Second model', contextWindow: 32000 }
    ],
    catalogModels: [],
    disabledModelSpecs: []
  })
  const modelChip = await until(() => document.querySelector('.model-chip'), 'The model chip is missing')
  modelChip.click()
  // The chip opens the effort card first; its model row turns the card into the list.
  const modelListButton = await until(() => document.querySelector('.effort-card__model-btn'), 'The effort card has no way to the model list')
  modelListButton.click()
  await until(() => document.querySelectorAll('.model-picker__row').length >= 2, 'The model picker did not list both models')
  const otherModel = [...document.querySelectorAll('.model-picker__row')].find((row) => !row.querySelector('.model-picker__check'))
  check(otherModel, 'The second model is not selectable')
  otherModel.click()
  await until(() => !document.querySelector('.model-picker-container'), 'Picking a model left the picker open')
  passed.push('picking a model closes the picker without waiting on Pi')

  // Side chat is a parallel conversation, not a second chat UI: its header is
  // its own, and its transcript and composer are the main chat's components
  // rendered in the side scope.
  await openToolPage('side-chat', 'Side chat')
  await until(() => document.querySelector('.side-chat'), 'The Side chat panel did not render')
  check(Boolean(document.querySelector('.side-chat__head')), 'The Side chat panel has no header')
  check(
    Boolean(document.querySelector('.side-chat .composer-wrap')),
    'Side chat does not render the main conversation composer'
  )
  check(
    Boolean(document.querySelector('.side-chat .thread-frame')) ||
      Boolean(document.querySelector('.side-chat .side-empty')),
    'Side chat renders neither the main transcript nor its empty state'
  )
  check(
    !document.querySelector('.side-chat__readonly'),
    'Side chat must not be presented as read-only'
  )
  passed.push('side chat opens as its own working panel, built from the main chat')
  await store.getState().updateSettings({ model: 'fixture/sidebar-test', provider: 'fixture' })
  store.setState({ models: [], catalogModels: [] })
  // The Swarm page: one situation line, a two-line roster, a filter, and the
  // selected worker's turn, which opens the child conversation. Injected
  // through the store because the fake provider does not run a real team.
  const swarmNow = Date.now()
  const swarmItem = {
    id: 'swarm-assign-1', kind: 'tool', toolCallId: 'swarm-assign-1', toolName: 'swarm_task',
    args: { name: 'math-reason', task: 'expand the math direction' },
    status: 'ok', result: 'dispatched', timestamp: swarmNow - 80_000,
    startedAt: swarmNow - 80_000, finishedAt: swarmNow - 70_000, order: 1
  }
  store.setState((state) => ({
    activeSessionFile: undefined,
    draftId: 'draft:swarm-check',
    items: [swarmItem],
    activeToolsRevision: state.activeToolsRevision + 1,
    uiStatuses: [{ key: 'pi-desktop-swarm', text: JSON.stringify([
      { name: 'math-reason', status: 'working', task: 'expand the math direction', progressText: 'writing 12 more questions', tokens: 1200, startedAt: swarmNow - 90_000 },
      { name: 'code', status: 'idle', task: 'add boundary cases', output: 'added 8 cases', tokens: 800, queued: 1, startedAt: swarmNow - 200_000, finishedAt: swarmNow - 10_000 },
      { name: 'know-safety', status: 'failed', task: 'expand knowledge', errorMessage: 'exit 1', startedAt: swarmNow - 500_000, finishedAt: swarmNow - 400_000 }
    ]) }]
  }))
  await openToolPage('swarm', 'Swarm')
  const situation = await until(() => document.querySelector('.swarm__situation'), 'The Swarm page has no situation line')
  check(/\b2\b/.test(situation.textContent ?? ''), 'The situation line did not count the workers that are working')
  const workerNames = await until(() => {
    const names = [...document.querySelectorAll('.swarm__worker-name')].map((node) => node.textContent?.trim())
    return names.length === 3 ? names : null
  }, 'The Swarm worker list did not render')
  check(workerNames.includes('know-safety') && workerNames.includes('math-reason'), 'The worker list lost a worker')
  const failedFilter = [...document.querySelectorAll('.swarm__filter')].find((node) => node.textContent?.startsWith('Failed'))
  failedFilter?.click()
  await until(() => document.querySelectorAll('.swarm__worker').length === 1, 'The worker filter did not narrow the list')
  document.querySelector('.swarm__worker-toggle')?.click()
  await until(() => document.querySelector('.swarm__worker-error'), 'The failed worker did not show its error')
  ;[...document.querySelectorAll('.swarm__filter')].find((node) => node.textContent?.startsWith('All'))?.click()
  await until(() => document.querySelectorAll('.swarm__worker').length === 3, 'Clearing the worker filter did not restore the roster')
  ;[...document.querySelectorAll('.swarm__worker-toggle')].find((node) => node.textContent?.includes('math-reason'))?.click()
  const turn = await until(
    () => [...document.querySelectorAll('.swarm__turn')].find((node) => node.textContent?.includes('expand the math direction')) ?? null,
    'The selected worker did not list its turn'
  )
  turn.click()
  await until(() => document.querySelector('.subagent-conversation'), 'The turn did not open its conversation')
  document.querySelector('.subagent-conversation__back')?.click()
  await until(() => !document.querySelector('.subagent-conversation') && document.querySelector('.swarm__turn'),
    'Leaving the turn did not return to that worker')
  passed.push('the Swarm page shows the roster, the selected worker and opens a turn')
  store.setState({ uiStatuses: [], items: [] })
  // A Chinese interface must not keep English inside it. The map translates
  // both the app's own labels and the plain-text messages the main process
  // sends, and the toast is where a reader meets the latter. Switch, look, and
  // The sidebar is one keyboard column: the arrows walk its rows, and the top
  // of the column hands focus to the search button above it.
  const sidebarRows = () => [...document.querySelectorAll('.sidebar [data-sidebar-row]')]
    .filter((row) => row.getClientRects().length > 0)
  const firstRow = sidebarRows()[0]
  const secondRow = sidebarRows()[1]
  check(Boolean(firstRow && secondRow), 'The sidebar exposed fewer than two rows to the keyboard')
  firstRow.focus()
  firstRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await until(() => document.activeElement === secondRow, 'ArrowDown did not move to the next sidebar row')
  secondRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await until(() => document.activeElement === firstRow, 'ArrowUp did not move back to the previous sidebar row')
  firstRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await until(
    () => document.activeElement === document.querySelector('.sidebar__head-btn'),
    'ArrowUp at the top of the sidebar did not reach the search button'
  )
  passed.push('the sidebar list walks with the arrow keys')

  // Opening a conversation from search or a shortcut reveals its row: a folded
  // project opens and the column follows the selection.
  const activeBeforeReveal = store.getState().activeSessionFile ?? store.getState().draftId
  const sessionByLowerFile = new Map(
    store.getState().sessions.map((session) => [session.file.toLowerCase(), session])
  )
  const revealTarget = [...document.querySelectorAll('.project[data-expanded="true"]')]
    .map((project) => {
      const row = [...project.querySelectorAll('.session-item')].find((item) => {
        const file = item.getAttribute('data-session-file')
        const session = file ? sessionByLowerFile.get(file.toLowerCase()) : undefined
        return Boolean(session && session.file !== activeBeforeReveal)
      })
      return row
        ? {
            project,
            row,
            file: row.getAttribute('data-session-file'),
            session: sessionByLowerFile.get(row.getAttribute('data-session-file').toLowerCase())
          }
        : null
    })
    .find(Boolean)
  check(Boolean(revealTarget), 'No expanded project listed a selectable conversation to reveal')
  const revealPath = revealTarget.project.getAttribute('data-path')
  const revealFile = revealTarget.file
  revealTarget.project.querySelector('.project__main')?.click()
  await until(
    () => [...document.querySelectorAll('.project')]
      .find((project) => project.getAttribute('data-path') === revealPath)
      ?.getAttribute('data-expanded') === 'false',
    'The project row did not fold'
  )
  await store.getState().selectSession(revealTarget.session)
  const revealProject = () => [...document.querySelectorAll('.project')]
    .find((project) => project.getAttribute('data-path') === revealPath)
  await until(
    () => revealProject()?.getAttribute('data-expanded') === 'true',
    'Opening a conversation did not reveal its project'
  )
  const revealedRow = () => [...revealProject().querySelectorAll('.session-item')]
    .find((item) => item.getAttribute('data-session-file') === revealFile)
  await until(() => revealedRow()?.getClientRects().length > 0, 'The opened conversation row stayed hidden')
  passed.push('opening a conversation reveals its row in the sidebar')

  // The search dialog is keyboard-complete: ArrowDown moves into the results,
  // ArrowUp returns to the field, and Enter takes the top result.
  const searchTrigger = [...document.querySelectorAll('.sidebar__head-btn')]
    .find((button) => button.getAttribute('aria-label') === 'Search projects and conversations')
  searchTrigger?.click()
  const searchField = await until(
    () => document.querySelector('.search-dialog input'),
    'The search dialog did not open'
  )
  setInput.call(searchField, 'workspace')
  searchField.dispatchEvent(new Event('input', { bubbles: true }))
  const firstResult = await until(
    () => document.querySelector('[data-search-result]'),
    'The search dialog found no result for the workspace'
  )
  searchField.focus()
  searchField.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  await until(() => document.activeElement === firstResult, 'ArrowDown did not enter the search results')
  firstResult.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
  await until(() => document.activeElement === searchField, 'ArrowUp did not return to the search field')
  searchField.focus()
  searchField.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  await until(() => !document.querySelector('.search-dialog'), 'Enter did not open the top search result')
  passed.push('the conversation search opens its top result with Enter')

  // A toast that names an exported file also offers to open it.
  store.getState().showToast('Exported notes.md', 'info', undefined, 'C:/tmp/notes.md')
  const openAction = await until(
    () => [...document.querySelectorAll('.app-toast__action')].find((button) => button.textContent?.trim() === 'Open'),
    'An exported-file toast has no Open action'
  )
  check(openAction, 'An exported-file toast has no Open action')
  check(
    openAction.getAttribute('aria-label') === 'Open the exported file',
    'The Open action has no descriptive accessible label'
  )
  store.getState().clearToast()
  passed.push('a file toast offers to open what it names')

  // switch back so the harness screenshot stays in English for visual review.
  await store.getState().updateSettings({ language: 'zh-CN' })
  const chineseLabel = await until(() => {
    const button = document.querySelector('.btn-new-chat')
    return button?.textContent?.includes('新聊天') ? button : null
  }, 'The Chinese interface did not load')
  check(chineseLabel, 'The new-chat button kept its English label in the Chinese interface')
  store.getState().showToast('Nothing is staged. Stage a file or include unstaged changes.', 'error')
  await until(
    () => document.querySelector('.app-toast__text')?.textContent === '没有已暂存的更改。请先暂存文件，或勾选包含未暂存更改。',
    'A main-process message stayed English in the Chinese interface'
  )
  // A supervisor guard is the other half: it is thrown from the main process,
  // painted by the toast, and has no literal `t()` call behind it.
  store.getState().showToast('Pi is not running for this conversation.', 'error')
  await until(
    () => document.querySelector('.app-toast__text')?.textContent === '这个对话的 Pi 进程没有在运行。',
    'A supervisor message stayed English in the Chinese interface'
  )
  store.getState().clearToast()
  await store.getState().updateSettings({ language: 'en' })
  await until(() => document.querySelector('.btn-new-chat')?.textContent?.includes('New chat'), 'The English interface did not return')
  passed.push('the Chinese interface translates labels and the messages the main process sends')

  // A new chat is a box to type in: creating one puts the caret there.
  document.querySelector('.sidebar__head-btn')?.focus()
  await store.getState().newChat()
  const composerInput = await until(
    () => document.querySelector('.main__body .composer__input'),
    'The new chat did not render its composer'
  )
  await until(
    () => document.activeElement === composerInput,
    'A new chat left the caret outside the composer'
  )
  passed.push('a new chat puts the caret in the composer')

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
  PI_DESKTOP_EVAL: `(${checkRenderer.toString()})(${JSON.stringify(markerFile)}, ${JSON.stringify(nestedWorkspace)}, ${JSON.stringify(workspace)}, ${JSON.stringify(goalFixture)}, ${JSON.stringify(thinkingFixture)}, ${JSON.stringify(backgroundFixture)}, ${JSON.stringify(planFixture)}, ${JSON.stringify(questionFixture)})`
})
try {
  const { stdout, stderr } = await promisify(execFile)(require('electron'), [root], {
    cwd: root, env, windowsHide: true, timeout: 180000, maxBuffer: 2 * 1024 * 1024
  })
  const rendererErrors = stdout.split(/\r?\n/).filter((line) => line.includes('[pi-desktop] renderer error:'))
  assert.deepEqual(rendererErrors, [], `Renderer console errors:\n${rendererErrors.join('\n')}`)
  assert.doesNotMatch(`${stdout}\n${stderr}`, /Ancestor with aria-hidden: <aside\.tool-panel>/, 'Closing the tools panel hid an element while its terminal was focused')
  const match = /\[pi-desktop\] eval result: (.+)/.exec(stdout)
  assert.ok(match, `Renderer regressions failed:\n${stdout}\n${stderr}\nRequests: ${JSON.stringify(requests)}`)
  const passed = JSON.parse(match[1])
  assert.equal(passed.length, process.platform === 'win32' ? 64 : 59)
  assert.deepEqual(questionRequests, { normal: 2, plan: 2, cancel: 1 })
  assert.equal(existsSync(path.join(workspace, questionFixture.prematureFile)), false, 'Pi wrote a file from the question batch')
  assert.deepEqual(planRequests, { original: 1, revision: 1, implementation: 2 })
  assert.equal(readFileSync(path.join(workspace, planFixture.file), 'utf8'), planFixture.result)
  if (process.platform === 'win32') {
    // ConPTY may redraw old output on resize; the file counts actual executions.
    assert.equal(readFileSync(markerFile, 'utf8').trim().split(/\r?\n/).length, 2, 'Terminal replayed a request')
    assert.equal(readFileSync(path.join(nestedWorkspace, 'terminal-scope-marker.txt'), 'utf8').trim(), 'scoped')
    assert.equal(existsSync(path.join(workspace, 'terminal-scope-marker.txt')), false, 'The previous project received a terminal command')
  }
  for (const name of passed) console.log(`PASS ${name}`)
} finally {
  fixture.closeAllConnections()
  await new Promise((resolve) => fixture.close(resolve))
  assert.equal(path.dirname(profile), output)
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

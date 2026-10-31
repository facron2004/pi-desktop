import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const packagedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : undefined
const output = path.join(root, 'output/playwright/2026-10-29-session-concurrency', `run-${Date.now()}`)
const profile = path.join(output, 'profile'), agent = path.join(output, 'agent'), home = path.join(output, 'home')
const dirs = { A: path.join(output, 'workspace-a'), B: path.join(output, 'workspace-b') }
for (const dir of [profile, agent, home, ...Object.values(dirs)]) mkdirSync(dir, { recursive: true })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const live = new Map(), requests = [], checks = [], errors = [], pending = new Map()
let sequence = 0, child, socket, exitCode, stdout = '', stderr = ''
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  try {
    const payload = JSON.parse(body)
    const user = payload.messages?.findLast(message => message.role === 'user' && JSON.stringify(message.content).includes('CASE:'))
    const task = /CASE:([A-Z]+)/.exec(JSON.stringify(user?.content))?.[1] ?? 'OTHER'
    requests.push({ task, model: payload.model })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: `case-${task}`, object: 'chat.completion.chunk', created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    const userIndex = payload.messages.indexOf(user)
    if (['J', 'K'].includes(task) && !payload.messages.slice(userIndex + 1).some(message => message.role === 'tool')) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `write-${task}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: `approval-${task}.txt`, content: task }) } }] })
      chunk({}, 'tool_calls'); res.end('data: [DONE]\n\n'); return
    }
    chunk({ role: 'assistant', content: `RUN:${task}\n` })
    live.set(task, { finish: () => { chunk({ content: `DONE:${task}` }); chunk({}, 'stop'); res.end('data: [DONE]\n\n') } })
    res.on('close', () => live.delete(task))
  } catch (error) { res.writeHead(500); res.end(String(error)) }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const models = ['test-a', 'test-b'].map(id => ({ id, contextWindow: 32000, maxTokens: 1024, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }))
writeFileSync(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-test', models } } }))
writeFileSync(path.join(agent, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'test-a', defaultThinkingLevel: 'off', enableBashTool: true }))
writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ workspaces: [{ id: 'a', path: dirs.A, name: 'A', lastOpenedAt: 1 }, { id: 'b', path: dirs.B, name: 'B', lastOpenedAt: 1 }], activeWorkspaceId: 'a', model: 'fixture/test-a', thinkingLevel: 'off', language: 'zh-CN', theme: 'dark', permissionMode: 'ask', trustProject: false, desktopNotifications: false }))

function check(name, passed, detail) {
  checks.push({ name, passed, detail }); console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`)
  if (!passed) throw new Error(`${name}: ${JSON.stringify(detail)}`)
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)) }, 45000)
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result) }, reject: error => { clearTimeout(timer); reject(error) } })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
async function until(predicate, name, ms = 45000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await predicate()) return; await pause(100) }
  const state = await evaluate('({view:store.getState().activeSessionFile,status:store.getState().status,error:store.getState().error,run:store.getState().run,cases})').catch(() => null)
  throw new Error(`Timeout ${name}: ${JSON.stringify({ state, requests, live: [...live.keys()] })}`)
}
const wait = (expression, name) => until(() => evaluate(expression), name)
async function start(task, dir) {
  await evaluate(`(async()=>{await store.getState().switchProject(${JSON.stringify(dir)});await store.getState().newChat();cases.${task}=store.getState().draftId;void store.getState().send('CASE:${task}',[]);})()`)
}
const idle = task => wait(`store.getState().threads[cases.${task}]?.run.settled===true`, `${task} settled`)
const select = (task, dir) => evaluate(`store.getState().selectSession({id:${JSON.stringify(task)},file:cases.${task},cwd:${JSON.stringify(dir)},preview:'CASE:${task}',updatedAt:1,messageCount:1})`)
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(path.join(output, `${name}.png`), Buffer.from(result.data, 'base64'))
}
function activeCliPids() {
  // Portable launchers do not forward main-process stdout. Observe only the
  // process family this harness started, rather than relying on trace output.
  const script = `
    $rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId)
    $owned = [Collections.Generic.HashSet[uint32]]::new()
    [void]$owned.Add(${child.pid})
    do {
      $count = $owned.Count
      foreach ($row in $rows) { if ($owned.Contains([uint32]$row.ParentProcessId)) { [void]$owned.Add([uint32]$row.ProcessId) } }
    } while ($owned.Count -ne $count)
    $found = @(foreach ($row in $rows) {
      if ($owned.Contains([uint32]$row.ProcessId)) {
        $detail = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $row.ProcessId) -Property CommandLine
        if ($detail.CommandLine -like '*pi-coding-agent*cli.js*') { [int]$row.ProcessId }
      }
    })
    ConvertTo-Json -InputObject $found -Compress`
  return JSON.parse(execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 20000 }).trim())
}
try {
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
  const env = { ...process.env, PI_DESKTOP_SCREENSHOT: path.join(output, 'unused.png'), PI_DESKTOP_SCREENSHOT_DELAY: '3600000', PI_DESKTOP_USER_DATA: profile, USERPROFILE: home, PI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_SESSION_DIR: path.join(agent, 'sessions'), PI_DESKTOP_RPC_TRACE: '1' }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'PI_DESKTOP_WORKSPACE', 'PI_DESKTOP_THEME', 'PI_DESKTOP_PROMPT', 'PI_DESKTOP_SESSION', 'npm_package_version']) delete env[key]
  const executable = packagedExecutable ?? path.join(root, 'node_modules/electron/dist/electron.exe')
  child = spawn(executable, [...(packagedExecutable ? [] : ['.']), `--remote-debugging-port=${port}`], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes }); child.on('exit', code => { exitCode = code })
  let target
  await until(async () => { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith('file:')); return !!target } catch { return false } }, 'Electron renderer')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  socket.addEventListener('message', ({ data }) => {
    const record = JSON.parse(data), entry = pending.get(record.id)
    if (entry) { pending.delete(record.id); record.error ? entry.reject(new Error(record.error.message)) : entry.resolve(record.result) }
    else if (record.method === 'Runtime.exceptionThrown') errors.push(record.params.exceptionDetails.exception?.description || record.params.exceptionDetails.text)
  })
  socket.addEventListener('close', () => { for (const entry of pending.values()) entry.reject(new Error('CDP closed')); pending.clear() })
  await send('Runtime.enable')
  await wait("window.__piDesktopStore?.getState().status.phase==='ready'", 'app ready')
  const expectedVersion = process.env.PI_DESKTOP_EXPECT_VERSION
  if (expectedVersion) {
    const info = await evaluate('window.pi.app.info()')
    check('Packaged app reports the expected version', info.version === expectedVersion, info.version)
    check('Packaged app uses its bundled Pi CLI', info.pi.source === 'bundled' && info.pi.display.includes('app.asar.unpacked'), info.pi.source)
  }
  await evaluate("window.store=window.__piDesktopStore;window.cases={};window.pi.runtime.onRekey(({from,to})=>{if(from.startsWith('draft:'))for(const name in cases)if(cases[name]===from)cases[name]=to})")
  await start('A', dirs.A); await until(() => live.has('A'), 'A streaming')
  await start('B', dirs.B); await until(() => live.has('B'), 'B streaming')
  check('Two directories run concurrently', live.has('A') && live.has('B'))
  check('Background A still owns its run', await evaluate('store.getState().threads[cases.A].isStreaming&&store.getState().threads[cases.B].isStreaming'))
  await evaluate('store.getState().newChat()')
  const guardedGit = await evaluate("window.pi.git.switchBranch('must-not-switch')")
  check('Git writes see a background run even with an idle chat on screen', !guardedGit.ok && guardedGit.error.includes('conversation is working'), guardedGit)
  await select('B', dirs.B)
  await screenshot('concurrent')
  await evaluate('store.getState().stopSession(cases.A)'); await idle('A')
  check('Stopping background A leaves B streaming', live.has('B') && await evaluate('store.getState().threads[cases.B].isStreaming'))
  await evaluate('store.getState().stop()'); await idle('B')
  check('Stop settles before its response without leaving Aborting', await evaluate("store.getState().run.phase==='idle'"))

  await start('C', dirs.A); await until(() => live.has('C'), 'C streaming')
  await start('D', dirs.A)
  await wait("store.getState().run.phase==='queued'&&store.getState().status.phase==='ready'", 'D directory queue')
  await pause(400)
  check('Same-directory D waits while C streams', !requests.some(request => request.task === 'D') && live.has('C'))
  await screenshot('queued')
  live.get('C').finish(); await idle('C'); await until(() => live.has('D'), 'D dequeued')
  check('C completion starts D without switching the view', await evaluate('store.getState().activeSessionFile===cases.D'))
  live.get('D').finish(); await idle('D')
  check('Concurrent transcripts stay separate', await evaluate("['C','D'].every(name=>store.getState().threads[cases[name]].items.filter(i=>i.kind==='user').every(i=>i.text==='CASE:'+name))"))

  await evaluate("store.getState().newChat();"); await evaluate("store.getState().runInlineBash('echo INLINE-SMOKE')")
  check('Inline bash starts a cold runtime and records its result', await evaluate("store.getState().items.some(i=>i.kind==='bash'&&i.exitCode===0&&i.output.includes('INLINE-SMOKE'))"))
  await start('F', dirs.A); await until(() => live.has('F'), 'prompt after bash')
  live.get('F').finish(); await idle('F')
  check('Bash completion releases the directory gate', true)

  await evaluate('window.pi.runtime.stop(cases.C)'); await select('C', dirs.A)
  check('Opening cold history does not start a process', !(await evaluate('window.pi.runtime.has(cases.C)')))
  check('Cold history stays ready to send', await evaluate("store.getState().status.phase==='ready'"))
  await evaluate("store.getState().setAgentMode('plan')")
  check('An explicit cold-session action restarts its own runtime', await evaluate("store.getState().agentMode==='plan'&&window.pi.runtime.has(cases.C)"))
  await evaluate("store.getState().newChat()")
  check('A new chat does not inherit Plan Mode', await evaluate("store.getState().agentMode==='default'"))
  await select('C', dirs.A)
  check('Returning to C restores its Plan Mode', await evaluate("store.getState().agentMode==='plan'"))
  await evaluate("(async()=>{await store.getState().refreshForkTargets();const entry=store.getState().forkTargets[0]?.entryId;if(!entry)throw Error('No fork target');await store.getState().forkFrom(entry);cases.FORK=store.getState().activeSessionFile})()")
  const forkFile = await evaluate('cases.FORK')
  check('Fork preserves the source chat cache', await evaluate('cases.C!==cases.FORK&&!!store.getState().threads[cases.C]'))
  await select('C', dirs.A); await evaluate('store.getState().ensureRuntime()')
  check('Source and fork have independent runtime identities', await evaluate("(async()=>{const a=await window.pi.runtime.request('get_state',{},undefined,undefined,cases.C);const b=await window.pi.runtime.request('get_state',{},undefined,undefined,cases.FORK);return a.sessionFile===cases.C&&b.sessionFile===cases.FORK})()"))

  await select('B', dirs.B); await evaluate('store.getState().ensureRuntime()')
  const saved = await evaluate("(async()=>{const p=(await window.pi.providers.list()).find(p=>p.id==='fixture');return store.getState().saveProvider({...p,selectedModel:'test-b'})})()")
  check('Provider save applies to the selected chat', saved.applied === true, saved.applyError)
  check('Provider save leaves another idle background model unchanged', await evaluate("(async()=>{const a=await window.pi.runtime.request('get_state',{},undefined,undefined,cases.C);const b=await window.pi.runtime.request('get_state',{},undefined,undefined,cases.B);return a.model.id==='test-a'&&b.model.id==='test-b'})()"))

  await select('C', dirs.A)
  await evaluate("window.dispatchEvent(new CustomEvent('pi:terminal-run',{detail:{command:'ping -n 8 127.0.0.1'}}))")
  await wait("document.querySelector('.terminal__output')?.textContent.includes('127.0.0.1')", 'terminal partial output')
  check('Terminal receives scoped output while its command is running', await evaluate("document.querySelector('.terminal__output')?.textContent.includes('127.0.0.1')&&!!document.querySelector('.terminal__actions .ghost-btn')"))
  await start('T', dirs.B); await until(() => live.has('T'), 'T streaming beside terminal')
  await evaluate("document.querySelector('.terminal__actions .ghost-btn').click()")
  await wait("!document.querySelector('.terminal__actions .ghost-btn')", 'terminal stop')
  check('Terminal stop after a view switch leaves the other chat running', live.has('T'))
  await evaluate('store.getState().stop()'); await idle('T')
  await evaluate("window.dispatchEvent(new CustomEvent('pi:toggle-terminal'))")

  await start('J', dirs.A); await wait('!!store.getState().threads[cases.J]?.uiRequest', 'J approval')
  await start('K', dirs.B); await wait('!!store.getState().threads[cases.K]?.uiRequest', 'K approval')
  check('Two conversations retain their own approval dialogs', await evaluate("store.getState().threads[cases.J].run.phase==='waiting_approval'&&store.getState().threads[cases.K].run.phase==='waiting_approval'"))
  await evaluate('store.getState().respondUi({confirmed:true})'); await until(() => live.has('K'), 'K approved tool')
  check('Approving K writes only K and leaves J blocked', existsSync(path.join(dirs.B, 'approval-K.txt')) && !existsSync(path.join(dirs.A, 'approval-J.txt')) && await evaluate('!!store.getState().threads[cases.J].uiRequest'))
  live.get('K').finish(); await idle('K')
  await select('J', dirs.A); await evaluate('store.getState().respondUi({confirmed:false})')
  await idle('J')
  check('Denying J settles without writing its file', !existsSync(path.join(dirs.A, 'approval-J.txt')))

  await start('G', dirs.A); await until(() => live.has('G'), 'G streaming')
  await start('H', dirs.B); await until(() => live.has('H'), 'H streaming')
  await evaluate(`store.getState().removeWorkspace({path:${JSON.stringify(dirs.A)}})`)
  check('Removing an inactive project stops its background writer', !(await evaluate('window.pi.runtime.has(cases.G)')))
  check('The removed project has no phantom streaming conversation', await evaluate('!store.getState().threads[cases.G].isStreaming&&store.getState().threads[cases.G].run.settled'))
  check('Removing A leaves B active and running', live.has('H') && await evaluate(`store.getState().workspace.path===${JSON.stringify(dirs.B)}`))
  await screenshot('final')
  const pids = process.platform === 'win32' ? activeCliPids() : [...stdout.matchAll(/\[pi-desktop:trace\] (\{[^\n]+\})/g)].map(match => { try { return JSON.parse(match[1]) } catch { return {} } }).filter(record => record.kind === 'boot').map(record => record.pid)
  await send('Browser.close').catch(() => {})
  await until(() => exitCode !== undefined, 'app exit', 10000)
  check('Electron exits cleanly while work is running', exitCode === 0, exitCode)
  await until(() => live.size === 0, 'all inference connections closed', 10000)
  check('Shutdown closes all active runtime connections', live.size === 0)
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  await until(() => pids.every(pid => !alive(pid)), 'CLI children exit', 10000)
  check('No bundled CLI process remains after exit', pids.length > 0 && pids.every(pid => !alive(pid)), pids)
  check('No renderer exceptions or destroyed-window errors', errors.length === 0 && !stderr.includes('Object has been destroyed') && !stderr.includes('uncaught exception'), errors)
  writeFileSync(path.join(output, 'validation.json'), JSON.stringify({ passed: true, checks, requests, errors, forkFile, executable: packagedExecutable, scope: 'Production renderer, real Electron main/preload, bundled Pi CLI and RPC, isolated profile/sessions, local deterministic SSE provider.' }, null, 2))
  console.log(JSON.stringify({ passed: true, checks: checks.length, requests: requests.length, output }))
} catch (error) {
  writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ error: error.stack, checks, requests, errors }, null, 2))
  console.error(error); console.log(JSON.stringify({ output })); process.exitCode = 1
} finally {
  if (exitCode === undefined && socket?.readyState === WebSocket.OPEN) await send('Browser.close').catch(() => {})
  socket?.close(); if (exitCode === undefined) child?.kill()
  server.closeAllConnections(); server.close()
  writeFileSync(path.join(output, 'stdout.log'), stdout); writeFileSync(path.join(output, 'stderr.log'), stderr)
}

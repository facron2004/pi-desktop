/**
 * Builds the Pi extension that adds the Swarm tools.
 *
 * Subagents are one task per process: they are spawned, run their briefing and
 * exit. A swarm worker is a named process that stays alive across turns, so the
 * lead conversation can ask it a follow-up without paying for a fresh context
 * and without losing what the worker already learned.
 *
 * The extension keeps the worker pool in this process, publishes a compact
 * snapshot through the existing `setStatus` channel (the Swarm panel reads it),
 * and relays each worker's tool approvals to the lead conversation one dialog
 * at a time, the same way the subagent bridge does.
 */

export interface SwarmExtensionOptions {
  /** The permission extension a worker loads; also its readiness signal. */
  permissionExtensionPath?: string
  permissionTitle?: string
  /** The parent's explicit project-safety choice. */
  trustProject?: boolean
  /** Fallback CLI when `process.argv[1]` is not a runnable script. */
  fallbackInvocation?: { command: string; prefixArgs: string[] }
  workspaceToolsExtensionPath?: string
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const THINKING_PATTERN = /^(?:off|minimal|low|medium|high|xhigh|max)$/

export function swarmExtension(options: SwarmExtensionOptions = {}): string {
  const permissionPath = options.permissionExtensionPath ?? ''
  const permissionTitle = options.permissionTitle ?? ''
  const trustProject = options.trustProject === true
  const fallbackInvocation = options.fallbackInvocation ?? { command: 'pi', prefixArgs: [] }
  const workspaceToolsPath = options.workspaceToolsExtensionPath ?? ''
  return `import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { Type } from 'typebox';

const MODEL_PATTERN = new RegExp(${JSON.stringify(MODEL_PATTERN.source)});
const THINKING_PATTERN = new RegExp(${JSON.stringify(THINKING_PATTERN.source)});
const MAX_WORKERS = 8;
// Turns, not workers: a swarm of eight idle workers costs nothing, while eight
// simultaneous model streams would swamp the machine and the provider budget.
const MAX_ACTIVE_TURNS = 4;
const MAX_QUEUE_PER_WORKER = 8;
const MAX_SNAPSHOT_OUTPUT_CHARS = 4000;
const MAX_PROGRESS_TEXT_CHARS = 2000;
const MAX_STDERR_CHARS = 32 * 1024;
const PROGRESS_THROTTLE_MS = 400;
const IDLE_RECYCLE_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const STATUS_KEY = 'pi-desktop-swarm';
const APPROVAL_EXTENSION_PATH = ${JSON.stringify(permissionPath)};
const WORKSPACE_TOOLS_EXTENSION_PATH = ${JSON.stringify(workspaceToolsPath)};
const PERMISSION_TITLE = ${JSON.stringify(permissionTitle)};
const FALLBACK_INVOCATION = ${JSON.stringify(fallbackInvocation)};

const WORKER_SYSTEM_PROMPT = 'You are a named worker in a swarm led by a desktop conversation. You stay alive across tasks: a follow-up from the lead refers to work you already did, so keep your own notes short and your context coherent. Work autonomously on the task you are given, inspect what you need, make the changes, verify them, and finish each turn with a concise factual report of what you did, what you changed and how you verified it. Never ask the user questions; report an external blocker explicitly instead. Do not delegate further.';

const workers = new Map();
let turnSequence = 0;
let uiQueue = Promise.resolve();
let activeTurns = 0;
const turnWaiters = [];
let lastPublishAt = 0;
let publishTimer;

function emptyUsage() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function bounded(text, limit) {
  if (typeof text !== 'string') return '';
  return text.length <= limit ? text : text.slice(0, limit);
}

function cleanName(value) {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(name) ? name : '';
}

function validModel(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && MODEL_PATTERN.test(text) ? text : '';
}

function validThinking(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && THINKING_PATTERN.test(text) ? text : '';
}

function normalizeTimeout(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, number));
}

function normalizeTools(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(entry => typeof entry === 'string')
    .map(entry => entry.trim())
    .filter(Boolean)
    .slice(0, 32);
}

function emptyWorker(name) {
  return {
    name,
    role: '',
    model: '',
    thinking: '',
    tools: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    status: 'starting',
    child: null,
    processAbort: undefined,
    decoder: undefined,
    buffer: '',
    bufferBytes: 0,
    stderr: '',
    permissionReady: false,
    permissionFailed: false,
    readyResolvers: [],
    pending: null,
    queue: [],
    output: '',
    task: '',
    progressText: '',
    activity: '',
    toolName: '',
    activeTools: new Map(),
    usage: emptyUsage(),
    startedAt: undefined,
    finishedAt: undefined,
    errorMessage: '',
    turnFailed: false,
    recycled: false,
    idleTimer: undefined,
    spawnPromise: undefined,
    ctx: undefined
  };
}

function snapshot(worker) {
  return {
    name: worker.name,
    role: worker.role,
    status: worker.status,
    model: worker.model || undefined,
    thinking: worker.thinking || undefined,
    task: worker.task,
    output: bounded(worker.output, MAX_SNAPSHOT_OUTPUT_CHARS),
    outputTruncated: worker.output.length > MAX_SNAPSHOT_OUTPUT_CHARS,
    progressText: worker.status === 'working' ? bounded(worker.progressText, MAX_PROGRESS_TEXT_CHARS) : '',
    activity: worker.status === 'working' ? worker.activity : undefined,
    toolName: worker.status === 'working' ? worker.toolName : undefined,
    startedAt: worker.startedAt,
    finishedAt: worker.finishedAt,
    recycled: worker.recycled === true || undefined,
    turns: worker.usage.turns,
    tokens: worker.usage.input + worker.usage.output + worker.usage.cacheRead + worker.usage.cacheWrite,
    cost: worker.usage.cost,
    errorMessage: worker.errorMessage || undefined
  };
}

function snapshots() {
  return [...workers.values()].map(snapshot);
}

function currentContext() {
  for (const worker of workers.values()) {
    if (worker.ctx) return worker.ctx;
  }
  return undefined;
}

function publishStatus(force, ctx = currentContext()) {
  if (!ctx) return;
  const at = Date.now();
  if (!force && at - lastPublishAt < PROGRESS_THROTTLE_MS) {
    if (!publishTimer) {
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        publishStatus(true);
      }, PROGRESS_THROTTLE_MS);
    }
    return;
  }
  lastPublishAt = at;
  try {
    ctx.ui.setStatus(STATUS_KEY, JSON.stringify(snapshots()));
  } catch {
    // A closed lead session only costs the live panel view.
  }
}

function releaseTurnSlot() {
  const next = turnWaiters.shift();
  if (next) {
    next(releaseTurnSlot);
    return;
  }
  activeTurns = Math.max(0, activeTurns - 1);
}

function acquireTurnSlot(signal) {
  if (signal.aborted) return Promise.resolve(undefined);
  if (activeTurns < MAX_ACTIVE_TURNS) {
    activeTurns += 1;
    return Promise.resolve(releaseTurnSlot);
  }
  return new Promise(resolve => {
    const assign = slot => {
      signal.removeEventListener('abort', cancel);
      resolve(slot);
    };
    const cancel = () => {
      const index = turnWaiters.indexOf(assign);
      if (index !== -1) turnWaiters.splice(index, 1);
      resolve(undefined);
    };
    turnWaiters.push(assign);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function piInvocation(args) {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
  return { command: FALLBACK_INVOCATION.command, args: [...FALLBACK_INVOCATION.prefixArgs, ...args] };
}

// Two tool calls can name the same cold worker at once; a second spawn while
// one is starting would orphan the first child, and both stdout streams would
// feed one worker state. Share the in-flight spawn instead.
function ensureWorker(worker, ctx) {
  if (worker.spawnPromise) return worker.spawnPromise;
  if (worker.child) return Promise.resolve(true);
  const spawned = spawnWorker(worker, ctx).finally(() => {
    if (worker.spawnPromise === spawned) worker.spawnPromise = undefined;
  });
  worker.spawnPromise = spawned;
  return spawned;
}

function killProcessTree(child) {
  if (!child) return;
  try {
    if (process.platform === 'win32') {
      if (child.pid) {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => {});
        return;
      }
      child.kill('SIGKILL');
      return;
    }
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function clearIdleTimer(worker) {
  if (worker.idleTimer) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = undefined;
  }
}

function detachWorkerProcess(worker) {
  clearIdleTimer(worker);
  const child = worker.child;
  worker.child = null;
  worker.permissionReady = false;
  worker.spawnPromise = undefined;
  worker.processAbort?.abort();
  worker.processAbort = undefined;
  return child;
}

function scheduleIdleRecycle(worker) {
  clearIdleTimer(worker);
  worker.idleTimer = setTimeout(() => {
    worker.idleTimer = undefined;
    if (worker.pending || !worker.child) return;
    // The record and its last output stay; only the context is released, so the
    // next task starts a fresh process with the same role and model.
    const child = detachWorkerProcess(worker);
    worker.recycled = true;
    worker.status = 'idle';
    killProcessTree(child);
    publishStatus(true);
  }, IDLE_RECYCLE_MS);
  if (typeof worker.idleTimer.unref === 'function') worker.idleTimer.unref();
}

function settleReady(worker, ready) {
  const resolvers = worker.readyResolvers;
  worker.readyResolvers = [];
  for (const resolve of resolvers) resolve(ready);
}

function writeRecord(worker, record) {
  const child = worker.child;
  if (!child || !child.stdin || !child.stdin.writable || child.stdin.destroyed) return false;
  try {
    child.stdin.write(JSON.stringify(record) + '\\n');
    return true;
  } catch {
    return false;
  }
}

function turnResult(worker) {
  return { status: worker.status, text: workerText(worker) };
}

function resolveTurn(turn, result) {
  if (turn.timer) clearTimeout(turn.timer);
  turn.removeAbortListener?.();
  turn.slot();
  turn.resolve(result);
}

function finishTurn(worker, ok, error) {
  const turn = worker.pending;
  if (!turn) return;
  worker.pending = null;
  worker.status = ok ? 'idle' : 'failed';
  worker.finishedAt = Date.now();
  worker.activity = '';
  worker.toolName = '';
  worker.activeTools.clear();
  worker.errorMessage = ok ? '' : (error || 'The worker failed.');
  if (ok) {
    worker.progressText = '';
    scheduleIdleRecycle(worker);
  }
  publishStatus(true);
  resolveTurn(turn, turnResult(worker));
  drainQueue(worker);
}

function drainQueue(worker) {
  if (worker.pending || worker.queue.length === 0) return;
  const next = worker.queue.shift();
  startTurn(worker, next.ctx, next.text, next.kind, next.onUpdate, next.signal).then(result => {
    if (!result.ok) {
      next.resolve({ status: 'failed', text: result.error });
      drainQueue(worker);
      return;
    }
    result.promise.then(next.resolve);
  }, () => {
    next.resolve({ status: 'failed', text: 'The queued worker task could not start.' });
    drainQueue(worker);
  });
}

function stopWorker(worker, status) {
  const child = detachWorkerProcess(worker);
  worker.status = status;
  worker.finishedAt = Date.now();
  worker.activity = '';
  worker.toolName = '';
  worker.activeTools.clear();
  killProcessTree(child);
  settleReady(worker, false);
  const turn = worker.pending;
  worker.pending = null;
  const result = turnResult(worker);
  worker.queue.splice(0).forEach(queued => queued.resolve(result));
  if (turn) resolveTurn(turn, result);
  publishStatus(true);
}

function onProcessExit(worker, child, message) {
  if (worker.child !== child) return;
  detachWorkerProcess(worker);
  settleReady(worker, false);
  if (worker.pending) {
    finishTurn(worker, false, message || worker.stderr.trim() || 'The worker process exited before the task settled.');
    return;
  }
  worker.status = 'failed';
  worker.errorMessage = message || worker.stderr.trim() || 'The worker process exited.';
  publishStatus(true);
}

function spawnWorker(worker, ctx) {
  worker.ctx = ctx;
  worker.status = 'starting';
  worker.errorMessage = '';
  worker.stderr = '';
  worker.progressText = '';
  worker.activity = 'Starting';
  worker.toolName = '';
  worker.recycled = false;
  worker.permissionReady = !APPROVAL_EXTENSION_PATH;
  worker.permissionFailed = false;
  clearIdleTimer(worker);
  publishStatus(true);

  const args = ['--mode', 'rpc', '--no-session', ${JSON.stringify(trustProject ? '--approve' : '--no-approve')}];
  if (WORKSPACE_TOOLS_EXTENSION_PATH) args.push('--extension', WORKSPACE_TOOLS_EXTENSION_PATH);
  if (APPROVAL_EXTENSION_PATH) args.push('--extension', APPROVAL_EXTENSION_PATH);
  if (worker.model) args.push('--model', worker.model);
  if (worker.thinking) args.push('--thinking', worker.thinking);
  if (worker.tools.length > 0) args.push('--tools', worker.tools.join(','));
  let systemPrompt = WORKER_SYSTEM_PROMPT + '\\n\\nYour worker name is "' + worker.name + '".';
  if (worker.role) systemPrompt += '\\n\\nRole:\\n' + worker.role;
  args.push('--append-system-prompt', systemPrompt);

  const invocation = piInvocation(args);
  const decoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');
  worker.decoder = decoder;
  worker.buffer = '';
  worker.bufferBytes = 0;

  let child;
  try {
    child = spawn(invocation.command, invocation.args, {
      cwd: ctx.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true
    });
  } catch (error) {
    worker.status = 'failed';
    worker.errorMessage = error instanceof Error ? error.message : String(error);
    publishStatus(true);
    return Promise.resolve(false);
  }
  worker.child = child;
  worker.processAbort = new AbortController();
  worker.startedAt = worker.startedAt || Date.now();
  worker.finishedAt = undefined;
  child.stdout.on('data', chunk => {
    if (worker.child === child) consumeStdout(worker, decoder.write(chunk), ctx);
  });
  child.stdout.on('end', () => {
    if (worker.child === child) consumeStdout(worker, decoder.end(), ctx);
  });
  child.stderr.on('data', chunk => {
    if (worker.child === child) worker.stderr = bounded(worker.stderr + stderrDecoder.write(chunk), MAX_STDERR_CHARS);
  });
  child.stderr.on('end', () => {
    if (worker.child === child) worker.stderr = bounded(worker.stderr + stderrDecoder.end(), MAX_STDERR_CHARS);
  });
  child.stdin.on('error', () => {});
  child.on('error', error => {
    onProcessExit(worker, child, error instanceof Error ? error.message : String(error));
  });
  child.on('close', () => onProcessExit(worker, child, ''));

  return new Promise(resolve => {
    if (worker.permissionReady) {
      worker.status = 'idle';
      worker.activity = '';
      publishStatus(true);
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      if (worker.permissionReady || worker.child !== child) return;
      worker.permissionFailed = true;
      worker.errorMessage = 'Pi did not load its tool approval controls.';
      stopWorker(worker, 'failed');
      settleReady(worker, false);
      resolve(false);
    }, 30_000);
    if (typeof timer.unref === 'function') timer.unref();
    worker.readyResolvers.push(ok => {
      clearTimeout(timer);
      resolve(ok);
    });
  });
}

function startTurn(worker, ctx, text, kind, onUpdate, signal) {
  if (!ctx) return Promise.resolve({ ok: false, error: 'The lead session is not available.' });
  // An AbortSignal that fired while the turn waited does not fire again, so
  // a queued task whose run was stopped must not still run to completion.
  if (signal && signal.aborted) {
    return Promise.resolve({ ok: false, error: 'The task was cancelled before it started.' });
  }
  if (worker.pending) {
    if (worker.queue.length >= MAX_QUEUE_PER_WORKER) {
      return Promise.resolve({ ok: false, error: 'Worker "' + worker.name + '" has too many queued tasks.' });
    }
    return new Promise(resolve => {
      worker.queue.push({ ctx, text, kind, onUpdate, signal, resolve });
    }).then(result => ({ ok: true, promise: Promise.resolve(result) }));
  }
  const ensure = ensureWorker(worker, ctx);
  const processSignal = worker.processAbort?.signal;
  return ensure.then(ready => {
    if (!ready || !processSignal) {
      return { ok: false, error: 'Worker "' + worker.name + '" could not start: ' + (worker.errorMessage || 'unknown error') };
    }
    const dispatchSignal = signal ? AbortSignal.any([signal, processSignal]) : processSignal;
    return acquireTurnSlot(dispatchSignal).then(slot => {
      if (!slot || dispatchSignal.aborted) {
        slot?.();
        return { ok: false, error: 'The task was cancelled before it started.' };
      }
      if (worker.pending) {
        slot();
        return { ok: false, error: 'Worker "' + worker.name + '" started another task first.' };
      }
      if (worker.idleTimer) {
        clearTimeout(worker.idleTimer);
        worker.idleTimer = undefined;
      }
      const turn = {
        id: 'swarm-' + worker.name + '-' + (++turnSequence),
        text,
        kind,
        startedAt: Date.now(),
        timer: undefined,
        slot,
        resolve: undefined,
        promise: undefined,
        removeAbortListener: undefined
      };
      turn.promise = new Promise(resolve => { turn.resolve = resolve; });
      worker.pending = turn;
      worker.status = 'working';
      worker.task = text;
      worker.progressText = '';
      worker.activity = 'Starting';
      worker.toolName = '';
      worker.finishedAt = undefined;
      worker.output = '';
      worker.errorMessage = '';
      worker.turnFailed = false;
      publishStatus(true);
      const prefix = kind === 'message' ? 'Message from the lead: ' : 'Task: ';
      if (!writeRecord(worker, { type: 'prompt', id: turn.id, message: prefix + text })) {
        finishTurn(worker, false, 'The worker process is not accepting input.');
        return { ok: false, error: 'The worker process is not accepting input.' };
      }
      turn.timer = setTimeout(() => {
        if (!worker.pending || worker.pending !== turn) return;
        // The error is set before the turn is settled so the snapshot the
        // blocked tool call receives explains why the worker stopped.
        worker.errorMessage = 'The worker timed out after ' + worker.timeoutMs + ' ms.';
        stopWorker(worker, 'failed');
      }, worker.timeoutMs);
      if (typeof turn.timer.unref === 'function') turn.timer.unref();
      if (signal) {
        const abort = () => {
          if (worker.pending === turn) stopWorker(worker, 'stopped');
        };
        signal.addEventListener('abort', abort, { once: true });
        turn.removeAbortListener = () => signal.removeEventListener('abort', abort);
      }
      if (onUpdate) {
        try {
          onUpdate({
            content: [{ type: 'text', text: 'Worker "' + worker.name + '" started.' }],
            details: { workers: snapshots() }
          });
        } catch {
          // Progress reporting must never detach a live worker.
        }
      }
      return { ok: true, promise: turn.promise };
    });
  });
}

function finalAssistantText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const part of message.content) {
    if (part && part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
  }
  return parts.join('');
}

function forwardDialog(worker, event, ctx) {
  const signal = worker.processAbort.signal;
  const respond = record => {
    if (!signal.aborted) writeRecord(worker, record);
  };
  const run = async () => {
    if (signal.aborted) return;
    if (!ctx || !ctx.ui) {
      respond({ type: 'extension_ui_response', id: event.id, confirmed: false, cancelled: true });
      return;
    }
    try {
      let value;
      const options = { signal, ...(event.timeout ? { timeout: event.timeout } : {}) };
      if (event.method === 'confirm') {
        let approval;
        try { approval = JSON.parse(event.message || ''); } catch {}
        if (approval && typeof approval === 'object' && !Array.isArray(approval)) {
          approval.cwd = ctx.cwd;
          value = await ctx.ui.confirm(event.title || PERMISSION_TITLE, JSON.stringify(approval), options);
        } else {
          value = await ctx.ui.confirm(event.title || '', event.message || '', options);
        }
        respond({ type: 'extension_ui_response', id: event.id, confirmed: Boolean(value), ...(value === undefined ? { cancelled: true } : {}) });
        return;
      }
      if (event.method === 'select') {
        value = await ctx.ui.select(event.title || '', Array.isArray(event.options) ? event.options : [], options);
      } else if (event.method === 'input') {
        value = await ctx.ui.input(event.title || '', event.placeholder || '', options);
      } else {
        value = await ctx.ui.editor(event.title || '', event.prefill || '');
      }
      if (value === undefined) respond({ type: 'extension_ui_response', id: event.id, cancelled: true });
      else respond({ type: 'extension_ui_response', id: event.id, value });
    } catch {
      respond({ type: 'extension_ui_response', id: event.id, confirmed: false, cancelled: true });
    }
  };
  const queued = uiQueue.then(run, run);
  uiQueue = queued.then(() => {}, () => {});
}

/** A turn ends the same way the desktop app's own process ends one: on agent_settled. */
function handleEvent(worker, event, ctx) {
  if (event.type === 'extension_ui_request') {
    if (event.method === 'setStatus') {
      if (event.statusKey === PERMISSION_TITLE && event.statusText === 'ready') {
        worker.permissionReady = true;
        if (worker.status === 'starting') {
          worker.status = 'idle';
          worker.activity = '';
        }
        publishStatus(true);
        settleReady(worker, true);
      }
      return;
    }
    if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      forwardDialog(worker, event, ctx);
    }
    return;
  }
  const turn = worker.pending;
  if (event.type === 'response' && turn && event.id === turn.id) {
    if (!event.success) finishTurn(worker, false, String(event.error || 'Pi rejected the worker prompt'));
    return;
  }
  if (event.type === 'message_start' && event.message && event.message.role === 'assistant') {
    worker.progressText = '';
    worker.activity = 'Working';
    publishStatus(true);
    return;
  }
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent;
    if (!update) return;
    if (update.type === 'thinking_start') {
      worker.activity = 'Thinking';
      publishStatus(true);
      return;
    }
    if (update.type === 'text_start') {
      worker.activity = 'Responding';
      publishStatus(true);
      return;
    }
    if (update.type === 'text_delta' && typeof update.delta === 'string') {
      worker.progressText = (worker.progressText + update.delta).slice(-MAX_PROGRESS_TEXT_CHARS);
      publishStatus(false);
    }
    return;
  }
  if (event.type === 'tool_execution_start') {
    if (event.toolCallId) worker.activeTools.set(event.toolCallId, event.toolName || 'tool');
    worker.activity = 'Running a tool';
    worker.toolName = [...worker.activeTools.values()].join(', ');
    publishStatus(true);
    return;
  }
  if (event.type === 'tool_execution_end') {
    if (event.toolCallId) worker.activeTools.delete(event.toolCallId);
    worker.activity = worker.activeTools.size ? 'Running a tool' : 'Working';
    worker.toolName = worker.activeTools.size ? [...worker.activeTools.values()].join(', ') : '';
    publishStatus(true);
    return;
  }
  if (event.type === 'message_end' && event.message && event.message.role === 'assistant') {
    const message = event.message;
    const text = finalAssistantText(message);
    if (text.trim()) worker.output = text;
    worker.usage.turns += 1;
    const usage = message.usage;
    if (usage) {
      worker.usage.input += usage.input || 0;
      worker.usage.output += usage.output || 0;
      worker.usage.cacheRead += usage.cacheRead || 0;
      worker.usage.cacheWrite += usage.cacheWrite || 0;
      worker.usage.cost += usage.cost && typeof usage.cost.total === 'number' ? usage.cost.total : 0;
    }
    if (!worker.model && typeof message.model === 'string') worker.model = message.model;
    if (typeof message.errorMessage === 'string' && message.errorMessage) {
      worker.turnFailed = true;
      worker.errorMessage = bounded(message.errorMessage, 2000);
    } else if (message.stopReason === 'error') {
      worker.turnFailed = true;
      worker.errorMessage = worker.errorMessage || 'The worker stopped with an error.';
    }
    publishStatus(true);
    return;
  }
  if (event.type === 'agent_settled') finishTurn(worker, !worker.turnFailed, worker.errorMessage);
}

function consumeStdout(worker, text, ctx) {
  if (!text) return;
  worker.buffer += text;
  worker.bufferBytes += Buffer.byteLength(text, 'utf8');
  if (worker.bufferBytes > 64 * 1024 * 1024) {
    worker.buffer = '';
    worker.bufferBytes = 0;
    worker.errorMessage = 'A worker RPC record exceeded the 64 MB limit.';
    stopWorker(worker, 'failed');
    return;
  }
  let start = 0;
  while (true) {
    const newline = worker.buffer.indexOf('\\n', start);
    if (newline === -1) {
      if (start > 0) {
        worker.buffer = worker.buffer.slice(start);
        worker.bufferBytes = Buffer.byteLength(worker.buffer, 'utf8');
      }
      return;
    }
    const line = worker.buffer.slice(start, newline).replace(/\\r$/, '');
    start = newline + 1;
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    handleEvent(worker, event, ctx);
  }
}

function outputOf(worker) {
  if (worker.status === 'failed') {
    const detail = worker.errorMessage || worker.stderr.trim();
    return detail ? 'Worker ' + worker.name + ' failed: ' + detail : 'Worker ' + worker.name + ' failed.';
  }
  return worker.output || '(no output)';
}

function workerText(worker) {
  return '[' + worker.name + '] ' + worker.status + '\\n\\n' + outputOf(worker);
}

export default function (pi) {
  pi.registerTool({
    name: 'swarm_spawn',
    label: 'Spawn swarm worker',
    description: 'Create or update a named worker that stays alive across tasks. A worker keeps its context between turns, so a later follow-up can build on what it already did. Up to 8 workers may exist; at most 4 turns run at once.',
    promptSnippet: 'Create a named worker that stays alive across tasks',
    promptGuidelines: [
      'Use swarm_spawn to create a small named team before starting multi-step work: one worker per coherent role (for example researcher, coder, reviewer), with a role that says what it owns.',
      'Give every worker a short lowercase name. Reuse the same name for follow-up work so the worker keeps its context instead of starting over.',
      'Do not spawn more workers than the work needs; a swarm of two focused workers beats six idle ones.'
    ],
    defaultActive: true,
    parameters: Type.Object({
      name: Type.String({ description: 'Short lowercase worker name (letters, digits, dashes).' }),
      role: Type.Optional(Type.String({ description: 'What this worker owns: its responsibilities, constraints and definition of done.' })),
      model: Type.Optional(Type.String({ description: 'Model override for this worker, for example provider/model.' })),
      thinking: Type.Optional(Type.String({ description: 'Thinking level override for this worker.' })),
      tools: Type.Optional(Type.Array(Type.String(), { description: 'Tool allowlist for this worker. Omit to inherit the lead tools.' })),
      timeoutMs: Type.Optional(Type.Number({ description: 'Per-turn wall-clock timeout in milliseconds (1000-86400000, default 1800000).' }))
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const name = cleanName(input.name);
      if (!name) {
        return { content: [{ type: 'text', text: 'Worker names are short lowercase slugs: letters, digits and dashes only.' }], details: { workers: snapshots() }, isError: true };
      }
      let worker = workers.get(name);
      if (!worker && workers.size >= MAX_WORKERS) {
        return { content: [{ type: 'text', text: 'The swarm already has ' + workers.size + ' workers, the maximum. Disband one before adding another.' }], details: { workers: snapshots() }, isError: true };
      }
      if (!worker) {
        worker = emptyWorker(name);
        workers.set(name, worker);
      }
      if (worker.status === 'working') {
        return { content: [{ type: 'text', text: 'Worker "' + name + '" is working. Wait for its turn or use swarm_collect first.' }], details: { workers: snapshots() }, isError: true };
      }
      worker.ctx = ctx;
      if (typeof input.role === 'string' && input.role.trim()) worker.role = input.role.trim().slice(0, 8000);
      worker.model = validModel(input.model) || worker.model;
      worker.thinking = validThinking(input.thinking) || worker.thinking;
      if (Array.isArray(input.tools)) worker.tools = normalizeTools(input.tools);
      if (input.timeoutMs !== undefined) worker.timeoutMs = normalizeTimeout(input.timeoutMs);
      const ready = await ensureWorker(worker, ctx);
      if (!ready) {
        return { content: [{ type: 'text', text: 'Worker "' + name + '" could not start: ' + (worker.errorMessage || 'unknown error') }], details: { workers: snapshots() }, isError: true };
      }
      return { content: [{ type: 'text', text: 'Worker "' + name + '" is ready' + (worker.role ? ' — ' + worker.role.slice(0, 160) : '') + '. Keep its name for follow-up tasks.' }], details: { workers: snapshots() } };
    }
  });

  pi.registerTool({
    name: 'swarm_task',
    label: 'Assign swarm task',
    description: 'Give a named worker one self-contained task. By default the call waits for the turn to finish and returns the worker report; wait=false dispatches it in the background for swarm_collect.',
    promptSnippet: 'Assign a task to a named worker',
    promptGuidelines: [
      'Use swarm_task with wait=false when several workers can work at the same time, then call swarm_collect to gather the reports.',
      'Write each assignment as a complete briefing: goal, exact paths or data, constraints and definition of done. A worker keeps its past context but you must still name everything this turn needs.'
    ],
    defaultActive: true,
    parameters: Type.Object({
      name: Type.String({ description: 'Worker name created with swarm_spawn.' }),
      task: Type.String({ description: 'Complete briefing for this turn: goal, exact paths or data, constraints and definition of done.' }),
      wait: Type.Optional(Type.Boolean({ description: 'Wait for the turn to finish (default true). Set false for background dispatch.' }))
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    async execute(_id, input, signal, onUpdate, ctx) {
      const name = cleanName(input.name);
      const worker = name ? workers.get(name) : undefined;
      if (!worker) {
        return { content: [{ type: 'text', text: 'No worker named "' + String(input.name) + '". Spawn it first with swarm_spawn. Running workers: ' + ([...workers.keys()].join(', ') || 'none') }], details: { workers: snapshots() }, isError: true };
      }
      if (typeof input.task !== 'string' || !input.task.trim()) {
        return { content: [{ type: 'text', text: 'Provide the task text.' }], details: { workers: snapshots() }, isError: true };
      }
      const started = await startTurn(worker, ctx, input.task.trim(), 'task', onUpdate, signal);
      if (!started.ok) {
        return { content: [{ type: 'text', text: started.error }], details: { workers: snapshots() }, isError: true };
      }
      if (input.wait === false) {
        return { content: [{ type: 'text', text: 'Dispatched to "' + name + '". Use swarm_collect when you need the report.' }], details: { workers: snapshots() } };
      }
      const finished = await started.promise;
      return { content: [{ type: 'text', text: finished.text }], details: { workers: snapshots() }, isError: finished.status !== 'idle' };
    }
  });

  pi.registerTool({
    name: 'swarm_collect',
    label: 'Collect swarm results',
    description: 'Wait for the running turns of named workers (or every worker) and return their reports.',
    promptSnippet: 'Collect the reports of running workers',
    parameters: Type.Object({
      names: Type.Optional(Type.Array(Type.String(), { description: 'Workers to collect. Omit for every worker.' }))
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    defaultActive: true,
    async execute(_id, input, _signal, onUpdate, ctx) {
      const requested = Array.isArray(input.names) ? input.names.map(cleanName).filter(Boolean) : [];
      const targets = requested.length
        ? requested.map(name => workers.get(name)).filter(Boolean)
        : [...workers.values()];
      if (targets.length === 0) {
        return { content: [{ type: 'text', text: 'The swarm has no workers.' }], details: { workers: snapshots() } };
      }
      const reports = await Promise.all(targets.map(worker =>
        worker.pending?.promise.then(result => result.text) ?? workerText(worker)
      ));
      return { content: [{ type: 'text', text: reports.join('\\n\\n---\\n\\n') }], details: { workers: snapshots() } };
    }
  });

  pi.registerTool({
    name: 'swarm_message',
    label: 'Message swarm worker',
    description: 'Send a follow-up to a named worker without treating it as a new task. The worker keeps the context of its previous turns.',
    promptSnippet: 'Send a follow-up to a worker',
    defaultActive: true,
    parameters: Type.Object({
      name: Type.String({ description: 'Worker name created with swarm_spawn.' }),
      message: Type.String({ description: 'The follow-up: a correction, extra detail, or the next step of the same piece of work.' }),
      wait: Type.Optional(Type.Boolean({ description: 'Wait for the reply (default true).' }))
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async execute(_id, input, signal, onUpdate, ctx) {
      const name = cleanName(input.name);
      const worker = name ? workers.get(name) : undefined;
      if (!worker) {
        return { content: [{ type: 'text', text: 'No worker named "' + String(input.name) + '".' }], details: { workers: snapshots() }, isError: true };
      }
      if (typeof input.message !== 'string' || !input.message.trim()) {
        return { content: [{ type: 'text', text: 'Provide the message text.' }], details: { workers: snapshots() }, isError: true };
      }
      const started = await startTurn(worker, ctx, input.message.trim(), 'message', onUpdate, signal);
      if (!started.ok) {
        return { content: [{ type: 'text', text: started.error }], details: { workers: snapshots() }, isError: true };
      }
      if (input.wait === false) {
        return { content: [{ type: 'text', text: 'Message queued for "' + name + '".' }], details: { workers: snapshots() } };
      }
      const finished = await started.promise;
      return { content: [{ type: 'text', text: finished.text }], details: { workers: snapshots() }, isError: finished.status !== 'idle' };
    }
  });

  pi.registerTool({
    name: 'swarm_status',
    label: 'Swarm status',
    description: 'List every worker with its status, last task and token usage.',
    promptSnippet: 'Inspect the worker team',
    defaultActive: true,
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute() {
      const list = snapshots();
      if (list.length === 0) {
        return { content: [{ type: 'text', text: 'The swarm has no workers yet. Create one with swarm_spawn.' }], details: { workers: [] } };
      }
      const lines = list.map(worker => '- ' + worker.name + ' · ' + worker.status
        + (worker.task ? ' · ' + worker.task.replace(/\\s+/g, ' ').slice(0, 80) : '')
        + (worker.tokens ? ' · ' + worker.tokens + ' tokens' : ''));
      return { content: [{ type: 'text', text: 'Workers (' + list.length + '):\\n' + lines.join('\\n') }], details: { workers: list } };
    }
  });

  pi.registerTool({
    name: 'swarm_disband',
    label: 'Disband swarm worker',
    description: 'Stop one worker, or the whole team, and release its process.',
    promptSnippet: 'End a worker or the whole team',
    defaultActive: true,
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: 'Worker to disband. Omit for every worker.' }))
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      const name = cleanName(input.name);
      if (input.name !== undefined && !name) {
        return { content: [{ type: 'text', text: 'Provide a valid worker name or omit it to disband the whole team.' }], details: { workers: snapshots() }, isError: true };
      }
      if (name) {
        const worker = workers.get(name);
        if (!worker) {
          return { content: [{ type: 'text', text: 'No worker named "' + name + '".' }], details: { workers: snapshots() }, isError: true };
        }
        stopWorker(worker, 'stopped');
        workers.delete(name);
        publishStatus(true, ctx);
        return { content: [{ type: 'text', text: 'Worker "' + name + '" was disbanded.' }], details: { workers: snapshots() } };
      }
      const names = [...workers.keys()];
      for (const worker of workers.values()) stopWorker(worker, 'stopped');
      workers.clear();
      publishStatus(true, ctx);
      return { content: [{ type: 'text', text: names.length ? 'Disbanded ' + names.length + ' worker(s): ' + names.join(', ') : 'The swarm had no workers.' }], details: { workers: [] } };
    }
  });

  // The lead turn is blocked inside swarm_task, so the panel stops a worker the
  // same way it stops a subagent task: an extension command reaches Pi while
  // the session is streaming.
  pi.registerCommand('desktop-swarm-stop', {
    description: 'Stop one swarm worker by name',
    handler: async value => {
      const name = cleanName(value);
      if (!name) throw new Error('Usage: /desktop-swarm-stop <worker>');
      const worker = workers.get(name);
      if (!worker) throw new Error('No swarm worker named ' + name);
      stopWorker(worker, 'stopped');
    }
  });

  const stopOnExit = () => {
    for (const worker of workers.values()) killProcessTree(worker.child);
  };
  process.on('exit', stopOnExit);
  pi.on('session_shutdown', () => {
    process.removeListener('exit', stopOnExit);
    if (publishTimer) clearTimeout(publishTimer);
    // The roster describes worker processes that die with this one, so it is
    // retracted explicitly: a client that kept the last snapshot would show
    // workers as running with a duration that only grows.
    const ctx = currentContext();
    for (const worker of workers.values()) stopWorker(worker, 'stopped');
    workers.clear();
    publishStatus(true, ctx);
  });
}
`
}

/** Settings choices for a spawned subagent; an absent one follows the conversation. */
export interface SubagentDefaults {
  /** A catalog id in `provider/id` form, where the id may itself hold slashes. Anything else is dropped. */
  model?: string
  /** One of Pi's thinking levels. */
  thinking?: string
}

/**
 * Both values end up in the argv of a spawned process, so only the shapes the model
 * catalog and Pi itself use are interpolated; a stray string from the settings file
 * becomes the empty string, which the extension reads as "follow the session".
 *
 * The id half keeps its slashes on purpose: a gateway provider's model id is
 * `vendor/model`, and the catalog splits a saved spec on its FIRST slash only
 * (`resolveSavedModel`). Rejecting them here would make a model the picker can
 * choose land in the settings file and then do nothing.
 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const THINKING_PATTERN = /^(?:off|minimal|low|medium|high|xhigh|max)$/

function bounded(value: string | undefined, pattern: RegExp): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return pattern.test(text) ? text : ''
}

/**
 * Builds the Pi extension that adds the `subagent` tool.
 *
 * The app writes this source to a per-process `.mjs` file next to the other
 * runtime extensions, so it stays a self-contained ESM module: no imports
 * from the main process and no generated TypeScript.
 *
 * `defaults` come from Settings. A call that names its own model or thinking level
 * still wins; the defaults only replace the dispatching session's live values.
 * `trustProject` carries the parent's explicit project-safety choice; it defaults
 * to false so a caller that omits it never trusts project-local resources.
 */
export function subagentExtension(
  defaults: SubagentDefaults = {},
  permissionExtensionPath = '',
  permissionTitle = '',
  trustProject = false,
  fallbackInvocation: { command: string; prefixArgs: string[] } = { command: 'pi', prefixArgs: [] }
): string {
  const settingsModel = bounded(defaults.model, MODEL_PATTERN)
  const settingsThinking = bounded(defaults.thinking, THINKING_PATTERN)
return `import { execFile, spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { Type } from 'typebox';

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_SUBAGENT_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_SUBAGENT_OUTPUT_CHARS = 256 * 1024;
const MAX_SUBAGENT_ERROR_CHARS = 64 * 1024;
const MAX_SUBAGENT_STDERR_CHARS = 256 * 1024;
const MAX_SUBAGENT_PROGRESS_OUTPUT_CHARS = 16 * 1024;
const MAX_SUBAGENT_TRANSCRIPT_MESSAGES = 200;
const MAX_SUBAGENT_TRANSCRIPT_BYTES = 256 * 1024;
const APPROVAL_EXTENSION_PATH = ${JSON.stringify(permissionExtensionPath)};
const PERMISSION_TITLE = ${JSON.stringify(permissionTitle)};
const FALLBACK_INVOCATION = ${JSON.stringify(fallbackInvocation)};
let uiQueue = Promise.resolve();
let activeSubagentCount = 0;
const subagentWaiters = [];

function releaseSubagentSlot() {
  activeSubagentCount -= 1;
  while (subagentWaiters.length > 0) {
    const waiter = subagentWaiters.shift();
    if (waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort);
    if (waiter.signal && waiter.signal.aborted) {
      waiter.resolve(() => {});
      continue;
    }
    activeSubagentCount += 1;
    waiter.resolve(releaseSubagentSlot);
    return;
  }
}

function acquireSubagentSlot(signal) {
  if (signal && signal.aborted) return Promise.resolve(() => {});
  if (activeSubagentCount < MAX_CONCURRENCY) {
    activeSubagentCount += 1;
    return Promise.resolve(releaseSubagentSlot);
  }
  return new Promise(resolve => {
    const waiter = { resolve, signal, abort: undefined };
    if (signal) {
      waiter.abort = () => {
        const index = subagentWaiters.indexOf(waiter);
        if (index === -1) return;
        subagentWaiters.splice(index, 1);
        signal.removeEventListener('abort', waiter.abort);
        resolve(() => {});
      };
    }
    subagentWaiters.push(waiter);
    if (signal) {
      signal.addEventListener('abort', waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    }
  });
}

async function runWithSubagentSlot(defaultCwd, params, task, cwd, signal, onUpdate, ctx) {
  const release = await acquireSubagentSlot(signal);
  try {
    return await runSubagent(defaultCwd, params, task, cwd, signal, onUpdate, ctx);
  } finally {
    release();
  }
}
// Settings for this process. '' means the setting is unset and the call follows
// the dispatching session, exactly as it did before the setting existed.
const SETTINGS_MODEL = ${JSON.stringify(settingsModel)};
const SETTINGS_THINKING = ${JSON.stringify(settingsThinking)};
const MODEL_PATTERN = new RegExp(${JSON.stringify(MODEL_PATTERN.source)});
const THINKING_PATTERN = new RegExp(${JSON.stringify(THINKING_PATTERN.source)});
const SUBAGENT_SYSTEM_PROMPT = 'You are a subagent working on one self-contained task. Work autonomously, inspect anything you need, make the requested changes, and finish with a concise report of what you did and how you verified it. Never ask the user questions; if an external blocker prevents completion, report it.';

function validOverride(value, pattern) {
  const requested = typeof value === 'string' ? value.trim() : '';
  return requested && pattern.test(requested) ? requested : '';
}

const TaskItem = Type.Object({
  task: Type.String({ description: 'Task for this subagent' }),
  cwd: Type.Optional(Type.String({ description: 'Working directory for this subagent' }))
});

const SubagentParams = Type.Object({
  task: Type.Optional(Type.String({ description: 'A single task to delegate' })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: 'Parallel tasks to delegate (max 8, concurrency 4)' })),
  cwd: Type.Optional(Type.String({ description: 'Working directory for the subagent process' })),
  model: Type.Optional(Type.String({ description: 'Model override, for example provider/model' })),
  thinking: Type.Optional(Type.String({ description: 'Thinking level override' })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Allowlist of tool names for the subagent' }))
});

function piInvocation(args) {
  const currentScript = process.argv[1];
  if (currentScript && existsSync(currentScript)) return { command: process.execPath, args: [currentScript, ...args] };
  return { command: FALLBACK_INVOCATION.command, args: [...FALLBACK_INVOCATION.prefixArgs, ...args] };
}

function safeWorkingDirectory(defaultCwd, requestedCwd) {
  try {
    const root = realpathSync(defaultCwd);
    const target = realpathSync(requestedCwd ? path.resolve(defaultCwd, requestedCwd) : defaultCwd);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
    return statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

function emptyUsage() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

function finalAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    if (!Array.isArray(message.content)) return '';
    const notice = '\\n[Subagent final output truncated at 262144 characters]';
    const contentLimit = MAX_SUBAGENT_OUTPUT_CHARS - notice.length;
    const parts = [];
    let length = 0;
    let truncated = false;
    for (const part of message.content) {
      if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
      const remaining = contentLimit - length;
      if (part.text.length <= remaining) {
        parts.push(part.text);
        length += part.text.length;
        continue;
      }
      let end = 0;
      for (const character of part.text) {
        if (end + character.length > remaining) break;
        end += character.length;
      }
      if (end > 0) parts.push(part.text.slice(0, end));
      truncated = true;
      break;
    }
    return parts.join('') + (truncated ? notice : '');
  }
  return '';
}

function boundedError(text) {
  const notice = '\\n[Subagent error truncated at 65536 characters]';
  if (text.length <= MAX_SUBAGENT_ERROR_CHARS) return text;
  const contentLimit = MAX_SUBAGENT_ERROR_CHARS - notice.length;
  let end = 0;
  for (const character of text) {
    if (end + character.length > contentLimit) break;
    end += character.length;
  }
  return text.slice(0, end) + notice;
}

function progressOutput(text) {
  if (text.length <= MAX_SUBAGENT_PROGRESS_OUTPUT_CHARS) return text;
  return text.slice(0, MAX_SUBAGENT_PROGRESS_OUTPUT_CHARS) + '\\n[Progress output truncated; see the final result below]';
}

function failedResult(result) {
  return result.exitCode !== 0 || result.aborted || result.stopReason === 'error' || result.stopReason === 'aborted';
}

function resultOutput(result) {
  if (failedResult(result)) return result.errorMessage || result.stderr || result.output || '(no output)';
  return result.output || '(no output)';
}

function buildArgs(params) {
  const args = ['--mode', 'rpc', '--no-session', ${JSON.stringify(trustProject ? '--approve' : '--no-approve')}];
  if (APPROVAL_EXTENSION_PATH) args.push('--extension', APPROVAL_EXTENSION_PATH);
  if (params.model) args.push('--model', params.model);
  if (params.thinking) args.push('--thinking', params.thinking);
  if (Array.isArray(params.tools) && params.tools.length > 0) args.push('--tools', params.tools.join(','));
  args.push('--append-system-prompt', SUBAGENT_SYSTEM_PROMPT);
  return args;
}

function runSubagent(defaultCwd, params, task, cwd, signal, onUpdate, ctx) {
  const workingDirectory = safeWorkingDirectory(defaultCwd, cwd);
  const result = {
    task,
    cwd: workingDirectory || defaultCwd,
    exitCode: -1,
    output: '',
    stderr: '',
    usage: emptyUsage(),
    model: params.model,
    stopReason: undefined,
    errorMessage: undefined,
    aborted: false,
    status: 'queued',
    startedAt: undefined,
    finishedAt: undefined,
    activity: undefined,
    toolName: undefined,
    messages: [],
    messagesTruncated: false
  };
  if (!workingDirectory) {
    result.exitCode = 1;
    result.errorMessage = 'Subagent working directory must be an existing folder inside the current project.';
    result.stopReason = 'error';
    result.status = 'failed';
    result.finishedAt = Date.now();
    return Promise.resolve(result);
  }
  const messages = [];
  let transcriptBytes = 0;
  const emitUpdate = () => {
    if (!onUpdate) return;
    const output = result.output ? progressOutput(result.output) : '';
    onUpdate({
      content: [{ type: 'text', text: output || '(running...)' }],
      details: { mode: 'single', results: [{ ...result, output, usage: { ...result.usage } }] }
    });
  };
  return new Promise(resolve => {
    if (signal?.aborted) {
      result.aborted = true;
      result.status = 'aborted';
      result.exitCode = 1;
      result.errorMessage = 'Subagent was aborted';
      result.finishedAt = Date.now();
      emitUpdate();
      resolve(result);
      return;
    }
    let settled = false;
    let agentSettled = false;
    let wasAborted = false;
    let killTimer;
    let approvalReadyTimer;
    let permissionReady = !APPROVAL_EXTENSION_PATH;
    let permissionFailed = false;
    let promptSent = false;
    let stdoutBuffer = '';
    let stdoutBufferBytes = 0;
    let protocolFailed = false;
    let rejectOversizedRecord = () => {};
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const invocation = piInvocation(buildArgs(params));
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: workingDirectory,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      });
    } catch (error) {
      result.exitCode = 1;
      result.errorMessage = boundedError(error instanceof Error ? error.message : String(error));
      result.status = 'failed';
      result.finishedAt = Date.now();
      emitUpdate();
      resolve(result);
      return;
    }
    result.status = 'running';
    result.startedAt = Date.now();
    result.activity = 'Starting';
    const signalProcessGroup = signal => {
      try {
        if (!child.pid) throw new Error('The subagent process has no pid');
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
    };
    const killProcessTree = (signal, force = false) => {
      if (process.platform !== 'win32') {
        signalProcessGroup(signal);
        return Promise.resolve();
      }
      if (!child.pid) {
        try { child.kill(signal); } catch {}
        return Promise.resolve();
      }
      return new Promise(resolve => {
        const args = ['/PID', String(child.pid), '/T'];
        if (force) args.push('/F');
        execFile('taskkill.exe', args, {
          windowsHide: true,
          timeout: 5000
        }, error => {
          if (error) {
            if (!force) {
              void killProcessTree(signal, true).then(resolve, () => {
                try { child.kill(signal); } catch {}
                resolve();
              });
              return;
            }
            try { child.kill('SIGKILL'); } catch {}
          }
          resolve();
        });
      });
    };
    let treeKillPending;
    const finish = code => {
      if (settled) return;
      settled = true;
      if (approvalReadyTimer) clearTimeout(approvalReadyTimer);
      if (killTimer && wasAborted && process.platform !== 'win32') {
        signalProcessGroup('SIGKILL');
        clearTimeout(killTimer);
      }
      result.exitCode = typeof code === 'number' ? code : 1;
      if (APPROVAL_EXTENSION_PATH && !permissionReady && !wasAborted) {
        result.errorMessage = result.errorMessage || 'Pi did not load its tool approval controls.';
        result.stopReason = 'error';
      }
      if (!wasAborted && result.exitCode === 0 && !agentSettled) {
        result.errorMessage = result.errorMessage || 'Pi exited before the subagent task settled.';
        result.stopReason = 'error';
      }
      if (wasAborted) {
        result.aborted = true;
        result.errorMessage = result.errorMessage || 'Subagent was aborted';
      }
      result.messages = messages.map(entry => entry.message);
      result.status = result.aborted ? 'aborted' : failedResult(result) ? 'failed' : 'completed';
      result.finishedAt = Date.now();
      result.activity = undefined;
      result.toolName = undefined;
      if (signal) signal.removeEventListener('abort', kill);
      const complete = () => {
        if (killTimer) clearTimeout(killTimer);
        emitUpdate();
        resolve(result);
      };
      const waitForTreeKill = pending => {
        pending.then(() => {
          if (treeKillPending !== pending) {
            waitForTreeKill(treeKillPending);
            return;
          }
          complete();
        }, complete);
      };
      if (treeKillPending) waitForTreeKill(treeKillPending);
      else complete();
    };
    const activeTools = new Map();
    const setActivity = (activity, toolName) => {
      if (result.activity === activity && result.toolName === toolName) return;
      result.activity = activity;
      result.toolName = toolName;
      emitUpdate();
    };
    const processLine = line => {
      if (line.endsWith('\\r')) line = line.slice(0, -1);
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'extension_ui_request' && event.method === 'setStatus' && event.statusKey === PERMISSION_TITLE) {
        if (event.statusText === 'ready' && !permissionFailed) {
          permissionReady = true;
          if (approvalReadyTimer) clearTimeout(approvalReadyTimer);
          sendPrompt();
        }
        return;
      }
      if (event.type === 'response' && event.id === 'subagent-prompt') {
        if (!event.success) {
          result.errorMessage = boundedError(String(event.error || 'Pi rejected the subagent prompt'));
          result.stopReason = 'error';
          child.stdin.end();
        } else if (event.data?.disposition === 'handled') {
          child.stdin.end();
        }
        return;
      }
      if (event.type === 'extension_ui_request') {
        if (['select', 'confirm', 'input', 'editor'].includes(event.method)) {
          const runUi = async () => {
            if (!ctx?.ui || signal?.aborted || settled) {
              writeRecord({ type: 'extension_ui_response', id: event.id, confirmed: false, cancelled: true });
              return;
            }
            try {
              let value;
              if (event.method === 'confirm' && event.title === PERMISSION_TITLE) {
                let approval;
                try { approval = JSON.parse(event.message || ''); } catch {}
                if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
                  writeRecord({ type: 'extension_ui_response', id: event.id, confirmed: false });
                  return;
                }
                approval.cwd = workingDirectory;
                value = await ctx.ui.confirm(PERMISSION_TITLE, JSON.stringify(approval));
              } else if (event.method === 'confirm') {
                value = await ctx.ui.confirm(event.title || '', event.message || '', event.timeout ? { timeout: event.timeout } : undefined);
              } else if (event.method === 'select') {
                value = await ctx.ui.select(event.title || '', Array.isArray(event.options) ? event.options : [], event.timeout ? { timeout: event.timeout } : undefined);
              } else if (event.method === 'input') {
                value = await ctx.ui.input(event.title || '', event.placeholder || '', event.timeout ? { timeout: event.timeout } : undefined);
              } else {
                value = await ctx.ui.editor(event.title || '', event.prefill || '');
              }
              if (event.method === 'confirm') {
                writeRecord({ type: 'extension_ui_response', id: event.id, confirmed: Boolean(value), ...(value === undefined ? { cancelled: true } : {}) });
              } else if (value === undefined) {
                writeRecord({ type: 'extension_ui_response', id: event.id, cancelled: true });
              } else {
                writeRecord({ type: 'extension_ui_response', id: event.id, value });
              }
            } catch {
              writeRecord({ type: 'extension_ui_response', id: event.id, confirmed: false, cancelled: true });
            }
          };
          const queued = uiQueue.then(runUi, runUi);
          uiQueue = queued.then(() => {}, () => {});
        }
        return;
      }
      if (event.type === 'agent_settled') {
        agentSettled = true;
        child.stdin.end();
        return;
      }
      if (event.type === 'message_start' && event.message?.role === 'assistant') setActivity('Working');
      if (event.type === 'message_update') {
        const type = event.assistantMessageEvent?.type;
        if (type === 'thinking_start') setActivity('Thinking');
        else if (type === 'text_start') setActivity('Responding');
      }
      if (event.type === 'tool_execution_start') {
        activeTools.set(event.toolCallId, event.toolName || 'tool');
        setActivity('Running a tool', [...activeTools.values()].join(', '));
      } else if (event.type === 'tool_execution_end') {
        activeTools.delete(event.toolCallId);
        setActivity(activeTools.size ? 'Running a tool' : 'Working', activeTools.size ? [...activeTools.values()].join(', ') : undefined);
      }
      if ((event.type === 'message_end' || event.type === 'tool_result_end') && event.message) {
        const message = event.message;
        if (message.role === 'assistant') {
          result.output = finalAssistantText([message]);
          result.usage.turns += 1;
          const usage = message.usage;
          if (usage) {
            result.usage.input += usage.input || 0;
            result.usage.output += usage.output || 0;
            result.usage.cacheRead += usage.cacheRead || 0;
            result.usage.cacheWrite += usage.cacheWrite || 0;
            result.usage.cost += usage.cost && typeof usage.cost.total === 'number' ? usage.cost.total : 0;
            if (typeof usage.totalTokens === 'number') result.usage.contextTokens = usage.totalTokens;
          }
          if (!result.model && message.model) result.model = message.model;
          if (message.stopReason) result.stopReason = message.stopReason;
          if (message.errorMessage) result.errorMessage = boundedError(String(message.errorMessage));
        }
        const messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (messageBytes > MAX_SUBAGENT_TRANSCRIPT_BYTES) {
          messages.length = 0;
          transcriptBytes = 0;
          result.messagesTruncated = true;
        } else {
          messages.push({ message, bytes: messageBytes });
          transcriptBytes += messageBytes;
          while (messages.length > MAX_SUBAGENT_TRANSCRIPT_MESSAGES || transcriptBytes > MAX_SUBAGENT_TRANSCRIPT_BYTES) {
            transcriptBytes -= messages.shift().bytes;
            result.messagesTruncated = true;
          }
        }
        result.messages = messages.map(entry => entry.message);
        emitUpdate();
      }
    };
    const consumeStdout = text => {
      if (protocolFailed) return;
      let start = 0;
      while (true) {
        const newline = text.indexOf('\\n', start);
        const end = newline === -1 ? text.length : newline;
        const segment = text.slice(start, end);
        const segmentBytes = Buffer.byteLength(segment, 'utf8');
        if (stdoutBufferBytes + segmentBytes > MAX_SUBAGENT_RECORD_BYTES) {
          stdoutBuffer = '';
          stdoutBufferBytes = 0;
          rejectOversizedRecord();
          return;
        }
        stdoutBuffer += segment;
        stdoutBufferBytes += segmentBytes;
        if (newline === -1) return;
        processLine(stdoutBuffer);
        stdoutBuffer = '';
        stdoutBufferBytes = 0;
        start = newline + 1;
      }
    };
    child.stdout.on('data', chunk => consumeStdout(stdoutDecoder.write(chunk)));
    child.stdout.on('end', () => {
      consumeStdout(stdoutDecoder.end());
      if (!protocolFailed && stdoutBuffer.trim()) {
        result.errorMessage = result.errorMessage || 'Subagent RPC record was not terminated by LF.';
        result.stopReason = 'error';
      }
      stdoutBuffer = '';
      stdoutBufferBytes = 0;
    });
    let stderrTruncated = false;
    const appendStderr = text => {
      if (stderrTruncated) return;
      const notice = '\\n[Subagent stderr truncated at 262144 characters]';
      const contentLimit = MAX_SUBAGENT_STDERR_CHARS - notice.length;
      const remaining = contentLimit - result.stderr.length;
      if (text.length > remaining) {
        result.stderr += text.slice(0, Math.max(0, remaining)) + notice;
        stderrTruncated = true;
      } else {
        result.stderr += text;
      }
    };
    child.stderr.on('data', chunk => appendStderr(stderrDecoder.write(chunk)));
    child.stderr.on('end', () => appendStderr(stderrDecoder.end()));
    child.stdin.on('error', () => {});
    child.on('close', code => finish(code));
    child.on('error', error => {
      result.errorMessage = boundedError(error instanceof Error ? error.message : String(error));
      finish(1);
    });
    const writeRecord = record => {
      if (!child.stdin.writable || child.stdin.destroyed) return false;
      try {
        child.stdin.write(JSON.stringify(record) + '\\n');
        return true;
      } catch {
        return false;
      }
    };
    const sendPrompt = () => {
      if (promptSent || settled || permissionFailed || !permissionReady) return;
      promptSent = true;
      writeRecord({ type: 'prompt', id: 'subagent-prompt', message: 'Task: ' + task });
    };
    const kill = () => {
      wasAborted = true;
      if (approvalReadyTimer) clearTimeout(approvalReadyTimer);
      treeKillPending = killProcessTree('SIGTERM');
      killTimer = setTimeout(() => {
        if (process.platform === 'win32') {
          treeKillPending = Promise.all([treeKillPending, killProcessTree('SIGKILL', true)]).then(() => {});
        } else {
          signalProcessGroup('SIGKILL');
        }
      }, 5000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    };
    rejectOversizedRecord = () => {
      if (protocolFailed || settled) return;
      protocolFailed = true;
      result.errorMessage = 'Subagent RPC record exceeded the 64 MB limit.';
      result.stopReason = 'error';
      try { child.stdin.end(); } catch {}
      treeKillPending = killProcessTree('SIGTERM');
      killTimer = setTimeout(() => {
        if (process.platform === 'win32') {
          treeKillPending = Promise.all([treeKillPending, killProcessTree('SIGKILL', true)]).then(() => {});
        } else {
          signalProcessGroup('SIGKILL');
        }
      }, 1000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    };
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    }
    emitUpdate();
    if (APPROVAL_EXTENSION_PATH && !permissionReady) {
      approvalReadyTimer = setTimeout(() => {
        if (permissionReady || settled) return;
        permissionFailed = true;
        result.errorMessage = 'Pi did not load its tool approval controls.';
        result.stopReason = 'error';
        child.stdin.end();
        treeKillPending = killProcessTree('SIGTERM');
        killTimer = setTimeout(() => {
          if (process.platform === 'win32') {
            treeKillPending = Promise.all([treeKillPending, killProcessTree('SIGKILL', true)]).then(() => {});
          } else {
            signalProcessGroup('SIGKILL');
          }
        }, 1000);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }, 30_000);
      if (typeof approvalReadyTimer.unref === 'function') approvalReadyTimer.unref();
    } else {
      sendPrompt();
    }
  });
}

async function mapWithConcurrency(items, concurrency, fn) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const workers = [];
  for (let worker = 0; worker < limit; worker++) {
    workers.push((async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        results[index] = await fn(items[index], index);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}

export default function (pi) {
  pi.registerTool({
    name: 'subagent',
    label: 'Subagent',
    description: 'Delegate self-contained work to isolated Pi subagents. Use task for one subagent, or tasks for a parallel batch (max 8 tasks, 4 at a time). Each subagent runs in its own process with its own context window.',
    parameters: SubagentParams,
    defaultActive: true,
    annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: true },
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const single = typeof params.task === 'string' && params.task.trim().length > 0;
      const parallel = Array.isArray(params.tasks) && params.tasks.length > 0;
      if (single === parallel) {
        return {
          content: [{ type: 'text', text: 'Provide exactly one of task or tasks.' }],
          details: { mode: 'single', results: [] },
          isError: true
        };
      }
      if (parallel && params.tasks.length > MAX_PARALLEL_TASKS) {
        return {
          content: [{ type: 'text', text: 'Too many parallel tasks (' + params.tasks.length + '). Max is ' + MAX_PARALLEL_TASKS + '.' }],
          details: { mode: 'parallel', results: [] },
          isError: true
        };
      }
      const effective = {
        task: params.task,
        tasks: params.tasks,
        cwd: params.cwd,
        // Precedence: what the call asked for, then Settings, then the session that dispatched it.
        model: validOverride(params.model, MODEL_PATTERN) || SETTINGS_MODEL || validOverride(
          ctx.model ? ctx.model.provider + '/' + ctx.model.id : '',
          MODEL_PATTERN
        ),
        thinking: validOverride(params.thinking, THINKING_PATTERN) || SETTINGS_THINKING ||
          validOverride(ctx.thinkingLevel, THINKING_PATTERN),
        tools: params.tools
      };
      if (single) {
        const result = await runWithSubagentSlot(ctx.cwd, effective, effective.task, effective.cwd, signal, onUpdate, ctx);
        return {
          content: [{ type: 'text', text: resultOutput(result) }],
          details: { mode: 'single', results: [result] },
          isError: failedResult(result)
        };
      }
      const tasks = effective.tasks;
      const results = tasks.map(item => ({
        task: item.task,
        cwd: item.cwd || effective.cwd || ctx.cwd,
        exitCode: -1,
        output: '',
        stderr: '',
        usage: emptyUsage(),
        model: effective.model,
        stopReason: undefined,
        errorMessage: undefined,
        aborted: false,
        status: 'queued'
      }));
      const publishProgress = () => {
        if (!onUpdate) return;
        const done = results.filter(result => result.exitCode !== -1 || result.aborted).length;
        const running = results.filter(result => result.status === 'running').length;
        const queued = results.filter(result => result.status === 'queued').length;
        onUpdate({
          content: [{ type: 'text', text: 'Parallel: ' + done + '/' + results.length + ' done, ' + running + ' running, ' + queued + ' queued' }],
          details: { mode: 'parallel', results: results.slice() }
        });
      };
      publishProgress();
      await mapWithConcurrency(tasks, MAX_CONCURRENCY, async (item, index) => {
        const result = await runWithSubagentSlot(ctx.cwd, effective, item.task, item.cwd || effective.cwd, signal, partial => {
          const current = partial.details && partial.details.results && partial.details.results[0];
          if (current) results[index] = current;
          publishProgress();
        }, ctx);
        results[index] = result;
        publishProgress();
        return result;
      });
      const successCount = results.filter(result => !failedResult(result)).length;
      const sections = results.map((result, index) => {
        const status = failedResult(result) ? 'failed' : 'completed';
        return '### [' + (index + 1) + '] ' + status + '\\n\\n' + resultOutput(result);
      });
      return {
        content: [{ type: 'text', text: 'Parallel: ' + successCount + '/' + results.length + ' succeeded\\n\\n' + sections.join('\\n\\n---\\n\\n') }],
        details: { mode: 'parallel', results },
        isError: successCount === 0
      };
    }
  });
}
`
}

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
const THINKING_PATTERN = /^[a-z][a-z0-9-]*$/

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
 */
export function subagentExtension(defaults: SubagentDefaults = {}): string {
  const settingsModel = bounded(defaults.model, MODEL_PATTERN)
  const settingsThinking = bounded(defaults.thinking, THINKING_PATTERN)
  return `import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { Type } from 'typebox';

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
// Settings for this process. '' means the setting is unset and the call follows
// the dispatching session, exactly as it did before the setting existed.
const SETTINGS_MODEL = ${JSON.stringify(settingsModel)};
const SETTINGS_THINKING = ${JSON.stringify(settingsThinking)};
const SUBAGENT_SYSTEM_PROMPT = 'You are a subagent working on one self-contained task. Work autonomously, inspect anything you need, make the requested changes, and finish with a concise report of what you did and how you verified it. Never ask the user questions; if an external blocker prevents completion, report it.';

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
  return { command: 'pi', args };
}

function emptyUsage() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

function finalAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

function failedResult(result) {
  return result.exitCode !== 0 || result.aborted || result.stopReason === 'error' || result.stopReason === 'aborted';
}

function resultOutput(result) {
  if (failedResult(result)) return result.errorMessage || result.stderr || result.output || '(no output)';
  return result.output || '(no output)';
}

function buildArgs(params, task) {
  const args = ['--mode', 'json', '-p', '--no-session', '--no-approve'];
  if (params.model) args.push('--model', params.model);
  if (params.thinking) args.push('--thinking', params.thinking);
  if (Array.isArray(params.tools) && params.tools.length > 0) args.push('--tools', params.tools.join(','));
  args.push('--append-system-prompt', SUBAGENT_SYSTEM_PROMPT);
  args.push('Task: ' + task);
  return args;
}

function runSubagent(defaultCwd, params, task, cwd, signal, onUpdate) {
  const result = {
    task,
    cwd: cwd || defaultCwd,
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
    messages: []
  };
  const messages = [];
  const emitUpdate = () => {
    if (!onUpdate) return;
    onUpdate({
      content: [{ type: 'text', text: result.output || '(running...)' }],
      details: { mode: 'single', results: [{ ...result, usage: { ...result.usage } }] }
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
    let wasAborted = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const invocation = piInvocation(buildArgs(params, task));
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: result.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      result.exitCode = 1;
      result.errorMessage = error instanceof Error ? error.message : String(error);
      result.status = 'failed';
      result.finishedAt = Date.now();
      emitUpdate();
      resolve(result);
      return;
    }
    result.status = 'running';
    result.startedAt = Date.now();
    result.activity = 'Starting';
    const finish = code => {
      if (settled) return;
      settled = true;
      result.exitCode = typeof code === 'number' ? code : 1;
      if (wasAborted) {
        result.aborted = true;
        result.errorMessage = result.errorMessage || 'Subagent was aborted';
      }
      result.output = finalAssistantText(messages);
      result.messages = messages.slice();
      result.status = result.aborted ? 'aborted' : failedResult(result) ? 'failed' : 'completed';
      result.finishedAt = Date.now();
      result.activity = undefined;
      result.toolName = undefined;
      if (signal) signal.removeEventListener('abort', kill);
      emitUpdate();
      resolve(result);
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
        messages.push(event.message);
        const message = event.message;
        if (message.role === 'assistant') {
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
          if (message.errorMessage) result.errorMessage = message.errorMessage;
        }
        result.output = finalAssistantText(messages);
        result.messages = messages.slice();
        emitUpdate();
      }
    };
    child.stdout.on('data', chunk => {
      stdoutBuffer += stdoutDecoder.write(chunk);
      while (true) {
        const newline = stdoutBuffer.indexOf('\\n');
        if (newline === -1) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        processLine(line);
      }
    });
    child.stdout.on('end', () => {
      stdoutBuffer += stdoutDecoder.end();
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      stdoutBuffer = '';
    });
    child.stderr.on('data', chunk => {
      stderrBuffer += stderrDecoder.write(chunk);
      while (true) {
        const newline = stderrBuffer.indexOf('\\n');
        if (newline === -1) break;
        const line = stderrBuffer.slice(0, newline);
        stderrBuffer = stderrBuffer.slice(newline + 1);
        result.stderr += line + '\\n';
      }
    });
    child.stderr.on('end', () => {
      stderrBuffer += stderrDecoder.end();
      if (stderrBuffer) result.stderr += stderrBuffer;
    });
    child.on('close', code => finish(code));
    child.on('error', error => {
      result.errorMessage = error instanceof Error ? error.message : String(error);
      finish(1);
    });
    const kill = () => {
      wasAborted = true;
      try { child.kill('SIGTERM'); } catch {}
      const timer = setTimeout(() => {
        try { if (!child.killed) child.kill('SIGKILL'); } catch {}
      }, 5000);
      if (typeof timer.unref === 'function') timer.unref();
    };
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    }
    emitUpdate();
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
        model: params.model || SETTINGS_MODEL || (ctx.model ? ctx.model.provider + '/' + ctx.model.id : undefined),
        thinking: params.thinking || SETTINGS_THINKING || ctx.thinkingLevel,
        tools: params.tools
      };
      if (single) {
        const result = await runSubagent(ctx.cwd, effective, effective.task, effective.cwd, signal, onUpdate);
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
        const result = await runSubagent(ctx.cwd, effective, item.task, item.cwd || effective.cwd, signal, partial => {
          const current = partial.details && partial.details.results && partial.details.results[0];
          if (current) results[index] = current;
          publishProgress();
        });
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

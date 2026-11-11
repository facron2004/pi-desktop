import {
  SUBAGENT_EDITOR_CANCEL_STATUS_KEY,
  SUBAGENT_EDITOR_PENDING_STATUS_KEY
} from '@shared/types'

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
// A child that stops making progress must not hold a slot (or the parent turn)
// forever. The default is generous enough for a real implementation task, but
// a task that needs more can ask for it explicitly.
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_PROGRESS_TEXT_CHARS = 4096;
const PROGRESS_THROTTLE_MS = 300;
// A retry is only allowed when the attempt never reached the model, so nothing
// was written anywhere. The cap keeps a hard-failing spawn from looping.
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 500;
// The schema travels in the child's argv, so it has to stay far below the
// Windows command-line limit for a long real briefing plus this instruction.
const MAX_OUTPUT_SCHEMA_BYTES = 8 * 1024;
const MAX_SCHEMA_DEPTH = 8;
const MAX_SCHEMA_PROPERTIES = 200;
const MAX_SUBAGENT_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_SUBAGENT_OUTPUT_CHARS = 256 * 1024;
const MAX_SUBAGENT_ERROR_CHARS = 64 * 1024;
const MAX_SUBAGENT_STDERR_CHARS = 256 * 1024;
const MAX_SUBAGENT_PROGRESS_OUTPUT_CHARS = 16 * 1024;
const MAX_SUBAGENT_TRANSCRIPT_MESSAGES = 200;
const MAX_SUBAGENT_TRANSCRIPT_BYTES = 256 * 1024;
const SUBAGENT_EDITOR_PENDING_STATUS_KEY = ${JSON.stringify(SUBAGENT_EDITOR_PENDING_STATUS_KEY)};
const SUBAGENT_EDITOR_CANCEL_STATUS_KEY = ${JSON.stringify(SUBAGENT_EDITOR_CANCEL_STATUS_KEY)};
const APPROVAL_EXTENSION_PATH = ${JSON.stringify(permissionExtensionPath)};
const PERMISSION_TITLE = ${JSON.stringify(permissionTitle)};
const FALLBACK_INVOCATION = ${JSON.stringify(fallbackInvocation)};
let uiQueue = Promise.resolve();
let uiRequestSequence = 0;
let activeSubagentCount = 0;
const subagentWaiters = [];
/** Running tasks by \`toolCallId:index\`, so the app can stop exactly one of them. */
const taskCancels = new Map();

function registerTaskCancel(taskId, controller) {
  taskCancels.set(taskId, controller);
  return () => {
    if (taskCancels.get(taskId) === controller) taskCancels.delete(taskId);
  };
}

function combinedSignal(signals) {
  const active = signals.filter(signal => signal && typeof signal.aborted === 'boolean');
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) { controller.abort(); break; }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

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
  const queuedAtMonotonic = performance.now();
  const queueAbort = new AbortController();
  let timedOut = false;
  const abortQueue = () => queueAbort.abort();
  if (signal) {
    if (signal.aborted) abortQueue();
    else signal.addEventListener('abort', abortQueue, { once: true });
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    abortQueue();
  }, params.timeoutMs);
  let release = () => {};
  try {
    release = await acquireSubagentSlot(queueAbort.signal);
    const elapsed = Math.max(0, performance.now() - queuedAtMonotonic);
    if (timedOut || elapsed >= params.timeoutMs) {
      return queuedTaskResult(defaultCwd, params, task, cwd, 'timed_out',
        'Subagent timed out after ' + params.timeoutMs + ' ms while waiting for a worker slot.');
    }
    if (signal && signal.aborted) {
      return queuedTaskResult(defaultCwd, params, task, cwd, 'aborted', 'Subagent was aborted while waiting for a worker slot.');
    }
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abortQueue);
    const remainingTimeout = Math.max(1, params.timeoutMs - Math.ceil(elapsed));
    return await runSubagent(defaultCwd, { ...params, timeoutMs: remainingTimeout }, task, cwd, signal, onUpdate, ctx);
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', abortQueue);
    release();
  }
}

function queuedTaskResult(defaultCwd, params, task, cwd, status, errorMessage) {
  const workingDirectory = safeWorkingDirectory(defaultCwd, cwd);
  return {
    task,
    label: params.label || '',
    cwd: workingDirectory || defaultCwd,
    exitCode: 1,
    output: '',
    progressText: '',
    stderr: '',
    usage: emptyUsage(),
    model: params.model,
    stopReason: status === 'timed_out' ? 'timeout' : status === 'aborted' ? 'aborted' : 'error',
    errorMessage,
    aborted: status === 'aborted',
    status,
    startedAt: undefined,
    finishedAt: Date.now(),
    activity: undefined,
    toolName: undefined,
    messages: [],
    messagesTruncated: false,
    attempts: 0,
    retriesUsed: 0,
    cancelled: false,
    structured: undefined,
    schemaError: undefined
  };
}
// Settings for this process. '' means the setting is unset and the call follows
// the dispatching session, exactly as it did before the setting existed.
const SETTINGS_MODEL = ${JSON.stringify(settingsModel)};
const SETTINGS_THINKING = ${JSON.stringify(settingsThinking)};
const MODEL_PATTERN = new RegExp(${JSON.stringify(MODEL_PATTERN.source)});
const THINKING_PATTERN = new RegExp(${JSON.stringify(THINKING_PATTERN.source)});
const SUBAGENT_SYSTEM_PROMPT = 'You are a subagent working on one self-contained task. The task text is your complete briefing: the parent agent wrote it for a fresh context, so treat it as the only description of the goal, the relevant paths and the definition of done. Work autonomously, inspect anything you need, make the requested changes, verify them, and finish with a concise report of what you did, what you changed and how you verified it. Never ask the user questions; if an external blocker prevents completion, report it explicitly instead of guessing. Do not delegate further. Keep the final report short and factual; the work belongs in the files, not in prose.';

function validOverride(value, pattern) {
  const requested = typeof value === 'string' ? value.trim() : '';
  return requested && pattern.test(requested) ? requested : '';
}

function normalizeTimeout(value, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, number));
}

function normalizeConcurrency(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : MAX_CONCURRENCY;
  return Math.min(MAX_PARALLEL_TASKS, Math.max(1, number));
}

function normalizeRetries(value, fallback) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(MAX_RETRIES, Math.max(0, number));
}

/** A schema is only accepted when it is a plain object that fits in an argv. */
function validOutputSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const text = JSON.stringify(value);
    if (!text || text.length > MAX_OUTPUT_SCHEMA_BYTES) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

/** The final answer as JSON: a fence or one line of prose around it is tolerated. */
function parseJsonOutput(text) {
  if (typeof text !== 'string') return { ok: false, error: 'no output' };
  let body = text.trim();
  const fence = body.match(/\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`/i);
  if (fence) body = fence[1].trim();
  const start = body.indexOf('{') === -1 ? body.indexOf('[') : Math.min(
    body.indexOf('{'),
    body.indexOf('[') === -1 ? body.indexOf('{') : body.indexOf('[')
  );
  if (start > 0) {
    const opener = body[start];
    const end = opener === '{' ? body.lastIndexOf('}') : body.lastIndexOf(']');
    if (end > start) body = body.slice(start, end + 1);
  }
  try {
    return { ok: true, value: JSON.parse(body) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Validates the subset of JSON Schema a delegation actually uses: type,
 * required, properties, additionalProperties, items, enum, const and the common
 * length/number bounds. Unknown keywords are ignored, while schema depth and
 * property count are capped so partial validation cannot silently pass.
 */
function schemaError(schema, value, at, depth) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return '';
  const where = at || 'value';
  if (depth > MAX_SCHEMA_DEPTH) return where + ' exceeds the maximum supported outputSchema depth';
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    return where + ' must equal ' + JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value))) {
    return where + ' must be one of ' + JSON.stringify(schema.enum);
  }
  const type = schema.type;
  if (typeof type === 'string') {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (type === 'integer' ? !(actual === 'number' && Number.isInteger(value)) : actual !== type) {
      return where + ' must be ' + type + ' (got ' + actual + ')';
    }
  } else if (Array.isArray(type) && type.length > 0) {
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const matches = type.some(entry => entry === 'integer'
      ? actual === 'number' && Number.isInteger(value)
      : entry === actual);
    if (!matches) return where + ' must be one of ' + JSON.stringify(type) + ' (got ' + actual + ')';
  }
  if (typeof schema.minLength === 'number' && typeof value === 'string' && value.length < schema.minLength) {
    return where + ' must be at least ' + schema.minLength + ' characters';
  }
  if (typeof schema.maxLength === 'number' && typeof value === 'string' && value.length > schema.maxLength) {
    return where + ' must be at most ' + schema.maxLength + ' characters';
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    return where + ' must be >= ' + schema.minimum;
  }
  if (typeof schema.maximum === 'number' && typeof value === 'number' && value > schema.maximum) {
    return where + ' must be <= ' + schema.maximum;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return where + ' must hold at least ' + schema.minItems + ' items';
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return where + ' must hold at most ' + schema.maxItems + ' items';
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === 'object' && !Array.isArray(itemSchema)) {
      for (let index = 0; index < value.length; index++) {
        const failure = schemaError(itemSchema, value[index], where + '[' + index + ']', depth + 1);
        if (failure) return failure;
      }
    }
    return '';
  }
  if (value && typeof value === 'object') {
    const properties = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {};
    const names = Object.keys(properties);
    if (names.length > MAX_SCHEMA_PROPERTIES) return where + ' has too many outputSchema properties';
    if (Array.isArray(schema.required)) {
      for (const name of schema.required) {
        if (typeof name !== 'string') continue;
        if (!Object.prototype.hasOwnProperty.call(value, name)) return where + ' is missing required property "' + name + '"';
      }
    }
    for (const name of names) {
      if (!Object.prototype.hasOwnProperty.call(value, name)) continue;
      const failure = schemaError(properties[name], value[name], where + '.' + name, depth + 1);
      if (failure) return failure;
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, name)) return where + ' has an unexpected property "' + name + '"';
      }
    }
  }
  return '';
}

function checkOutputSchema(schema, output) {
  const parsed = parseJsonOutput(output);
  if (!parsed.ok) return { ok: false, error: 'the final answer is not JSON (' + parsed.error + ')' };
  const failure = schemaError(schema, parsed.value, '', 0);
  if (failure) return { ok: false, error: failure };
  return { ok: true, value: parsed.value };
}

// Per-task values win over the batch defaults, which already won over Settings
// and the dispatching session. Anything that is not a valid shape falls back,
// so a stray string can never reach a child's argv.
function taskParams(effective, item) {
  return {
    model: validOverride(item && item.model, MODEL_PATTERN) || effective.model,
    thinking: validOverride(item && item.thinking, THINKING_PATTERN) || effective.thinking,
    tools: Array.isArray(item && item.tools) && item.tools.length > 0 ? item.tools : effective.tools,
    timeoutMs: normalizeTimeout(item && item.timeoutMs, effective.timeoutMs),
    retries: normalizeRetries(item && item.retries, effective.retries),
    outputSchema: validOutputSchema(item && item.outputSchema) || effective.outputSchema,
    label: typeof (item && item.label) === 'string' ? item.label.trim().slice(0, 80) : ''
  };
}

const OutputSchemaParam = Type.Optional(Type.Any({
  description: 'A JSON Schema (the common subset: type, required, properties, items, enum, const, length/number bounds). The child must answer with a single JSON value that matches it; anything else fails the task instead of passing as success.'
}));

const TaskItem = Type.Object({
  task: Type.String({ description: 'A complete, self-contained briefing for the child: goal, exact paths or data, constraints and definition of done. The child cannot see this conversation.' }),
  label: Type.Optional(Type.String({ description: 'A short human-readable name for this task, shown in the subagent tree instead of the whole briefing.' })),
  cwd: Type.Optional(Type.String({ description: 'Working directory for this task, resolved inside the current project.' })),
  model: Type.Optional(Type.String({ description: 'Model override for this task only, for example provider/model.' })),
  thinking: Type.Optional(Type.String({ description: 'Thinking level override for this task only.' })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Tool allowlist for this task only.' })),
  timeoutMs: Type.Optional(Type.Number({ description: 'Wall-clock timeout for this task in milliseconds (1000-86400000, default 1800000).' })),
  retries: Type.Optional(Type.Number({ description: 'Retries for this task, 0-2. A retry happens only when the attempt never reached the model, so no work is repeated.' })),
  outputSchema: OutputSchemaParam
});

const SubagentParams = Type.Object({
  task: Type.Optional(Type.String({ description: 'One self-contained task to delegate. Write a full briefing: the child sees no conversation history.' })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: 'Independent tasks to delegate in parallel (max 8). Each may carry its own label, cwd, model, thinking, tools, timeoutMs, retries and outputSchema.' })),
  cwd: Type.Optional(Type.String({ description: 'Default working directory for the child processes, resolved inside the current project.' })),
  model: Type.Optional(Type.String({ description: 'Default model override, for example provider/model.' })),
  thinking: Type.Optional(Type.String({ description: 'Default thinking level override.' })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Default allowlist of tool names for the children.' })),
  timeoutMs: Type.Optional(Type.Number({ description: 'Default wall-clock timeout in milliseconds for every task in this call (1000-86400000, default 1800000).' })),
  concurrency: Type.Optional(Type.Number({ description: 'Maximum tasks of this batch running at once (1-8, default 4; the process-wide cap is 4).' })),
  retries: Type.Optional(Type.Number({ description: 'Default retry count for this call, 0-2. Only an attempt that never reached the model is retried.' })),
  outputSchema: OutputSchemaParam,
  label: Type.Optional(Type.String({ description: 'A short name for a single task, shown in the subagent tree.' }))
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
  return result.exitCode !== 0 || result.aborted || result.stopReason === 'error' || result.stopReason === 'aborted' || result.stopReason === 'timeout' || result.stopReason === 'schema';
}

function resultOutput(result) {
  if (result.stopReason === 'schema') {
    // The work may be fine; the contract was not met. Show both so the parent
    // can salvage the result instead of only seeing a failure.
    return 'Subagent finished but its answer did not match outputSchema: '
      + (result.schemaError || result.errorMessage || 'invalid output')
      + '\\n\\nRaw output:\\n'
      + (result.output || '(no output)');
  }
  if (failedResult(result)) return result.errorMessage || result.stderr || result.output || '(no output)';
  return result.output || '(no output)';
}

function buildArgs(params) {
  const args = ['--mode', 'rpc', '--no-session', ${JSON.stringify(trustProject ? '--approve' : '--no-approve')}];
  if (APPROVAL_EXTENSION_PATH) args.push('--extension', APPROVAL_EXTENSION_PATH);
  if (params.model) args.push('--model', params.model);
  if (params.thinking) args.push('--thinking', params.thinking);
  if (Array.isArray(params.tools) && params.tools.length > 0) args.push('--tools', params.tools.join(','));
  let systemPrompt = SUBAGENT_SYSTEM_PROMPT;
  if (params.outputSchema) {
    systemPrompt += '\\n\\nYour final answer must be a single JSON value that conforms to this JSON Schema. Output only the JSON value: no prose, no markdown fences, no notes.\\n'
      + JSON.stringify(params.outputSchema);
  }
  args.push('--append-system-prompt', systemPrompt);
  return args;
}

/**
 * Runs one task, retrying only an attempt that never reached the model.
 *
 * That condition is the whole safety argument: no assistant turn and no tool
 * event means the child cannot have changed a file, run a command or spent the
 * model's budget, so a second attempt repeats nothing. An attempt that did make
 * progress is never retried, and neither is a timeout or a schema mismatch.
 */
async function runSubagent(defaultCwd, params, task, cwd, signal, onUpdate, ctx) {
  const attemptsAllowed = 1 + normalizeRetries(params.retries, 0);
  const beganAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let result = await runSubagentOnce(defaultCwd, params, task, cwd, signal, onUpdate, ctx);
  result.attempts = 1;
  result.retriesUsed = 0;
  for (let attempt = 2; attempt <= attemptsAllowed; attempt++) {
    if (!shouldRetry(result) || (signal && signal.aborted)) break;
    const elapsed = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - beganAt;
    if (typeof params.timeoutMs === 'number' && elapsed >= params.timeoutMs) break;
    await retryDelay(RETRY_DELAY_MS * (attempt - 1));
    if (signal && signal.aborted) break;
    result.activity = 'Retrying';
    result.toolName = undefined;
    if (onUpdate) {
      try {
        onUpdate({
          content: [{ type: 'text', text: 'Retrying (' + (attempt - 1) + '/' + (attemptsAllowed - 1) + ')...' }],
          details: { mode: 'single', results: [{ ...result }] }
        });
      } catch {
        // Progress reporting must never cancel the retry it is describing.
      }
    }
    const remaining = typeof params.timeoutMs === 'number'
      ? Math.max(1, Math.floor(params.timeoutMs - elapsed))
      : params.timeoutMs;
    const next = await runSubagentOnce(defaultCwd, { ...params, timeoutMs: remaining }, task, cwd, signal, onUpdate, ctx);
    next.attempts = attempt;
    next.retriesUsed = attempt - 1;
    result = next;
  }
  result.attempts = result.attempts || 1;
  return result;
}

function shouldRetry(result) {
  return result.status === 'failed'
    && result.aborted !== true
    && result.stopReason !== 'timeout'
    && result.stopReason !== 'schema'
    && result.startedAt !== undefined
    && result.usage !== undefined
    && result.usage.turns === 0
    && Array.isArray(result.messages)
    && result.messages.length === 0;
}

function retryDelay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

function runSubagentOnce(defaultCwd, params, task, cwd, signal, onUpdate, ctx) {
  const workingDirectory = safeWorkingDirectory(defaultCwd, cwd);
  const result = {
    task,
    label: params.label || '',
    cwd: workingDirectory || defaultCwd,
    exitCode: -1,
    output: '',
    progressText: '',
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
    messagesTruncated: false,
    attempts: 0,
    retriesUsed: 0,
    cancelled: false,
    /** The parsed answer when the task ran with an outputSchema. */
    structured: undefined,
    /** Why the answer did not match outputSchema, when it did not. */
    schemaError: undefined
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
  let lastProgressAt = 0;
  const emitUpdate = () => {
    if (!onUpdate) return;
    const output = result.output ? progressOutput(result.output) : '';
    try {
      onUpdate({
        content: [{ type: 'text', text: output || '(running...)' }],
        details: { mode: 'single', results: [{ ...result, output, usage: { ...result.usage } }] }
      });
    } catch {
      // Progress reporting must not detach a child process from its parent task.
    }
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
    let timedOut = false;
    let killTimer;
    let timeoutTimer;
    let approvalReadyTimer;
    const uiAbortController = new AbortController();
    let activeEditorToken;
    const cancelPendingUi = () => {
      const token = activeEditorToken;
      activeEditorToken = undefined;
      if (token && ctx?.ui) {
        try { ctx.ui.setStatus(SUBAGENT_EDITOR_CANCEL_STATUS_KEY, token); } catch {}
      }
      uiAbortController.abort();
    };
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
    const forceKillTree = () => {
      if (killTimer) clearTimeout(killTimer);
      killTimer = undefined;
      if (process.platform === 'win32') {
        const pending = treeKillPending || Promise.resolve();
        treeKillPending = Promise.all([pending, killProcessTree('SIGKILL', true)]).then(() => {});
      } else {
        signalProcessGroup('SIGKILL');
      }
    };
    const scheduleKillEscalation = delay => {
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(forceKillTree, delay);
      if (typeof killTimer.unref === 'function') killTimer.unref();
    };
    const finish = code => {
      if (settled) return;
      settled = true;
      cancelPendingUi();
      if (killTimer) forceKillTree();
      if (approvalReadyTimer) clearTimeout(approvalReadyTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      result.exitCode = typeof code === 'number' ? code : 1;
      if (APPROVAL_EXTENSION_PATH && !permissionReady && !wasAborted && !timedOut) {
        result.errorMessage = result.errorMessage || 'Pi did not load its tool approval controls.';
        result.stopReason = 'error';
      }
      if (!wasAborted && !timedOut && result.exitCode === 0 && !agentSettled) {
        result.errorMessage = result.errorMessage || 'Pi exited before the subagent task settled.';
        result.stopReason = 'error';
      }
      if (wasAborted) {
        result.aborted = true;
        result.errorMessage = result.errorMessage || 'Subagent was aborted';
      }
      result.messages = messages.map(entry => entry.message);
      result.progressText = '';
      // The schema is a contract, not a hint: an answer that does not match it
      // must not be reported as success, or the parent would trust a shape the
      // child never produced.
      if (params.outputSchema && !result.aborted && !timedOut && !failedResult(result)) {
        const checked = checkOutputSchema(params.outputSchema, result.output);
        if (checked.ok) {
          result.structured = checked.value;
        } else {
          result.schemaError = checked.error;
          result.errorMessage = 'Subagent answer did not match outputSchema: ' + checked.error;
          result.stopReason = 'schema';
        }
      }
      result.status = result.aborted ? 'aborted' : timedOut ? 'timed_out' : failedResult(result) ? 'failed' : 'completed';
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
            if (!ctx?.ui || uiAbortController.signal.aborted || settled) {
              writeRecord({ type: 'extension_ui_response', id: event.id, confirmed: false, cancelled: true });
              return;
            }
            try {
              let value;
              const dialogOptions = {
                ...(event.timeout ? { timeout: event.timeout } : {}),
                signal: uiAbortController.signal
              };
              if (event.method === 'confirm' && event.title === PERMISSION_TITLE) {
                let approval;
                try { approval = JSON.parse(event.message || ''); } catch {}
                if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
                  writeRecord({ type: 'extension_ui_response', id: event.id, confirmed: false });
                  return;
                }
                approval.cwd = workingDirectory;
                value = await ctx.ui.confirm(PERMISSION_TITLE, JSON.stringify(approval), dialogOptions);
              } else if (event.method === 'confirm') {
                value = await ctx.ui.confirm(event.title || '', event.message || '', dialogOptions);
              } else if (event.method === 'select') {
                value = await ctx.ui.select(event.title || '', Array.isArray(event.options) ? event.options : [], dialogOptions);
              } else if (event.method === 'input') {
                value = await ctx.ui.input(event.title || '', event.placeholder || '', dialogOptions);
              } else {
                const token = 'subagent-editor-' + (++uiRequestSequence);
                activeEditorToken = token;
                try {
                  ctx.ui.setStatus(SUBAGENT_EDITOR_PENDING_STATUS_KEY, token);
                  value = await ctx.ui.editor(event.title || '', event.prefill || '');
                } finally {
                  try { ctx.ui.setStatus(SUBAGENT_EDITOR_PENDING_STATUS_KEY, undefined); } catch {}
                  if (activeEditorToken === token) activeEditorToken = undefined;
                }
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
      if (event.type === 'message_start' && event.message?.role === 'assistant') {
        result.progressText = '';
        setActivity('Working');
      }
      if (event.type === 'message_update') {
        const type = event.assistantMessageEvent?.type;
        if (type === 'thinking_start') setActivity('Thinking');
        else if (type === 'text_start') setActivity('Responding');
        else if (type === 'text_delta' && typeof event.assistantMessageEvent.delta === 'string') {
          // A bounded tail of the child's live answer, not its reasoning. Deltas
          // can arrive many times per second, so publish at most every 300ms.
          result.progressText = (result.progressText + event.assistantMessageEvent.delta).slice(-MAX_PROGRESS_TEXT_CHARS);
          const now = Date.now();
          if (now - lastProgressAt >= PROGRESS_THROTTLE_MS) {
            lastProgressAt = now;
            emitUpdate();
          }
        }
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
          result.progressText = '';
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
      // A timeout already owns the tree kill; a late user abort must not turn
      // a timed_out task into an aborted one.
      if (timedOut) return;
      wasAborted = true;
      cancelPendingUi();
      if (approvalReadyTimer) clearTimeout(approvalReadyTimer);
      treeKillPending = killProcessTree('SIGTERM');
      scheduleKillEscalation(5000);
    };
    rejectOversizedRecord = () => {
      if (protocolFailed || settled) return;
      protocolFailed = true;
      cancelPendingUi();
      result.errorMessage = 'Subagent RPC record exceeded the 64 MB limit.';
      result.stopReason = 'error';
      try { child.stdin.end(); } catch {}
      treeKillPending = killProcessTree('SIGTERM');
      scheduleKillEscalation(1000);
    };
    if (signal) {
      if (signal.aborted) kill();
      else signal.addEventListener('abort', kill, { once: true });
    }
    emitUpdate();
    const timeoutMs = params.timeoutMs;
    timeoutTimer = setTimeout(() => {
      if (settled || wasAborted) return;
      timedOut = true;
      cancelPendingUi();
      result.errorMessage = 'Subagent timed out after ' + timeoutMs + ' ms.';
      result.stopReason = 'timeout';
      if (approvalReadyTimer) clearTimeout(approvalReadyTimer);
      try { child.stdin.end(); } catch {}
      treeKillPending = killProcessTree('SIGTERM');
      scheduleKillEscalation(1000);
    }, timeoutMs);
    if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref();
    if (APPROVAL_EXTENSION_PATH && !permissionReady) {
      approvalReadyTimer = setTimeout(() => {
        if (permissionReady || settled) return;
        permissionFailed = true;
        cancelPendingUi();
        result.errorMessage = 'Pi did not load its tool approval controls.';
        result.stopReason = 'error';
        child.stdin.end();
        treeKillPending = killProcessTree('SIGTERM');
        scheduleKillEscalation(1000);
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
    description: 'Delegate self-contained work to isolated Pi subagents. Each child runs in its own process and context window: it sees only the briefing you write, the project files and the tools you allow. Use task for one child, or tasks for a parallel batch (max 8, default concurrency 4, default timeout 30 minutes). Write a complete briefing and give each task a short label; per-task model, thinking, tools, timeoutMs, retries and cwd may differ. Give a task an outputSchema when you need a machine-checkable answer: the child must then reply with one JSON value that matches it, and a mismatch fails the task instead of passing as success. Every child returns a final text report, with status, usage, attempts and transcript in the details.',
    parameters: SubagentParams,
    promptSnippet: 'Delegate self-contained work to isolated subagents',
    promptGuidelines: [
      'Use the subagent tool when work is independent enough to run in a fresh context, when several files or questions can be explored in parallel, or when a long investigation would otherwise fill the main context.',
      'Write each subagent task as a complete briefing: state the goal, the exact paths or data to use, the constraints and the definition of done. A child cannot see this conversation, so never refer to "the file we discussed" without naming it.',
      'Use the subagent tool with a tasks array for independent work that can run at the same time; keep one coherent goal per task and give each a short label so the results are easy to tell apart.',
      'Do not use the subagent tool for a trivial one-step read or edit that is cheaper to do directly, and do not delegate work that needs to see the live conversation.',
      'Report every child result faithfully: if a child failed, timed out or was stopped, say so and show its error instead of claiming success.'
    ],
    defaultActive: true,
    annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: true },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
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
        tools: params.tools,
        timeoutMs: normalizeTimeout(params.timeoutMs, DEFAULT_TIMEOUT_MS),
        concurrency: normalizeConcurrency(params.concurrency),
        retries: normalizeRetries(params.retries, 0),
        outputSchema: validOutputSchema(params.outputSchema)
      };
      // One controller per task, keyed the way the app names the row, so
      // /desktop-subagent-cancel can stop exactly one child and leave its
      // siblings running.
      const taskSlot = index => {
        const controller = new AbortController();
        const taskId = (toolCallId || 'subagent') + ':' + index;
        const release = registerTaskCancel(taskId, controller);
        return { taskId, controller, signal: combinedSignal([signal, controller.signal]), release };
      };
      const markCancelled = (result, slot) => {
        if (result && result.status === 'aborted' && slot.controller.signal.aborted && !(signal && signal.aborted)) {
          result.cancelled = true;
          result.errorMessage = 'Subagent task was stopped by the user.';
        }
        return result;
      };
      if (single) {
        const perTask = taskParams(effective, {
          label: params.label,
          timeoutMs: params.timeoutMs,
          retries: params.retries,
          outputSchema: params.outputSchema
        });
        const slot = taskSlot(0);
        let result;
        try {
          result = markCancelled(
            await runWithSubagentSlot(ctx.cwd, perTask, effective.task, effective.cwd, slot.signal, onUpdate, ctx),
            slot
          );
        } catch (error) {
          result = queuedTaskResult(ctx.cwd, perTask, effective.task, effective.cwd, 'failed',
            boundedError(error instanceof Error ? error.message : String(error)));
        } finally {
          slot.release();
        }
        return {
          content: [{ type: 'text', text: resultOutput(result) }],
          details: { mode: 'single', results: [result] },
          isError: failedResult(result)
        };
      }
      const tasks = effective.tasks;
      const results = tasks.map(item => ({
        task: item.task,
        label: typeof item.label === 'string' ? item.label.trim().slice(0, 80) : '',
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
        try {
          onUpdate({
            content: [{ type: 'text', text: 'Parallel: ' + done + '/' + results.length + ' done, ' + running + ' running, ' + queued + ' queued' }],
            details: { mode: 'parallel', results: results.slice() }
          });
        } catch {
          // Progress reporting must not detach child processes from the batch.
        }
      };
      publishProgress();
      await mapWithConcurrency(tasks, effective.concurrency, async (item, index) => {
        const perTask = taskParams(effective, item);
        const slot = taskSlot(index);
        let result;
        try {
          result = markCancelled(
            await runWithSubagentSlot(ctx.cwd, perTask, item.task, item.cwd || effective.cwd, slot.signal, partial => {
              const current = partial.details && partial.details.results && partial.details.results[0];
              if (current) results[index] = current;
              publishProgress();
            }, ctx),
            slot
          );
        } catch (error) {
          result = queuedTaskResult(ctx.cwd, perTask, item.task, item.cwd || effective.cwd, 'failed',
            boundedError(error instanceof Error ? error.message : String(error)));
        } finally {
          slot.release();
        }
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

  // The parent model is blocked inside the tool call, so an individual task is
  // stopped by the app, not by another tool: the renderer sends this command
  // through Pi's prompt channel while the batch is still running.
  pi.registerCommand('desktop-subagent-cancel', {
    description: 'Stop one running subagent task by its id (toolCallId:index)',
    handler: async value => {
      const taskId = String(value || '').trim();
      if (!taskId) throw new Error('Usage: /desktop-subagent-cancel <taskId>');
      const controller = taskCancels.get(taskId);
      if (!controller) throw new Error('No running subagent task: ' + taskId);
      controller.abort();
    }
  });
}
`
}

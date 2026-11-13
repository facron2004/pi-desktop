import {
  SUBAGENT_EDITOR_CANCEL_STATUS_KEY,
  SUBAGENT_EDITOR_PENDING_STATUS_KEY
} from '@shared/types'
import type { AgentPreset } from './agents'

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

const AGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_AGENT_DESCRIPTION_CHARS = 500
const MAX_AGENT_PROMPT_CHARS = 32 * 1024
const MAX_AGENT_TOOLS = 32

/**
 * Re-validates everything the main process read, because the preset is about
 * to become part of a child's argv and system prompt. A preset that fails a
 * check here is dropped, the same fallback doctrine as every other value: a
 * stray shape never reaches a child, it just stops pretending to be an agent.
 */
function sanitizeAgentPreset(preset: AgentPreset): AgentPreset | null {
  const name = typeof preset?.name === 'string' ? preset.name.trim().toLowerCase() : ''
  const description = typeof preset?.description === 'string' ? preset.description.trim() : ''
  const prompt = typeof preset?.prompt === 'string' ? preset.prompt.trim().slice(0, MAX_AGENT_PROMPT_CHARS) : ''
  if (!AGENT_NAME_PATTERN.test(name) || !description) return null
  const clean: AgentPreset = {
    name,
    description: description.slice(0, MAX_AGENT_DESCRIPTION_CHARS),
    prompt
  }
  const model = bounded(preset.model, MODEL_PATTERN)
  if (model) clean.model = model
  const thinking = bounded(preset.thinking, THINKING_PATTERN)
  if (thinking) clean.thinking = thinking
  if (Array.isArray(preset.tools) && preset.tools.length > 0) {
    const tools = preset.tools
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, MAX_AGENT_TOOLS)
    if (tools.length > 0) clean.tools = tools
  }
  if (typeof preset.timeoutMs === 'number' && Number.isFinite(preset.timeoutMs) && preset.timeoutMs > 0) {
    clean.timeoutMs = preset.timeoutMs
  }
  return clean
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
  fallbackInvocation: { command: string; prefixArgs: string[] } = { command: 'pi', prefixArgs: [] },
  agents: AgentPreset[] = []
): string {
  const settingsModel = bounded(defaults.model, MODEL_PATTERN)
  const settingsThinking = bounded(defaults.thinking, THINKING_PATTERN)
  // The presets were read and validated in the main process; this second pass
  // is the same boundary every other interpolated value crosses. Duplicates
  // keep the first entry so the generated source is deterministic.
  const sanitizedAgents: AgentPreset[] = []
  const seenAgentNames = new Set<string>()
  for (const entry of agents ?? []) {
    const preset = sanitizeAgentPreset(entry)
    if (!preset || seenAgentNames.has(preset.name)) continue
    seenAgentNames.add(preset.name)
    sanitizedAgents.push(preset)
  }
  const agentRoster = sanitizedAgents.length > 0
    ? ' Named agent presets are available through the agent parameter: '
      + sanitizedAgents
        .map((preset) => `${preset.name} — ${preset.description}`)
        .join('; ')
        .slice(0, 1200)
      + '. Pass agent with the name, keep the briefing about the goal, and the preset adds the role, the model, the tools and the time budget.'
    : ''
  const agentGuideline = sanitizedAgents.length > 0
    ? ['When one of the named agent presets fits the work (see the subagent tool description), pass its name in agent and write the briefing about the goal; the preset already carries the role instructions, the model and the tool allowlist.']
    : []
return `import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
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
const OUTPUT_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const OUTPUT_SCHEMA_KEYWORDS = new Set([
  'type', 'required', 'properties', 'additionalProperties', 'items', 'enum', 'const',
  'minLength', 'maxLength', 'minimum', 'maximum', 'minItems', 'maxItems',
  '$schema', '$id', '$comment', 'title', 'description', 'default', 'examples',
  'deprecated', 'readOnly', 'writeOnly'
]);
const MAX_SUBAGENT_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_SUBAGENT_OUTPUT_CHARS = 256 * 1024;
const MAX_SUBAGENT_ERROR_CHARS = 64 * 1024;
const MAX_SUBAGENT_STDERR_CHARS = 256 * 1024;
const MAX_SUBAGENT_PROGRESS_OUTPUT_CHARS = 16 * 1024;
const MAX_SUBAGENT_TRANSCRIPT_MESSAGES = 200;
const MAX_SUBAGENT_TRANSCRIPT_BYTES = 256 * 1024;
// Worktrees live inside the project so the realpath cwd sandbox still holds.
// They are registered in .git/info/exclude, never in the user's .gitignore.
const WORKTREE_ROOT = '.pi/worktrees';
const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SUBAGENT_EDITOR_PENDING_STATUS_KEY = ${JSON.stringify(SUBAGENT_EDITOR_PENDING_STATUS_KEY)};
const SUBAGENT_EDITOR_CANCEL_STATUS_KEY = ${JSON.stringify(SUBAGENT_EDITOR_CANCEL_STATUS_KEY)};
const APPROVAL_EXTENSION_PATH = ${JSON.stringify(permissionExtensionPath)};
const PERMISSION_TITLE = ${JSON.stringify(permissionTitle)};
const FALLBACK_INVOCATION = ${JSON.stringify(fallbackInvocation)};
const AGENTS = ${JSON.stringify(sanitizedAgents)};
const AGENT_NAMES = AGENTS.map(agent => agent.name);
let uiQueue = Promise.resolve();
let uiRequestSequence = 0;
let activeSubagentCount = 0;
const subagentWaiters = [];
/** Cancellable tasks by \`toolCallId:index\`, including tasks waiting in a batch queue. */
const taskCancels = new Map();

function registerTaskCancel(taskId, controller, cancelQueued) {
  const task = { controller, cancelQueued };
  taskCancels.set(taskId, task);
  return () => {
    if (taskCancels.get(taskId) === task) taskCancels.delete(taskId);
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
    // A worktree is created only after the task owns a slot, so a cancelled
    // queue never leaves one behind. The child cwd is the worktree path, still
    // verified by safeWorkingDirectory against the project root.
    let worktree = null;
    let childCwd = cwd;
    if (params.worktree) {
      const created = await createWorktree(defaultCwd);
      if (created.error) {
        return queuedTaskResult(defaultCwd, params, task, cwd, 'failed', created.error);
      }
      worktree = created;
      childCwd = path.relative(defaultCwd, created.path);
    }
    const result = await runSubagent(defaultCwd, { ...params, timeoutMs: remainingTimeout }, task, childCwd, signal, onUpdate, ctx);
    if (worktree) {
      try {
        result.worktree = await finalizeWorktree(worktree, defaultCwd);
      } catch (error) {
        result.worktree = {
          name: worktree.name,
          branch: worktree.branch,
          path: worktree.path,
          kept: true,
          reason: 'worktree could not be finalized: ' + (error instanceof Error ? error.message : String(error))
        };
      }
    }
    return result;
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
    schemaError: undefined,
    worktree: undefined
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

/**
 * A schema is only accepted when it is an object that fits in an argv.
 *
 * Models routinely send a nested schema as a JSON *string* rather than an
 * object, especially when the schema itself was described inside the briefing,
 * so a string that parses to an object is accepted instead of silently
 * disabling the contract the caller asked for.
 */
function parseOutputSchema(value) {
  if (value === undefined) return { schema: undefined, error: undefined };
  let candidate = value;
  if (typeof candidate === 'string') {
    const text = candidate.trim();
    if (!text) return { schema: undefined, error: 'outputSchema must contain JSON' };
    if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_SCHEMA_BYTES) {
      return { schema: undefined, error: 'outputSchema exceeds the maximum size' };
    }
    try { candidate = JSON.parse(text); } catch {
      return { schema: undefined, error: 'outputSchema must contain valid JSON' };
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { schema: undefined, error: 'outputSchema must be an object schema' };
  }
  try {
    const text = JSON.stringify(candidate);
    if (!text || Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_SCHEMA_BYTES) {
      return { schema: undefined, error: 'outputSchema exceeds the maximum size' };
    }
    return { schema: candidate, error: undefined };
  } catch {
    return { schema: undefined, error: 'outputSchema must be JSON-serializable' };
  }
}

function parseJsonValue(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function isSingleLineProse(text) {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029 ||
        code === 96 || character === '{' || character === '}' || character === '[' || character === ']') {
      return false;
    }
  }
  return true;
}

function jsonValueEnd(text, start) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character.charCodeAt(0) === 92) escaped = true;
      else if (character === '\"') inString = false;
      continue;
    }
    if (character === '\"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      stack.push(character);
      continue;
    }
    if (character === '}' || character === ']') {
      const opener = stack.pop();
      if (opener !== (character === '}' ? '{' : '[')) return -1;
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

/** The final answer as JSON: a fence or one line of prose around it is tolerated. */
function parseJsonOutput(text) {
  if (typeof text !== 'string') return { ok: false, error: 'no output' };
  let body = text.trim();
  const fence = body.match(/\`\`\`(?:json)?\\s*([\\s\\S]*?)\`\`\`/i);
  if (fence) {
    const before = body.slice(0, fence.index);
    const after = body.slice(fence.index + fence[0].length);
    if (!isSingleLineProse(before) || !isSingleLineProse(after)) {
      return { ok: false, error: 'expected a single JSON value with at most one line of surrounding prose' };
    }
    return parseJsonValue(fence[1].trim());
  }

  const direct = parseJsonValue(body);
  if (direct.ok) return direct;
  const objectStart = body.indexOf('{');
  const arrayStart = body.indexOf('[');
  const start = objectStart < 0 ? arrayStart : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart);
  if (start < 0) return direct;
  const end = jsonValueEnd(body, start);
  if (end < 0 || !isSingleLineProse(body.slice(0, start)) || !isSingleLineProse(body.slice(end))) {
    return { ok: false, error: 'expected a single JSON value with at most one line of surrounding prose' };
  }
  return parseJsonValue(body.slice(start, end));
}

/** Validate the full schema definition before spawning a child. */
function outputSchemaDefinitionError(schema, where = 'outputSchema', depth = 0) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return where + ' must be an object schema';
  }
  if (depth > MAX_SCHEMA_DEPTH) return where + ' exceeds the maximum supported outputSchema depth';
  for (const keyword of Object.keys(schema)) {
    if (!OUTPUT_SCHEMA_KEYWORDS.has(keyword)) {
      return where + ' uses unsupported keyword "' + keyword + '"';
    }
  }
  if (schema.type !== undefined) {
    const types = typeof schema.type === 'string' ? [schema.type] : schema.type;
    if (!Array.isArray(types) || types.length === 0 || types.some(type => !OUTPUT_SCHEMA_TYPES.has(type))) {
      return where + '.type must contain supported JSON types';
    }
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(name => typeof name !== 'string'))) {
    return where + '.required must be an array of strings';
  }
  if (schema.properties !== undefined && (!schema.properties || typeof schema.properties !== 'object' || Array.isArray(schema.properties))) {
    return where + '.properties must be an object';
  }
  if (schema.properties) {
    const names = Object.keys(schema.properties);
    if (names.length > MAX_SCHEMA_PROPERTIES) return where + ' has too many outputSchema properties';
    for (const name of names) {
      const failure = outputSchemaDefinitionError(schema.properties[name], where + '.properties.' + name, depth + 1);
      if (failure) return failure;
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') {
    return where + '.additionalProperties must be a boolean';
  }
  if (schema.items !== undefined) {
    const failure = outputSchemaDefinitionError(schema.items, where + '.items', depth + 1);
    if (failure) return failure;
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    return where + '.enum must be a non-empty array';
  }
  for (const keyword of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[keyword] !== undefined && (!Number.isInteger(schema[keyword]) || schema[keyword] < 0)) {
      return where + '.' + keyword + ' must be a non-negative integer';
    }
  }
  for (const keyword of ['minimum', 'maximum']) {
    if (schema[keyword] !== undefined && (typeof schema[keyword] !== 'number' || !Number.isFinite(schema[keyword]))) {
      return where + '.' + keyword + ' must be a finite number';
    }
  }
  for (const [minimum, maximum] of [['minLength', 'maxLength'], ['minItems', 'maxItems'], ['minimum', 'maximum']]) {
    if (schema[minimum] !== undefined && schema[maximum] !== undefined && schema[minimum] > schema[maximum]) {
      return where + '.' + minimum + ' cannot exceed ' + maximum;
    }
  }
  return '';
}

/** Compare JSON values while treating object property order as insignificant. */
function jsonValueEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    return left.length === right.length && left.every((entry, index) => jsonValueEqual(entry, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && jsonValueEqual(left[key], right[key]));
}

/** Validate a value against a schema already checked by outputSchemaDefinitionError. */
function schemaError(schema, value, at, depth) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return '';
  const where = at || 'value';
  if (depth > MAX_SCHEMA_DEPTH) return where + ' exceeds the maximum supported outputSchema depth';
  if (schema.const !== undefined && !jsonValueEqual(schema.const, value)) {
    return where + ' must equal ' + JSON.stringify(schema.const);
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0 && !schema.enum.some(entry => jsonValueEqual(entry, value))) {
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
  const stringLength = typeof value === 'string' ? Array.from(value).length : 0;
  if (typeof schema.minLength === 'number' && typeof value === 'string' && stringLength < schema.minLength) {
    return where + ' must be at least ' + schema.minLength + ' characters';
  }
  if (typeof schema.maxLength === 'number' && typeof value === 'string' && stringLength > schema.maxLength) {
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

function agentByName(requested) {
  const name = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
  if (!name) return undefined;
  return AGENTS.find(agent => agent.name === name);
}

// Per-task values win over the named agent's preset, which wins over the batch
// defaults, which already won over Settings and the dispatching session.
// Anything that is not a valid shape falls back, so a stray string can never
// reach a child's argv.
function taskParams(effective, item) {
  const agent = agentByName(item && item.agent);
  const outputSchema = item && item.outputSchema !== undefined
    ? parseOutputSchema(item.outputSchema)
    : effective.outputSchema;
  const agentRequested = Boolean(item && typeof item.agent === 'string' && item.agent.trim());
  return {
    model: validOverride(item && item.model, MODEL_PATTERN) || (agent && agent.model) || effective.model,
    thinking: validOverride(item && item.thinking, THINKING_PATTERN) || (agent && agent.thinking) || effective.thinking,
    tools: Array.isArray(item && item.tools) && item.tools.length > 0
      ? item.tools
      : (agent && Array.isArray(agent.tools) && agent.tools.length > 0 ? agent.tools : effective.tools),
    timeoutMs: normalizeTimeout(item && item.timeoutMs, (agent && agent.timeoutMs) || effective.timeoutMs),
    retries: normalizeRetries(item && item.retries, effective.retries),
    outputSchema: outputSchema.schema,
    outputSchemaError: outputSchema.error,
    label: typeof (item && item.label) === 'string' ? item.label.trim().slice(0, 80) : '',
    prompt: agent && agent.prompt ? agent.prompt : '',
    agentName: agent ? agent.name : '',
    worktree: item && item.worktree !== undefined ? item.worktree === true : effective.worktree === true,
    // An unknown name must fail the task before a child starts: silently
    // running a generic subagent would make the caller believe it got the role.
    agentError: agentRequested && !agent
      ? 'Unknown subagent agent "' + String(item.agent).trim() + '". Available agents: '
        + (AGENT_NAMES.join(', ') || 'none')
      : ''
  };
}

const OutputSchemaParam = Type.Optional(Type.Any({
  description: 'A JSON Schema (the common subset: type, required, properties, items, enum, const, length/number bounds). The child must answer with a single JSON value that matches it; anything else fails the task instead of passing as success.'
}));

const TaskItem = Type.Object({
  task: Type.String({ description: 'A complete, self-contained briefing for the child: goal, exact paths or data, constraints and definition of done. The child cannot see this conversation.' }),
  label: Type.Optional(Type.String({ description: 'A short human-readable name for this task, shown in the subagent tree instead of the whole briefing.' })),
  agent: Type.Optional(Type.String({ description: 'Name of a named agent preset for this task. Available agents are listed in the tool description; an unknown name fails the task before a child starts.' })),
  cwd: Type.Optional(Type.String({ description: 'Working directory for this task, resolved inside the current project.' })),
  model: Type.Optional(Type.String({ description: 'Model override for this task only, for example provider/model.' })),
  thinking: Type.Optional(Type.String({ description: 'Thinking level override for this task only.' })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Tool allowlist for this task only.' })),
  timeoutMs: Type.Optional(Type.Number({ description: 'Wall-clock timeout for this task in milliseconds (1000-86400000, default 1800000).' })),
  retries: Type.Optional(Type.Number({ description: 'Retries for this task, 0-2. A retry happens only when the attempt never reached the model, so no work is repeated.' })),
  outputSchema: OutputSchemaParam,
  worktree: Type.Optional(Type.Boolean({ description: 'Run this task in its own git worktree and branch. Parallel write tasks then cannot overwrite each other; a worktree with changes is kept and the branch is reported.' }))
});

const SubagentParams = Type.Object({
  task: Type.Optional(Type.String({ description: 'One self-contained task to delegate. Write a full briefing: the child sees no conversation history.' })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: 'Independent tasks to delegate in parallel (max 8). Each may carry its own label, agent, cwd, model, thinking, tools, timeoutMs, retries and outputSchema.' })),
  agent: Type.Optional(Type.String({ description: 'Name of a named agent preset for a single task. Available agents are listed in the tool description; an unknown name fails the task before a child starts.' })),
  cwd: Type.Optional(Type.String({ description: 'Default working directory for the child processes, resolved inside the current project.' })),
  model: Type.Optional(Type.String({ description: 'Default model override, for example provider/model.' })),
  thinking: Type.Optional(Type.String({ description: 'Default thinking level override.' })),
  tools: Type.Optional(Type.Array(Type.String(), { description: 'Default allowlist of tool names for the children.' })),
  timeoutMs: Type.Optional(Type.Number({ description: 'Default wall-clock timeout in milliseconds for every task in this call (1000-86400000, default 1800000).' })),
  concurrency: Type.Optional(Type.Number({ description: 'Maximum tasks of this batch running at once (1-8, default 4; the process-wide cap is 4).' })),
  retries: Type.Optional(Type.Number({ description: 'Default retry count for this call, 0-2. Only an attempt that never reached the model is retried.' })),
  outputSchema: OutputSchemaParam,
  worktree: Type.Optional(Type.Boolean({ description: 'Run every task of this batch in its own git worktree and branch, so parallel write tasks cannot overwrite each other.' })),
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

function runGit(args, cwd) {
  return new Promise(resolve => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        message: error ? (error.message || String(error)) : ''
      });
    });
  });
}

/**
 * Give one task its own git worktree, inside the project so the realpath cwd
 * sandbox still holds. The name is a generated slug, never caller-supplied, so
 * a task brief cannot choose a path or a branch ref.
 */
async function createWorktree(defaultCwd) {
  const repo = await runGit(['rev-parse', '--is-inside-work-tree'], defaultCwd);
  if (!repo.ok || repo.stdout.trim() !== 'true') {
    return { error: 'worktree requires a git repository: ' + (repo.stderr.trim() || repo.message || 'git rev-parse failed') };
  }
  const name = 'pi-subagent-' + randomUUID().slice(0, 12);
  const branch = 'pi-subagent/' + name;
  const worktreePath = path.join(defaultCwd, WORKTREE_ROOT, name);
  const parent = path.join(defaultCwd, WORKTREE_ROOT);
  if (!resolvesExistingAncestorInside(defaultCwd, parent)) {
    return { error: 'worktree directory escapes the project' };
  }
  mkdirSync(parent, { recursive: true });
  if (!resolvesInside(defaultCwd, parent)) {
    return { error: 'worktree directory escapes the project' };
  }
  const add = await runGit(['worktree', 'add', '-b', branch, '--', worktreePath], defaultCwd);
  if (!add.ok) {
    return { error: 'git worktree add failed: ' + (add.stderr.trim() || add.message) };
  }
  if (!safeWorkingDirectory(defaultCwd, path.join(WORKTREE_ROOT, name))) {
    await runGit(['worktree', 'remove', '--force', worktreePath], defaultCwd);
    return { error: 'worktree resolved outside the project after creation' };
  }
  // Keep the worktree directory out of git status without touching the
  // user's committed .gitignore: info/exclude is local to this repository.
  try {
    const excludePath = await runGit(['rev-parse', '--git-path', 'info/exclude'], defaultCwd);
    const target = path.resolve(defaultCwd, excludePath.stdout.trim());
    const exclusion = '/' + WORKTREE_ROOT + '/';
    const existing = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (!existing.split(/\\r?\\n/).includes(exclusion)) {
      mkdirSync(path.dirname(target), { recursive: true });
      appendFileSync(target, (existing && !existing.endsWith('\\n') ? '\\n' : '') + exclusion + '\\n', 'utf8');
    }
  } catch {
    // A missing info/exclude only costs a noisy git status, not isolation.
  }
  return { name, branch, path: worktreePath };
}

function resolvesInside(root, candidate) {
  try {
    const relative = path.relative(realpathSync(root), realpathSync(candidate));
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function resolvesExistingAncestorInside(root, candidate) {
  try {
    const rootReal = realpathSync(root);
    let ancestor = path.resolve(candidate);
    while (true) {
      try {
        lstatSync(ancestor);
        break;
      } catch (error) {
        if (error?.code !== 'ENOENT') return false;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return false;
        ancestor = parent;
      }
    }
    const realAncestor = realpathSync(ancestor);
    const relative = path.relative(rootReal, realAncestor);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

/**
 * Keep a worktree only when the child actually produced something: uncommitted
 * changes or a commit the parent branch does not have. Otherwise remove the
 * worktree and its branch so a failed read-only task leaves nothing behind.
 */
async function finalizeWorktree(worktree, defaultCwd) {
  const status = await runGit(['-C', worktree.path, 'status', '--porcelain'], defaultCwd);
  const childHead = await runGit(['-C', worktree.path, 'rev-parse', 'HEAD'], defaultCwd);
  const parentHead = await runGit(['rev-parse', 'HEAD'], defaultCwd);
  const hasChanges = status.ok && status.stdout.trim().length > 0;
  const hasCommits = childHead.ok && parentHead.ok && childHead.stdout.trim() !== parentHead.stdout.trim();
  const kept = hasChanges || hasCommits || !status.ok || !childHead.ok;
  if (kept) {
    return {
      name: worktree.name,
      branch: worktree.branch,
      path: worktree.path,
      kept: true,
      reason: hasChanges ? 'the child left uncommitted changes' : hasCommits ? 'the child created a commit' : 'git status could not be read'
    };
  }
  const removed = await runGit(['worktree', 'remove', '--force', worktree.path], defaultCwd);
  if (removed.ok) {
    await runGit(['branch', '-D', worktree.branch], defaultCwd);
  }
  return {
    name: worktree.name,
    branch: worktree.branch,
    path: worktree.path,
    kept: false,
    reason: 'the child produced no changes; the worktree and branch were cleaned up'
  };
}

function emptyUsage() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0 };
}

function finalAssistantText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || message.role !== 'assistant') continue;
    if (!Array.isArray(message.content)) return { text: '', truncated: false };
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
    return { text: parts.join('') + (truncated ? notice : ''), truncated };
  }
  return { text: '', truncated: false };
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
    // Keep schema-definition failures and answer mismatches visible to the parent.
    return 'Subagent outputSchema validation failed: '
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
  if (params.prompt) {
    systemPrompt += '\\n\\n' + params.prompt;
  }
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
    && result.sawTool !== true
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
    /** True once a tool started; such an attempt must never be retried. */
    sawTool: false,
    /** The parsed answer when the task ran with an outputSchema. */
    structured: undefined,
    /** Why the answer did not match outputSchema, when it did not. */
    schemaError: undefined,
    /** The worktree and branch this task ran in, when isolation was requested. */
    worktree: undefined
  };
  if (!workingDirectory) {
    result.exitCode = 1;
    result.errorMessage = 'Subagent working directory must be an existing folder inside the current project.';
    result.stopReason = 'error';
    result.status = 'failed';
    result.finishedAt = Date.now();
    return Promise.resolve(result);
  }
  const schemaProblem = params.outputSchemaError || (params.outputSchema !== undefined
    ? outputSchemaDefinitionError(params.outputSchema)
    : '');
  if (schemaProblem) {
    result.exitCode = 1;
    result.stopReason = 'schema';
    result.schemaError = schemaProblem;
    result.errorMessage = 'Subagent outputSchema is invalid or unsupported: ' + schemaProblem;
    result.status = 'failed';
    result.finishedAt = Date.now();
    return Promise.resolve(result);
  }
  const messages = [];
  let transcriptBytes = 0;
  let lastProgressAt = 0;
  let outputTruncated = false;
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
        const checked = outputTruncated
          ? { ok: false, error: 'the final answer was truncated and cannot be fully validated' }
          : checkOutputSchema(params.outputSchema, result.output);
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
        result.sawTool = true;
        activeTools.set(event.toolCallId, event.toolName || 'tool');
        setActivity('Running a tool', [...activeTools.values()].join(', '));
      } else if (event.type === 'tool_execution_end') {
        result.sawTool = true;
        activeTools.delete(event.toolCallId);
        setActivity(activeTools.size ? 'Running a tool' : 'Working', activeTools.size ? [...activeTools.values()].join(', ') : undefined);
      }
      if ((event.type === 'message_end' || event.type === 'tool_result_end') && event.message) {
        const message = event.message;
        if (message.role === 'assistant') {
          const final = finalAssistantText([message]);
          result.output = final.text;
          outputTruncated = final.truncated;
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
    description: 'Delegate self-contained work to isolated Pi subagents. Each child runs in its own process and context window: it sees only the briefing you write, the project files and the tools you allow. Use task for one child, or tasks for a parallel batch (max 8, default concurrency 4, default timeout 30 minutes). Write a complete briefing and give each task a short label; per-task agent, model, thinking, tools, timeoutMs, retries and cwd may differ. Give a task an outputSchema when you need a machine-checkable answer: the child must then reply with one JSON value that matches it, and a mismatch fails the task instead of passing as success. Set worktree when a task writes files in parallel with other tasks: it runs in its own git worktree and branch, so the writes cannot collide; a worktree with changes is kept and its branch is reported, a clean one is removed. Every child returns a final text report, with status, usage, attempts and transcript in the details.${agentRoster}',
    parameters: SubagentParams,
    promptSnippet: 'Delegate self-contained work to isolated subagents',
    promptGuidelines: [
      'Use the subagent tool when work is independent enough to run in a fresh context, when several files or questions can be explored in parallel, or when a long investigation would otherwise fill the main context.',
      'Write each subagent task as a complete briefing: state the goal, the exact paths or data to use, the constraints and the definition of done. A child cannot see this conversation, so never refer to "the file we discussed" without naming it.',
      'Use the subagent tool with a tasks array for independent work that can run at the same time; keep one coherent goal per task and give each a short label so the results are easy to tell apart.',
      'Do not use the subagent tool for a trivial one-step read or edit that is cheaper to do directly, and do not delegate work that needs to see the live conversation.',
      'Set worktree to true when two or more delegated tasks may write to the same files, so each child gets its own git worktree and branch instead of overwriting another child. Review the reported branches before merging.',
      'Report every child result faithfully: if a child failed, timed out or was stopped, say so and show its error instead of claiming success.',
      ...${JSON.stringify(agentGuideline)}
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
        outputSchema: parseOutputSchema(params.outputSchema),
        worktree: params.worktree === true
      };
      // One controller per task, keyed the way the app names the row, so
      // /desktop-subagent-cancel can stop exactly one child and leave its
      // siblings running.
      const taskSlot = (index, cancelQueued) => {
        const controller = new AbortController();
        const taskId = (toolCallId || 'subagent') + ':' + index;
        const release = registerTaskCancel(taskId, controller, cancelQueued);
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
          agent: params.agent,
          // The call's own values stay in the item so they can beat the named
          // agent's preset; effective.model etc. already carry Settings and the
          // dispatching session as the next fallback.
          model: params.model,
          thinking: params.thinking,
          tools: params.tools,
          timeoutMs: params.timeoutMs,
          retries: params.retries,
          outputSchema: params.outputSchema
        });
        if (perTask.agentError) {
          const failed = queuedTaskResult(ctx.cwd, perTask, effective.task, effective.cwd, 'failed', perTask.agentError);
          return {
            content: [{ type: 'text', text: resultOutput(failed) }],
            details: { mode: 'single', results: [failed] },
            isError: true
          };
        }
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
      const slots = tasks.map((item, index) => taskSlot(index, () => {
        if (results[index].status !== 'queued') return;
        const perTask = taskParams(effective, item);
        results[index] = queuedTaskResult(
          ctx.cwd,
          perTask,
          item.task,
          item.cwd || effective.cwd,
          'aborted',
          'Subagent task was stopped by the user.'
        );
        results[index].cancelled = true;
        publishProgress();
      }));
      publishProgress();
      await mapWithConcurrency(tasks, effective.concurrency, async (item, index) => {
        const perTask = taskParams(effective, item);
        const slot = slots[index];
        let result;
        try {
          result = results[index].cancelled
            ? results[index]
            // An unknown agent fails only this task, before any child starts;
            // its siblings keep their own slots and keep running.
            : perTask.agentError
              ? queuedTaskResult(ctx.cwd, perTask, item.task, item.cwd || effective.cwd, 'failed', perTask.agentError)
              : markCancelled(
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
    description: 'Stop one running or queued subagent task by its id (toolCallId:index)',
    handler: async value => {
      const taskId = String(value || '').trim();
      if (!taskId) throw new Error('Usage: /desktop-subagent-cancel <taskId>');
      const task = taskCancels.get(taskId);
      if (!task) throw new Error('No running subagent task: ' + taskId);
      task.controller.abort();
      task.cancelQueued?.();
    }
  });

  // A kept worktree is the user's to merge or discard; this removes it only
  // when explicitly named, and only from the directory the tool created.
  pi.registerCommand('desktop-subagent-worktree-remove', {
    description: 'Remove a kept subagent worktree and its branch by name',
    handler: async value => {
      const name = String(value || '').trim();
      if (!WORKTREE_NAME_PATTERN.test(name)) {
        throw new Error('Usage: /desktop-subagent-worktree-remove <pi-subagent-...>');
      }
      const worktreePath = path.join(process.cwd(), WORKTREE_ROOT, name);
      if (!resolvesInside(process.cwd(), worktreePath)) {
        throw new Error('Worktree path escapes the project');
      }
      const removed = await runGit(['worktree', 'remove', '--force', worktreePath], process.cwd());
      if (!removed.ok) throw new Error('Could not remove worktree: ' + (removed.stderr.trim() || removed.message));
      await runGit(['branch', '-D', 'pi-subagent/' + name], process.cwd());
    }
  });
}
`
}

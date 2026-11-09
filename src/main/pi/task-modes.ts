/** The modes Settings can seed into a process: Plan Mode on or off. */
import {
  EXTERNAL_CONTEXT_ENTRY,
  EXTERNAL_CONTEXT_CHECKED_ENTRY,
  EXTERNAL_CONTEXT_CLASSIFICATION_VERSION,
  EXTERNAL_CONTEXT_UNKNOWN_ENTRY,
  EXTERNAL_TOOL_OVERRIDE_ENTRY,
  LOCAL_BUILTIN_TOOL_NAMES,
  LOCAL_TOOL_NAMES
} from '../memory/policy'

export type TaskModeSeed = 'default' | 'plan'

/**
 * Runs inside Pi so mode state, tool selection and goal continuation belong to the session.
 *
 * `computerUse` is the Settings switch at the moment this process starts.
 * A later toggle arrives as `/desktop-computer on|off` and does not change the mode.
 *
 * `defaultMode` is the mode a session with nothing recorded starts in, which is how
 * "start new conversations in Plan Mode" reaches the agent. The extension source is
 * regenerated per process, so the seed is baked here and never broadcast to running
 * conversations — one already in progress is the user's, not the switch's to flip.
 */
export function taskModesExtension(
  computerUse = false,
  defaultMode: TaskModeSeed = 'default',
  extensionPath = 'pi-desktop-task-modes'
): string {
  // Narrowed before it is interpolated, so the literal can only ever be a known mode.
  const seededMode = defaultMode === 'plan' ? 'plan' : 'default'
  return `import { Type } from 'typebox';
export default function (pi) {
  const stateType = 'pi-desktop-mode';
  const goalType = 'pi-desktop-goal';
  const finishTool = 'desktop_goal_finish';
  const exitPlanTool = 'exit_plan_mode';
  const subagentTool = 'subagent';
  const computerTool = 'computer';
  const todoTool = 'desktop_todo';
  const externalContextEntry = ${JSON.stringify(EXTERNAL_CONTEXT_ENTRY)};
  const externalContextCheckedEntry = ${JSON.stringify(EXTERNAL_CONTEXT_CHECKED_ENTRY)};
  const externalContextClassificationVersion = ${JSON.stringify(EXTERNAL_CONTEXT_CLASSIFICATION_VERSION)};
  const externalContextUnknownEntry = ${JSON.stringify(EXTERNAL_CONTEXT_UNKNOWN_ENTRY)};
  const externalOverrideEntry = ${JSON.stringify(EXTERNAL_TOOL_OVERRIDE_ENTRY)};
  const taskModeExtensionPath = ${JSON.stringify(extensionPath)};
  const localBuiltinTools = new Set(${JSON.stringify(LOCAL_BUILTIN_TOOL_NAMES)});
  const localMemoryTools = new Set(${JSON.stringify(LOCAL_TOOL_NAMES)});
  const externalToolOverrides = new Set();
  let externalContextUsed = false;
  let externalContextUnknown = false;
  const readTools = new Set(['read', 'grep', 'find', 'ls']);
  // Kept out of the restored loadout and added back only while the setting is on.
  // Plan Mode never receives it.
  const managedTools = new Set([finishTool, exitPlanTool, computerTool, todoTool]);
  const modes = ['default', 'goal', 'plan', 'subagent', 'plugin'];
  // The mode a conversation starts in when its own session entries say nothing.
  const startMode = ${JSON.stringify(seededMode)};
  let mode = startMode;
  let computerEnabled = ${computerUse ? 'true' : 'false'};
  let goal;
  let originalTools;

  function isLocalToolImplementation(name, tool) {
    if (localBuiltinTools.has(name)) return tool?.sourceInfo?.source === 'builtin';
    return localMemoryTools.has(name) && tool?.sourceInfo?.path === taskModeExtensionPath;
  }

  function currentContextCheckIndex(entries) {
    let lastMessageIndex = -1;
    let lastCheckIndex = -1;
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.type === 'message') lastMessageIndex = index;
      if (
        entry.type === 'custom' &&
        entry.customType === externalContextCheckedEntry &&
        entry.data?.version === externalContextClassificationVersion
      ) lastCheckIndex = index;
    }
    return lastCheckIndex > lastMessageIndex ? lastCheckIndex : -1;
  }

  function appendContextClassification() {
    if (externalContextUsed) {
      pi.appendEntry(externalContextEntry, {});
    } else if (externalContextUnknown) {
      pi.appendEntry(externalContextUnknownEntry, {});
    } else {
      pi.appendEntry(externalContextCheckedEntry, { version: externalContextClassificationVersion });
    }
  }

  function publish(ctx) {
    ctx.ui.setStatus(stateType, mode);
    if (goal) ctx.ui.setStatus(goalType, JSON.stringify({ text: goal.text, status: goal.status, summary: goal.summary }));
    else ctx.ui.setStatus(goalType, undefined);
  }
  function persist(ctx) {
    pi.appendEntry(stateType, { mode, goal, originalTools });
    publish(ctx);
  }
  function baseTools() {
    return originalTools ?? pi.getActiveTools().filter(name => !managedTools.has(name));
  }
  function applyTools() {
    const base = baseTools();
    if (mode !== 'default' && !originalTools) originalTools = base;
    const registered = new Set(pi.getAllTools().map(tool => tool.name));
    const available = names => names.filter(name => registered.has(name));
    const withComputer = (names) => computerEnabled ? [...new Set([...names, computerTool])] : names;
    if (mode === 'plan') pi.setActiveTools(available([...readTools, exitPlanTool]));
    else if (mode === 'goal') pi.setActiveTools(available([...new Set(withComputer([...base, finishTool, todoTool]))]));
    else if (mode === 'subagent') pi.setActiveTools(available([...new Set(withComputer([...base, subagentTool, todoTool]))]));
    else pi.setActiveTools(available([...new Set(withComputer([...base, todoTool]))]));
    if (mode === 'default') originalTools = undefined;
  }
  function setMode(value, ctx) {
    if (!modes.includes(value)) throw new Error('Unknown task mode');
    if (!ctx.isIdle()) throw new Error('Stop the current run before changing modes');
    mode = value;
    applyTools();
    persist(ctx);
  }
  async function goalAction(value, ctx) {
    const text = (value || '').trim();
    const space = text.indexOf(' ');
    const action = (space === -1 ? text : text.slice(0, space)).toLowerCase();
    const rest = space === -1 ? '' : text.slice(space + 1).trim();
    if (action === 'pause') {
      if (!goal) throw new Error('No goal to pause');
      goal = { ...goal, status: 'paused' };
      persist(ctx);
      return;
    }
    if (action === 'resume') {
      if (!goal) throw new Error('No goal to resume');
      if (!ctx.isIdle()) throw new Error('Stop the current run before resuming the goal');
      goal = { ...goal, status: 'active' };
      mode = 'goal';
      applyTools();
      persist(ctx);
      pi.sendUserMessage('Continue toward the active goal: ' + goal.text);
      return;
    }
    if (action === 'clear') {
      if (!ctx.isIdle()) throw new Error('Stop the current run before clearing the goal');
      goal = undefined;
      mode = 'default';
      applyTools();
      persist(ctx);
      return;
    }
    if (action === 'edit') {
      if (!goal) throw new Error('No goal to edit');
      if (!rest) throw new Error('Usage: /desktop-goal edit <text>');
      goal = { ...goal, text: rest };
      persist(ctx);
      return;
    }
    throw new Error('Usage: /desktop-goal pause|resume|clear|edit <text>');
  }

  pi.on('session_start', (_event, ctx) => {
    if (originalTools) pi.setActiveTools(originalTools);
    mode = startMode; goal = undefined; originalTools = undefined;
    externalToolOverrides.clear();
    externalContextUsed = false;
    externalContextUnknown = false;
    const branch = ctx.sessionManager.getBranch();
    const toolsByName = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
    const lastContextCheckIndex = currentContextCheckIndex(branch);
    let hasUserMessage = false;
    for (let index = 0; index < branch.length; index++) {
      const entry = branch[index];
      if (entry.type === 'custom' && entry.customType === externalContextEntry) {
        externalContextUsed = true;
      }
      if (entry.type === 'custom' && entry.customType === externalContextUnknownEntry) {
        externalContextUnknown = true;
      }
      if (entry.type === 'custom' && entry.customType === externalOverrideEntry && entry.data) {
        const names = Array.isArray(entry.data.toolNames) ? entry.data.toolNames : [entry.data.toolName];
        for (const name of names) {
          if (localMemoryTools.has(name)) {
            externalToolOverrides.add(name);
            externalContextUsed = true;
          }
        }
      }
      if (entry.type === 'message' && entry.message) {
        if (entry.message.role === 'user') hasUserMessage = true;
        if (entry.message.role === 'assistant' && Array.isArray(entry.message.content)) {
          for (const block of entry.message.content) {
            if (block?.type !== 'toolCall') continue;
            if (!localMemoryTools.has(block.name)) {
              externalContextUsed = true;
              continue;
            }
            if (!isLocalToolImplementation(block.name, toolsByName.get(block.name))) {
              externalToolOverrides.add(block.name);
              externalContextUsed = true;
            } else if (index > lastContextCheckIndex) {
              // A legacy call's tool source was not persisted. The current
              // registration cannot prove what implementation ran then.
              externalContextUnknown = true;
            }
          }
        }
      }
      if (entry.type === 'custom' && entry.customType === stateType && entry.data) {
        mode = modes.includes(entry.data.mode) ? entry.data.mode : 'default';
        goal = entry.data.goal;
        originalTools = entry.data.originalTools;
      }
    }
    if (hasUserMessage) {
      appendContextClassification();
    }
    applyTools(); publish(ctx);
    // A seeded default belongs to the process, not to the conversation. Writing it
    // down is what keeps this one in Plan Mode after the setting is turned off.
    if (mode !== 'default') persist(ctx);
  });

  pi.registerCommand('desktop-mode', {
    description: 'Change the desktop task mode',
    handler: async (value, ctx) => {
      setMode(value.trim(), ctx);
    }
  });

  pi.registerCommand('desktop-goal', {
    description: 'Pause, resume, clear or edit the desktop goal',
    handler: async (value, ctx) => {
      await goalAction(value, ctx);
    }
  });

  pi.registerCommand('desktop-computer', {
    description: 'Turn Computer Use on or off without changing the task mode',
    handler: async (value) => {
      const text = (value || '').trim().toLowerCase();
      if (text !== 'on' && text !== 'off') throw new Error('Usage: /desktop-computer on|off');
      computerEnabled = text === 'on';
      applyTools();
    }
  });

  pi.registerCommand('plan', {
    description: 'Enter Plan Mode, or use /plan off to leave it',
    handler: async (value, ctx) => {
      const text = (value || '').trim();
      if (text.toLowerCase() === 'off') {
        setMode('default', ctx);
        return;
      }
      setMode('plan', ctx);
      if (text) pi.sendUserMessage(text);
    }
  });

  pi.registerCommand('plugin', {
    description: 'Enter Plugin Mode to build or modify a Pi extension, or use /plugin off to leave it',
    handler: async (value, ctx) => {
      const text = (value || '').trim();
      if (text.toLowerCase() === 'off') {
        setMode('default', ctx);
        return;
      }
      setMode('plugin', ctx);
      if (text) pi.sendUserMessage(text);
    }
  });

  pi.registerCommand('goal', {
    description: 'Set a goal, or use /goal off|pause|resume',
    handler: async (value, ctx) => {
      const text = (value || '').trim();
      const action = text.toLowerCase();
      if (action === 'off') {
        if (!ctx.isIdle()) throw new Error('Stop the current run before clearing the goal');
        goal = undefined;
        mode = 'default';
        applyTools();
        persist(ctx);
        return;
      }
      if (action === 'pause' || action === 'resume') {
        await goalAction(text, ctx);
        return;
      }
      if (text) {
        if (!ctx.isIdle()) throw new Error('Stop the current run before changing modes');
        mode = 'goal';
        goal = { text, status: 'active' };
        applyTools();
        persist(ctx);
        pi.sendUserMessage(text);
        return;
      }
      setMode('goal', ctx);
    }
  });

  pi.on('input', (event, ctx) => {
    if (mode !== 'goal' || event.source === 'extension' || event.text.trimStart().startsWith('/')) return;
    goal = goal?.status === 'active'
      ? { ...goal, text: goal.text + '\\n' + event.text }
      : { text: event.text, status: 'active' };
    persist(ctx);
  });

  pi.on('before_agent_start', () => {
    if (mode === 'plan') return { message: {
      customType: 'desktop-plan-context', display: false,
      content: 'Plan Mode is active. Inspect files using the read-only tools, clarify requirements when necessary, and produce an actionable plan. Do not modify files or execute commands. When the plan is ready, call exit_plan_mode with the complete plan so the user can approve it.'
    } };
    if (mode === 'goal' && goal?.status === 'active') return { message: {
      customType: 'desktop-goal-context', display: false,
      content: 'Goal Mode is active. Keep working toward the user goal and verify the outcome. Before finishing, call desktop_goal_finish with status complete and a summary only when all requested work is done, or status blocked when user input, approval or an unavailable external dependency prevents progress. Do not mark incomplete work complete. Goal: ' + goal.text
    } };
    if (mode === 'subagent') return { message: {
      customType: 'desktop-subagent-context', display: false,
      content: 'Subagent Mode is active. Delegate self-contained work to isolated subagents with the subagent tool instead of doing it in the main context. Keep the main conversation focused on orchestrating the subagents and reviewing their results. Do not delegate Computer Use; the computer tool is main-agent only.'
    } };
    if (mode === 'plugin') return { message: {
      customType: 'desktop-plugin-context', display: false,
      content: 'Plugin Mode is active. Build or modify a Pi extension for the user. Read the Pi extension documentation and a working example first (docs/extensions.md and examples/extensions in the Pi package). Keep the extension small and self-contained: register tools, commands, UI or hooks through the pi API instead of changing Pi itself. Put a global extension in ~/.pi/agent/extensions/<name>.ts, or a project-local one in .pi/extensions/<name>.ts. After writing it, load it with a throwaway pi run using -e ./path.ts to confirm it registers, then stop that process. Report the file path and how the user enables or reloads it.'
    } };
    if (computerEnabled) return { message: {
      customType: 'desktop-computer-context', display: false,
      content: 'Computer Use is enabled in Settings. Operate the Windows desktop with the computer tool. Call screenshot before any click, move or scroll, and use only pixels from that image (origin top-left). Window bounds are not click coordinates. After each action, screenshot again before deciding the next step. Prefer a file, command or API when one can do the job; use the desktop for a native app UI. Do not delegate Computer Use to a subagent. The setting already approved these actions.'
    } };
  });

  pi.on('tool_call', event => {
    if (mode !== 'plan') return;
    const builtinReadTools = new Set(
      pi.getAllTools()
        .filter(tool => readTools.has(tool.name) && tool.sourceInfo?.source === 'builtin')
        .map(tool => tool.name)
    );
    if (event.toolName !== exitPlanTool && !builtinReadTools.has(event.toolName)) {
      return { block: true, reason: 'Plan Mode only allows read-only file tools and exit_plan_mode', terminate: true };
    }
  });

  pi.on('tool_result', event => {
    if (!localMemoryTools.has(event.toolName)) {
      externalContextUsed = true;
      pi.appendEntry(externalContextEntry, {});
      return;
    }
    const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName);
    if (isLocalToolImplementation(event.toolName, tool)) return;
    externalToolOverrides.add(event.toolName);
    externalContextUsed = true;
    pi.appendEntry(externalOverrideEntry, { toolName: event.toolName });
    pi.appendEntry(externalContextEntry, {});
  });

  // Keep the classification near the session tail so bounded reads of long
  // conversations still see outside context from earlier turns.
  pi.on('agent_end', () => {
    appendContextClassification();
    if (externalToolOverrides.size) {
      pi.appendEntry(externalOverrideEntry, { toolNames: [...externalToolOverrides] });
    }
  });

  pi.registerTool({
    name: exitPlanTool, label: 'Exit plan mode',
    description: 'Submit the finished plan to the user for approval. The user may approve it, which leaves Plan Mode and begins implementation, or reject it so planning continues.',
    parameters: Type.Object({ plan: Type.String({ minLength: 1 }) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      if (mode !== 'plan') throw new Error('exit_plan_mode is only available in Plan Mode');
      const approved = await ctx.ui.confirm('Approve this plan?', input.plan);
      if (!approved) {
        return { content: [{ type: 'text', text: 'Plan not approved. Keep planning and ask the user what to change.' }], details: { approved: false } };
      }
      mode = 'default';
      applyTools();
      persist(ctx);
      return { content: [{ type: 'text', text: 'Plan approved. Implement it now.' }], details: { approved: true } };
    }
  });

  pi.registerTool({
    name: finishTool, label: 'Finish goal',
    description: 'End Goal Mode work after verifying completion, or report a blocker that requires user input or an external change. Never report incomplete work as complete.',
    parameters: Type.Object({ status: Type.Union([Type.Literal('complete'), Type.Literal('blocked')]), summary: Type.String({ minLength: 1 }) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      if (mode !== 'goal' || goal?.status !== 'active') throw new Error('No active goal');
      goal = { ...goal, status: input.status, summary: input.summary };
      persist(ctx);
      return { content: [{ type: 'text', text: input.summary }], details: { status: input.status } };
    }
  });

  pi.registerTool({
    name: todoTool, label: 'Update todo list',
    description: 'Replace the checklist of steps for the current task. Send the full list on every call: pending steps, at most one in_progress, completed only after the step is verified.',
    promptSnippet: 'Keep the checklist of the current task',
    promptGuidelines: [
      'Use desktop_todo whenever a task takes more than two steps: send the whole list each time, keep at most one step in_progress, and mark a step completed only after it is verified. Update the list when the plan changes.'
    ],
    parameters: Type.Object({
      items: Type.Array(Type.Object({
        text: Type.String({ minLength: 1, maxLength: 200 }),
        status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')])
      }), { minItems: 1, maxItems: 20 })
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, input) {
      const items = input.items;
      const done = items.filter(item => item.status === 'completed').length;
      const lines = items.map(item => '- [' + (item.status === 'completed' ? 'x' : ' ') + '] ' + item.text + (item.status === 'in_progress' ? ' (in progress)' : ''));
      return { content: [{ type: 'text', text: 'Todo (' + done + '/' + items.length + '):\\n' + lines.join('\\n') }], details: { items } };
    }
  });

  pi.on('turn_end', (event, ctx) => {
    if (mode === 'goal' && goal?.status === 'active' && event.toolResults.some(result => result.isError && /did not approve|not approved|approval is unavailable/i.test(JSON.stringify(result.content)))) {
      goal = { ...goal, status: 'blocked', summary: 'A tool operation was not approved' };
      persist(ctx);
    }
  });

  pi.on('agent_before_settle', (event, ctx) => {
    if (mode !== 'goal' || goal?.status !== 'active') return;
    if (event.outcome !== 'completed') {
      goal = { ...goal, status: 'blocked', summary: event.outcome === 'aborted' ? 'Stopped by user' : 'The runtime could not continue' };
      persist(ctx); return;
    }
    if (event.continue) return;
    return { continue: true, entries: [{ type: 'custom_message', customType: 'desktop-goal-continue', display: false,
      content: 'Continue toward the active goal: ' + goal.text + '\\nIf all work is verified complete, call desktop_goal_finish with complete. If progress requires user input or an external change, call it with blocked and explain the blocker.' }] };
  });

  pi.on('agent_settled', (event, ctx) => {
    if (mode === 'goal' && goal?.status === 'active') {
      goal = { ...goal, status: 'blocked', summary: event.aborted ? 'Stopped by user' : 'The runtime could not continue' };
      persist(ctx);
    }
  });

  pi.on('context', event => ({ messages: event.messages.filter(message => {
    if (message.customType === 'desktop-plan-context') return mode === 'plan';
    if (message.customType === 'desktop-goal-context' || message.customType === 'desktop-goal-continue') return mode === 'goal' && goal?.status === 'active';
    if (message.customType === 'desktop-subagent-context') return mode === 'subagent';
    if (message.customType === 'desktop-plugin-context') return mode === 'plugin';
    if (message.customType === 'desktop-computer-context') return computerEnabled && mode !== 'plan';
    return true;
  }) }));
}`
}

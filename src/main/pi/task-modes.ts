/** Runs inside Pi so mode state, tool selection and goal continuation belong to the session. */
export function taskModesExtension(): string {
  return `import { Type } from 'typebox';
export default function (pi) {
  const stateType = 'pi-desktop-mode';
  const goalType = 'pi-desktop-goal';
  const finishTool = 'desktop_goal_finish';
  const exitPlanTool = 'exit_plan_mode';
  const subagentTool = 'subagent';
  const computerTool = 'computer';
  const readTools = new Set(['read', 'grep', 'find', 'ls']);
  // Computer Use is added only while that mode is on, so it must not stick
  // in the loadout the other modes restore.
  const managedTools = new Set([finishTool, exitPlanTool, computerTool]);
  const modes = ['default', 'goal', 'plan', 'subagent', 'computer'];
  let mode = 'default';
  let goal;
  let originalTools;

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
    if (mode === 'plan') pi.setActiveTools(available([...readTools, exitPlanTool]));
    else if (mode === 'goal') pi.setActiveTools(available([...base, finishTool]));
    else if (mode === 'subagent') pi.setActiveTools(available([...new Set([...base, subagentTool])]));
    else if (mode === 'computer') pi.setActiveTools(available([...new Set([...base, computerTool])]));
    else pi.setActiveTools(base);
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
    mode = 'default'; goal = undefined; originalTools = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === stateType && entry.data) {
        mode = modes.includes(entry.data.mode) ? entry.data.mode : 'default';
        goal = entry.data.goal;
        originalTools = entry.data.originalTools;
      }
    }
    applyTools(); publish(ctx);
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

  pi.registerCommand('computer', {
    description: 'Enter Computer Use, or use /computer off to leave it',
    handler: async (value, ctx) => {
      const text = (value || '').trim();
      if (text.toLowerCase() === 'off') {
        setMode('default', ctx);
        return;
      }
      setMode('computer', ctx);
      if (text) pi.sendUserMessage(text);
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
    if (mode === 'computer') return { message: {
      customType: 'desktop-computer-context', display: false,
      content: 'Computer Use is active. Operate the Windows desktop with the computer tool. Call screenshot before any click, move or scroll, and use only pixels from that image (origin top-left). Window bounds are not click coordinates. After each action, screenshot again before deciding the next step. Prefer a file, command or API when one can do the job; use the desktop for a native app UI. Do not delegate Computer Use to a subagent. Choosing this mode already approved these actions.'
    } };
  });

  pi.on('tool_call', event => {
    if (mode === 'plan' && event.toolName !== exitPlanTool && !readTools.has(event.toolName)) {
      return { block: true, reason: 'Plan Mode only allows read-only file tools and exit_plan_mode', terminate: true };
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
    if (message.customType === 'desktop-computer-context') return mode === 'computer';
    return true;
  }) }));
}`
}

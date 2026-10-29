/** Runs inside Pi so mode state, tool selection and goal continuation belong to the session. */
export function taskModesExtension(): string {
  return `import { Type } from 'typebox';
export default function (pi) {
  const stateType = 'pi-desktop-mode';
  const finishTool = 'desktop_goal_finish';
  const readTools = new Set(['read', 'grep', 'find', 'ls']);
  let mode = 'default';
  let goal;
  let originalTools;

  function publish(ctx) { ctx.ui.setStatus(stateType, mode); }
  function persist(ctx) {
    pi.appendEntry(stateType, { mode, goal, originalTools });
    publish(ctx);
  }
  function applyTools() {
    const base = originalTools ?? pi.getActiveTools().filter(name => name !== finishTool);
    if (mode !== 'default' && !originalTools) originalTools = base;
    const registered = new Set(pi.getAllTools().map(tool => tool.name));
    pi.setActiveTools(mode === 'plan'
      ? [...readTools].filter(name => registered.has(name))
      : mode === 'goal' ? [...base, finishTool] : base);
    if (mode === 'default') originalTools = undefined;
  }

  pi.on('session_start', (_event, ctx) => {
    if (originalTools) pi.setActiveTools(originalTools);
    mode = 'default'; goal = undefined; originalTools = undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === stateType && entry.data) {
        mode = ['goal', 'plan'].includes(entry.data.mode) ? entry.data.mode : 'default';
        goal = entry.data.goal;
        originalTools = entry.data.originalTools;
      }
    }
    applyTools(); publish(ctx);
  });

  pi.registerCommand('desktop-mode', {
    description: 'Change the desktop task mode',
    handler: async (value, ctx) => {
      if (!['default', 'goal', 'plan'].includes(value.trim())) throw new Error('Unknown task mode');
      if (!ctx.isIdle()) throw new Error('Stop the current run before changing modes');
      mode = value.trim(); goal = undefined;
      applyTools(); persist(ctx);
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
      content: 'Plan Mode is active. Inspect files using the read-only tools, clarify requirements when necessary, and produce an actionable plan. Do not modify files or execute commands. Wait for the user to leave Plan Mode before implementing changes.'
    } };
    if (mode === 'goal' && goal?.status === 'active') return { message: {
      customType: 'desktop-goal-context', display: false,
      content: 'Goal Mode is active. Keep working toward the user goal and verify the outcome. Before finishing, call desktop_goal_finish with status complete and a summary only when all requested work is done, or status blocked when user input, approval or an unavailable external dependency prevents progress. Do not mark incomplete work complete. Goal: ' + goal.text
    } };
  });

  pi.on('tool_call', event => {
    if (mode === 'plan' && !readTools.has(event.toolName)) {
      return { block: true, reason: 'Plan Mode only allows read-only file tools', terminate: true };
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
    return true;
  }) }));
}`
}

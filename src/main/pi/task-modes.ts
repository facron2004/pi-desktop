/** The modes Settings can seed into a process: Plan Mode on or off. */
import { AGENT_MODES, ASK_USER_TOOL_NAME, GOAL_CONTINUE_CUSTOM_TYPE, GOAL_STATUS_KEY, PLAN_REVIEW_TITLE, TASK_MODE_STATUS_KEY } from '@shared/types'
import {
  EXTERNAL_CONTEXT_ENTRY,
  EXTERNAL_CONTEXT_CHECKED_ENTRY,
  EXTERNAL_CONTEXT_CLASSIFICATION_VERSION,
  EXTERNAL_CONTEXT_UNKNOWN_ENTRY,
  EXTERNAL_TOOL_OVERRIDE_ENTRY,
  LOCAL_BUILTIN_TOOL_NAMES,
  LOCAL_TOOL_NAMES
} from '../memory/policy'
import { WORKSPACE_TOOL_HOOKS } from './workspace-tools'

export type TaskModeSeed = 'default' | 'plan'

/**
 * Tells the model to narrate each step in visible text before invoking tools.
 *
 * `AssistantMessage` relies on short visible commentary before tool batches
 * to explain each step in the reading column.
 */
export const PROGRESS_COMMENTARY_GUIDELINE =
  "Before calling tools—both at the start of a turn and before each new step after tool results—write a brief one-sentence progress note in plain text (in the user's language) explaining what you are about to do. Never run a chain of tool calls silently without visible text commentary."

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
  const stateType = ${JSON.stringify(TASK_MODE_STATUS_KEY)};
  const goalType = ${JSON.stringify(GOAL_STATUS_KEY)};
  const planContextType = 'desktop-plan-context';
  const goalContextType = 'desktop-goal-context';
  const finishTool = 'desktop_goal_finish';
  const exitPlanTool = 'exit_plan_mode';
  const questionTool = ${JSON.stringify(ASK_USER_TOOL_NAME)};
  const subagentTool = 'subagent';
  const computerTool = 'computer';
  const todoTool = 'desktop_todo';
  const swarmTools = ['swarm_spawn', 'swarm_task', 'swarm_collect', 'swarm_message', 'swarm_status', 'swarm_disband'];
  const progressGuideline = ${JSON.stringify(PROGRESS_COMMENTARY_GUIDELINE)};
  const externalContextEntry = ${JSON.stringify(EXTERNAL_CONTEXT_ENTRY)};
  const externalContextCheckedEntry = ${JSON.stringify(EXTERNAL_CONTEXT_CHECKED_ENTRY)};
  const externalContextClassificationVersion = ${JSON.stringify(EXTERNAL_CONTEXT_CLASSIFICATION_VERSION)};
  const externalContextUnknownEntry = ${JSON.stringify(EXTERNAL_CONTEXT_UNKNOWN_ENTRY)};
  const externalOverrideEntry = ${JSON.stringify(EXTERNAL_TOOL_OVERRIDE_ENTRY)};
  const goalContinueCustomType = ${JSON.stringify(GOAL_CONTINUE_CUSTOM_TYPE)};
  const taskModeExtensionPath = ${JSON.stringify(extensionPath)};
  const localBuiltinTools = new Set(${JSON.stringify(LOCAL_BUILTIN_TOOL_NAMES)});
  const localMemoryTools = new Set(${JSON.stringify(LOCAL_TOOL_NAMES)});
  const externalToolOverrides = new Set();
  let externalContextUsed = false;
  let externalContextUnknown = false;
  const readTools = new Set(['read', 'grep', 'find', 'ls']);
  const waitForPlanFeedback = 'The user chose to keep planning. Wait for their next message before doing more research or submitting a revised plan.';
  const waitForAnswer = 'No option was selected. Wait for the user to reply before continuing with this decision.';
  // Kept out of the restored loadout and added back only while the setting is on.
  // Plan Mode never receives it.
  const managedTools = new Set([finishTool, exitPlanTool, subagentTool, computerTool, todoTool, questionTool, ...swarmTools]);
  const modes = ${JSON.stringify(AGENT_MODES)};
  // Bound every automatic continuation, including a request to report the outcome.
  const maxGoalRounds = 40;
  // The mode a conversation starts in when its own session entries say nothing.
  const startMode = ${JSON.stringify(seededMode)};
  let mode = startMode;
  let planReviewState = 'ready';
  let questionCallId;
  let questionDismissed = false;
  let computerEnabled = ${computerUse ? 'true' : 'false'};
  let goal;
  let goalTextForRequest;
  let originalTools;
  let goalRounds = 0;
  let goalRoundWorked = false;
  let goalAskedForOutcome = false;
  // Options the composer handed over for the next image generation. They are
  // one-shot: the run they belong to consumes them, a later prompt does not.
  let imageRequest;
  let imageRunActive = false;

  ${WORKSPACE_TOOL_HOOKS}

  function isLocalToolImplementation(name, tool) {
    if (localBuiltinTools.has(name)) return tool?.sourceInfo?.source === 'builtin';
    return localMemoryTools.has(name) && tool?.sourceInfo?.path === taskModeExtensionPath;
  }

  function isPlanTool(name, tool) {
    return (readTools.has(name) || name === exitPlanTool || name === questionTool) && isLocalToolImplementation(name, tool);
  }

  function pausePlanTurn(text) {
    return { content: [{ type: 'text', text }], details: { approved: false }, terminate: true };
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
  function hasActiveGoal() {
    return mode === 'goal' && goal?.status === 'active';
  }
  function resetGoalRounds() {
    goalRounds = 0;
    goalRoundWorked = false;
    goalAskedForOutcome = false;
  }
  function goalContinueContent() {
    return 'Continue toward the active goal. If all work is verified complete, call desktop_goal_finish with complete. If progress requires user input or an external change, call it with blocked and explain the blocker.';
  }
  function baseTools() {
    return originalTools ?? pi.getActiveTools().filter(name => !managedTools.has(name));
  }
  function applyTools(base = baseTools()) {
    if (mode !== 'default' && !originalTools) originalTools = base;
    const registered = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
    if (mode === 'plan') {
      pi.setActiveTools([...readTools, exitPlanTool, questionTool].filter(name => isPlanTool(name, registered.get(name))));
    } else {
      const tools = [...base];
      if (mode === 'goal') tools.push(finishTool);
      else if (mode === 'swarm') tools.push(...swarmTools);
      tools.push(subagentTool, todoTool, questionTool);
      if (computerEnabled) tools.push(computerTool);
      pi.setActiveTools([...new Set(tools)].filter(name => registered.has(name) &&
        (name !== questionTool || isLocalToolImplementation(name, registered.get(name)))));
    }
    if (mode === 'default') originalTools = undefined;
  }
  function setMode(value, ctx) {
    if (!modes.includes(value)) throw new Error('Unknown task mode');
    if (!ctx.isIdle()) throw new Error('Stop the current run before changing modes');
    mode = value;
    planReviewState = 'ready';
    applyTools();
    persist(ctx);
  }
  async function goalAction(value, ctx) {
    const text = (value || '').trim();
    const space = text.indexOf(' ');
    const action = (space === -1 ? text : text.slice(0, space)).toLowerCase();
    const rest = space === -1 ? '' : text.slice(space + 1).trim();
    const stopGoalRun = hasActiveGoal() && !ctx.isIdle();
    if (action === 'pause') {
      if (!goal) throw new Error('No goal to pause');
      goal = { ...goal, status: 'paused' };
      persist(ctx);
      // Pause means stop spending work now, not after an arbitrarily long run.
      // The settled handler keeps the paused status because it only reacts to
      // an active goal.
      if (stopGoalRun) ctx.abort();
      return;
    }
    if (action === 'resume') {
      if (!goal) throw new Error('No goal to resume');
      if (!ctx.isIdle()) throw new Error('Stop the current run before resuming the goal');
      goal = { ...goal, status: 'active', summary: undefined };
      mode = 'goal';
      resetGoalRounds();
      applyTools();
      persist(ctx);
      // The same hidden continuation the settle boundary uses, so resuming a
      // goal never writes a user message the user did not type.
      pi.sendMessage({
        customType: goalContinueCustomType,
        content: goalContinueContent(),
        display: false,
        // Pi timestamps the wire message and its saved entry separately.
        details: { resumedAt: Date.now() }
      }, { triggerTurn: true });
      return;
    }
    if (action === 'complete') {
      if (!goal) throw new Error('No goal to complete');
      goal = { ...goal, status: 'complete', summary: rest || 'Completed by the user' };
      // A completed goal must not turn the next ordinary message into a new
      // goal: leave Goal Mode but keep the finished objective on screen.
      if (mode === 'goal') {
        mode = 'default';
        resetGoalRounds();
        applyTools();
      }
      persist(ctx);
      if (stopGoalRun) ctx.abort();
      return;
    }
    if (action === 'clear') {
      if (!ctx.isIdle()) throw new Error('Stop the current run before clearing the goal');
      goal = undefined;
      resetGoalRounds();
      if (mode === 'goal') {
        mode = 'default';
        applyTools();
      }
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
    throw new Error('Usage: /desktop-goal pause|resume|complete|clear|edit <text>');
  }

  function restoreBranchState(event, ctx) {
    const fromTree = event?.type === 'session_tree';
    const previousBase = originalTools;
    if (!fromTree && previousBase) pi.setActiveTools(previousBase);
    mode = startMode; goal = undefined; originalTools = undefined; imageRequest = undefined; imageRunActive = false;
    planReviewState = 'ready';
    questionCallId = undefined;
    questionDismissed = false;
    goalTextForRequest = undefined;
    resetGoalRounds();
    externalToolOverrides.clear();
    externalContextUsed = false;
    externalContextUnknown = false;
    const branch = ctx.sessionManager.getBranch();
    const toolsByName = new Map(pi.getAllTools().map(tool => [tool.name, tool]));
    const lastContextCheckIndex = currentContextCheckIndex(branch);
    let hasUserMessage = false;
    let hasSystemMessage = false;
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
        if (entry.message.role === 'system') hasSystemMessage = true;
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
        originalTools = Array.isArray(entry.data.originalTools)
          ? entry.data.originalTools.filter(name => name !== subagentTool)
          : undefined;
      }
    }
    if (!fromTree && hasUserMessage) {
      appendContextClassification();
    }
    // Pi restores the selected branch's system loadout before session_tree.
    // An empty branch leaves the tools from the old mode active.
    const base = originalTools ?? (fromTree && !hasSystemMessage ? previousBase : undefined) ?? baseTools();
    const selectedTools = fromTree || event?.reason === 'reload' ? base : withWorkspaceTools(base);
    if (originalTools) originalTools = selectedTools;
    applyTools(selectedTools);
    // A seeded default belongs to the process, not to the conversation. Writing it
    // down is what keeps this one in Plan Mode after the setting is turned off.
    if (!fromTree && mode !== 'default') persist(ctx);
    else publish(ctx);
  }
  pi.on('session_start', restoreBranchState);
  pi.on('session_tree', restoreBranchState);

  pi.registerCommand('desktop-mode', {
    description: 'Change the desktop task mode',
    handler: async (value, ctx) => {
      setMode(value.trim(), ctx);
    }
  });

  pi.registerCommand('desktop-image', {
    description: 'Prepare the image settings the next prompt must generate with',
    handler: async (value) => {
      const text = (value || '').trim();
      if (!text) throw new Error('Usage: /desktop-image <json>');
      let request;
      try { request = JSON.parse(text); } catch { throw new Error('Image request must be valid JSON'); }
      if (typeof request?.cancel === 'string') {
        if (imageRequest?.id === request.cancel) imageRequest = undefined;
        return;
      }
      if (!request || typeof request.prompt !== 'string' || !request.prompt.trim()) {
        throw new Error('Image prompt is required');
      }
      const count = Number(request.n);
      const references = Number(request.references);
      imageRequest = {
        id: request.id,
        prompt: request.prompt.trim(),
        model: typeof request.model === 'string' ? request.model.trim() : '',
        size: typeof request.size === 'string' ? request.size.trim() : '',
        quality: typeof request.quality === 'string' ? request.quality.trim() : '',
        n: Number.isFinite(count) ? Math.min(4, Math.max(1, Math.round(count))) : 1,
        references: Number.isFinite(references) && references > 0 ? Math.min(8, Math.round(references)) : 0
      };
    }
  });

  pi.registerCommand('desktop-goal', {
    description: 'Pause, resume, complete, clear or edit the desktop goal',
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

  pi.registerCommand('desktop-rewind', {
    description: 'Move this conversation back to before a message so it can be edited',
    handler: async (value, ctx) => {
      const targetId = (value || '').trim();
      if (!targetId) throw new Error('Usage: /desktop-rewind <entryId>');
      if (!ctx.isIdle()) throw new Error('Wait for the current turn to finish before editing');
      if (!ctx.sessionManager.getBranch().some(entry =>
        entry.id === targetId && entry.type === 'message' && entry.message?.role === 'user'
      )) throw new Error('This message is no longer on the active branch');
      // Mark the branch we are about to leave before leaving it. Its tip may be
      // a user message, and navigation treats a user message as "stop before
      // it", which would make the undo lose that last entry.
      pi.appendEntry('pi-desktop-rewind-source');
      const sourceId = ctx.sessionManager.getLeafId();
      const result = await ctx.navigateTree(targetId, { summarize: false });
      if (result.cancelled) {
        // Leave the session exactly where the caller found it.
        if (sourceId) await ctx.navigateTree(sourceId, { summarize: false }).catch(() => {});
        throw new Error('Editing was cancelled');
      }
      if (ctx.sessionManager.getLeafId() === targetId) {
        if (sourceId) await ctx.navigateTree(sourceId, { summarize: false }).catch(() => {});
        throw new Error('Could not move before this message');
      }
      // Navigation only moves Pi's in-memory leaf. Persist a child of the
      // selected leaf so reopening the JSONL follows the same branch, and keep
      // the branch we left reachable for the undo command.
      pi.appendEntry('pi-desktop-rewind', sourceId ? { previousLeafId: sourceId } : undefined);
    }
  });

  pi.registerCommand('desktop-undo-rewind', {
    description: 'Return to the branch a message edit left behind',
    handler: async (_value, ctx) => {
      if (!ctx.isIdle()) throw new Error('Wait for the current turn to finish before undoing the edit');
      const branch = ctx.sessionManager.getBranch();
      const leafId = ctx.sessionManager.getLeafId();
      // Only the marker the branch now ends on can be taken back. A second
      // edit leaves an older rewind marker further down the branch, and
      // find() walks from the root, so answering the oldest one would
      // always fail the leaf check below.
      const isRewindMarker = (entry) =>
        entry.type === 'custom' && entry.customType === 'pi-desktop-rewind';
      const marker = branch.find(entry => entry.id === leafId && isRewindMarker(entry));
      const anyRewindMarker = marker ? true : branch.some(isRewindMarker);
      const previousLeafId = marker && marker.data && typeof marker.data.previousLeafId === 'string'
        ? marker.data.previousLeafId
        : undefined;
      if (!marker || !previousLeafId) {
        throw new Error(anyRewindMarker
          ? 'The conversation has moved on since the edit'
          : 'There is nothing to undo');
      }
      if (!ctx.sessionManager.getEntry(previousLeafId)) {
        throw new Error('The earlier branch is gone');
      }
      await ctx.navigateTree(previousLeafId, { summarize: false });
      if (ctx.sessionManager.getLeafId() !== previousLeafId) {
        throw new Error('Could not return to the earlier branch');
      }
      // A child of the restored leaf, so reopening the JSONL lands here.
      pi.appendEntry('pi-desktop-undo-rewind');
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

  pi.registerCommand('swarm', {
    description: 'Enter Swarm Mode to lead a team of persistent workers, or use /swarm off to leave it',
    handler: async (value, ctx) => {
      const text = (value || '').trim();
      if (text.toLowerCase() === 'off') {
        setMode('default', ctx);
        return;
      }
      setMode('swarm', ctx);
      if (text) pi.sendUserMessage(text);
    }
  });

  pi.registerCommand('goal', {
    description: 'Set a goal, or use /goal off|pause|resume|complete',
    handler: async (value, ctx) => {
      const text = (value || '').trim();
      const action = text.toLowerCase();
      if (action === 'off') {
        await goalAction('clear', ctx);
        return;
      }
      if (action === 'pause' || action === 'resume' || action === 'complete') {
        await goalAction(text, ctx);
        return;
      }
      if (text) {
        if (!ctx.isIdle()) throw new Error('Stop the current run before changing modes');
        mode = 'goal';
        goal = { text, status: 'active' };
        resetGoalRounds();
        applyTools();
        persist(ctx);
        pi.sendUserMessage(text);
        return;
      }
      setMode('goal', ctx);
    }
  });

  pi.on('input', (event, ctx) => {
    if (event.source !== 'extension') questionDismissed = false;
    if (mode === 'plan' && planReviewState === 'waiting-feedback' && event.source !== 'extension') {
      planReviewState = 'ready';
    }
    const text = (event.text || '').trim();
    // An image-only message carries no objective, and a slash command is not
    // one either: neither should define or extend the goal.
    if (mode !== 'goal' || event.source === 'extension' || !text || text.startsWith('/')) return;
    // A paused goal is the user's to resume: this message is a one-off prompt,
    // not a new objective. A blocked goal keeps its objective and the message
    // is the input it was waiting for. An active goal keeps its objective too:
    // the message is already in the conversation the model sees, and folding it
    // into the goal would grow the objective into a transcript that is repeated
    // in every round's context.
    if (goal && goal.status === 'paused') return;
    let changed = false;
    if (!goal || goal.status === 'complete') {
      goal = { text, status: 'active' };
      changed = true;
    } else if (goal.status === 'blocked') {
      goal = { ...goal, status: 'active', summary: undefined };
      changed = true;
    }
    resetGoalRounds();
    if (changed) persist(ctx);
  });

  pi.on('before_agent_start', (event) => {
    guideWorkspaceTools(event);
    const guidelines = event?.systemPromptOptions?.promptGuidelines;
    if (Array.isArray(guidelines) && !guidelines.includes(progressGuideline)) {
      guidelines.push(progressGuideline);
    }
    imageRunActive = false;
    if (imageRequest) {
      const request = imageRequest;
      imageRequest = undefined;
      // The options belong to the prompt they were sent with. A later, normal
      // prompt must not inherit them just because the first send failed.
      if (typeof event?.prompt === 'string' && event.prompt.trim() === request.prompt) {
        imageRunActive = true;
        const selected = event?.systemPromptOptions?.selectedTools;
        if (Array.isArray(selected) && !selected.includes('generate_image')) {
          selected.push('generate_image');
        }
        const options = ['n=' + request.n];
        if (request.model) options.push('model=' + request.model);
        if (request.size) options.push('size=' + request.size);
        if (request.quality) options.push('quality=' + request.quality);
        const hasReferences = (Array.isArray(event?.images) && event.images.length > 0) || request.references > 0;
        const referenceNote = hasReferences
          ? 'The user attached reference image(s) to this message. Carefully inspect their subject, style, composition, lighting, colour palette and key visual details, and fold those details into your refined prompt so the generated picture follows the reference. '
          : '';
        const content = 'Image generation request: ' + request.prompt + '\\n\\n' + referenceNote + 'Refine it into one detailed image prompt: name the subject, style, composition, colours and any exact text that must appear in the picture. Then call generate_image exactly once with prompt set to the refined prompt and these options unchanged (' + options.join(', ') + '). Do not use any other tool, and do not ask questions when the request is clear. After the tool returns, keep your visible reply to one short sentence. Do not repeat the refined prompt or the saved file paths: the app shows the pictures below your reply and keeps the prompt folded inside the image card.';
        // A section lives for this run only. A returned message would stay in
        // the session and tell every later turn to draw another picture.
        const sections = event?.systemPromptOptions?.sections;
        if (sections && typeof sections === 'object') {
          sections['desktop-image'] = content;
          return;
        }
        return { systemPrompt: String(event?.systemPrompt || '') + '\\n\\n' + content };
      }
    }
    if (mode === 'plan') return { message: {
      customType: planContextType, display: false,
      content: 'Plan Mode is active. Inspect the relevant code with read-only tools. If a decision needs user input, use ' + questionTool + ' with clear options and wait for the choice. Once the plan is ready, show the complete Markdown in the visible reply with the goal, ordered checkbox steps, affected areas, verification, and any material risks. Then submit that same Markdown in one exit_plan_mode call on its own. Approval restores the implementation tools. If the user keeps planning, wait for their next message before revising or submitting again.'
    } };
    if (mode === 'swarm') return { message: {
      customType: 'desktop-swarm-context', display: false,
      content: 'Swarm Mode is active. Lead a small team of named workers that stay alive across turns. Create workers with swarm_spawn (one per coherent role), assign work with swarm_task, send follow-ups with swarm_message, gather background reports with swarm_collect, inspect the team with swarm_status and end it with swarm_disband. Give every assignment a complete briefing, keep the team no larger than the work needs, and report each worker result faithfully. Do not delegate Computer Use; the computer tool is main-agent only.'
    } };
    if (mode === 'plugin') return { message: {
      customType: 'desktop-plugin-context', display: false,
      content: 'Plugin Mode is active. Build or modify a Pi extension for the user. Read the Pi extension documentation and a working example first (docs/extensions.md and examples/extensions in the Pi package). Keep the extension small and self-contained: register tools, commands, UI or hooks through the pi API instead of changing Pi itself. Put a global extension in ~/.pi/agent/extensions/<name>.ts, or a project-local one in .pi/extensions/<name>.ts. After writing it, load it with a throwaway pi run using -e ./path.ts to confirm it registers, then stop that process. Report the file path and how the user enables or reloads it.'
    } };
    if (computerEnabled && !hasActiveGoal()) return { message: {
      customType: 'desktop-computer-context', display: false,
      content: 'Computer Use is enabled in Settings. Operate the Windows desktop with the computer tool. Call screenshot before any click, move or scroll, and use only pixels from that image (origin top-left). Window bounds are not click coordinates. After each action, screenshot again before deciding the next step. Prefer a file, command or API when one can do the job; use the desktop for a native app UI. Do not delegate Computer Use to a subagent. The setting already approved these actions.'
    } };
  });

  pi.on('message_end', ({ message }) => {
    if (message?.role !== 'assistant') return;
    // The next assistant request sees the answer before it chooses which other tools to run.
    questionCallId = Array.isArray(message.content)
      ? message.content.find(block => block.type === 'toolCall' && block.name === questionTool)?.id
      : undefined;
  });

  pi.on('tool_call', event => {
    if (questionDismissed) return { block: true, reason: waitForAnswer, terminate: true };
    if (questionCallId && event.toolCallId !== questionCallId) {
      return { block: true, reason: 'Wait for the user to answer the question before calling other tools.', terminate: true };
    }
    normalizeWorkspaceSearch(event);
    if (mode !== 'plan') return;
    if (imageRunActive && event.toolName === 'generate_image') return;
    if (planReviewState === 'waiting-feedback') return { block: true, reason: waitForPlanFeedback, terminate: true };
    const tool = pi.getAllTools().find(candidate => candidate.name === event.toolName);
    if (!isPlanTool(event.toolName, tool)) {
      return { block: true, reason: 'Plan Mode only allows read-only file tools, user questions, and exit_plan_mode', terminate: true };
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
    imageRunActive = false;
    appendContextClassification();
    if (externalToolOverrides.size) {
      pi.appendEntry(externalOverrideEntry, { toolNames: [...externalToolOverrides] });
    }
  });

  pi.registerTool({
    name: questionTool, label: 'Ask the user',
    description: 'Ask for a decision that is needed to continue. Show one question with 2 to 5 distinct choices and wait for the user to select one; the user may also answer in their own words instead.',
    promptSnippet: 'Ask the user to decide between concrete options in a dialog',
    promptGuidelines: [
      'Use ' + questionTool + ' on its own when a material ambiguity remains after checking the available context. Write in the user’s language and give choices that describe distinct outcomes. The user may pick a choice or reply in their own words — both are the answer, so use it to proceed. Plan and operation approvals have their own controls.'
    ],
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 400 }),
      options: Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 2, maxItems: 5 })
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    executionMode: 'sequential',
    async execute(_id, input, signal, _onUpdate, ctx) {
      const question = input.question.trim();
      const options = input.options.map(option => option.trim());
      if (!question) throw new Error('A question is required');
      if (options.some(option => !option) || new Set(options).size !== options.length) {
        throw new Error('Provide distinct nonempty options');
      }
      const unanswered = { question, options, answer: null };
      if (!ctx.hasUI) {
        return { content: [{ type: 'text', text: 'Ask this question and list its options in the visible reply, then wait for the user.' }], details: unanswered, isError: true };
      }
      const answer = signal?.aborted ? undefined : await ctx.ui.select(question, options, { signal });
      const picked = typeof answer === 'string' ? answer.trim() : '';
      // The choices are a convenience, not the only door: the card carries a line
      // for answering in the reader's own words, and the select's value is
      // whatever they submitted. A reply that is not one of the labels is still an
      // answer — dropping it would silently ignore what the user typed.
      if (!signal?.aborted && picked) {
        if (options.includes(picked)) {
          return { content: [{ type: 'text', text: 'The user selected: ' + picked }], details: { question, options, answer: picked } };
        }
        return { content: [{ type: 'text', text: 'The user answered: ' + picked }], details: { question, options, answer: picked, custom: true } };
      }
      if (!signal?.aborted) {
        questionDismissed = true;
        if (hasActiveGoal()) {
          goal = { ...goal, status: 'blocked', summary: question };
          persist(ctx);
        }
      }
      return { content: [{ type: 'text', text: waitForAnswer }], details: unanswered, terminate: true };
    }
  });

  pi.registerTool({
    name: exitPlanTool, label: 'Exit plan mode',
    description: 'Submit the same complete Markdown plan already shown in the visible assistant response for human review. The user can keep planning or explicitly execute it; only execution approval leaves Plan Mode and begins implementation.',
    promptGuidelines: [progressGuideline],
    parameters: Type.Object({ plan: Type.String({ minLength: 1 }) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, input, signal, _onUpdate, ctx) {
      if (mode !== 'plan') throw new Error('exit_plan_mode is only available in Plan Mode');
      if (!input.plan.trim()) throw new Error('Plan text is required');
      if (planReviewState === 'waiting-feedback') return pausePlanTurn(waitForPlanFeedback);
      if (planReviewState === 'reviewing') return pausePlanTurn('This batch already submitted a plan. Use the outcome of the first review.');
      if (signal?.aborted) return pausePlanTurn('Plan review was cancelled.');
      planReviewState = 'reviewing';
      try {
        const approved = await ctx.ui.confirm(${JSON.stringify(PLAN_REVIEW_TITLE)}, input.plan, { signal });
        if (signal?.aborted) return pausePlanTurn('Plan review was cancelled.');
        if (approved !== true) {
          planReviewState = 'waiting-feedback';
          return pausePlanTurn(waitForPlanFeedback);
        }
        mode = 'default';
        applyTools();
        persist(ctx);
        return { content: [{ type: 'text', text: 'The user approved this plan. Start implementation now, following the reviewed plan.' }], details: { approved: true } };
      } finally {
        if (planReviewState === 'reviewing') planReviewState = 'ready';
      }
    }
  });

  pi.registerTool({
    name: finishTool, label: 'Finish goal',
    description: 'End Goal Mode work after verifying completion, or report a blocker that requires user input or an external change. Never report incomplete work as complete.',
    parameters: Type.Object({ status: Type.Union([Type.Literal('complete'), Type.Literal('blocked')]), summary: Type.String({ minLength: 1 }) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    async execute(_id, input, _signal, _onUpdate, ctx) {
      if (!hasActiveGoal()) throw new Error('No active goal');
      if (goalTextForRequest !== undefined && goalTextForRequest !== goal.text) {
        throw new Error('The goal was edited during this request. Use the current goal before reporting an outcome.');
      }
      goal = { ...goal, status: input.status, summary: input.summary };
      // Completion ends Goal Mode; blocked keeps it so the bar's Resume action
      // can pick the same objective up again.
      if (input.status === 'complete') {
        mode = 'default';
        resetGoalRounds();
        applyTools();
      }
      persist(ctx);
      // An outcome ends the turn. The model has just said everything there is
      // to say about it, so letting it continue produces a second message after
      // "marked complete" — a chat that goes on about work that is already
      // done. terminate closes the tool batch without another request.
      return { content: [{ type: 'text', text: input.summary }], details: { status: input.status }, terminate: true };
    }
  });

  pi.registerTool({
    name: todoTool, label: 'Update todo list',
    description: 'Replace the checklist of steps for the current task. Send the full list on every call: pending steps, at most one in_progress, completed only after the step is verified.',
    promptSnippet: 'Keep the checklist of the current task',
    promptGuidelines: [
      'Use desktop_todo whenever a task takes more than two steps: send the whole list each time, keep at most one step in_progress, and mark a step completed only after it is verified. Update the list when the plan changes.',
      'If you used desktop_todo, sync the final checklist before replying. Keep unfinished or blocked steps pending. If you cannot call the tool, include the same steps in the same order and with the same text as a Markdown checklist in your final reply, checking off only verified steps.',
      progressGuideline
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
    questionCallId = undefined;
    if (!hasActiveGoal()) return;
    // A retry or an older event may carry no results; an absent list is an
    // empty round, not a reason to throw inside the extension.
    const results = Array.isArray(event.toolResults) ? event.toolResults : [];
    if (results.some(result => !result.isError && result.toolName !== todoTool)) {
      goalRoundWorked = true;
    }
    if (results.some(result => result.isError && /did not approve|not approved|approval is unavailable/i.test(JSON.stringify(result.content)))) {
      goal = { ...goal, status: 'blocked', summary: 'A tool operation was not approved' };
      persist(ctx);
    }
  });

  pi.on('agent_before_settle', (event, ctx) => {
    if (!hasActiveGoal()) return;
    if (event.outcome !== 'completed') {
      goal = { ...goal, status: 'blocked', summary: event.outcome === 'aborted' ? 'Stopped by user' : 'The runtime could not continue' };
      persist(ctx); return;
    }
    if (event.continue) return;
    if (goalRounds >= maxGoalRounds) {
      goal = { ...goal, status: 'blocked', summary: 'Reached the continuation limit; resume to keep working toward the goal' };
      persist(ctx);
      return;
    }
    if (!goalRoundWorked && goalAskedForOutcome) {
      goal = { ...goal, status: 'blocked', summary: 'The last rounds made no progress with tools; resume when the goal needs more work' };
      persist(ctx);
      return;
    }
    // Give a round without a successful work tool one chance to report its outcome.
    goalAskedForOutcome = !goalRoundWorked;
    goalRounds += 1;
    goalRoundWorked = false;
    return { continue: true, entries: [...(event.entries ?? []), { type: 'custom_message', customType: goalContinueCustomType, display: false,
      content: goalAskedForOutcome
        ? 'Goal Mode is still active. If all the work is verified complete, call desktop_goal_finish with status complete now instead of replying with text only. If work remains, continue it. If you need the user, call desktop_goal_finish with status blocked and explain the blocker.'
        : goalContinueContent() }] };
  });

  pi.on('agent_settled', (event, ctx) => {
    imageRunActive = false;
    questionCallId = undefined;
    questionDismissed = false;
    if (hasActiveGoal()) {
      goal = { ...goal, status: 'blocked', summary: event.aborted ? 'Stopped by user' : 'The runtime could not continue' };
      persist(ctx);
    }
  });

  pi.on('context', event => {
    // Pi also requests context for automatic continuations and tool follow-ups.
    // Build the instruction from the current goal for each of those requests.
    const activeGoal = hasActiveGoal() && !imageRunActive;
    const lastPlanContext = mode === 'plan' && !imageRunActive
      ? event.messages.findLastIndex(message => message.customType === planContextType)
      : -1;
    const lastGoalContinue = activeGoal
      ? event.messages.findLastIndex(message => message.customType === goalContinueCustomType)
      : -1;
    const messages = event.messages.filter((message, index) => {
      if (message.customType === planContextType) return index === lastPlanContext;
      if (message.customType === goalContextType) return false;
      if (message.customType === goalContinueCustomType) return index === lastGoalContinue;
      if (message.customType === 'desktop-subagent-context') return false;
      if (message.customType === 'desktop-swarm-context') return mode === 'swarm';
      if (message.customType === 'desktop-plugin-context') return mode === 'plugin';
      if (message.customType === 'desktop-computer-context') return computerEnabled && mode !== 'plan';
      return true;
    });
    goalTextForRequest = activeGoal ? goal.text : undefined;
    if (activeGoal) messages.push({
      role: 'custom', customType: goalContextType, display: false, timestamp: Date.now(),
      content: 'Goal Mode is active. Keep working toward the user goal and verify the outcome. Before finishing, call desktop_goal_finish with status complete and a summary only when all requested work is done, or status blocked when user input, approval or an unavailable external dependency prevents progress. Do not mark incomplete work complete. Goal: ' + goalTextForRequest
    });
    return { messages };
  });
}`
}

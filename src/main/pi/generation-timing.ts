import { GENERATION_TIMING_STATUS_KEY } from '@shared/types'

/** Measure prompt-to-first-text in Pi's process, without renderer/IPC clock skew. */
export function generationTimingExtension(): string {
  return `const STATUS_KEY = ${JSON.stringify(GENERATION_TIMING_STATUS_KEY)};

export default function registerGenerationTiming(pi) {
  let active = false;
  let runStartedAt;
  pi.on("agent_start", () => {
    if (!active) runStartedAt = performance.now();
    active = true;
  });
  pi.on("message_update", (event, ctx) => {
    const part = event.assistantMessageEvent;
    if (!active || runStartedAt === undefined || part?.type !== "text_delta" ||
        typeof part.delta !== "string" || part.delta.length === 0) return;
    const ttftMs = Math.max(0, performance.now() - runStartedAt);
    active = false;
    ctx.ui.setStatus(STATUS_KEY, JSON.stringify({ ttftMs }));
  });
  pi.on("agent_settled", () => { active = false; runStartedAt = undefined; });
}
`
}

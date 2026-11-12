import { GENERATION_TIMING_STATUS_KEY } from '@shared/types'

/**
 * Measure the latency of one model request, in Pi's process, without
 * renderer/IPC clock skew.
 *
 * The clock starts when Pi is about to send a model request and stops at the
 * first visible text delta of that request. Starting at `agent_start` instead
 * would fold every tool call, retry backoff and later model turn before the
 * final answer into "time to first token" — a run that worked for four minutes
 * produced a 4m29s TTFT sample. Each new request starts a fresh clock, so a
 * tool gap can never land in the reading.
 */
export function generationTimingExtension(): string {
  return `const STATUS_KEY = ${JSON.stringify(GENERATION_TIMING_STATUS_KEY)};
const MAX_TTFT_MS = 120000;

export default function registerGenerationTiming(pi) {
  let requestStartedAt;
  let sampled = false;
  const beginRequest = () => { requestStartedAt = performance.now(); };
  pi.on("agent_start", () => { sampled = false; });
  // \`before_provider_request\` is closest to the wire; \`turn_start\` is the
  // fallback for transports that do not expose the provider hooks.
  pi.on("before_provider_request", beginRequest);
  pi.on("turn_start", beginRequest);
  pi.on("message_update", (event, ctx) => {
    const part = event.assistantMessageEvent;
    if (sampled || requestStartedAt === undefined || part?.type !== "text_delta" ||
        typeof part.delta !== "string" || part.delta.length === 0) return;
    const ttftMs = performance.now() - requestStartedAt;
    requestStartedAt = undefined;
    // A single request that needs minutes to emit its first visible token is
    // a stalled boundary, not a latency reading. Leave the run unmeasured
    // rather than poisoning the average with an obviously wrong duration.
    if (ttftMs < 0 || ttftMs > MAX_TTFT_MS) return;
    sampled = true;
    ctx.ui.setStatus(STATUS_KEY, JSON.stringify({ ttftMs }));
  });
  pi.on("agent_settled", () => { sampled = false; requestStartedAt = undefined; });
}
`
}

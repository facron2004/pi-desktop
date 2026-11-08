import { CONTEXT_BREAKDOWN_STATUS_KEY } from '@shared/types'

/**
 * Observe the provider payload at Pi's extension hook and publish only counts.
 * A later extension may still transform the payload. This extension never
 * changes the request or exposes its contents.
 */
export function contextBreakdownExtension(): string {
  const statusKey = JSON.stringify(CONTEXT_BREAKDOWN_STATUS_KEY)
  return `const STATUS_KEY = ${statusKey};

const SYSTEM_KEYS = new Set(["system", "systeminstruction", "system_instruction", "system_prompt", "instructions", "developer"]);
const TOOL_KEYS = new Set(["tools", "toolconfig", "tool_config", "tool_definitions", "functions", "functiondeclarations", "function_declarations"]);
const MESSAGE_KEYS = new Set(["messages", "contents", "input", "prompt", "conversation"]);
const MEDIA_KEYS = new Set(["data", "url", "uri", "bytes", "base64", "inline_data", "inlinedata", "image_url", "imageurl"]);

function keyName(value) {
  return String(value).toLowerCase().replace(/[^a-z_]/g, "");
}

function measure(value, key = "", insideMedia = false) {
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + measure(item, key, insideMedia), 0);
  if (!value || typeof value !== "object") return 0;
  const media = insideMedia || /image|audio|video/i.test(key) || /image|audio|video/i.test(String(value.type || value.mimeType || value.mime_type || ""));
  let chars = 0;
  for (const [name, child] of Object.entries(value)) {
    const normalized = keyName(name);
    if (media && MEDIA_KEYS.has(normalized)) continue;
    chars += name.length + measure(child, name, media);
  }
  return chars;
}

function estimate(chars) {
  return chars > 0 ? Math.ceil(chars / 4) : 0;
}

function collect(payload) {
  const parts = { system: 0, tools: 0, messages: 0, hasSystem: false, hasTools: false, hasMessages: false };

  function addMessage(message) {
    const role = String(message?.role || message?.type || "").toLowerCase();
    if (role === "system" || role === "developer") {
      parts.hasSystem = true;
      parts.system += measure(message.content ?? message.parts ?? message.text ?? message);
    } else {
      parts.hasMessages = true;
      parts.messages += measure(message);
    }
  }

  function visit(value, key = "") {
    const name = keyName(key);
    if (SYSTEM_KEYS.has(name)) {
      parts.hasSystem = true;
      parts.system += measure(value, key);
      return;
    }
    if (TOOL_KEYS.has(name)) {
      parts.hasTools = true;
      parts.tools += measure(value, key);
      return;
    }
    if (MESSAGE_KEYS.has(name)) {
      parts.hasMessages = true;
      if (Array.isArray(value)) value.forEach(addMessage);
      else parts.messages += measure(value, key);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
    } else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
    }
  }

  visit(payload);
  return parts;
}

export default function registerContextBreakdown(pi) {
  pi.on("before_provider_request", (event, ctx) => {
    try {
      const parts = collect(event.payload);
      if (!parts.hasSystem && !parts.hasTools && !parts.hasMessages) return;
      const usage = ctx.getContextUsage();
      const total = typeof usage?.tokens === "number" && usage.tokens > 0 ? usage.tokens : null;
      let systemPrompt = parts.hasSystem ? estimate(parts.system) : null;
      let toolDefinitions = parts.hasTools ? estimate(parts.tools) : null;
      const known = (systemPrompt ?? 0) + (toolDefinitions ?? 0);
      const scale = total !== null && known > total && known > 0 ? total / known : 1;
      if (systemPrompt !== null) systemPrompt = Math.round(systemPrompt * scale);
      if (toolDefinitions !== null) toolDefinitions = Math.round(toolDefinitions * scale);
      const knownRows = (systemPrompt ?? 0) + (toolDefinitions ?? 0);
      const conversationMessages = parts.hasMessages
        ? total === null ? estimate(parts.messages) : Math.max(0, total - knownRows)
        : null;
      ctx.ui.setStatus(STATUS_KEY, JSON.stringify({
        systemPrompt,
        toolDefinitions,
        conversationMessages
      }));
    } catch (error) {
      console.error("[pi-desktop] context breakdown could not be read:", error);
    }
  });
}
`
}

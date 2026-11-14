/**
 * Builds the Pi extension that adds the `generate_image` tool.
 *
 * The generated extension runs inside the Pi process, not in Electron. It calls
 * the local Magpie gateway directly, streams the picture back as an inline
 * image block, and also saves it under the current project's
 * `output/generated/` directory so the model can refer to the file by its
 * absolute path in later turns. The gateway credentials are read at runtime
 * from models.json and never baked into this source.
 */
export function imageToolExtension(): string {
  return `import { readFileSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Type } from 'typebox';

function magpieConfig() {
  const fallback = { baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'magpie' };
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent');
    const parsed = JSON.parse(readFileSync(path.join(agentDir, 'models.json'), 'utf8'));
    const provider = parsed?.providers?.magpie;
    if (!provider) return fallback;
    let baseUrl = String(provider.baseUrl || '').trim();
    while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
    const apiKey = String(provider.apiKey || '').trim() || fallback.apiKey;
    if (!baseUrl) return fallback;
    const url = new URL(baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return { baseUrl: baseUrl, apiKey: apiKey };
  } catch {
    return fallback;
  }
}

function safeName(prompt) {
  const cleaned = String(prompt || '')
    .toLowerCase()
    .replace(/[^a-z0-9\\u4e00-\\u9fff_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 48) || 'image';
}

function extFor(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'image/webp') return 'webp';
  throw new Error('Unsupported image mime type');
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

function projectRoot(cwd) {
  try {
    const root = realpathSync(cwd);
    if (!statSync(root).isDirectory()) throw new Error();
    return root;
  } catch {
    throw new Error('Output directory escapes the project');
  }
}

function ensureOutputDir(cwd, expectedRoot) {
  const dir = path.resolve(cwd, 'output/generated');
  if (!inside(cwd, dir) || !inside(expectedRoot, projectRoot(cwd))) throw new Error('Output directory escapes the project');
  let current = cwd;
  for (const segment of path.relative(cwd, dir).split(path.sep).filter(Boolean)) {
    const parent = current;
    current = path.join(current, segment);
    let resolved;
    try {
      resolved = realpathSync(current);
    } catch {
      if (!inside(expectedRoot, projectRoot(parent))) throw new Error('Output directory escapes the project');
      try { mkdirSync(current); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      try { resolved = realpathSync(current); } catch { throw new Error('Output directory escapes the project'); }
    }
    if (!inside(expectedRoot, resolved)) throw new Error('Output directory escapes the project');
    try {
      if (!statSync(resolved).isDirectory()) throw new Error();
    } catch {
      throw new Error('Output directory escapes the project');
    }
  }
  if (!inside(expectedRoot, projectRoot(cwd))) throw new Error('Output directory escapes the project');
  return { cwd: cwd, dir: dir, root: expectedRoot };
}

function outputDir() {
  const cwd = process.cwd();
  return ensureOutputDir(cwd, projectRoot(cwd));
}

function clampN(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(4, Math.max(1, Math.round(n)));
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(120000);
  if (!signal) return timeout;
  try {
    return AbortSignal.any([timeout, signal]);
  } catch {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abort, { once: true });
    timeout.addEventListener('abort', abort, { once: true });
    return controller.signal;
  }
}

export default function (pi) {
  pi.registerTool({
    name: 'generate_image',
    label: 'Generate image',
    description: 'Generate an image from a text prompt through the local Magpie gateway. The picture is returned inline AND saved to disk under <project>/output/generated/, so it can be referenced later by its absolute path. Write a detailed prompt: name the subject, the style, the composition, the colours and any exact text that must appear in the picture. Prefer one rich paragraph over a few words; leave the model, size, quality and n at their defaults unless the request needs something specific. Use n only for several variations of the same prompt.',
    defaultActive: true,
    annotations: { destructiveHint: false, readOnlyHint: false, openWorldHint: true },
    parameters: Type.Object({
      prompt: Type.String(),
      model: Type.Optional(Type.String()),
      size: Type.Optional(Type.String()),
      n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      quality: Type.Optional(Type.String())
    }),
    async execute(_id, params, signal) {
      let config;
      try { config = magpieConfig(); } catch { config = { baseUrl: 'http://127.0.0.1:3425/v1', apiKey: 'magpie' }; }
      try {
        const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
        if (!prompt) throw new Error('prompt is required');
        const { cwd, dir, root } = outputDir();
        const modelParam = typeof params.model === 'string' && params.model.trim() ? params.model.trim() : '';
        const body = {
          prompt: prompt,
          n: clampN(params.n),
          size: typeof params.size === 'string' && params.size.trim() ? params.size.trim() : '1024x1024',
          quality: typeof params.quality === 'string' && params.quality.trim() ? params.quality.trim() : 'auto',
          response_format: 'b64_json'
        };
        if (modelParam) body.model = modelParam;
        const response = await fetch(config.baseUrl + '/images/generations', {
          method: 'POST',
          signal: requestSignal(signal),
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
          body: JSON.stringify(body)
        });
        if (!response.ok) {
          let detail = '';
          try { detail = String(await response.text() || '').slice(0, 500); } catch {}
          throw new Error('Image gateway HTTP ' + response.status + (detail ? ': ' + detail : ''));
        }
        const result = await response.json();
        const items = result && Array.isArray(result.data) ? result.data.slice(0, 4) : [];
        if (!items.length) throw new Error('The gateway returned no images');
        const paths = [];
        const imageBlocks = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i] || {};
          const b64 = item.b64_json;
          if (typeof b64 !== 'string' || !b64.trim()) throw new Error('An image item had no b64_json');
          const mime = typeof item.mime_type === 'string' && item.mime_type.trim() ? item.mime_type.trim() : 'image/png';
          if (mime !== 'image/png' && mime !== 'image/jpeg' && mime !== 'image/webp') throw new Error('Unsupported image mime type');
          const bytes = Buffer.from(b64.trim(), 'base64');
          if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error('An image was empty or larger than 20 MiB');
          const ext = extFor(mime);
          const fileName = safeName(prompt) + '-' + Date.now() + '-' + (i + 1) + '-' + randomBytes(3).toString('hex') + '.' + ext;
          ensureOutputDir(cwd, root);
          const filePath = path.resolve(dir, fileName);
          const relFile = path.relative(cwd, filePath);
          if (!relFile || relFile.startsWith('..') || path.isAbsolute(relFile)) throw new Error('Refusing to write outside the project');
          writeFileSync(filePath, bytes, { flag: 'wx' });
          paths.push(filePath);
          imageBlocks.push({ type: 'image', data: b64.trim(), mimeType: mime });
        }
        const text = 'Generated ' + paths.length + ' image(s):\\n' + paths.map((p) => '- ' + p).join('\\n');
        const usedModel = (result && typeof result.model === 'string' && result.model) || modelParam || '';
        return { content: [{ type: 'text', text: text }, ...imageBlocks], details: { paths: paths, model: usedModel } };
      } catch (error) {
        let shortMessage = error && error.message ? String(error.message) : String(error);
        if (config.apiKey) shortMessage = shortMessage.split(config.apiKey).join('[redacted]');
        shortMessage = shortMessage.slice(0, 500);
        return { content: [{ type: 'text', text: 'Image generation failed: ' + shortMessage }], isError: true };
      }
    }
  });
}
`
}

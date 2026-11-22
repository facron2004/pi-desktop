/** Shared by the desktop task modes and the Pi processes they delegate to. */
export const WORKSPACE_TOOL_HOOKS = String.raw`
  function builtinTools() {
    return new Set(pi.getAllTools().filter(tool => tool.sourceInfo?.source === 'builtin').map(tool => tool.name));
  }

  function withWorkspaceTools(active) {
    const settings = pi.getSettings?.();
    // Keep an explicit Pi tool selection or a restricted session loadout.
    if (!settings || settings.defaultTools !== undefined || !['read', 'bash', 'edit', 'write'].every(name => active.includes(name))) {
      return active;
    }
    const builtin = builtinTools();
    const defaults = ['grep', 'find', 'ls'];
    if (process.platform === 'win32') defaults.push('powershell');
    const additions = defaults.filter(name => builtin.has(name) && !active.includes(name));
    return additions.length ? [...active, ...additions] : active;
  }

  function guideWorkspaceTools(event) {
    const { selectedTools, promptGuidelines } = event.systemPromptOptions ?? {};
    if (!Array.isArray(selectedTools) || !Array.isArray(promptGuidelines)) return;
    const builtin = builtinTools();
    const has = name => builtin.has(name) && selectedTools.includes(name);
    const add = guideline => {
      if (!promptGuidelines.includes(guideline)) promptGuidelines.push(guideline);
    };
    if (has('grep')) add('Use grep to search file contents. Set literal to true for exact text. Use path for the search directory or file and glob for a relative file filter with forward slashes.');
    if (has('find')) add('Use find to locate files by glob pattern. Set pattern to a relative glob such as src/**/*.ts and path to the search directory.');
    if (has('ls')) add('Use ls to list a directory.');
    if (process.platform !== 'win32') return;
    if (has('powershell')) add('Prefer the powershell tool for Windows commands. Pass 5.1-compatible PowerShell syntax directly. Quote paths and use -LiteralPath for filesystem cmdlets that support it. For UTF-8 text files, pass -Encoding utf8 to Get-Content.');
    if (has('bash')) add('Use Bash syntax in the bash tool. Quote paths and use forward slashes, preferably with paths relative to the workspace.');
  }

  function normalizeWorkspaceSearch(event) {
    const { toolName, input } = event;
    if (toolName !== 'find' && toolName !== 'grep') return;
    if (Object.isFrozen(input) || !builtinTools().has(toolName)) return;
    const windows = process.platform === 'win32';
    if (toolName === 'find' && typeof input.pattern === 'string') {
      // A leading ./ keeps fd's full-path glob from matching the search root.
      const pattern = input.pattern.replace(windows ? /^(?:\.[\\/]+)+/ : /^(?:\.\/+)+/, '');
      if (pattern && pattern !== input.pattern) input.pattern = pattern;
    }
    if (windows && toolName === 'grep' && typeof input.glob === 'string') {
      const glob = input.glob;
      // A wildcard cannot be a literal filename character on Windows. Leave
      // mixed separators and patterns with explicit glob escapes to ripgrep.
      if (!glob.includes('/') && /\\[?*]/.test(glob) && !/\\[\\[\]{},!]/.test(glob)) {
        input.glob = glob.replaceAll('\\', '/');
      }
    }
  }
`

export function workspaceToolsExtension(): string {
  return `export default function (pi) {
  ${WORKSPACE_TOOL_HOOKS}
  pi.on('session_start', event => {
    if (event.reason === 'reload') return;
    const active = pi.getActiveTools();
    const tools = withWorkspaceTools(active);
    if (tools !== active) pi.setActiveTools(tools);
  });
  pi.on('before_agent_start', guideWorkspaceTools);
  pi.on('tool_call', normalizeWorkspaceSearch);
}`
}

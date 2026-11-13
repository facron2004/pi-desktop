# pi-mermaid-plugin

Mermaid diagram authoring for Pi, tuned for product managers.

The package adds three things to Pi:

- a **`mermaid` tool** the model can call to build a PM starter or check a diagram before presenting it;
- a **`/mermaid` command** that asks for a diagram type and topic, then sends a complete authoring instruction to the agent;
- a **`mermaid-diagrams` skill** with a type chooser, a swimlane pattern, syntax pitfalls, compact examples and a quality checklist.

When a prompt mentions diagrams, the extension also appends a compact Mermaid authoring policy to the system prompt — unless a policy with the `PI MERMAID POLICY` marker is already present, so Pi Desktop's built-in policy and this plugin never duplicate guidance.

## Install

From this repository:

```bash
pi install ./plugins/mermaid
```

Or try it for one invocation without installing:

```bash
pi -e ./plugins/mermaid/extensions/mermaid.ts
```

The package declares `@earendil-works/pi-coding-agent` and `typebox` as peer dependencies because Pi provides them. `lovely-mermaid` is a runtime dependency; it is also optional at runtime — when neither `lovely-mermaid` nor the older `grok-mermaid` package is available, checking still works and the report simply omits the Unicode preview.

## The `mermaid` tool

### `action=template`

Build a complete starter diagram.

| Parameter | Required | Description |
|---|---|---|
| `action` | yes | `template` |
| `template` | yes | One of the template ids below |
| `title` | no | Topic used in the starter labels |

Every template is deterministic, contains quoted labels and English placeholder content, and ends with a one-line usage note. Replace the placeholders, then check the final source.

Template ids:

| Id | Best for |
|---|---|
| `flowchart` | Process steps, decisions and retry loops |
| `swimlane` | Hand-offs across Customer / Product / Engineering lanes |
| `sequence` | Messages and approvals in time order |
| `state` | Lifecycle statuses and allowed transitions |
| `journey` | Experience and pain points per stage |
| `gantt` | Dates, dependencies and milestones |
| `mindmap` | Scope and theme hierarchy |
| `timeline` | Milestones by quarter or phase |
| `quadrant` | Prioritisation on two axes |
| `requirement` | Requirements, risk and verification |
| `kanban` | Delivery board columns and cards |
| `architecture` | Services, groups and boundaries |
| `pie` | One simple proportion |

### `action=check`

Validate Mermaid source before showing it.

| Parameter | Required | Description |
|---|---|---|
| `action` | yes | `check` |
| `source` | yes | Complete Mermaid source |

The report includes:

- `ok` / `FAILED` and the detected diagram type;
- every error with a **line number** and a concrete **fix**;
- warnings for diagrams that are technically valid but hard to read;
- a Unicode preview when a terminal Mermaid renderer is installed, trimmed to at most 80 columns and 30 rows.

The validator catches the common LLM mistakes: empty source, unknown or missing headers, a flowchart without a direction, unbalanced `[](){}`, missing `end` after `subgraph`, unquoted parentheses inside node labels, a sequence diagram with no messages, a gantt without `dateFormat`, requirement blocks without braces, and empty pie/timeline/quadrant data.

## The `/mermaid` command

In an interactive Pi session:

```text
/mermaid
```

Pick a template from the readable menu, enter the topic, and Pi receives a complete instruction containing the starter source and the authoring rules. In headless modes (`--print`, JSON) the command explains that the UI is unavailable; the model can still use the `mermaid` tool directly.

## Package layout

```text
plugins/mermaid/
├── package.json
├── extensions/
│   └── mermaid.ts          # tool, command and before_agent_start policy
├── src/
│   ├── templates.ts        # pure template metadata and builders
│   └── validate.ts         # pure validator, no Pi imports
├── skills/
│   └── mermaid-diagrams/
│       └── SKILL.md        # PM-oriented model skill
└── README.md
```

`templates.ts` and `validate.ts` are deliberately pure TypeScript: they have no Pi or renderer imports and are exercised directly by `tests/mermaid-plugin.test.ts`.

## Development

```bash
node tests/run.mjs        # runs the mermaid suite with the rest of the unit tests
```

To verify the module loads in Pi without a model call:

```bash
node node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js \
  -e ./plugins/mermaid/extensions/mermaid.ts --no-session --print "hello"
```

The `--print` run still needs a configured provider for the model turn; the extension itself is loaded before that point. Use `pi --version` first if the CLI path differs.

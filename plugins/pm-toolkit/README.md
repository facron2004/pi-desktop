# pi-pm-toolkit

Product-manager tooling for Pi: the mechanical parts of product work made
deterministic, inspectable and fast.

## Install

From the Pi Desktop repository:

```bash
pi install ./plugins/pm-toolkit
```

Or try it for one invocation:

```bash
pi -e ./plugins/pm-toolkit/extensions/pm-toolkit.ts
```

The package declares `@earendil-works/pi-coding-agent` and `typebox` as peer
dependencies because Pi provides them.

## Tools

| Tool | What it does |
| --- | --- |
| `pm_doc` | Builds a PM document skeleton: PRD, user story, acceptance criteria, launch checklist, status update, interview guide, survey, decision log, roadmap, competitor matrix or release notes. |
| `pm_prioritize` | RICE, ICE, MoSCoW and value × cost scoring with a transparent table, formula and warnings. |
| `pm_experiment` | A/B sample size, two-proportion significance/confidence interval and funnel conversion. |
| `pm_check` | Reviews a PRD, user story, launch checklist or status update for missing sections, vague wording and missing acceptance criteria. |

Every tool returns Markdown that can go straight into a document or a chat
answer. Nothing is sent to a model by the tools themselves.

## `/pm` command

In an interactive Pi session:

```text
/pm
```

Choose a document (PRD, user story, launch checklist, roadmap, interview guide,
survey, decision log, competitor matrix, release notes) or a calculation
(prioritisation, A/B experiment, metrics/funnel), enter a topic and Pi starts the
work with the right structure.

## Skills

| Skill | Covers |
| --- | --- |
| `pm-product` | PRDs, user stories, acceptance criteria, RICE/ICE, roadmaps and launch planning |
| `pm-research` | Interview guides, research synthesis, personas, JTBD and surveys |
| `pm-metrics` | North Star trees, funnels, cohorts, guardrails and experiment design |
| `pm-comms` | Status updates, decision records, release notes, stakeholder maps |

Pi loads the relevant skill from the description when the conversation matches.
The extension also appends a compact PM policy on PM-related prompts, so even a
short request produces a reviewable structure rather than a wall of prose.

## Examples

```text
/pm → PRD → 退款审批体验优化
```

```text
用 RICE 帮我排一下这三个需求：自助退款、批量审批、发票下载。
```

```text
设计一个 A/B 实验，基线转化率 3%，希望检测 10% 的相对提升。
```

## Package layout

```text
plugins/pm-toolkit/
├── package.json
├── extensions/
│   └── pm-toolkit.ts       # tools, /pm command, before_agent_start policy
├── src/
│   ├── frameworks.ts       # RICE/ICE/MoSCoW/value-effort maths
│   ├── stats.ts            # sample size, significance, funnel maths
│   ├── templates.ts        # bilingual document skeletons
│   ├── checks.ts           # document completeness checks
│   └── format.ts           # Markdown formatting
├── skills/
│   ├── pm-product/SKILL.md
│   ├── pm-research/SKILL.md
│   ├── pm-metrics/SKILL.md
│   └── pm-comms/SKILL.md
└── README.md
```

The `src/` modules have no Pi imports, so they are exercised directly by
`tests/pm-toolkit.test.ts` and can be reused by another client.

## Development

```bash
node tests/run.mjs
```

All maths is tested against known values. The extension is intentionally thin:
if a calculation is wrong, the test fails without spawning a model.

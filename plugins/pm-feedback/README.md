# pi-pm-feedback

Turn a raw user-feedback export into a defensible theme report.

`pi-pm-feedback` is a Pi plugin for product managers. It parses CSV, JSON and
one-line-per-item feedback, runs **deterministic keyword pre-clustering** over a
bilingual Chinese/English theme taxonomy, and builds a Markdown report with
counts, representative quotes, segment differences, next investigation steps and
an explicit note that the sample is not statistically representative.

The tool intentionally does not claim semantic clustering. Keyword matching is a
first pass: the model must read the quotes and the unclustered items, merge,
split or rename themes, remove false positives, and only then use the result.

## Install

From the Pi Desktop repository:

```bash
pi install ./plugins/pm-feedback
```

Or try it for one invocation:

```bash
pi -e ./plugins/pm-feedback/extensions/pm-feedback.ts
```

The package declares `@earendil-works/pi-coding-agent` and `typebox` as peer
dependencies because Pi provides them. It has no other runtime dependencies and
makes no network calls.

## Tools

| Tool | What it does |
| --- | --- |
| `pm_feedback` `action=parse` | Parses CSV / JSON / lines input, detects the text/source/segment/severity/date columns, reports field coverage and previews the items. |
| `pm_feedback` `action=cluster` | Matches each item against a deterministic keyword taxonomy and returns clusters with counts, shares, matched keywords, representative quotes and unclustered items. |
| `pm_feedback` `action=report` | Builds a Markdown report: TL;DR, theme distribution, top themes with quotes, segment differences, what to investigate next and the non-representative-sample caveat. |

Optional parameters:

- `format`: `csv`, `json` or `lines`; auto-detected when omitted.
- `themes`: custom taxonomy as `[{ name, keywords: [...] }]`; replaces the default one.
- `language`: `zh-CN` (default) or `en`.

### Default theme taxonomy

`性能`, `稳定性/崩溃`, `易用性/学习成本`, `功能缺失`, `价格/计费`, `客服/支持`,
`数据/报表`, `集成/API`, `权限/安全`, `移动端`, `其他`.

`其他` is the catch-all bucket for items that matched no keyword; the same items
are also returned in `unclustered` so they can be reviewed manually.

## `/feedback` command

In an interactive Pi session:

```text
/feedback
```

Choose parse, cluster or report, then paste the feedback into the editor. Pi
starts the corresponding analysis with instructions to refine the keyword
themes and verify every quote.

## Skill

| Skill | Covers |
| --- | --- |
| `pm-feedback` | Feedback vs interviews, CSV/JSON export hygiene, theme taxonomy design, quote selection, severity versus frequency, avoiding overclaiming and a quality checklist. |

Pi loads the skill when the conversation is about user feedback, reviews, VOC,
support tickets or feedback reports. The extension also appends a compact policy
on feedback-related prompts so the model treats keyword clusters as a first pass
rather than a conclusion.

## Examples

```text
/feedback → 关键词聚类 → 粘贴 App Store 导出的 CSV
```

```text
帮我把这 200 条客服工单做主题分析，并按用户群对比，最后给一份可以给老板看的报告。
```

```text
这是我们上个季度的 NPS 开放题评论，先看看主要抱怨是什么，再说哪些不能从这份数据里下结论。
```

## Package layout

```text
plugins/pm-feedback/
├── package.json
├── extensions/
│   └── pm-feedback.ts       # pm_feedback tool, /feedback command, before_agent_start policy
├── src/
│   ├── feedback.ts          # parsing, keyword clustering, stats, Markdown report
│   └── format.ts            # Markdown formatting for tool output
├── skills/
│   └── pm-feedback/SKILL.md
└── README.md
```

The `src/` modules have no Pi imports, make no network calls and contain no
clock or randomness, so they are exercised directly by
`tests/pm-feedback.test.ts` and can be reused by another client.

## Development

```bash
node tests/run.mjs
```

The tests cover quoted CSV fields and embedded newlines, JSON and JSON Lines,
line input, the default and custom taxonomies, multi-theme matching, the
catch-all/unclustered path, statistics, report sections and deterministic
output. Everything is tested without spawning a model.

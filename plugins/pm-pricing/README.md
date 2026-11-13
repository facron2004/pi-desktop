# pi-pm-pricing

Pricing and packaging analysis for product managers. The mechanical parts —
Van Westendorp curves, the feature-by-tier matrix, value-metric scoring and the
report scaffold — are deterministic and inspectable. The pricing judgement
still belongs to the PM.

## Install

From the Pi Desktop repository:

```bash
pi install ./plugins/pm-pricing
```

Or try it for one invocation:

```bash
pi -e ./plugins/pm-pricing/extensions/pm-pricing.ts
```

The package declares `@earendil-works/pi-coding-agent` and `typebox` as peer
dependencies because Pi provides them.

## Tools

| Tool | What it does |
| --- | --- |
| `pm_pricing` `van_westendorp` | Computes medians and quartiles for the four price questions, cumulative price-perception curves, the acceptable range (PMC–PME), optimal price point (OPP), indifference price point (IPP) and warnings for inconsistent respondents. |
| `pm_pricing` `tier_matrix` | Builds a feature-by-tier matrix, flags features present in every tier (table stakes) and features unique to one tier (differentiators), and renders limits/quotas. |
| `pm_pricing` `value_metric` | Scores candidate value metrics on alignment, scalability, predictability, fairness and measurability, then returns a deterministic ranking with rationale hooks. |
| `pm_pricing` `report` | Assembles a Markdown pricing report: Van Westendorp results, tier matrix, value-metric guidance, migration/rollback questions and a pre-launch checklist. Missing evidence is stated instead of omitted. |

Every tool returns Markdown that can go straight into a document or a chat
answer. Nothing is sent to a model by the tools themselves.

## `/pricing` command

In an interactive Pi session:

```text
/pricing
```

Choose an analysis (Van Westendorp, tier matrix, value metric, full report or
a migration plan), enter the product and context, and Pi starts the work with
the right structure. The command does not use UI notifications.

## Skill

`pm-pricing` covers the judgement around the maths:

- choosing a value metric and the common candidates (seat, active user, usage,
  outcome, workspace);
- designing the four-question Van Westendorp survey, with sample-size and
  interpretation caveats;
- tier design principles (table stakes vs differentiators, upgrade reasons,
  limits, number of tiers);
- grandfathering, notice periods, downgrade paths and rollback planning;
- price-testing ethics and the pre-launch checklist.

Pi loads the skill from its description when the conversation matches. The
extension also appends a compact `PI PRICING POLICY` on pricing-related
prompts, so a short request cannot skip the evidence and migration questions.

## Method and caveats

**Van Westendorp is directional.** The tool computes cumulative curves on a
sorted grid of observed prices and linearly interpolates crossings between
adjacent prices. The curves are the share of respondents who find each price
too cheap, a bargain, expensive but acceptable, or too expensive. The
crossings are: PMC = too-cheap × expensive, PME = bargain × too-expensive,
OPP = too-cheap × too-expensive and IPP = bargain × expensive. That is a
defensible simple method, not a demand model. It cannot tell you purchase
intent, elasticity or revenue. Use a representative sample of the target
segment — roughly 30–100+ respondents per segment, more for narrow segments —
keep the question wording identical, and treat the acceptable range and price
points as a band to investigate. Inconsistent respondents
(`tooCheap ≥ tooExpensive`, or prices out of order) are excluded with a
warning. Below 30 usable responses the result carries an explicit sample-size
warning.

**Value-metric scores are decision inputs, not measurements.** Scores may be
entered on a 1–5 or 0–10 scale; a candidate with any score above 5 is treated
as 0–10 throughout. The ranking is deterministic: weighted score descending,
then name. State where each score came from.

**No network calls and no new dependencies.** `src/pricing.ts` has no Pi
imports, so it can be reused by another client or tested directly.

## Examples

```text
/pricing → Van Westendorp → 团队版协作工具的年费定价
```

```text
帮我给下面三档套餐做功能矩阵：Starter ¥10/月、Pro ¥30/月、Enterprise ¥100/月……
```

```text
我们有 40 份价格调研数据，帮我算 Van Westendorp 的可接受区间和 OPP。
```

```text
准备把 Pro 从 ¥30 涨到 ¥39，帮我列出老客户迁移、grandfathering 和回滚方案。
```

## Package layout

```text
plugins/pm-pricing/
├── package.json
├── extensions/
│   └── pm-pricing.ts       # pm_pricing tool, /pricing command, before_agent_start policy
├── src/
│   └── pricing.ts          # VW maths, tier matrix, value-metric scoring, Markdown report
├── skills/
│   └── pm-pricing/
│       └── SKILL.md        # pricing judgement, survey design, migration, ethics, checklist
└── README.md
```

## Development

The suite is `tests/pm-pricing.test.ts` and runs through the same esbuild
bundling pattern as the other suites:

```bash
node tests/run.mjs
```

If the suite is not yet registered in that list, bundle it directly:

```bash
node -e "const esbuild=require('esbuild');esbuild.buildSync({entryPoints:['tests/pm-pricing.test.ts'],bundle:true,format:'esm',platform:'node',outfile:'pm-pricing.test.mjs'})"
node --test pm-pricing.test.mjs
```

All maths is tested against known values: medians and quartiles, all four
crossings, inconsistent-response exclusion, tier presence flags, value-metric
ranking and ties, report sections and deterministic output.

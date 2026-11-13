---
name: pm-pricing
description: Design and review pricing and packaging: choose a value metric, run a Van Westendorp willingness-to-pay survey, build good-better-best tiers, plan grandfathering and migration, and test prices ethically. Use when the user asks about pricing, price, packaging, tiers, plans, monetisation, willingness to pay, subscription or billing design, including 定价、价格、套餐、包装、付费意愿、价值指标、计费、订阅、涨价、降价.
---

# Pricing and packaging that can survive a board review

Pricing is a product decision, not a spreadsheet output. The job is to connect
the price to the value a specific segment gets, then make the offer easy to
understand, sell, bill and change. Never present a number as "the optimal
price" when it came from a small or unrepresentative sample.

Use the `pm_pricing` tool for the mechanical parts: `van_westendorp`,
`tier_matrix`, `value_metric` and `report`. The policy below is the judgement
that wraps it.

## Start with the decision

Write these down before analysing anything:

- **Segment**: who is this price for? New customers, a new segment, or the
  existing base? Mixing them produces an average that fits nobody.
- **Offer and unit**: what exactly is being sold, and what does one "unit"
  mean? A seat, an active user, an API call, a transaction, a location?
- **Job and value**: what measurable outcome does the customer get, and how
  does that outcome scale?
- **Constraints**: current contracts, competitor anchors, margin floor,
  billing-system capability, tax, currency and discount policy.
- **Decision rule**: what evidence would make us choose A over B, and what
  would make us stop?

## Choose the value metric

A value metric is the unit the price scales on. Prefer one that satisfies all
five criteria, and score candidates explicitly with the tool:

| Criterion | Question | Red flag |
| --- | --- | --- |
| **Alignment** | Does the metric grow when the customer gets more value? | Price rises while customer value is flat |
| **Scalability** | Does revenue grow without renegotiating every account? | Every expansion needs a new contract |
| **Predictability** | Can finance forecast it and can the customer budget for it? | Spiky usage makes bills unforecastable |
| **Fairness** | Can the customer understand and influence the bill? | Normal use triggers surprise overages |
| **Measurability** | Can we measure it from telemetry and explain it on an invoice? | The customer cannot verify the count |

Common candidates to compare:

- **Per seat / per user** — predictable and easy to understand; weak when value
  is created by a small number of heavy users or when seat sharing is possible.
- **Per active user / monthly active** — aligns better with usage than seats,
  but "active" needs a precise, auditable definition.
- **Per usage unit** (API calls, messages, transactions, GB) — scales well;
  can be volatile and can penalise customers for growing usage patterns.
- **Per outcome** (booking completed, invoice processed, ticket resolved) —
  strong alignment when the outcome is attributable; hard to measure and easy
  to game.
- **Per workspace / per location** — simple and stable; may undersell large
  customers and invite account consolidation.

Rules of thumb:

- If two candidates score close, choose the one a customer can explain to
  their boss in one sentence.
- Price the *value driver*, not the cost driver. Cost only sets the floor.
- A dashboard metric that the customer never sees is a poor billing metric.
- Avoid metrics that customers can reduce by behaving worse (for example,
  charging per support ticket can discourage asking for help).

## Run a Van Westendorp survey

The Price Sensitivity Meter asks four open-ended price questions about the
same product description:

1. **Too cheap**: "At what price would this be so cheap that you would
   question its quality?"
2. **Bargain**: "At what price would this be a great buy for the money — a
   bargain?"
3. **Expensive**: "At what price would it start to feel expensive, but you
   would still consider it?"
4. **Too expensive**: "At what price would it be too expensive to consider?"

### Survey design

- Show the offer, target customer and billing period exactly as they would be
  sold. A vague product description produces a vague price.
- Ask all four questions in the same order, open-ended, in the respondent's
  currency and billing period. Do not anchor with a list of prices first.
- Screen respondents: they must be actual or realistic buyers in the segment.
  Excluding non-buyers matters more than adding more respondents.
- Record segment, company size, current spend and role. Analyse segments
  separately; an average across segments hides the pricing decision.
- Randomise the order of the four questions between respondents when possible
  to reduce order effects, but keep the wording identical.
- Aim for **30–100+ usable responses per segment**. Below ~30 the curves are
  directional only. A large sample cannot fix a biased panel.
- Watch for straight-lining, contradictions and prices that are obviously
  placeholders (0, 1, 999999). Flag and exclude inconsistent responses.

### Analysis caveats

- Van Westendorp measures **stated price perceptions**, not purchase intent,
  elasticity or revenue. It cannot tell you how many people will actually buy.
- The four curves are cumulative distributions over a coarse price grid.
  Crossings are interpolated and sensitive to the sample, ties and outliers.
  Report OPP (optimal price point), IPP (indifference price point), PMC and
  PME as a **band to investigate**, not a precise price.
- Report sample size, usable/excluded counts, median and quartiles for every
  question, and the acceptable range before discussing any single price.
- Validate with behavioural evidence: fake-door or pre-order tests, a real
  price test in a subset of new customers, win/loss analysis, and margin
  modelling. Triangulate, do not average incompatible methods.
- A VW study conducted on existing customers can understate willingness to pay
  because they are anchored on the current price. Say so.

## Design the tiers

Good-better-best or a focused three-tier lineup works when each step is
obvious. The matrix is a decision aid, not a feature dump.

- **Table stakes**: features every tier needs to be credible. They belong in
  the base tier; gating them creates resentment and support load.
- **Differentiators**: features that map to a distinct job, segment or usage
  level. Put them where the customer's value step changes, not at random.
- **Every higher tier needs a reason to upgrade**: more of the value metric,
  a capability a growing team needs, or a service level (SSO, audit, SLA).
- **Limits are packaging too**: seats, projects, storage, API calls and
  support response times communicate the tier as much as feature checkmarks.
- **Avoid a pure decoy tier**. A "bad" tier can anchor, but it often damages
  trust and makes the middle tier look manipulative. If a tier exists only to
  make another look good, remove it.
- **Keep the number of tiers small**. Three is usually enough; four only when
  there is a real enterprise or usage step between them.
- **Name tiers by who they are for**, not by internal org structure or
  arbitrary metal names. "Team" and "Business" beat "Silver" and "Gold".
- **Price points should not sit on top of each other**: a 10% step is usually
  not worth a new SKU; a 2–3× step between self-serve and enterprise is normal
  when the value and buying process differ.
- **Annual vs monthly**: annual billing is a cash-flow and retention lever,
  not a separate product. Show the effective monthly price and the true
  annual commitment.

## Grandfathering and migration

Never launch a price change without a migration plan. Answer these before
announcing anything:

- **Who is affected**: segment, contract type, renewal date, current price,
  discount and special terms. Build the list, not an estimate.
- **Grandfathering**: do existing customers keep the current price forever, for
  a fixed period, or until renewal? State the end date and what happens then.
  "Forever" is a promise, not a default.
- **Notice and consent**: what do contracts and local law require? Who signs
  off the communication? Keep proof of delivery.
- **Downgrade path**: what can a customer move to if the new price is too high?
  Preserve the relationship even when the revenue drops.
- **Billing mechanics**: proration, credits, refunds, tax/VAT, invoice timing,
  payment terms and the billing system's ability to hold two price lists.
- **Communication**: one owner, one message, a clear effective date and a
  named contact. Train support before the email goes out.
- **Rollback**: define the metric (churn, downgrade rate, support volume,
  conversion, expansion revenue), the threshold and the decision date. Keep
  the old price list live until the rollback window closes.

## Price testing ethics

- Do not charge different prices to similar customers without a lawful,
  documented reason. Personalised pricing can be illegal or trust-destroying.
- Do not fake scarcity, countdown timers or "was" prices that never existed.
- Do not target vulnerable customers or use dark patterns to prevent
  cancellation or comparison.
- Test on new customers or a clearly disclosed cohort where possible; avoid
  experimenting on customers who cannot reasonably consent.
- Get legal and finance review for discrimination, tax and consumer-protection
  questions. Ethics is not a growth lever to optimise later.

## Checklist

- [ ] Decision, segment, offer, unit and decision rule are written down.
- [ ] Candidate value metrics are scored on alignment, scalability,
      predictability, fairness and measurability.
- [ ] At least one representative WTP study or behavioural test exists; sample
      size, exclusions and bias are stated.
- [ ] Van Westendorp results are reported as a directional band with the
      acceptable range, not a single "optimal" price.
- [ ] Tier matrix separates table stakes from differentiators and every higher
      tier has a reason to upgrade.
- [ ] Limits, billing period, currency and tax treatment are explicit.
- [ ] Existing customers, contracts, notice periods and grandfathering are
      mapped with owners.
- [ ] Downgrade path, proration, refunds and billing-system changes are tested.
- [ ] Rollback metric, threshold and review date are agreed.
- [ ] Price testing and discount policy pass legal and ethical review.

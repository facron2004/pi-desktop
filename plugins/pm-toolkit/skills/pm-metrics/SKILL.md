---
name: pm-metrics
description: Define product metrics, North Star trees, funnels, cohorts, guardrails and A/B experiments. Use when the user asks for product metrics, North Star/KPI design, funnel analysis, experiment design, sample size, statistical significance or metric definitions.
---

# Metrics and experiments for product decisions

A metric is useful only if someone can change it and someone can be held accountable for it. Define the decision, the metric and the measurement window together.

## Metric tree

1. Start with the user value the product creates.
2. Choose one **North Star metric** that captures delivered value, not revenue vanity.
3. Break it into input metrics the team can influence, plus guardrails that must not be harmed.
4. Define each metric as `value = numerator / denominator` and state the denominator population and time window.
5. Add a quality check: is it gameable? Does it move with real user value? Can it be measured reliably?

Examples:

- North Star: weekly active teams completing a core workflow.
- Inputs: activation rate, repeat usage, invited collaborators.
- Guardrails: crash rate, time to complete, support contacts per 1,000 users.

## Funnel analysis

Use `pm_experiment` with `action=funnel` and absolute user counts at each step. Report:

- step-to-step conversion and overall conversion;
- absolute and relative drop-off;
- the biggest drop by rate (and by users lost);
- the hypothesis for the drop and the next experiment.

Do not compare funnels with different definitions, time windows or populations. Segment by acquisition channel, plan and new vs returning users before declaring a winner.

## A/B experiments

Use `pm_experiment` for sample size and significance.

Before the test, write:

- hypothesis and the decision it informs;
- primary metric and guardrail metrics;
- baseline, minimum detectable effect and expected duration;
- randomisation unit and exposure definition;
- decision rule for ship / iterate / stop.

Rules:

- Do not peek and stop on the first significant day; use a fixed sample or a sequential design agreed in advance.
- Statistical significance is not practical significance. Report effect size and confidence interval.
- Check sample ratio mismatch and guardrail regressions.
- Segment results are exploratory unless pre-registered.
- One primary metric keeps the test honest; additional metrics are diagnostic.

## Reporting

Lead with the decision, not the p-value. State the observed effect, uncertainty, guardrails and what you recommend. If the data is inconclusive, say what would make the next test more decisive.

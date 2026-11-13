---
name: pm-research
description: Plan and synthesise product research: interview guides, user interviews, surveys, JTBD, personas and opportunity maps. Use when the user asks for user research, interview questions, survey design, research synthesis, personas, journey pain points or customer discovery.
---

# User research that changes a decision

Research exists to reduce uncertainty about a product decision. Start with the decision, not with a list of questions.

## Research plan

1. Write the decision this research informs and the two or three questions that would change it.
2. Name what you already believe (assumptions) and what would prove you wrong.
3. Choose the method: interviews for why and how, surveys for how many, usability tests for whether people can complete a task, analytics for what happened.
4. Recruit for behaviour and context, not just job title. Include people who recently did the thing and people who chose a workaround.
5. Define sample size and stopping rule before collecting data. Five to eight interviews per segment is a useful discovery starting point, not a statistical guarantee.

## Interview guide

Use `pm_doc` with `kind=interview_guide`. The best questions are about a specific recent event:

- "Walk me through the last time you did X."
- "What did you do first? And then?"
- "Where did you get stuck?"
- "What did you do instead when that did not work?"
- "Who else was involved?"
- "What would have made the biggest difference?"

Avoid hypothetical and leading questions: "Would you use…", "Don't you think…", "Wouldn't it be better if…". Ask about past behaviour, current workaround and cost.

## Synthesis

Separate observation from interpretation:

- **Observation**: what the participant did or said, with a quote.
- **Theme**: a pattern across at least two participants.
- **Insight**: what the pattern means for the product decision.
- **Opportunity**: a problem worth solving, not a predetermined feature.
- **Assumption**: what still needs validation.

Tag each quote with participant and segment. Do not average away outliers; an outlier may be the most important signal. Look for contradictions between what people say and what they do.

## Personas and JTBD

A persona is a decision aid, not a demographic collage. Include role, context, goals, current workaround, pain, trigger and success signal. Do not invent names or photos.

Jobs-to-be-done format:

> When <situation>, I want to <motivation>, so I can <expected outcome>.

## Survey quality

- Screen first, then ask about recent behaviour, then pain, then concept.
- One idea per question; mutually exclusive and exhaustive options.
- Use 1–5 or 1–7 scales with labelled anchors.
- Randomise option order where order could bias.
- Keep under 8 minutes; test it with three people before fielding.
- Report base sizes, not just percentages; do not over-interpret small differences.

## Deliverable

End with: what we learned, what we now believe, what changed in the product decision, what remains uncertain, and the next cheapest experiment.

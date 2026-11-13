---
name: pm-comms
description: Write product communication: status updates, stakeholder updates, decision records, release notes and launch announcements. Use when the user asks for a weekly update, exec summary, stakeholder communication, launch announcement, release note or decision log.
---

# Product communication that gets a decision

Every update should let the reader do something: approve, unblock, reprioritise or simply stop worrying. Lead with the decision or the change, not the activity log.

## Status update

Use the `pm_doc` tool with `kind=status_update`, then fill:

- **TL;DR**: one sentence on the most important change or judgement.
- **Shipped**: outcomes, not a list of tickets.
- **In progress**: item, owner, expected date; flag anything slipping.
- **Risks and blockers**: impact and the exact ask (who does what by when).
- **Decisions needed**: owner and deadline.
- **Metrics**: primary metric, guardrail and trend.

Keep it skimmable. If a reader has 30 seconds, they should understand the state and the ask.

## Decision log

Use `kind=decision_log`. Record context, options (including "do nothing"), the decision, rationale and consequences. A decision log is not a meeting transcript; it is the durable record of why the choice was made.

## Release notes and announcements

Use `kind=release_notes`. Separate:

- what changed for the user;
- what they need to do (migration, breaking changes);
- what is known to be broken;
- where to get help.

Do not use internal codenames or feature names the customer has never seen. State the benefit before the mechanics.

## Stakeholder map

Before writing, name the audience and their question:

| Audience | They care about | Evidence they need |
| --- | --- | --- |
| Exec | outcome, risk, ask | metric trend, decision |
| Sales/Support | customer impact, talking points | FAQ, timeline |
| Engineering | scope, dependencies, risk | acceptance criteria, owners |
| Legal/Compliance | obligations and deadlines | data flow, policy change |

## Tone

Direct, specific, and free of internal jargon. A status update full of "aligned", "synergy", "in flight" and "socialised" communicates nothing. Replace adjectives with evidence and dates.

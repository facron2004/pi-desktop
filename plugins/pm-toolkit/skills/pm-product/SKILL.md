---
name: pm-product
description: Write and review product documents: PRDs, user stories, acceptance criteria, prioritisation, roadmaps and launch plans. Use when the user asks for a PRD, requirement doc, user story, RICE/ICE ranking, roadmap, release plan, product scope or requirement review.
---

# Product documents that survive review

A PM document is a decision aid. The first sentence should say what decision the reader is being asked to make or acknowledge.

## Workflow

1. Clarify the decision, audience and deadline. If the user has not supplied them, state a reasonable assumption in one line and continue.
2. Use the `pm_doc` tool to start from the right skeleton: `prd`, `user_story`, `acceptance_criteria`, `launch_checklist`, `roadmap`, `decision_log`, `competitor_matrix` or `release_notes`.
3. Fill every placeholder with the user's actual context. Never leave `<角色>`, `TODO`, `TBD` or invented user evidence.
4. For prioritisation use `pm_prioritize`; show the formula and inputs, not just a ranking.
5. Run `pm_check` on a PRD, user story, launch checklist or status update before presenting it. Fix errors; explain remaining warnings.
6. Finish with the one decision or next action you recommend.

## PRD quality bar

A PRD must contain:

- **Problem**: the user pain in the user's language, current workaround and cost of inaction.
- **Why now**: the trigger, opportunity or deadline.
- **Users and scenarios**: target segment and the specific moment of use.
- **Goals and metrics**: one primary metric, guardrails and a target or measurement window.
- **Scope and non-goals**: what is explicitly not being built this round.
- **User stories**: role → capability → value.
- **Acceptance criteria**: Given/When/Then, including failure and edge cases.
- **Risks, dependencies and open questions**: owner and decision date for each open question.
- **Milestones and rollout**: canary, rollback trigger and review date.

## User stories and acceptance criteria

Format:

> 作为 <角色>，我希望 <能力>，以便 <价值>。
> As a <role>, I want <capability>, so that <value>.

Check INVEST: Independent, Negotiable, Valuable, Estimable, Small, Testable. If a story is too large, split by user outcome or workflow step, not by technical layer.

Acceptance criteria use Given/When/Then and cover the happy path, empty state, permission denied, timeout, duplicate submission and data boundaries. A criterion must be observable by someone who did not write the code.

## Prioritisation

- **RICE**: Reach × Impact × Confidence ÷ Effort. Put the unit on Reach, state the confidence as a percentage, and show Effort in person-weeks or person-months.
- **ICE**: Impact × Confidence × Ease on 1–10. Useful when data is thin; still record why each score was chosen.
- **MoSCoW**: Must / Should / Could / Won't. Use Must only for commitments that would make the launch fail.
- **Value × cost matrix**: quick wins, strategic bets, fill-ins and avoid. Use it to structure a conversation, not to hide judgement.

Never present a score with false precision. Round where it helps and say what would change the ranking.

## Roadmap and launch

- Organise a roadmap by outcome and confidence (`Now`, `Next`, `Later`), not by a feature list with fake dates.
- Every `Next` item needs the assumption it tests; every `Later` item needs a trigger for revisiting.
- A launch checklist covers product scope, support/FAQ, monitoring, analytics, rollback, on-call and post-launch review.
- Release notes answer: what changed for the user, what they need to do, and what is still known to be broken.

---
name: pm-feedback
description: Turn raw user feedback, app-store reviews, support tickets or VOC exports into defensible themes and an evidence-backed report. Use when the user asks to analyse user feedback, customer reviews, ratings, complaints, feedback exports, voice-of-customer data or feedback theme reports. Covers CSV/JSON exports, theme taxonomy design, quote selection, severity versus frequency and avoiding overclaiming.
---

# User feedback that supports a decision

Feedback tells you **what** people hit and how they describe it. Interviews tell you **why** they behave that way. Do not use a feedback export as a substitute for interviews, and do not use five interview quotes as if they were a survey.

## When to use feedback vs interviews

| Question | Use |
| --- | --- |
| What are the most common complaints? | Feedback export / reviews / tickets |
| Which segment is affected? | Feedback with source + segment fields |
| Why do users behave this way? | Interviews or contextual inquiry |
| How many users are affected? | Product analytics, not feedback |
| Would users pay for X? | Pricing research, not review mining |
| Is this a widespread regression? | Feedback + telemetry + version field |

If the data has no source, segment or date, say so. A theme without a denominator is an anecdote with a spreadsheet.

## Workflow

1. **Define the decision.** Write the question the analysis must answer, the time window and the channels included. "Improve the product" is not a question.
2. **Export and clean.** One row per feedback item. Keep the original text verbatim. Add `source`, `segment`, `severity` and `date` columns whenever the system has them. De-duplicate copy-paste tickets and remove PII before analysis.
3. **Parse with the tool.** Call `pm_feedback` with `action=parse` and the right `format` (`csv`, `json` or `lines`). Check the field coverage: a `severity` column that is empty for 80% of rows cannot support severity claims.
4. **Pre-cluster.** Call `pm_feedback` with `action=cluster`. The tool does **deterministic keyword matching**, not semantic clustering. It will miss synonyms, sarcasm, negations and mixed-language phrasing.
5. **Refine themes yourself.** Read every representative quote and every unclustered item. Merge near-duplicates, split buckets that contain two different problems, rename themes in product language, and delete keyword false positives. Only then call `action=report` (or write the report from the refined themes).
6. **Report with evidence.** Every theme gets a count, a share of the parsed sample, representative verbatim quotes and the segments where it concentrates. End with what to investigate next.

## CSV and JSON export workflow

- Prefer UTF-8 CSV with a header row. Excel on Windows may save UTF-8 with BOM; the parser handles it.
- Required column: `text` (aliases such as `feedback`, `comment`, `content`, `review`, `评论`, `反馈内容` are recognised).
- Recommended columns: `source`, `segment`, `severity`, `date`, `id`.
- Unknown columns are preserved as `metadata`; use them for app version, locale or plan.
- Quote fields containing commas or line breaks with double quotes and escape inner quotes as `""`.
- If there is no header, the first column is treated as the feedback text.
- JSON accepts an array of objects or `{ "items": [...] }`; JSON Lines is also accepted as a fallback.

## Theme taxonomy design

- Aim for 5–8 actionable themes, plus an explicit `其他` / unclustered bucket. A taxonomy with 30 themes is a list of complaints, not an analysis.
- Keep themes at the same level of abstraction. "Crash on export" is a sub-theme of "Stability", not a peer of "Pricing".
- Name themes by the user problem, not by the proposed feature. "Cannot reconcile monthly totals" beats "Add CSV export button".
- Write keywords for both Chinese and English if the export mixes languages, and include common synonyms and misspellings.
- Test the taxonomy on a sample of 20 items before applying it to everything. Count false positives as well as misses.
- A theme that appears in only one quote can stay in the unclustered/emerging bucket; do not promote it to a headline theme without corroboration.
- Keep the taxonomy stable across reporting periods so trends are comparable; version it when you change it.

## Quote selection

- Quote **verbatim**, never paraphrased as if it were a quote. Fix nothing except obvious PII redaction, and mark redactions.
- Pick quotes that make the theme recognisable, not the most dramatic ones. Include one representative quote per sub-theme where possible.
- Include at least one minority or contradictory quote if it changes the interpretation; do not cherry-pick only confirmations.
- Always attach source, segment and date to a quote. A quote without context cannot be verified.
- Keep quotes short enough to read (roughly 1–3 sentences) and put the full item in an appendix if needed.
- Never invent quotes, counts or percentages. If the tool output does not contain a quote, do not add one from memory.

## Severity vs frequency

Frequency answers "how many items mention this"; severity answers "how bad is one occurrence"; reach answers "how many users are exposed"; strategic impact answers "what does it cost the business". Keep them separate.

|  | High frequency | Low frequency |
| --- | --- | --- |
| **High severity** | Fix now; likely a systemic regression | Investigate first; rare crashes, data loss or security issues can outrank volume |
| **Low severity** | Plan a polish pass; do not call it a crisis | Park it, but keep the quote in the appendix |

Never sort a roadmap by raw mention count. A crash affecting 2% of enterprise accounts may matter more than a colour preference affecting 30% of free users.

## Avoiding overclaiming

- Feedback is **not a statistically representative sample**. App-store reviewers, angry support users and power users self-select. Say this in the report, not only in your head.
- Percentages are shares of the parsed sample, not of all users. Always state the denominator and the date window.
- Keyword matches are not semantic understanding. Report the tool's themes as a first pass that was reviewed, and say which items remained unclustered.
- Do not infer causality from co-occurrence. "Crashes mention version 4.2" means investigate, not "4.2 caused the crashes".
- Do not turn a theme into a feature request without a decision and a hypothesis. A theme is a problem statement; the solution still needs design.
- If the sample is small (under ~30 items) or from one channel, label it as directional and skip precise percentages.

## Using the extension

- `pm_feedback action=parse` — parse and inspect field coverage.
- `pm_feedback action=cluster` — deterministic keyword pre-clustering; returns clusters, shares, matched keywords, representative quotes and unclustered items.
- `pm_feedback action=report` — Markdown report with TL;DR, theme distribution, representative quotes, segment differences, next investigation steps and an explicit non-representative-sample caveat.
- `/feedback` in an interactive session opens a parse/cluster/report menu and an editor for pasted feedback.

The tool never calls a model and never claims semantic clustering. You are responsible for reading the quotes, refining the themes and writing the judgement.

## Quality checklist

- [ ] Decision, time window, channels and sample size stated.
- [ ] Every item has a source; segment coverage is reported.
- [ ] Themes are 5–8, mutually distinguishable, and named as user problems.
- [ ] Every headline theme has a count and at least one verbatim quote with context.
- [ ] Unclustered items were read, not silently dropped.
- [ ] Frequency, severity and reach are not conflated.
- [ ] The report says the sample is not statistically representative.
- [ ] Next steps name the cheapest way to validate the top themes.

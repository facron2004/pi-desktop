# The task rail, aligned with MCode

Pi Desktop's task rail is the card beside the conversation. This file records
what was changed to line it up with MCode's session panel, **where the
reference came from**, and what was deliberately not copied.

## Where the reference came from

Nothing here was drawn from memory. MCode is installed on this machine
(`E:\exe\Minimax Code`), so its real implementation was read out of the
package:

```bash
node output/mcode-probe/extract.cjs        # 972 renderer files out of app.asar
node output/mcode-probe/find-string.cjs "环境信息" "交付物"
node output/mcode-probe/locale.cjs group workspace_panel
node output/mcode-probe/slice.cjs out/_next/static/chunks/32652.c6448f3f94c13392.js 44945 48000
```

The panel is MCode's `workspace_panel`: its locale group names the sections
(`section_environmental` → 环境信息, `section_progress` → 进度,
`working_folders` → 交付物), and the chunk
`out/_next/static/chunks/32652.c6448f3f94c13392.js` holds the components
themselves. The running app shows the fourth section as 后台任务
(background tasks), which is where the panel's task rows live.

## The numbers

MCode's own, read from that package:

| Thing | MCode | Pi Desktop (before) | Pi Desktop (now) |
|---|---|---|---|
| Sections | 环境信息 / 后台任务 / 进度 / 交付物 | Changes / Background tasks / Progress / Deliverables | the same four, in the same order |
| Section title | `text-sm font-normal leading-5 text-text_default_secondary`, no icon | an icon plus the title, 11px semibold | plain title, 14px, `--text-secondary` |
| Caret | 14px, `rotate` over 180ms, on the right | 12px, 120ms, on the right | 14px, 180ms (`--dur-base`), on the right |
| Section body | `grid-template-rows` 1fr ↔ 0fr, 180ms | `hidden` — it snapped shut | the same grid fold, 180ms |
| The branch | the subtitle under the title | a row of its own | the subtitle under the title |
| Row height | 32px (`h-8`) | 22–24px | 32px |
| Row icons | 20px | 13px | 16px |
| Changes row | `+N` in success, `−N` in error, right-aligned, tabular | the counts in the section header | the counts on the row, right-aligned |
| A task row | the name on the left, the state dot on the right | the dot on the left | the dot on the right |
| A finished step | a filled disc with the check cut out of it, struck through | a green tinted ring | a filled disc, struck through |
| Deliverables | a folder tree, 20px per level, caret on the right | a flat list under the workspace name | a folder tree, 14px per level, one 20px leading slot on every row, a one-file folder unfolded |

## What changed

### The environment is a section, not a set of rows

The branch describes the section, so it became the subtitle under the title.
The line counts of the working tree belong to the change they describe, so
they moved onto the Changes row, right-aligned and in the success and error
colours. The other two rows — commit and change graph — were already there and
keep their doors: the commit dialog and the history dialog.

### The rail says four things, in one order

环境信息 → 后台任务 → 进度 → 交付物. Every one of them is a projection of
what the app already knows:

- the environment section reads `git` from the store;
- background tasks are the subagent calls of the thread (`lib/subagents.ts`);
- progress is the checklist of the newest assistant message that carries one
  (`lib/plan.ts`) — the same source the plan strip reads;
- deliverables are the files the run wrote (`lib/changes.ts`), folded into a
  folder tree by `lib/task-panel.ts`.

The rail keeps no state of its own beyond which folders of the deliverables
tree are open, and that lives in `lib/view-state.ts`, keyed by the
conversation.

### A finished step is a filled disc

MCode draws a step that is done as a solid disc with the tick cut out of it,
and strikes the text through. The old rail drew a green tinted ring, which
read as "active" rather than "finished". The disc uses `--text-tertiary`, so
it inverts with the theme.

### The deliverables are a tree

Ten files written into one folder read as one line instead of ten. The tree is
built in `lib/task-panel.ts` and its folders fold on the same caret as the
sections.

Every row of that tree carries the same 20px leading slot, whether it wears a
mark or not: a file puts its icon tile in it, a folder leaves it empty because
the caret on the right already says it folds. Without the slot a folder's name
starts 28px left of the file names beside it — the same trap the sidebar already
documents for a conversation row's mark. The depth indent (14px) is then the
only thing allowed to move the text column.

The slot alone was not enough. Measured on a real capture: after it, `docs` did
share the column with `AGENTS.md` and `README.md`, and the list still read as one
row out of line, because the files inside `docs` hung 14px to the right of the
files beside it. A tree of folders is not what the section answers — "what did
this run produce" is a list of files — so **a file row never indents**. Every
file keeps the one column whatever folder it sits under and says where it came
from on the right of its own row, in the assist tone, in the room its name left
behind: `career-os-2-upgrade-status.md   docs/`, `subagent-prompt.txt
docs/agents/`. Only a folder *header* steps in with the depth, because that row's
job is structure and the file row's job is the file.

On top of that, a folder holding exactly one file is unfolded by
`buildDeliverableTree`: it is that file's path, not a group, and the row already
names its folder, so the header would only add a line. MCode folds per level and
keeps single-file folders folded; this is a deliberate departure, and it is why
the list reads as deliverables first and structure second.

The seventh case of `tests/ui-regressions.mjs` measures all of it — the column a
folder header, a root file, a file in a folder and a file in a sub-folder share,
the one step a sub-folder header takes, and every row's folder hint.
`output/audit/rail-check.mjs` prints the same numbers for a shape you can look at
and captures the rail.

## What was deliberately not copied

- **The panel is still a card, not a drawer.** MCode's session panel is a
  right-hand panel of its own, toggled with `Ctrl+Alt+B`. Pi Desktop's rail is
  a 280px card beside the conversation, and the tools panel on the right is a
  separate thing with its own pages. Moving the rail into the tools panel
  would be a layout change, not an alignment one.
- **20px row icons.** MCode's panel is about 400px wide; the rail is 280px, so
  the icons are 16px and the rows keep MCode's 32px height.
- **The push button.** MCode's commit row opens one dialog that can commit or
  push. Pi Desktop's commit dialog only commits, so the rail keeps its own
  push control on the right of the row rather than dropping the action.

## Evidence

- `tests/task-panel.test.ts` — the tree and the diff summary.
- The seventh case of `tests/ui-regressions.mjs` — the four sections, the
  task row, the checklist, the deliverables tree and the fold, in the real
  renderer.
- `output/audit/rail-env.png`, `output/audit/rail-rest.png` — the dark rail.
- `output/audit/rail-light.png` — the light rail.

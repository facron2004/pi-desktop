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
| Deliverables | a folder tree, 20px per level, caret on the right | a flat list under the workspace name | a flat list of files: one 20px tile plus one name, no folder rows, no indent, no path |

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
- progress is the newest todo list the agent sent with `desktop_todo`
  (`lib/plan.ts`), falling back to the checklist of the newest assistant
  message that carries one;
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

### The deliverables are a list of files, not a directory tree

MCode folds the produced files into a folder tree, 20px per level, caret on the
right. Pi Desktop copied that, measured it against real captures three times, and
dropped it. The record of why, because the tree will look tempting again:

1. **The folder row had no leading slot, so its name was not on the file column.**
   A file row put a 20px tile in front of its name and a folder row put nothing
   there, so `docs` started 28px left of `AGENTS.md` beside it — the same trap the
   sidebar documents for a conversation row's mark. Fixed: every row keeps the
   slot, a folder leaves it empty.
2. **The children still hung one indent step right.** After the slot fix the
   folder and its siblings shared a column, but the files inside `docs` sat 14px
   right of the files outside it, and the eye read that as one row out of line —
   three captures in, that was still the complaint. A deliverable is a file, and
   a run that wrote ten files produced ten deliverables, not a directory listing.
3. **An absolute path is a tree of nothing.** A chat written outside the project
   came in as `C:/Users/Facron/AppData/Roaming/pi-desktop/chats/gen_pelican.js`,
   and the tree dutifully drew `C:` → `Users` → `Facron` → `AppData` → `Roaming` →
   `pi-desktop` → `chats` — seven folder rows and one file, all of it noise.

So the section is now one flat list, in the order the run touched the files: one
20px tile, one name, one column, one row height. **The path is not shown.** The
full path is the row's tooltip and the click target, which is where a reader who
needs it will find it. The single exception is a name two produced files share
(`server/store.js` and `web/store.js`): those two rows say which folder each one
is in, because the name alone no longer identifies them.

`listDeliverables` in `lib/task-panel.ts` owns the rule — including the
duplicate-name test — and the component only renders what it is given.

The seventh case of `tests/ui-regressions.mjs` measures it: no folder rows at
all, one column and one height for every file row, the folder shown only on the
pair that shares a name, nothing shown on the rest, and the path still on the
`title`. `output/audit/rail-check.mjs` prints those numbers for a shape you can
look at and captures the rail.

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

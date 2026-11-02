# The workspace panel, aligned with MCode

Pi Desktop's workspace panel is the sidebar on the left: projects, and the
conversations under them. This file records what was changed to line it up
with MCode, **where the reference came from**, and what was deliberately not
copied.

## Where the reference came from

Nothing here was drawn from memory. MCode is installed on this machine
(`E:\exe\Minimax Code`), so its real implementation was read out of the
package:

```bash
node output/mcode-probe/probe.cjs       # the asar layout and its big files
node output/mcode-probe/extract.cjs     # 972 renderer files out of app.asar
node output/mcode-probe/css-sidebar.cjs # the sidebar rules
node output/mcode-probe/js-sidebar.cjs  # the sidebar components
node output/mcode-probe/jsx.cjs         # the JSX, readable
```

The numbers below are MCode's own, read from that package:

| Thing | MCode | Pi Desktop (before) | Pi Desktop (now) |
|---|---|---|---|
| Project row height | 30px | 32px | 32px (`--sidebar-project-h`) |
| Conversation row height | 30px | 28px | 28px (`--sidebar-row-h`) |
| Title of a project row | `min-w-0 flex-1 truncate` | `flex: 1 1 auto` | same |
| Slot for the row actions | `ml-auto w-[60px]`, always there | absolute, and the row's padding grew on hover | a 60px slot, always there (`--sidebar-action-slot`) |
| Mark on a conversation row | `data-session-indicator` = `error` / `unread` / `idle` | none | `data-session-indicator` = `needs-input` / `error` / `unread` / `running` / `idle` |
| The mark itself | 6px dot, or a 7px ring when idle | — | a 6px dot for `error` and `unread` |
| Project icon | an emoji or a line icon, in one of 8 tints | the folder icon | an emoji in one of 8 tints |
| Emoji list | 1714 entries, with keywords in two languages | — | 160 entries (`project-icon-data.ts`, generated from MCode's) |
| Picker | search, 8 tints, an 8-column grid | — | the same, without the line-icon tab |
| Session menu | 208px wide | 188px | 208px |

## What changed

### A project wears an icon

The emoji and the tint live in the workspace (`Workspace.icon`,
`Workspace.iconColor`), so they survive a restart and travel with the project.
The picker hangs off the project icon, which is a control of its own: clicking
the icon opens the picker, clicking the rest of the row still only folds the
list. The project menu carries a second door to the same picker, so the
feature is discoverable without hunting for a 20px target.

The tint is a token. The component writes `data-icon-color` and the stylesheet
picks the hue, so no colour is ever a literal in a component.

### A conversation says what happened to it

`sessionIndicator()` turns a thread into one mark. A waiting dialog outranks
everything, a failure outranks an unread answer, and a run that is still going
keeps its spinner. `unread` and `error` are the same kind of thing — *the
reader has not looked at this* — and they are cleared by opening the
conversation, not by a timer.

The mark is not a new source of truth: it is derived from the run the store
already keeps, and the one piece of state it adds (`thread.notice`) is
written by `agent_settled` and cleared by `selectSession`.

### Nothing moves when the mouse does

This was the change with the most proof behind it. Before, hovering a project
row changed the row's padding, so the title re-flowed. Now the actions live in
a slot that is always there, the count of the conversations and the buttons
take turns in it, and the title keeps the same width.

Measured, not assumed — `output/audit/hover-check.mjs` drives a real mouse
over the row and compares the geometry:

| | title left | title right | title width | slot width | count | buttons |
|---|---|---|---|---|---|---|
| before hover | 53 | 161 | 109 | 60 | opacity 1 | opacity 0 |
| after hover | 53 | 161 | 109 | 60 | opacity 0 | opacity 1 |

The title does not move. The gap between the title and the slot is 8px in
both states, so the title can never run under the buttons.

A conversation row is the same rule one step down: the dot and the spinner
share one 14px slot, so switching between them leaves the title where it
was. A row with nothing to say has no slot at all, so a marked row sits
about 20px further right. MCode behaves the same way — its indicator is
rendered only when there is something to say — and the ragged edge is
shared rather than invented.

## What was deliberately not copied

- **The project row does not switch projects.** MCode's project row opens the
  folder; Pi Desktop's row only folds and unfolds its list, and that is a
  contract in `AGENTS.md` ("the sidebar is a list, not a switch"). The icon
  was split out as its own control instead, which is what lets both be true
  at once.
- **The line-icon tab.** MCode offers a second, vector icon set with its own
  colour. Pi Desktop has no second icon set, so the picker offers emoji and
  the eight tints only.
- **The density setting.** MCode lets the reader pick compact / comfortable /
  airy. Pi Desktop has one density, so the row heights are tokens, not a
  choice.
- **The idle ring.** MCode draws a hollow ring on a row that has nothing to
  say. Pi Desktop draws nothing: an empty circle on every row is noise, and
  the mark is reserved for what the reader has to act on.

## A note on this machine

`Segoe UI Emoji` is installed here but registered with an empty path, so
Chromium cannot use it and every emoji renders as a box. That is a defect of
this Windows image, not of the app — the picker was captured with the font
loaded into the page by hand to prove it (`output/audit/sidebar-final.png`).
The app asks for the platform emoji font by name
(`'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji'`), so it follows
whatever the system provides, exactly like MCode's picker does.

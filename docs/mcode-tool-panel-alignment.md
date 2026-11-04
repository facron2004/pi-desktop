# The workspace panel, aligned with MCode

Pi Desktop's right side panel is the card beside the conversation. This file
records what was changed to line it up with MCode's workspace panel (`右侧拓展区`),
**where the reference came from**, and what was deliberately not copied.

## Where the reference came from

Nothing here was drawn from memory. MCode is installed on this machine
(`E:\exe\Minimax Code`, app version 3.1.10), so its real implementation was
read out of `resources/app.asar`:

```bash
node output/mcode-probe/probe.cjs          # the asar layout and its big files
node output/mcode-probe/extract.cjs        # 972 renderer files out of app.asar
node output/mcode-probe/locale.cjs group file_panel
node output/mcode-probe/slice.cjs out/_next/static/chunks/83679.ac3a0759ce985ea6.js 383118 396000
```

The relevant renderer chunks are:

- `out/_next/static/chunks/83679.ac3a0759ce985ea6.js` — the `SessionSidePanel`
  frame, its `file-panel-header-tabs` strip, the 176px add-page menu, the
  `file-panel-empty-state` start page, and the `file-panel-sidebar` beside the
  file preview.
- `out/_next/static/chunks/64916-e2b8e07a47dda4cd.js` — the panel width
  constants: default `640`, minimum `440`, and the `460`px the conversation
  must keep for itself.
- `out/_next/static/chunks/88822-9fbf4a2feca63e7b.js` — the `file_panel` locale
  group: `tab.files`, `tab.changes`, `tab.terminal`, `tab.browser`,
  `empty.open_chat_file`, `empty.start_here`, `tooltip_maximize`, and the rest.
- `out/_next/static/chunks/6017.281fe7439741bb6a.js` — a file page with its
  preview in the main area and a resizable `file-panel-sidebar` file tree.

## The numbers

MCode's own, read from that package:

| Thing | MCode | Pi Desktop (before) | Pi Desktop (now) |
|---|---|---|---|
| Panel width | default 640px, minimum 440px, conversation reserve 460px | 420px | 520px default, 360–760px dragged |
| Panel header | 46px, `px-2`, `bg_grouped_secondary`, 0.5px left border | 52px, `surface-canvas` | 46px, `surface-chrome`, 1px `border-default` |
| Page tab | 120–160px × 30px, radius 8px, 14px text, 18px icon | content-width × 30px, 13px text, 15px icon | 120–160px × 30px, radius 8px, 14px text, 18px icon |
| Tab close | 24px, opacity 0 until hover/focus, label fades under it | 20×22px, always visible | 24px, opacity 0 until hover/focus, label fades |
| New tab | 30px square, opens a 176px list of pages not open yet | 28px square, opened the permanent Tools guide tab | 30px square directly after the tabs; opens `Start from here` |
| Empty panel | 300px column, 32px above center, `Start from here` cards, 48px rows, 12px radius | a permanent Tools tab with a 320px card list | the MCode start page, six cards |
| Tab overflow | horizontal scroll + 208px all-tabs menu | horizontal wrap, no overflow menu | horizontal scroll + 208px all-pages menu |
| Tab context menu | right-click: close, close others, close to the right, close all | none | the same four entries |
| Tab reorder | drag and drop | none | drag and drop |
| Maximize | maximize/restore in the header, panel becomes the work area | none | same, leaving the project sidebar reachable |
| Files page | preview in the main area, resizable 220px file tree on the right, path bar | tree replaced by the viewer | preview + 220px tree, toggleable |
| File changes page | diff in the main area, changed-file tree on the right | one-column accordion | diff + 220px changed-file list |
| Terminal tabs | the same 30px pill as the panel's page tabs | 26px, 12px text | 30px, 14px text, 18px icon |
| Browser bar | 46px, 30px address field with 8px radius | 26px controls, pill address field | 46px bar, 30px field |
| Panel body | `bg_default_primary` under a grouped-secondary header | canvas under a canvas header | canvas under chrome |

## What changed

### The panel is a page strip, not a function bar

MCode's workspace panel has no permanent "Tools" tab. Every page is a tab; `+`
creates a new `Start from here` tab directly after the open tabs, and selecting
a card turns that tab into the chosen page. A closed page is gone. Pi
Desktop used to pin a Tools tab and swap its body for a guide whenever a page
closed. The panel initialises with the requested page and falls through to
`ToolStart` when the last page closes.

A page tab is a fixed 120–160px pill so a long file name cannot change the
strip's rhythm. The close control is overlaid on hover instead of taking width
from every tab; the label is masked under it on hover. Tabs can be dragged into
a new order, right-clicked for the four close operations, and listed in the
all-pages menu once the strip cannot show them all. `Maximize2` lifts the panel
over the work area while the project sidebar stays reachable, exactly as
MCode's restore/maximize control does.

### The Files and File changes pages are split views

MCode's file panel puts the preview in the main area and a file tree in a
resizable sidebar on the right; its review panel puts the diff in the main area
and the changed files in the same sidebar. Pi Desktop had the opposite shape:
the tree was the page, and opening a file replaced it, so the reader lost the
way back to the project.

The Files page now keeps a 220px tree on the right of the preview (and a toggle
to fold it away), the File changes page keeps a 220px list of changed files on
the right of the diff, and the Review (working tree) page uses the same split.
The tree's search field stays at the top of the sidebar, where MCode keeps it.

### The empty panel starts somewhere

Closing every page used to leave the reader on a guide tab they had to close
again. The empty state is now MCode's: a 300px column, the `Start from here`
caption, and a card for every page (18px icon, 14px label, shortcut on the
right). MCode also prints a line above the caption telling the reader to click a
file in the conversation; that line is dropped here — the cards already say what
the page is for, and the sentence is the kind of instruction a reader skips.
The old guide card
markup remains as `.tool-menu__card` because it is the shared card the start
page renders.

### The panel is wider, but not MCode-wide

MCode defaults its panel to 640px and requires 460px for the conversation.
Pi Desktop also has a 280px task rail beside the conversation and a 720px
reading measure. A 640px default would leave 280px for the transcript when the
rail is open, so the docked default is 520px and the drag range is 360–760px.
The panel still gets the full width when maximized.

## What was deliberately not copied

- **Per-file tabs.** MCode opens each previewed file as a tab of its own and
  can pin tabs. Pi Desktop's `inspectorFile` is one shell-level request shared
  with the transcript and diff rows; turning every file into a tab would put a
  second tab bookkeeping store beside it. The Files page keeps one preview and
  one tree, which is the same reading flow without the duplicate state.
- **Canvas, Mini App, Sources and Sidechat pages.** These are MCode surfaces
  with no Pi equivalent. Pi's six pages stay Files, Browser, Terminal, File
  changes, Subagents and Images.
- **MCode's review pagination and commit controls.** Pi's `ReviewView` already
  owns staging, revert, patch copy and the commit dialog; only its layout was
  changed. The large-diff paging that MCode adds on top is not in Pi's protocol
  surface.
- **MCode's 640px default.** See “The panel is wider, but not MCode-wide”.

## Evidence

- `tests/ui-regressions.mjs` — the eighth case drives the real renderer: the
  fixed-width tabs, the 46px header, the new-tab action, the start page, the
  Files split view, and maximize/restore.
- `output/audit/right-panel-dark.png` — the dark panel with a page open.
- `output/audit/right-panel-light.png` — the light panel with a page open.
- `output/audit/right-panel-start-dark.png` — the dark start page.
- `output/audit/right-panel-maximized-dark.png` — the maximized panel.

# The interface type, aligned with MCode

Pi Desktop's UI type is now MCode's standard preset, copied from the
installed reference app rather than from memory. This file records where the
numbers came from, what changed, and the handful of places where a Pi surface
deliberately keeps a different role.

## Where the reference came from

MCode (**MiniMax Code 3.1.10**) is installed on this machine at
`E:\exe\Minimax Code`. Its renderer was read live through the Chrome DevTools
Protocol and its package (`resources/app.asar`) was inspected for the type
scale and the bundled fonts. The probe scripts and raw evidence live in
`output/mcode-typography/` (see `mcode-spec.md`, `mcode-spec.json`,
`pi-audit.md` and `probe/`).

The user configuration that the captured values come from
(`%APPDATA%\MiniMax\minimax-agent-cn-config.json`) is:

| Setting | Value |
|---|---|
| `uiBaseFontSize` | 14 (Standard) |
| `codeFontSize` | 12 |
| `appearance.themePackId` | `codex-graphite` |
| `appearance.preferences.uiFontFamily` | `theme` (the system recipe) |
| `appearance.preferences.codeFontFamily` | `jetbrains-mono` |

The theme recipe is `typography: "system"`:
`-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`. Leaving the CJK
fallback to the generic `sans-serif` family is what makes Chinese render in
**Noto Sans SC** on this machine; an explicit `Microsoft YaHei` family earlier
in the stack changes every Chinese glyph.

## The scale that was copied

Values are CSS pixels at the Standard preset. MCode calls these `ui-assist`,
`ui-small`, `ui-body`, `ui-large`, `chat-body`, `dialog-medium`, `code-block`,
and so on.

| MCode role | Size / line-height | Weight |
|---|---|---|
| ui-assist | 12 / 16 | 430 |
| ui-small | 13 / 18.57 | 430 |
| ui-body | 14 / 21 | 430 |
| ui-body-strong | 14 / 21 | 500 |
| ui-large | 16 / 24.89 | 430 |
| chat-body / markdown-body | 14 / 22.75 | 430 |
| page hero / brand slogan | 28 / 35 | 600 |
| dialog-medium | 20 / 28, tracking -0.36px | 500 |
| markdown h1 | 21 / 28 | 600 |
| markdown h2 | 17.5 / 24.5 | 600 |
| markdown h3 | 15.75 / 24.5 | 600 |
| markdown h4 | 14 / 21 | 600 |
| markdown h5/h6 | 14 / 22.75 | 600 |
| markdown table header | 13 / 14 | 600 |
| markdown table cell | 13 / 22.75 | 430 |
| code block | 12 / 20 | 400 |
| code diff | 12 / 21.6 | 400 |
| code terminal | 12 / 14.4 | 400 |
| empty-state title | 16 / 26 | 600 |
| empty-state description | 14 / 20 | 400 |
| composer disclaimer | 10 / 14 | 430 |

Weights are MCode's five steps: regular 400, default **430**, medium 500,
semibold 600, bold 700. The body weight is 430 — that is why a plain
`font-weight: 500` looks heavier than MCode's normal UI text.

MCode's chat renderer adds `.matrix-markdown--shifted`, which promotes
headings one visual level (h2 takes h1's slot, h3 takes h2's, and so on). Pi's
`.md` rules do the same: the `--text-markdown-*` tokens describe MCode's role
scale, not the tag number.

## The fonts

- **UI**: the MCode system stack, with Pi's registered colour-emoji face kept
  after `Segoe UI` so the broken emoji registry on this Windows image cannot
  bring back boxes.
- **Code**: JetBrains Mono, bundled under
  `src/renderer/src/assets/fonts/jetbrains-mono/` (8 woff2 faces from MCode's
  own `OFL`-licensed bundle: 400/500/600/700, normal and italic). `--font-mono`
  now leads with `'JetBrains Mono'`; the @font-face declarations live in
  `tokens.css` and Vite hashes the files into the production build.
- The terminal's xterm instance re-fits once `document.fonts.ready` resolves,
  otherwise it keeps the fallback cell metrics measured before JetBrains Mono
  arrives.

## The tokens

`tokens.css` now exposes MCode's roles directly:

```css
--text-assist: 12px;     --leading-assist: 16px;
--text-small: 13px;      --leading-small: 18.57px;
--text-body: 14px;       --leading-body: 21px;
--text-chat: 14px;       --leading-chat: 22.75px;
--text-large: 16px;      --leading-large: 24.89px;
--text-dialog-title: 20px; --leading-dialog: 28px;
--text-hero: 28px;       --leading-hero: 35px;
--text-code-block: 12px; --leading-code-block: 20px;
```

The old numeric names (`--text-2xs`, `--text-xs`, `--text-sm`, `--text-md`,
`--text-lg`, `--text-xl`, `--text-2xl`, `--text-code`) remain as aliases so the
older stylesheets keep working. New code should use the role names. Every
role scales with `--font-scale`, except the code roles, which use
`--code-scale` so a UI size change cannot silently resize code.

## The four text sizes

Pi used to offer `0.92 / 1 / 1.1 / 1.22`, tuned for a 12–14px base. MCode's
presets are **12 / 14 / 15 / 16**. The ratios are now `12/14`, `1`, `15/14`,
`16/14`, and the settings labels are MCode's: **小号 / 标准 / 大号 / 超大号**
(`Small / Standard / Large / Extra large`).

Stored legacy values are translated once by `normalizeFontScale` in
`src/shared/font-scale.ts`: `0.92 → 12/14`, `1.1 → 15/14`, `1.22 → 16/14`.
`SettingsStore.read` applies it on load, `Launcher` steps from
`nearestFontStepIndex` (so an old value can no longer invert the
larger/smaller actions), and Settings compares against the normalized value.
A unit test (`tests/font-scale.test.ts`) pins the mapping.

## What moved

- Sidebar project/session titles: 13/20/400 → **14/21/430**.
- Sidebar section labels: stay **13/18.57/430** (they are MCode's small role,
  not body).
- Menus/popovers: 13/1.4 → **14/21**; menu rows are 32px.
- Tool rows: verb/name **13/18.57/430**, file/command target **13/18.57** in
  JetBrains Mono, state/time **12/16**.
- Composer: input **14/22.75**, placeholder **15/24**.
- Session-bar chips: **13/18.57/430** in the UI face (the branch is not code).
- Markdown headings: h1 21/28, h2 21/28 (shifted), h3 17.5/24.5,
  h4 15.75/24.5, h5 14/21, h6 14/22.75; table 13/22.75 with a 13/14 header.
- Code block/diff/tool output: **12/20/400 JetBrains Mono**, diff **12/21.6**.
- Dialog title: 20/600 → **20/28/500, -0.36px**.
- Settings: nav **14/21/430**, group title **14/21/500**, row label
  **13/18.57/430**, description **12/16/430**; the Appearance page title is
  MCode's settings content title **16/24.89/500**, not a 28px hero.
- Task rail: section title **14/21/430**, branch subtitle **12/16** in the UI
  face, rows **14/21/430**.
- Buttons/inputs: **14/20/400** at the 36px control height.
- Welcome hero: 28/500/1.45 → **28/35/600**.
- Terminal: 12/1.35 → **12/1.2**.

## Deliberate differences

- **Row heights are not forced to 30px.** MCode's live sidebar rows are 30px
  but Pi's sidebar keeps its existing 28/32px project and conversation rows;
  this round changed type, not the sidebar geometry. The type now fits those
  rows.
- **Pi's settings is a modal, MCode's is a page.** Pi therefore keeps a
  20/28/500 dialog title for the modal, while its content title uses MCode's
  settings content size (16/24.89/500). MCode's own modal dialogs use the same
  20/28/500 role.
- **Emoji**: Pi registers a FontFace for colour emoji (a workaround for this
  machine's font registry); MCode relies on the system font. The face sits
  after `Segoe UI` so it does not affect Latin or CJK.
- **A user-chosen font is still a user choice.** The old `Segoe UI` value is
  migrated to the system preset because MCode's system recipe is the same
  Latin face with the platform CJK fallback. Other user font picks are left
  alone; their fallback now names Noto Sans SC before YaHei so CJK matches
  MCode's fallback.
- **Code text size is not exposed separately yet.** MCode has an independent
  code-size setting (11/12/15/17). Pi renders the standard 12px code role
  (matching this machine's MCode config) and the `--code-scale` hook exists
  for adding that control later.

## Evidence

- Live MCode computed styles and the full role matrix:
  `output/mcode-typography/mcode-spec.md`.
- Pi baseline inventory and change map:
  `output/mcode-typography/pi-audit.md`.
- Verified in the built app through CDP after the change:
  body 14/21/430; sidebar title 14/21/430; section label 13/18.57/430;
  popover 14/21; tool verb 13/18.57/430; tool target 13/18.57 JetBrains Mono;
  user/assistant text 14/22.75; tool output 12/20/400 JetBrains Mono;
  dialog title 20/28/500; settings row 13/18.57 and description 12/16;
  text-size presets 12/14/15/16 with Standard active; Chinese platform font
  Noto Sans SC, Latin Segoe UI.
- Screenshots: `output/typo-v3-home.png`,
  `output/typo-v3-conversation.png`, `output/typo-v2-settings.png`.
- `npm run typecheck`, `npm test` (358 tests) and `npm run build` pass.

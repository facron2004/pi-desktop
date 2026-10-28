# Design QA: project row and composer controls

## Visual sources

The user-provided screenshots are the visual references. The screenshots show only component crops, so their CSS viewport and device scale are unknown.

| Reference | Source | Image size |
|---|---|---:|
| Project row | `C:/Users/Facron/AppData/Local/Temp/codex-clipboard-200c184b-3fc2-44cd-abdf-75fd5f2a237d.png` | 396 x 84 px |
| Composer | `C:/Users/Facron/AppData/Local/Temp/codex-clipboard-bb45f082-b994-4303-8449-6cd50d831637.png` | 1347 x 129 px |

## Captures

Capture directory: `E:/AI_Caches/.codex/visualizations/2026/10/20/01a1583c-6d07-7a63-8cf4-16c961162e4b/pi-desktop-ui-2026-10-21/`

| Capture | Image size | CSS viewport | State |
|---|---:|---:|---|
| `project-focused-final.png` | 396 x 84 px | Normalized focus crop | Project name only |
| `composer-focused-final.png` | 1347 x 129 px | Normalized focus crop | Idle composer, add button visible |
| `composer-idle-final.png` | 2220 x 1413 px | 1480 x 942 | Light theme, Chinese, Pi ready |
| `composer-final.png` | 2220 x 1413 px | 1480 x 942 | Add menu open; project icon toggle exercised |
| `composer-skills-final.png` | 2220 x 1413 px | 1480 x 942 | Skills list open |
| `reasoning-slider-final.png` | 2220 x 1413 px | 1480 x 942 | Reasoning slider open |
| `composer-final-1080.png` | 1620 x 1023 px | 1080 x 682 | Narrower layout, add menu open |

The full-window captures use an inferred 1.5x image-to-CSS scale. Crops are compared at the same pixel dimensions as their references.

## Review

- The project path is removed and the row retains the reference card height. Clicking the active project toggles its conversation list and switches between closed-folder and open-folder icons. Selecting another project activates it expanded.
- The composer has one `+` menu for image attachments, project-file insertion, Skills, and Plugins. Project-file insertion uses the existing `@` picker. Selecting a Skill or Plugin command inserts its slash command into the prompt so the user can add arguments before sending.
- Model and reasoning controls sit beside the send action. The reasoning popover uses a slider over Pi's reported levels and commits the selected level on release or keyboard completion.
- The send button and upward arrow are enlarged. The idle composer has no extra shortcut-hint row.
- Visual comparison found no P0–P2 findings. No image assets were needed; existing interface icons are used.

## Interaction and build evidence

- Renderer evaluation confirmed project expansion states `true → false → true` and that the folder icon changes.
- The add menu opened at 1480 x 942 and 1080 x 682 CSS viewports. Skills listed 56 available commands in the captured runtime.
- Selecting a Plugin inserted `/llama ` without sending. Selecting a project-file result inserted `@src/renderer/src/components/Composer.tsx `.
- Slider selection previewed `超高` and committed `xhigh` with the Pi action stubbed, so no inference or RPC request was sent.
- `npm run build` passed. `git diff --check` passed (Git reported existing CRLF/LF normalization warnings).
- `npm run typecheck` reports one error in unchanged `src/renderer/src/components/PlanStrip.tsx`: unused `Pencil` import. No changed file is reported by typecheck.
- Electron captures used isolated user-data and session directories; no normal user settings or sessions were used.

## Final result

passed

---

# Design QA: Codex reference sidebar (2026-10-21)

This section records the latest sidebar acceptance. The preceding composer/project-row review is preserved.

## Visual sources and normalization

- Source visual truth: `C:/Users/Facron/AppData/Local/Temp/codex-clipboard-3c2b0dc0-318d-4bbe-8221-3a671b168043.png` (344 x 1209 px).
- Evidence directory: `E:/AI_Caches/.codex/visualizations/2026/10/21/01a15eb6-f8d7-76d2-a10b-7c8a8f5558c4/pi-sidebar/`.
- Implementation: `accepted-light.png` and `accepted-dark.png`, each 1920 x 1209 px; real Electron renderer at 1280 x 806 CSS px, `devicePixelRatio = 1.5`.
- Sidebar: 230 x 806 CSS px / 345 x 1209 device px. `sidebar-final.png` crops the rightmost one device pixel for comparison with the 344 px source; no font or image rescaling was used. Source CSS size/density is unknown; 150% is inferred from its text and row sizes and matches the local display density.
- Full-view comparison: `comparison-final.png`, with source and implementation together in the same image.
- Focused comparison: `comparison-final-focused.png`, covering the header, project hierarchy, text fade, and active conversation. Both comparison images were opened and visually reviewed after the final build.
- State: Chinese, light theme, seven projects in recent order; Pi Desktop, MultiGateway and AI Component Studio show nested sessions; five-session preview plus an expand action; first MultiGateway session active and streaming. Fixture actions use the actual UI/store with reversible action stubs and no model inference.
- Additional state captures: `accepted-light-menu.png`, `accepted-light-notifications.png`, `accepted-light-search.png`, and corresponding dark captures. Focus crops `menu-focused.png`, `notifications-focused.png` and `search-focused.png` were also opened and reviewed.

## Findings and comparison history

| Pass | Evidence | Finding | Resolution |
|---|---|---|---|
| Baseline | `before-light.png` | [P1] Conversations were separated from projects, only the active project's sessions were shown, and date/count rows changed the hierarchy and density. | Nest single-line conversations under each project; allow several project lists to remain open; remove date/count decorations from these rows. |
| First | `comparison-first.png`, `comparison-first-focused.png` | [P2] A reserved scrollbar narrowed the list; title masks faded short titles; the projects heading was too tall; the notification popup exceeded the sidebar bounds. | Use one scroll surface without a reserved scrollbar gutter, stretch the title mask to the available line width, position the add-folder button outside heading layout, and anchor the notification popup to the header. |
| Second | `comparison-second.png`, `comparison-second-focused.png` | [P3] Small vertical offsets and header icon spacing differed from the source. | Adjust new-chat height, body padding, header action spacing, and the closed-folder/compose icon sizes. |
| Third | `comparison-final.png` before final header resilience change | No remaining P0/P1/P2 visual difference in the reference state. Large text at the minimum resized width still needed an explicit control-visibility check. | Let the brand label truncate at narrow widths while retaining both header actions; verify with actual 115% font scaling. |
| Final | `accepted-light.png`, `accepted-dark.png`, final full/focused comparisons and popup crops | No actionable P0/P1/P2 findings. | All final interaction and layout checks pass. |

## Required fidelity surfaces

- Fonts and typography: 18 px semibold brand, 14 px regular project/session labels and 23 px session line height. Electron's platform-font inspection confirms Segoe UI Variable for Latin and Microsoft YaHei UI for Chinese. Single-line titles retain the full text in their tooltip and fade only at the available line edge. The brand can truncate at 200 px width with 115% text sizing while search and notifications stay reachable.
- Spacing and layout: 230 px default width, 31 px project/session rows, 7 px outer inset, 32 px conversation indentation, 10 px active-row radius, and an 8 px gap after populated project groups. Projects and their sessions share one scrolling surface; there is no separate project-list height cap or fixed footer. Existing saved widths and pointer/keyboard resizing remain supported.
- Colors and tokens: source-sampled light background `#f9fbfd`, foreground `#303031` and active fill `#edeef0` live in sidebar-specific tokens. Dark mode uses the existing application palette. The rest of the application's color tokens are preserved.
- Image quality and assets: the source contains text and standard interface icons, with no photo/illustration assets. A compact inline SVG matches the Codex cloud/terminal mark; Lucide icons provide folder/open-folder, compose, bell, search, chevron and activity indicators. A small difference in the library's folder/activity shape is acceptable P3 polish.
- Copy and content: match the reference's `Codex`, `新聊天`, `项目` and `展开显示` labels. Session names in captures are QA fixtures modeled on the supplied screenshot, not persisted application data. Settings/open-folder actions live in the brand menu; the bell projects existing runtime/error/toast state without introducing a notification history.

## Interaction, layout and preservation evidence

- `checks-accepted-light.json`: 37 / 37 passed. `checks-accepted-dark.json`: 37 / 37 passed.
- Verified multi-project nesting, five/all-session expansion, project folding and switching, cross-project session selection, pin/unpin, rename/Enter/Escape, delete confirmation cancellation, new chat, settings menu, runtime notifications, search focus/filter/Escape, Ctrl+1/Ctrl+2 ordering, default/custom widths, keyboard resize, enlarged text, and scrolling to the last project.
- `layout-accepted-light.json` and `layout-accepted-dark.json`: 12 / 12 passed each, covering 1080/1480 CSS px widths, requested sidebar widths 200/230/460 px, and the inspector closed/open. Main content remains at least 480 px and the root has no horizontal overflow.
- Renderer console errors: none in the final light and dark runs. Electron used separate user-data/session directories. No inference, file deletion, real-session rename, or real-session pin change was performed by the harness.
- `npm run build`: passed against the final source. `git diff --check`: passed; Git only reports existing CRLF/LF normalization notices.
- `npm run typecheck`: the same pre-existing `src/renderer/src/components/PlanStrip.tsx(9,3)` unused `Pencil` import fails before and after this change. No sidebar/change-file error is reported. That unrelated file is unchanged.
- All 25 pre-existing modified files outside the sidebar's necessary integration scope retain their original SHA-256 hashes. Only the sidebar, its styles/tokens, its translations, and App's default width/project shortcut ordering were changed; the earlier content of this report is preserved.

## Intentional differences and follow-up polish

- Technical settings and diagnostics retain Pi Desktop / Pi runtime terminology; the sidebar product label matches the Codex reference.
- Pi Desktop has one active Pi runtime. Its session activity indicator follows that runtime; another project's spinner is not fabricated to match the static reference.
- The source crop includes its host window's curved upper corner. Window chrome is unchanged; this pass recreates the app-owned sidebar contents.
- Minor system-font rasterization and closest-library icon-shape differences remain P3. The dark theme has no source image and is validated against the application's existing theme behavior.

## Implementation checklist

- [x] Recreate header, navigation hierarchy, session density, active state and expanded-list affordance.
- [x] Keep existing project/session actions and search behavior working.
- [x] Compare source and final renderer together at normalized dimensions.
- [x] Verify both themes, minimum width, text scaling and inspector combinations.
- [x] Preserve unrelated WIP and document the pre-existing typecheck failure.

final result: passed
# Design QA: global quality and conversation stream (2026-10-27)

Scope: the whole surface set, driven by `agent-desktop-design-system` (SKILL.md body
principles) and the project's own tokens. The one-page contract this pass was held to is
[`docs/design-contract.md`](docs/design-contract.md); section 11 of it records the
per-item result, the items deliberately not done, and the unverified list.

The skill's companion files (`references/*.md`, `assets/agent-desktop-tokens.css`) are not
present on this machine, so the rules were taken from the SKILL.md body and mapped onto the
existing token layer instead of importing an external palette.

## Evidence

| Reference | Capture | Image size | CSS viewport | State |
|---|---|---|---|---|
| baseline | `output/audit/before-S1.png` … `before-S10.png` (S7 absent, see below) | 2220–2241 × 1413–1452 px | ~1480 × 942 | before this pass |
| accepted | `output/audit/after-S1.png` … `after-S10.png` | 2223–2246 × 1416–1458 px | ~1480 × 942 | after this pass, same scenarios |
| settings | `output/audit/after-settings-dark.png`, `after-settings-light.png` | 2244 × 1458 / 2238 × 1446 | ~1480 × 942 | settings dialog, both themes |

All ten `after-*` captures were taken at 12:12–12:14 on 2026-10-27, after the last source
edit (12:00), so none of them is stale. Earlier per-region `-col` crops from an intermediate
pass were deleted once they no longer matched the final source — an out-of-date crop is worse
than no crop, because it looks like evidence.

Scenarios: S1/S2 new chat, S3/S4 conversation from the top, S5/S6 conversation at the
composer, S8 execution details opened, S9 900 × 800, S10 1024 × 768 — all nine with a
before/after pair. Fixture is a real recorded session
(`2026-10-26T05-51-47-329Z_01a176c3…jsonl`), so the tool rows, thinking blocks and error
footer are real shapes rather than mock-ups.

S7 (a long tool output opened and scrolled halfway) has an **after capture only**, and that
is deliberate. The first version of it scrolled `.thread` to 25%, which produced a file
byte-identical to S5 (100%) — the column only overflows by ~120px, so both fractions clamp
to the same position and the scenario contributed no evidence. It was rebuilt to scroll
inside an expanded group body using a second real session
(`2026-10-26T09-13-31-001Z_01a1777c…jsonl`, 5600px of output), and the stale `before-S7.png`
was deleted rather than kept as a pair that would not be comparing the same state. The
expanded-body change is already covered by S8, whose pair is valid (11.88% changed pixels).
Hashing the set now proves the nine pairs are distinct and the ten after captures are all
different from each other.

**The before/after pairs were verified, not assumed.** `output/audit/verify-pairs.py` measures
the changed-pixel fraction of each pair (2.5–12.2%, mean delta 2.1–16.0, changes spanning
88–95% of frame height — i.e. whole-layout restyling, not one stray control), and
`verify-baseline.py` proves the `before-*` set really predates the work: the welcome
composer's vertical centre of mass moved from 0.723 → 0.634 (dark) and 0.745 → 0.627 (light),
which is the `flex-end` → centred change measured in the pixels themselves.

**The screenshots were not reviewed by eye.** Image reading returns "image omitted" for the
model driving this pass, so acceptance was done by measuring the live DOM instead
(`output/audit/measure.js`, `responsive.js`). Every number below comes from the real
renderer, which is a stricter check than looking at a picture.

## Review

- Token layer: the reading measure is one token (`--content-w` 720px) and the composer, run
  status, run outcome, plan strip and welcome column all resolve to it. Measured 720 / 720 /
  719 / 595 px at 1440 / 1280 / 1024 / 900 window widths — the text column does **not**
  narrow to make room, which is what the skill requires.
- Radius vocabulary: four layers, one each — shell `--r-lg`, floating `--r-md`, control
  `--r-sm`, pill `--r-full`; the bubble and the composer carry the two soft shapes of their
  own. Measured: main `0 14 14 0`, sidebar `14 0 0 14`, bubble `14 14 6 14`, composer `20`,
  tool row `6`.
- Type scale: every rendered size in the thread, composer, sidebar and title bar is one of
  the seven steps (`offScale: []` in both themes). Two relative sizes were on the drift path
  and were folded back: `.md h2` literal `15px` → `--text-lg`, and `.md code` `0.9em` (which
  rendered 12.6px, a size in no token) → `--text-sm`.
- Contrast: the tool row's object text measured 3.73:1 in dark and 3.19:1 in light against
  an 11px requirement of 4.5:1 — below AA. It was returned to `--text-secondary` and now
  measures 7.09:1 / 5.57:1. The session bar had the same defect at the same size (3.7:1 /
  3.2:1) and got the same fix. Body text is 16.13:1 / 15.52:1.
- The filled stop control was the last hard-coded colour in the repository, and fixing it
  exposed a real legibility bug: `--status-danger` is a *light* red (`#f87171`) in the dark
  theme, where white ink measures only 2.77:1 — under even the 3:1 threshold for a glyph.
  A `--status-danger-ink` token now resolves per theme and measures 7.03:1 dark / 4.83:1
  light. There are now zero colour literals outside `tokens.css`.
- The title bar was repeating the session bar: it rendered the project and branch while
  `SessionBar` already carried both *with* the controls to change them. AGENTS.md forbids
  exactly this ("a project or branch chip in two places is two things to keep in sync"), so
  the header block and its CSS were removed; measured `duplicated: false` afterwards.
- Tool rows stay compact: every `.tool__head` measured 34px, inside the 32–40px band the
  repository requires. The state word is hidden for a completed call and spoken only for
  running / failed / stopped / never-ran, so a column of finished calls reads as a list of
  steps rather than a status table.
- Two light-theme invisibility bugs were introduced by this pass and then fixed:
  `--surface-raised` and `--surface-overlay` are `#ffffff` in the light theme, the same as
  the canvas, so a "raised" sheet is invisible there. The expanded tool body now falls back
  to `--surface-sunken` in light, and the tool hover uses the semantic `--bg-hover`. Verified
  distinguishable in both themes (dark `rgb(13,15,19)` on `rgb(22,24,29)`; light
  `rgb(242,242,242)` on `rgb(255,255,255)`).
- A pre-existing overflow was found and fixed: at 1280px and below the model error text in
  `.assistant__footer` pushed the row past the window (a flex item will not shrink below its
  content). The row now wraps and the error is the one part that truncates. This also removed
  the last inline `style={{ color: 'var(--red)' }}` in the React tree.
- Horizontal overflow is now zero at 1440 / 1280 / 1024 / 900 in both themes.

## Interaction and build evidence

- `npm run build`: passed.
- `npm run typecheck`: **0 errors**. The `PlanStrip.tsx` unused-import failure recorded in the
  section above no longer occurs; that file was not touched by this pass.
- `npm test`: 19 / 19 reducer tests pass.
- `output/audit/measure-final.txt` holds the full before/after measurement dump for both
  themes; `output/audit/responsive.mjs` reproduces the four-width sweep.
- Keyboard and pointer contracts were not modified: the composer's two fixed controls are
  still `+` on the left and the round button on the right (measured at the same x positions
  before and after), `SessionBar` remains the only home for conversation settings, and no
  store state was added.
- Reduced motion: a global `prefers-reduced-motion` block now collapses animation and
  transition durations while keeping progress spinners turning, because a stopped spinner is
  a false statement about the run.

## Implementation checklist

- [x] Fix the contract before touching styles (`docs/design-contract.md`).
- [x] One reading measure, one radius per layer, one type step per role.
- [x] Tool rows 32–40px; thinking and tool output read a step below the answer.
- [x] Composer loses the gradient mask, keeps both fixed controls, radius 20px.
- [x] New chat sits above the middle instead of pinned to the bottom.
- [x] Both themes measured; the light-theme surface collisions fixed and verified.
- [x] No off-scale font sizes, no inline colour literals, no dead radius token.
- [x] Title bar keeps only the conversation name and the app's actions; the session bar is
      the only home for the project, branch and run settings.
- [x] Narrow widths checked without narrowing the text column.
- [x] Existing WIP preserved; only styles, one footer span and a duplicated interface touched.

final result: passed

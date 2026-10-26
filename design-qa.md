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

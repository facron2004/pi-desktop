# Marketplace: plugins and skills

The desk page behind the sidebar's **插件与技能 / Plugins & skills** entry is a
curated window onto the Pi ecosystem on GitHub. It has two sections — plugins
(Pi extensions/packages) and skills (Pi skill packages and skill collections) —
and every card installs through the Pi CLI. The old plugin/MCP management page
is gone from Settings: the desk page's **管理** view now owns installed
packages and MCP servers, and the project-trust switch lives in General →
Project safety.

Every card can also be marked with the **我的 / Mine** filter. That set is not a
separate flag: the page reads Pi's `packages` settings (agent and project
`settings.json`) and checks the agent skills directory, then matches those
sources back to snapshot entries.

An **Install from npm** bar above the grid accepts an arbitrary npm package
name (`pi install npm:<name>`). It is confirmation-gated like the catalog
install, and successful installs that match a snapshot entry immediately appear
under **我的**.

The top row also carries **创建** and **管理**. 创建 opens a dialog with three
starting points: a GitHub repository, an npm package, or a locally scaffolded
plugin/skill under the Pi agent directory. 管理 swaps the page body for a
resource manager: installed packages can be enabled, disabled, or removed by
rewriting the matching Pi settings entry, and MCP servers can be toggled or
removed in their user/project `mcp.json` files.

## Files

| Path | Role |
|---|---|
| `src/shared/marketplace.ts` | `MarketplaceEntry` / `MarketplaceSnapshot` types and the pure filter, category and star-format helpers used by the page and tests |
| `src/shared/marketplace-data.ts` | The bundled snapshot: 47 plugins and 25 skills curated from the public GitHub API and the pi.dev package catalog on 2026-11-05 |
| `src/main/marketplace.ts` | `listMarketplace`, `refreshMarketplace`, `listInstalledMarketplaceIds`, `installMarketplaceEntry`, `installNpmPackage`; cache merge; `skills:` clone path |
| `src/main/ipc.ts` | `marketplace:list` / `marketplace:refresh` / `marketplace:installed` / `marketplace:install` / `marketplace:installNpm` handlers |
| `src/preload/index.ts` | `window.pi.marketplace` bridge |
| `src/renderer/src/components/Marketplace.tsx` | The page: top tabs, 我的 filter, search, sort, star floor, category chips, npm install bar, cards, install confirmation |
| `src/renderer/src/components/ResourceManager.tsx` | Create dialog (GitHub / npm / own) and the management view for packages + MCP servers |
| `src/renderer/src/components/SettingsDialog.tsx` | Settings navigation (no Plugins page); its Keyboard shortcuts page shares `ShortcutsList` with the `Ctrl+/` modal |
| `src/renderer/src/styles/marketplace.css` | Page and card styles; tokens only |
| `tests/marketplace.test.ts` | Filter/merge/install-source unit tests and the bundled snapshot's data contract |

## Install sources

An entry's `install` field is one of three shapes, and the main process is the
only thing that turns it into a command:

- `npm:<package>` — `pi install npm:<package>`
- `git:github.com/<owner>/<repo>` — `pi install git:...` for a Pi package repo
  without an npm release
- `skills:github.com/<owner>/<repo>` — a plain skill collection (no
  `package.json` `pi` manifest, e.g. `badlogic/pi-skills`). It is cloned with
  `--depth 1` into `$PI_CODING_AGENT_DIR/skills/<repo>` (default
  `~/.pi/agent/skills/<repo>`), or pulled with `--ff-only` when it is already
  there.

The renderer sends only an entry id; the main process looks the source up in the
bundled snapshot and validates the prefix and the owner/repo characters before
spawning anything.

## Refresh

`marketplace:refresh` runs four public GitHub searches (`topic:pi-package`,
`topic:pi-extension`, `topic:pi-skill`, `topic:pi-skills`, sorted by stars). It
updates the live numbers of curated entries and appends repositories above the
snapshot's `minStars` (100). Curated descriptions, categories, tags and install
sources always win. The result is written atomically to
`<userData>/marketplace-cache.json`; `list` layers that cache over the bundle, so
the page still works offline. GitHub's unauthenticated search limit is
10 requests per minute, which is why the refresh is explicit rather than
periodic.

## Security

Extensions run inside the Pi process with the user's full permissions, and
skills can instruct the model to run programs. The page states that in a banner
and asks for confirmation before every install. Only the curated snapshot and
the GraphQL-shaped GitHub search results can become entries; the renderer never
supplies a command, a URL to clone, or a filesystem path.

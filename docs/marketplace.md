# Marketplace: Pi's official package catalog

The desk page behind the sidebar's **插件与技能 / Plugins & skills** entry is a
client for Pi's own package catalog — `https://pi.dev/packages`, the list npm
publishes for Pi. It carries four tabs (插件 / 技能 / 主题 / 提示词), server-side
search, three sort orders and an infinite **加载更多** list; every card installs
through `pi install npm:<package>`. The old plugin/MCP management page is gone
from Settings: the desk page's **管理** view owns installed packages and MCP
servers, and the project-trust switch lives in General → Project safety.

Every card can also be marked with the **我的 / Mine** filter. That set is not a
separate flag: the page reads Pi's `packages` settings (agent and project
`settings.json`) and checks the agent skills directory, then matches those
sources back to catalog entries.

The top row also carries **创建** and **管理**. 创建 opens a dialog with three
starting points: a GitHub repository, an npm package, or a locally scaffolded
plugin/skill under the Pi agent directory. 管理 swaps the page body for a
resource manager: installed packages can be enabled, disabled, or removed by
rewriting the matching Pi settings entry, and MCP servers can be toggled or
removed in their user/project `mcp.json` files.

## Where the data comes from

`pi.dev/packages` is server-rendered HTML, not a JSON API: each card is an
`<article data-package-card="true">` whose fields live on `data-*` attributes and
in a handful of classes. `src/main/pi-catalog.ts` parses that markup, and it is
deliberately tolerant — attributes first, visible text as a fallback — so a small
markup change loses a field rather than the whole catalog. Search and type
filters are sent to the server (the catalog holds thousands of packages, so a
local filter over page 1 would hide most of them); pages are cached in memory for
five minutes and a failed request falls back to the cached page.

The bundled `marketplace-data.ts` snapshot and the GitHub topic search in
`src/main/marketplace.ts` are still there — the install paths, the package
manager and their tests use them — but the page no longer reads them. The card
renders either shape: a catalog entry shows monthly downloads and its author, a
bundled GitHub entry shows stars and forks.

## Files

| Path | Role |
|---|---|
| `src/main/pi-catalog.ts` | Fetches and parses `pi.dev/packages`: search, type, sort, paging, the five-minute page cache |
| `src/shared/marketplace.ts` | `MarketplaceEntry` / `MarketplaceSnapshot` / `PiCatalogPage` types plus the pure filter, sort and download-format helpers |
| `src/shared/marketplace-data.ts` | The bundled GitHub snapshot (kept for the install path and its data contract test) |
| `src/main/marketplace.ts` | `listInstalledMarketplaceIds`, `installNpmPackage`, `installGitRepository`, `createResource`, the package manager and MCP helpers |
| `src/main/ipc.ts` | `marketplace:piCatalog` plus the install/manage handlers |
| `src/preload/index.ts` | `window.pi.marketplace` bridge |
| `src/renderer/src/components/Marketplace.tsx` | The page: kind tabs, 我的 filter, search, sort, paging, cards, install confirmation |
| `src/renderer/src/components/ResourceManager.tsx` | Create dialog (GitHub / npm / own) and the management view for packages + MCP servers |
| `src/renderer/src/styles/marketplace.css` | Page and card styles; tokens only |
| `tests/pi-catalog.test.ts` | Catalog card parsing, filtered counts, entity decoding, download labels |
| `tests/marketplace.test.ts` | Filter/merge/install-source unit tests and the bundled snapshot's data contract |

## Install sources

An entry's `install` field is one of three shapes, and the main process is the
only thing that turns it into a command:

- `npm:<package>` — `pi install npm:<package>` (every catalog entry)
- `git:github.com/<owner>/<repo>` — `pi install git:...` for a Pi package repo
  without an npm release
- `skills:github.com/<owner>/<repo>` — a plain skill collection (no
  `package.json` `pi` manifest, e.g. `badlogic/pi-skills`). It is cloned with
  `--depth 1` into `$PI_CODING_AGENT_DIR/skills/<repo>` (default
  `~/.pi/agent/skills/<repo>`), or pulled with `--ff-only` when it is already
  there.

The renderer sends only a package name: `marketplace:installNpm` validates it
against npm's own alphabet (optionally behind one `@scope/`) before spawning
anything, so a catalog page cannot become an arbitrary command.

The git and skills shapes still exist in the main process for the entries of the
bundled snapshot (`marketplace:install` looks an id up in that snapshot rather
than trusting a source string from the renderer) and for the **创建** dialog's
GitHub-repository door (`installGitRepository`). The catalog page itself only
ever produces `npm:` installs, because that is what it lists.

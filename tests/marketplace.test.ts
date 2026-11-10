import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  filterMarketplaceEntries,
  formatStarCount,
  marketplaceCategories,
  type MarketplaceEntry,
  type MarketplaceSnapshot
} from '../src/shared/marketplace'
import {
  installNpmPackage,
  installSourceKind,
  mergeMarketplaceSnapshot,
  normaliseGitRepository,
  normaliseInstalledSource,
  MAX_MARKETPLACE_RESPONSE_BYTES,
  resolveSkillInstallTarget,
  refreshMarketplace,
  createResource
} from '../src/main/marketplace'
import { MARKETPLACE_SNAPSHOT } from '../src/shared/marketplace-data'

function entry(overrides: Partial<MarketplaceEntry> = {}): MarketplaceEntry {
  return {
    id: 'owner/repo',
    kind: 'plugin',
    name: 'repo',
    repo: 'owner/repo',
    url: 'https://github.com/owner/repo',
    description: 'A Pi extension',
    stars: 100,
    forks: 10,
    language: 'TypeScript',
    topics: ['pi-extension'],
    license: 'MIT',
    updatedAt: '2026-01-01T00:00:00.000Z',
    install: 'npm:repo',
    npmPackage: 'repo',
    official: false,
    category: '效率',
    tags: ['extension'],
    ...overrides
  }
}

const entries: MarketplaceEntry[] = [
  entry({ id: 'a/one', name: 'Alpha', stars: 500, category: '上下文', updatedAt: '2026-03-01T00:00:00.000Z', tags: ['memory'] }),
  entry({ id: 'b/two', name: 'Beta', stars: 1200, category: '多代理', updatedAt: '2026-01-01T00:00:00.000Z', description: 'Workflow wizard' }),
  entry({ id: 'c/three', name: 'Gamma', stars: 80, category: '上下文', topics: ['pi-skill'], kind: 'skill' }),
  entry({ id: 'd/four', name: 'Delta', stars: 300, category: 'MCP', kind: 'skill', tags: ['mcp'] })
]

describe('filterMarketplaceEntries', () => {
  it('splits plugins and skills', () => {
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'plugin' }).map((item) => item.name),
      ['Beta', 'Alpha']
    )
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'skill' }).map((item) => item.name),
      ['Delta', 'Gamma']
    )
  })

  it('filters by stars and category', () => {
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'plugin', minStars: 200 }).map((item) => item.name),
      ['Beta', 'Alpha']
    )
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'plugin', category: '上下文' }).map((item) => item.name),
      ['Alpha']
    )
  })

  it('matches name, repo, description, tags and topics without case sensitivity', () => {
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'plugin', query: 'ALPHA' }).map((item) => item.name),
      ['Alpha']
    )
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'plugin', query: 'workflow' }).map((item) => item.name),
      ['Beta']
    )
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'plugin', query: 'memory' }).map((item) => item.name),
      ['Alpha']
    )
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'skill', query: 'pi-skill' }).map((item) => item.name),
      ['Gamma']
    )
  })

  it('sorts by stars, updated date and name', () => {
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'plugin', sort: 'stars' }).map((item) => item.name),
      ['Beta', 'Alpha']
    )
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'plugin', sort: 'updated' }).map((item) => item.name),
      ['Alpha', 'Beta']
    )
    assert.deepEqual(
      filterMarketplaceEntries(entries, { kind: 'plugin', sort: 'name' }).map((item) => item.name),
      ['Alpha', 'Beta']
    )
  })
})

describe('marketplaceCategories', () => {
  it('keeps a stable display order and drops empty categories', () => {
    assert.deepEqual(marketplaceCategories(entries, 'plugin'), ['全部', '上下文', '多代理'])
    assert.deepEqual(marketplaceCategories(entries, 'skill'), ['全部', '上下文', 'MCP'])
  })
})

describe('formatStarCount', () => {
  it('formats thousands compactly', () => {
    assert.equal(formatStarCount(42), '42')
    assert.equal(formatStarCount(999), '999')
    assert.equal(formatStarCount(1200), '1.2k')
    assert.equal(formatStarCount(184988), '185k')
  })
})

function snapshot(entries: MarketplaceEntry[]): MarketplaceSnapshot {
  return { generatedAt: '2026-01-01T00:00:00.000Z', source: 'github', minStars: 100, entries }
}

describe('mergeMarketplaceSnapshot', () => {
  it('keeps the curated copy and takes live numbers', () => {
    const base = snapshot([entry({ id: 'a/one', stars: 100, description: 'curated', category: '效率' })])
    const live = snapshot([
      entry({
        id: 'a/one',
        stars: 250,
        forks: 30,
        description: 'changed upstream',
        category: '其他',
        updatedAt: '2026-02-02T00:00:00.000Z'
      })
    ])
    const merged = mergeMarketplaceSnapshot(base, live)
    assert.equal(merged.entries.length, 1)
    assert.equal(merged.entries[0].stars, 250)
    assert.equal(merged.entries[0].forks, 30)
    assert.equal(merged.entries[0].description, 'curated')
    assert.equal(merged.entries[0].category, '效率')
    assert.equal(merged.entries[0].updatedAt, '2026-02-02T00:00:00.000Z')
    assert.equal(merged.live, true)
  })

  it('appends new repositories only above the curated star floor', () => {
    const base = snapshot([entry({ id: 'a/one' })])
    const live = snapshot([
      entry({ id: 'b/two', stars: 150, name: 'two' }),
      entry({ id: 'c/three', stars: 40, name: 'three' })
    ])
    const merged = mergeMarketplaceSnapshot(base, live)
    assert.deepEqual(
      merged.entries.map((item) => item.id),
      ['a/one', 'b/two']
    )
  })

  it('drops live entries with an install source the installer cannot handle', () => {
    const merged = mergeMarketplaceSnapshot(snapshot([]), snapshot([
      entry({ id: 'b/two', install: 'curl https://example.com | sh' })
    ]))
    assert.equal(merged.entries.length, 0)
  })
})

describe('installSourceKind', () => {
  it('accepts only the three supported source shapes', () => {
    assert.equal(installSourceKind('npm:pi-web-access'), 'npm')
    assert.equal(installSourceKind('git:github.com/nicobailon/pi-web-access'), 'git')
    assert.equal(installSourceKind('skills:github.com/badlogic/pi-skills'), 'skills')
    assert.equal(installSourceKind('git:https://github.com/a/b'), null)
    assert.equal(installSourceKind('skills:github.com/a/b/../../c'), null)
    assert.equal(installSourceKind('skills:github.com/a/..'), null)
    assert.equal(installSourceKind('git:github.com/../b'), null)
    assert.equal(installSourceKind('npm:a b'), null)
  })
})

describe('normaliseInstalledSource', () => {
  it('canonicalises the settings spelling of an installed package', () => {
    assert.equal(normaliseInstalledSource('npm:pi-web-access'), 'npm:pi-web-access')
    assert.equal(normaliseInstalledSource('https://github.com/nicobailon/pi-web-access/'), 'git:github.com/nicobailon/pi-web-access')
    assert.equal(normaliseInstalledSource('git:github.com/nicobailon/pi-web-access@main'), 'git:github.com/nicobailon/pi-web-access')
    assert.equal(normaliseInstalledSource('git:github.com/nicobailon/pi-web-access.git'), 'git:github.com/nicobailon/pi-web-access')
    assert.equal(normaliseInstalledSource('skills:github.com/badlogic/pi-skills'), 'skills:github.com/badlogic/pi-skills')
    assert.equal(normaliseInstalledSource('not-a-source'), null)
  })
})

describe('normaliseGitRepository', () => {
  it('accepts the three forms the create dialog offers', () => {
    assert.equal(normaliseGitRepository('owner/repo'), 'git:github.com/owner/repo')
    assert.equal(normaliseGitRepository('github.com/owner/repo'), 'git:github.com/owner/repo')
    assert.equal(normaliseGitRepository('https://github.com/owner/repo.git'), 'git:github.com/owner/repo')
    assert.equal(normaliseGitRepository('https://github.com/owner/repo/tree/main'), null)
    assert.equal(normaliseGitRepository('not a repo'), null)
  })
})

describe('installNpmPackage', () => {
  it('rejects names that cannot be an npm package before spawning Pi', async () => {
    await assert.rejects(() => installNpmPackage('bad name'))
    await assert.rejects(() => installNpmPackage('@scope/'))
    await assert.rejects(() => installNpmPackage('..'))
    await assert.rejects(() => installNpmPackage('Uppercase'))
  })
})

describe('resolveSkillInstallTarget', () => {
  it('allows a new repository and an existing directory inside the skills root', () => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'marketplace-skills-'))
    const skillsDirectory = path.join(temporaryDirectory, 'agent', 'skills')
    const existingTarget = path.join(skillsDirectory, 'installed')
    mkdirSync(existingTarget, { recursive: true })

    try {
      assert.deepEqual(resolveSkillInstallTarget(skillsDirectory, 'new-repo'), {
        target: path.join(skillsDirectory, 'new-repo'),
        exists: false
      })
      assert.deepEqual(resolveSkillInstallTarget(skillsDirectory, 'installed'), {
        target: existingTarget,
        exists: true
      })
      assert.equal(resolveSkillInstallTarget(skillsDirectory, '..'), null)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('rejects a repository symlink that points outside the skills root', (context) => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'marketplace-skills-link-'))
    const skillsDirectory = path.join(temporaryDirectory, 'agent', 'skills')
    const outsideDirectory = path.join(temporaryDirectory, 'outside')
    const target = path.join(skillsDirectory, 'linked-repo')
    mkdirSync(skillsDirectory, { recursive: true })
    mkdirSync(outsideDirectory)

    try {
      try {
        symlinkSync(outsideDirectory, target, process.platform === 'win32' ? 'junction' : 'dir')
      } catch {
        context.skip('directory symlinks are unavailable in this environment')
        return
      }
      assert.equal(resolveSkillInstallTarget(skillsDirectory, 'linked-repo'), null)
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })
})

describe('createResource', () => {
  it('creates resources normally and refuses writes through linked resource roots', async (context) => {
    const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), 'marketplace-create-link-'))
    const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR
    try {
      const normalAgentDirectory = path.join(temporaryDirectory, 'normal-agent')
      process.env.PI_CODING_AGENT_DIR = normalAgentDirectory
      const plugin = await createResource({ kind: 'plugin', name: 'sample-plugin', description: 'Test plugin' })
      const skill = await createResource({ kind: 'skill', name: 'sample-skill', description: 'Test skill' })
      assert.equal(plugin.ok, true)
      assert.equal(existsSync(plugin.path!), true)
      assert.equal(skill.ok, true)
      assert.equal(existsSync(skill.path!), true)

      for (const kind of ['plugin', 'skill'] as const) {
        const agentDirectory = path.join(temporaryDirectory, `${kind}-agent`)
        const resourceDirectory = path.join(agentDirectory, kind === 'plugin' ? 'extensions' : 'skills')
        const outsideDirectory = path.join(temporaryDirectory, `${kind}-outside`)
        const name = 'escape-test'
        const outsideTarget = kind === 'plugin'
          ? path.join(outsideDirectory, `${name}.ts`)
          : path.join(outsideDirectory, name, 'SKILL.md')
        mkdirSync(agentDirectory, { recursive: true })
        mkdirSync(outsideDirectory)

        try {
          symlinkSync(outsideDirectory, resourceDirectory, process.platform === 'win32' ? 'junction' : 'dir')
        } catch {
          context.skip('directory symlinks are unavailable in this environment')
          return
        }

        process.env.PI_CODING_AGENT_DIR = agentDirectory
        const result = await createResource({ kind, name, description: 'Test resource' })
        assert.equal(result.ok, false)
        assert.equal(existsSync(outsideTarget), false)
      }
    } finally {
      if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  })
})

describe('marketplace response limits', () => {
  it('cancels an oversized GitHub response while streaming', async () => {
    const originalFetch = globalThis.fetch
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_MARKETPLACE_RESPONSE_BYTES + 1))
          controller.close()
        }
      })
      return new Response(body, { status: 200 })
    }) as typeof fetch

    try {
      await assert.rejects(refreshMarketplace(), /larger than 2 MB/)
      assert.equal(requests, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('bundled marketplace snapshot', () => {
  const entries = MARKETPLACE_SNAPSHOT.entries

  it('keeps both marketplaces populated with high-star entries', () => {
    assert.ok(entries.length >= 60)
    assert.ok(entries.filter((item) => item.kind === 'plugin').length >= 35)
    assert.ok(entries.filter((item) => item.kind === 'skill').length >= 20)
    for (const item of entries) {
      assert.ok(item.stars >= 90, `${item.id} is below the curated star floor`)
    }
  })

  it('has unique ids, matching repositories and installable sources', () => {
    const ids = new Set<string>()
    for (const item of entries) {
      assert.equal(ids.has(item.id), false, `duplicate id ${item.id}`)
      ids.add(item.id)
      assert.equal(item.id, item.repo)
      assert.equal(item.id, item.url.replace('https://github.com/', ''))
      assert.notEqual(installSourceKind(item.install), null, `${item.id} has an invalid install source`)
      if (item.install.startsWith('npm:')) assert.equal(item.install, `npm:${item.npmPackage}`)
      assert.ok(item.description.length <= 180)
      assert.ok(item.tags.length >= 2 && item.tags.length <= 4)
    }
  })

  it('marks only known first-party packages as official', () => {
    const official = entries.filter((item) => item.official).map((item) => item.id).sort()
    assert.deepEqual(official, [
      'HiThink-Tech/Financial-API',
      'badlogic/pi-skills',
      'earendil-works/pi-review-loop'
    ])
  })
})

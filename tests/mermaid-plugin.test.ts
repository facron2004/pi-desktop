import test from 'node:test'
import assert from 'node:assert/strict'
import { TEMPLATES, TEMPLATE_IDS, buildTemplate, quoteLabel, type TemplateId } from '../plugins/mermaid/src/templates'
import { validateMermaid } from '../plugins/mermaid/src/validate'

const EXPECTED_TEMPLATE_IDS: TemplateId[] = [
  'flowchart',
  'swimlane',
  'sequence',
  'state',
  'journey',
  'gantt',
  'mindmap',
  'timeline',
  'quadrant',
  'requirement',
  'kanban',
  'architecture',
  'pie'
]

test('validateMermaid accepts a valid flowchart', () => {
  const result = validateMermaid(`flowchart TD
  Start["Collect requirement"] --> Check{"Complete?"}
  Check -->|Yes| Build["Build solution"]
  Check -->|No| Ask["Ask for details"]
  Ask --> Check
  Build --> Done["Launch"]`)

  assert.equal(result.ok, true)
  assert.equal(result.diagramType, 'flowchart')
  assert.deepEqual(result.errors, [])
})

test('validateMermaid accepts quoted parentheses in labels', () => {
  const result = validateMermaid(`flowchart LR
  A["Start (draft)"] --> B["Done (ready)"]`)

  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
})

test('validateMermaid reports an unclosed bracket with a line and fix', () => {
  const result = validateMermaid(`flowchart TD
  A[Start --> B[Done]`)

  assert.equal(result.ok, false)
  assert.equal(result.diagramType, 'flowchart')
  assert.equal(result.errors.length >= 1, true)
  const unclosed = result.errors.find((error) => error.message.includes("Unclosed '['"))
  assert.ok(unclosed)
  assert.equal(unclosed.line, 2)
  assert.match(unclosed.fix ?? '', /missing/i)
})

test('validateMermaid reports unquoted parentheses in node labels', () => {
  const result = validateMermaid(`flowchart TD
  A[Start (draft)] --> B[Done]`)

  assert.equal(result.ok, false)
  const error = result.errors.find((candidate) => candidate.message.includes('unquoted parentheses'))
  assert.ok(error)
  assert.equal(error.line, 2)
  assert.match(error.fix ?? '', /A\["Start \(draft\)"\]/)
})

test('validateMermaid reports a subgraph without a matching end', () => {
  const result = validateMermaid(`flowchart TD
  subgraph One
    A --> B
  end
  subgraph Two
    C --> D`)

  assert.equal(result.ok, false)
  const error = result.errors.find((candidate) => candidate.message.includes('never closed'))
  assert.ok(error)
  assert.equal(error.line, 5)
  assert.match(error.fix ?? '', /matching `end`/)
})

test('validateMermaid rejects an unknown diagram type', () => {
  const result = validateMermaid(`notADiagram
  A --> B`)

  assert.equal(result.ok, false)
  assert.equal(result.diagramType, 'unknown')
  assert.equal(result.errors[0].line, 1)
  assert.match(result.errors[0].fix ?? '', /supported header/i)
})

test('validateMermaid rejects empty source', () => {
  const result = validateMermaid('   \n  ')

  assert.equal(result.ok, false)
  assert.equal(result.diagramType, 'unknown')
  assert.equal(result.errors[0].line, 1)
  assert.match(result.errors[0].message, /empty/i)
})

test('validateMermaid requires a flowchart direction', () => {
  const result = validateMermaid(`flowchart
  A --> B`)

  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /direction/i)
  assert.match(result.errors[0].fix ?? '', /flowchart TD/i)
})

test('validateMermaid requires a sequence message', () => {
  const result = validateMermaid(`sequenceDiagram
  participant A
  participant B`)

  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /no messages/i)
  assert.match(result.errors[0].fix ?? '', /->>/)
})

test('validateMermaid requires gantt dateFormat', () => {
  const result = validateMermaid(`gantt
  title Plan
  section Discovery
    Research :research, 2026-01-05, 5d`)

  assert.equal(result.ok, false)
  assert.match(result.errors[0].message, /dateFormat/i)
})

test('validateMermaid reports a requirement block without braces', () => {
  const result = validateMermaid(`requirementDiagram
  requirement R1
    id: R1`)

  assert.equal(result.ok, false)
  assert.equal(result.errors.some((error) => /opening brace/i.test(error.message)), true)
})

test('validateMermaid warns when a diagram has no content', () => {
  const result = validateMermaid('flowchart TD')

  assert.equal(result.ok, true)
  assert.equal(result.warnings.some((warning) => /no content/i.test(warning)), true)
})

test('template metadata exposes all 13 ids exactly once', () => {
  assert.deepEqual(TEMPLATE_IDS, EXPECTED_TEMPLATE_IDS)
  assert.equal(new Set(TEMPLATE_IDS).size, 13)
  assert.equal(TEMPLATES.length, 13)
})

test('every template builds non-empty valid Mermaid with a Chinese title', () => {
  for (const id of EXPECTED_TEMPLATE_IDS) {
    const source = buildTemplate(id, '测试主题')
    const result = validateMermaid(source)

    assert.equal(source.trim().length > 0, true, `${id} source should not be empty`)
    assert.equal(source.includes('测试主题'), true, `${id} should embed the title`)
    assert.equal(result.ok, true, `${id} should validate: ${JSON.stringify(result.errors)}`)
  }
})

test('template building is deterministic', () => {
  for (const id of EXPECTED_TEMPLATE_IDS) {
    assert.equal(buildTemplate(id, 'Checkout flow'), buildTemplate(id, 'Checkout flow'))
  }
})

test('a title with punctuation is embedded safely', () => {
  const source = buildTemplate('flowchart', 'Q1: "Launch" (draft) [beta]')
  const result = validateMermaid(source)

  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.match(source, /Q1: #quot;Launch#quot; \(draft\) \[beta\]/)
  assert.equal(quoteLabel('A "quoted" label'), '"A #quot;quoted#quot; label"')
})

test('an unknown template id throws a clear error', () => {
  assert.throws(() => buildTemplate('not-a-template' as TemplateId, 'x'), /Unknown Mermaid template/)
})

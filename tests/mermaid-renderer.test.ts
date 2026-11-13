import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMermaidThemeCss,
  buildMermaidThemeVariables,
  detectMermaidDiagramType,
  formatMermaidError,
  isMermaidLanguage,
  mermaidDiagramLabel,
  normalizeMermaidSource,
  prepareMermaidSvgForDownload,
  readMermaidSvgSize,
  type MermaidPalette
} from '../src/renderer/src/lib/mermaid'
import { MERMAID_TEMPLATES, mermaidTemplateList } from '../src/renderer/src/lib/mermaid-templates'

const palette: MermaidPalette = {
  background: '#101010',
  surface: '#151515',
  surfaceRaised: '#1d1d1d',
  surfaceSunken: '#0a0a0a',
  text: '#f5f5f5',
  textMuted: '#aaaaaa',
  textFaint: '#888888',
  border: '#333333',
  borderStrong: '#444444',
  accent: '#4c9aff',
  accentContrast: '#080b11',
  accentSoft: 'rgba(76, 154, 255, 0.14)',
  success: '#4ade80',
  warning: '#f59e0b',
  danger: '#f87171',
  fontFamily: 'system-ui, sans-serif',
  shadow: 'rgba(0, 0, 0, 0.3)',
  series: ['#4c9aff', '#4ade80']
}

test('mermaid fences are recognised by language, including mmd', () => {
  assert.equal(isMermaidLanguage('mermaid'), true)
  assert.equal(isMermaidLanguage('Mermaid'), true)
  assert.equal(isMermaidLanguage(' mmd '), true)
  assert.equal(isMermaidLanguage('javascript'), false)
  assert.equal(isMermaidLanguage(undefined), false)
})

test('diagram type detection skips comments and YAML frontmatter', () => {
  assert.deepEqual(detectMermaidDiagramType('flowchart TD\n A-->B'), { id: 'flowchart', label: 'Flowchart' })
  assert.deepEqual(detectMermaidDiagramType('%% a comment\nsequenceDiagram\n A->>B: hi'), {
    id: 'sequence',
    label: 'Sequence diagram'
  })
  assert.deepEqual(detectMermaidDiagramType('---\ntitle: Demo\n---\nstateDiagram-v2\n[*] --> A'), {
    id: 'state',
    label: 'State diagram'
  })
  assert.deepEqual(
    detectMermaidDiagramType('flowchart LR\n  subgraph A[客户]\n    A1-->A2\n  end\n  subgraph B[客服]\n    B1-->B2\n  end'),
    { id: 'swimlane', label: 'Swimlane' }
  )
  assert.deepEqual(detectMermaidDiagramType('flowchart TD\n  subgraph A[前端]\n    A1-->A2\n  end'), {
    id: 'flowchart',
    label: 'Flowchart'
  })
  assert.equal(detectMermaidDiagramType('---\ntitle: Demo\n'), null)
  assert.equal(detectMermaidDiagramType('not a diagram'), null)
  assert.equal(mermaidDiagramLabel('gantt\n dateFormat YYYY-MM-DD'), 'Gantt chart')
  assert.equal(mermaidDiagramLabel(''), 'Diagram')
})

test('normalization preserves significant indentation', () => {
  assert.equal(normalizeMermaidSource('\uFEFFflowchart TD\r\n  A[Start]  \r\n  A --> B\n\n'), 'flowchart TD\n  A[Start]\n  A --> B')
})

test('svg size reads width/height and falls back to the viewBox', () => {
  assert.deepEqual(readMermaidSvgSize('<svg width="320" height="180" viewBox="0 0 320 180"></svg>'), {
    width: 320,
    height: 180
  })
  assert.deepEqual(readMermaidSvgSize('<svg viewBox="0 0 640 480"></svg>'), { width: 640, height: 480 })
  assert.equal(readMermaidSvgSize('<svg viewBox="0 0 0 0"></svg>'), null)
  assert.equal(readMermaidSvgSize('<div></div>'), null)
})

test('download preparation adds a namespace and a background rect', () => {
  const svg = prepareMermaidSvgForDownload('<svg width="10" height="10"><g/></svg>', '#ffffff')
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /<rect[^>]*fill="#ffffff"[^>]*\/>/)
  assert.match(svg, /<g\/><\/svg>$/)
})

test('theme variables map app tokens to Mermaid roles', () => {
  const variables = buildMermaidThemeVariables(palette)
  assert.equal(variables.primaryTextColor, palette.text)
  assert.equal(variables.primaryColor, palette.surfaceRaised)
  assert.equal(variables.edgeLabelBackground, palette.surfaceRaised)
  assert.equal(variables.pie1, palette.series[0])
  assert.equal(variables.pie2, palette.series[1])
  assert.equal(variables.fontFamily, palette.fontFamily)
})

test('theme CSS rounds nodes, tints decision diamonds and keeps shadows soft', () => {
  const css = buildMermaidThemeCss(palette)
  assert.match(css, /\.node rect[\s\S]*rx: 9px/)
  assert.match(css, /\.node polygon[\s\S]*fill: rgba\(76, 154, 255, 0\.14\) !important/)
  assert.match(css, /drop-shadow\(0 3px 8px rgba\(0, 0, 0, 0\.3\)\)/)
  assert.match(css, /\.edgePath \.path[\s\S]*stroke-width: 1\.4px/)
  assert.match(css, /\.cluster rect[\s\S]*stroke-dasharray/)
})

test('render errors become short single-line messages', () => {
  assert.equal(formatMermaidError(new Error('Parse error on line 2')), 'Parse error on line 2')
  assert.equal(formatMermaidError(''), 'The diagram could not be rendered.')
  assert.equal(formatMermaidError({ message: 'boom' }), 'boom')
  assert.match(formatMermaidError(new Error('x'.repeat(3000))), /…$/)
})

test('the composer exposes the full bilingual PM template catalogue', () => {
  assert.equal(MERMAID_TEMPLATES.length, 13)
  assert.equal(new Set(MERMAID_TEMPLATES.map((template) => template.id)).size, 13)
  const english = mermaidTemplateList('en')
  const chinese = mermaidTemplateList('zh-CN')
  assert.equal(english.length, 13)
  assert.equal(chinese.length, 13)
  for (const [index, template] of MERMAID_TEMPLATES.entries()) {
    for (const prompt of [template.prompt.en, template.prompt.zh]) {
      assert.match(prompt, /```mermaid/, `${template.id} prompt must request one mermaid fence`)
      assert.match(prompt, /20/, `${template.id} prompt must cap the diagram size`)
    }
    assert.equal(english[index].name, template.name.en)
    assert.equal(chinese[index].name, template.name.zh)
    assert.notEqual(english[index].prompt, chinese[index].prompt)
  }
  const swimlane = MERMAID_TEMPLATES.find((template) => template.id === 'swimlane')
  assert.match(swimlane?.prompt.en ?? '', /flowchart LR/)
  assert.match(swimlane?.prompt.en ?? '', /subgraph/)
})

/**
 * The only module that touches `mermaid` itself.
 *
 * The library is imported dynamically so a conversation without a diagram
 * never pays for it, and every render is funnelled through one queue: Mermaid
 * mutates a global config (the theme), so two diagrams initialised at the same
 * time could otherwise paint with each other's colours.
 */
import type { MermaidConfig } from 'mermaid'
import {
  buildMermaidThemeCss,
  buildMermaidThemeVariables,
  normalizeMermaidSource,
  type MermaidPalette
} from './mermaid'

type MermaidApi = (typeof import('mermaid'))['default']

let mermaidPromise: Promise<MermaidApi> | null = null
let initializedSignature: string | null = null
let renderSequence = 0
let renderQueue: Promise<unknown> = Promise.resolve()

/** Load the library once. Safe to call from an effect; the promise is shared. */
export function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((module) => module.default)
  return mermaidPromise
}

/** Warm the import without waiting for it. */
export function preloadMermaid(): void {
  void loadMermaid()
}

function readToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = styles.getPropertyValue(name).trim()
  return value || fallback
}

let colorCanvas: HTMLCanvasElement | null = null

/**
 * Turn a token's computed value into a plain colour.
 *
 * Appearance settings can override `--accent-soft`, `--surface-chrome` and
 * friends with `color-mix(...)`, which is valid CSS but not a value Mermaid's
 * colour math can consume. A canvas fillStyle normalises it to rgb()/rgba()
 * without duplicating the app's colour formulas.
 */
function resolveColor(value: string, fallback: string): string {
  const trimmed = value.trim()
  if (!trimmed || typeof document === 'undefined') return fallback
  try {
    colorCanvas ??= document.createElement('canvas')
    colorCanvas.width = 1
    colorCanvas.height = 1
    const context = colorCanvas.getContext('2d', { willReadFrequently: true })
    if (!context) return fallback
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = '#010203'
    context.fillStyle = trimmed
    if (context.fillStyle === '#010203' && trimmed.toLowerCase() !== '#010203') return fallback
    context.fillRect(0, 0, 1, 1)
    const data = context.getImageData(0, 0, 1, 1).data
    const alpha = data[3] / 255
    if (alpha === 0) return 'rgba(0, 0, 0, 0)'
    if (alpha === 1) return `rgb(${data[0]}, ${data[1]}, ${data[2]})`
    return `rgba(${data[0]}, ${data[1]}, ${data[2]}, ${Number(alpha.toFixed(3))})`
  } catch {
    return fallback
  }
}

function readColor(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return resolveColor(readToken(styles, name, fallback), fallback)
}

function fallbackPalette(isDark: boolean): MermaidPalette {
  return isDark
    ? {
        background: '#16181d',
        surface: '#111317',
        surfaceRaised: '#1d2027',
        surfaceSunken: '#0d0f13',
        text: '#f2f4f8',
        textMuted: '#9da4b2',
        textFaint: '#868e9e',
        border: 'rgba(255, 255, 255, 0.1)',
        borderStrong: 'rgba(255, 255, 255, 0.17)',
        accent: '#4c9aff',
        accentContrast: '#080b11',
        accentSoft: 'rgba(76, 154, 255, 0.14)',
        success: '#4ade80',
        warning: '#f59e0b',
        danger: '#f87171',
        fontFamily: 'system-ui, sans-serif',
        shadow: 'rgba(0, 0, 0, 0.32)',
        series: ['#4c9aff', '#4ade80', '#f59e0b', '#f87171', '#a78bfa', '#f472b6', '#fb923c', '#facc15']
      }
    : {
        background: '#ffffff',
        surface: '#f8f8f8',
        surfaceRaised: '#ffffff',
        surfaceSunken: '#f2f2f2',
        text: '#242424',
        textMuted: '#686868',
        textFaint: '#666666',
        border: '#e0e0e0',
        borderStrong: '#d4d4d4',
        accent: '#292929',
        accentContrast: '#ffffff',
        accentSoft: '#ededed',
        success: '#16a34a',
        warning: '#b45309',
        danger: '#dc2626',
        fontFamily: 'system-ui, sans-serif',
        shadow: 'rgba(15, 23, 42, 0.12)',
        series: ['#292929', '#16a34a', '#b45309', '#dc2626', '#7c3aed', '#db2777', '#c2410c', '#a16207']
      }
}

/**
 * Resolve the app's design tokens into the palette Mermaid understands.
 *
 * Reading the custom properties at render time means an appearance change
 * (dark/light, accent, contrast tone) reaches the SVG without a second copy
 * of the colours in TypeScript.
 */
export function readMermaidPalette(isDark: boolean): MermaidPalette {
  if (typeof document === 'undefined') return fallbackPalette(isDark)
  const root = document.documentElement
  const styles = getComputedStyle(root)
  const bodyFont = getComputedStyle(document.body).fontFamily
  return {
    background: readColor(styles, '--surface-canvas', '#16181d'),
    surface: readColor(styles, '--surface-chrome', '#111317'),
    surfaceRaised: readColor(styles, '--surface-raised', '#1d2027'),
    surfaceSunken: readColor(styles, '--surface-sunken', '#0d0f13'),
    text: readColor(styles, '--text-primary', '#f2f4f8'),
    textMuted: readColor(styles, '--text-secondary', '#9da4b2'),
    textFaint: readColor(styles, '--text-tertiary', '#868e9e'),
    border: readColor(styles, '--border-default', 'rgba(255, 255, 255, 0.1)'),
    borderStrong: readColor(styles, '--border-strong', 'rgba(255, 255, 255, 0.17)'),
    accent: readColor(styles, '--accent', '#4c9aff'),
    accentContrast: readColor(styles, '--accent-contrast', '#080b11'),
    accentSoft: readColor(styles, '--accent-soft', 'rgba(76, 154, 255, 0.14)'),
    success: readColor(styles, '--status-success', '#4ade80'),
    warning: readColor(styles, '--status-warning', '#f59e0b'),
    danger: readColor(styles, '--status-danger', '#f87171'),
    fontFamily: bodyFont || 'system-ui, sans-serif',
    shadow: isDark ? 'rgba(0, 0, 0, 0.34)' : 'rgba(15, 23, 42, 0.12)',
    series: [
      readColor(styles, '--accent', '#4c9aff'),
      readColor(styles, '--status-success', '#4ade80'),
      readColor(styles, '--status-warning', '#f59e0b'),
      readColor(styles, '--status-danger', '#f87171'),
      readColor(styles, '--violet', '#a78bfa'),
      readColor(styles, '--project-icon-pink', '#f472b6'),
      readColor(styles, '--project-icon-orange', '#fb923c'),
      readColor(styles, '--project-icon-yellow', '#facc15'),
      readColor(styles, '--project-icon-blue', '#4c9aff')
    ]
  }
}

function createConfig(isDark: boolean): MermaidConfig {
  const palette = readMermaidPalette(isDark)
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    darkMode: isDark,
    htmlLabels: true,
    fontFamily: palette.fontFamily,
    themeVariables: buildMermaidThemeVariables(palette),
    themeCSS: buildMermaidThemeCss(palette),
    suppressErrorRendering: true,
    // Product diagrams do not need to be tiny; the container scrolls.
    maxTextSize: 100_000,
    maxEdges: 2_000,
    // `useMaxWidth:false` writes the natural pixel size onto the SVG, which is
    // what lets the viewer fit-to-width and zoom without guessing.
    flowchart: {
      useMaxWidth: false,
      curve: 'basis',
      nodeSpacing: 38,
      rankSpacing: 48,
      diagramPadding: 10
    },
    swimlane: { useMaxWidth: false },
    sequence: {
      useMaxWidth: false,
      diagramMarginX: 18,
      diagramMarginY: 18,
      actorMargin: 58,
      messageMargin: 38,
      bottomMarginAdj: 10,
      mirrorActors: false
    },
    gantt: {
      useMaxWidth: false,
      barHeight: 24,
      barGap: 4,
      topPadding: 44,
      leftPadding: 72,
      rightPadding: 24,
      gridLineStartPadding: 30,
      fontSize: 13,
      sectionFontSize: 13,
      numberSectionStyles: 4
    },
    journey: { useMaxWidth: false },
    timeline: { useMaxWidth: false },
    class: { useMaxWidth: false },
    state: { useMaxWidth: false },
    er: { useMaxWidth: false },
    pie: { useMaxWidth: false },
    quadrantChart: { useMaxWidth: false },
    xyChart: { useMaxWidth: false },
    requirement: { useMaxWidth: false },
    architecture: { useMaxWidth: false },
    mindmap: { useMaxWidth: false },
    ishikawa: { useMaxWidth: false },
    kanban: { useMaxWidth: false },
    gitGraph: { useMaxWidth: false },
    c4: { useMaxWidth: false },
    sankey: { useMaxWidth: false },
    packet: { useMaxWidth: false },
    block: { useMaxWidth: false },
    eventmodeling: { useMaxWidth: false },
    treeView: { useMaxWidth: false },
    radar: { useMaxWidth: false },
    venn: { useMaxWidth: false },
    cynefin: { useMaxWidth: false },
    railroad: { useMaxWidth: false }
  }
}

function paletteSignature(palette: MermaidPalette): string {
  return JSON.stringify(palette)
}

async function ensureInitialized(isDark: boolean): Promise<MermaidApi> {
  const mermaid = await loadMermaid()
  const palette = readMermaidPalette(isDark)
  const signature = paletteSignature(palette)
  if (initializedSignature !== signature) {
    mermaid.initialize(createConfig(isDark))
    initializedSignature = signature
  }
  return mermaid
}

/**
 * Mermaid appends a temporary measuring element to `<body>` for a render and,
 * on some parse failures, leaves it behind. Clear only elements the library
 * itself owns so a failed fence cannot litter the transcript's DOM.
 */
function cleanupRenderArtifacts(id: string): void {
  if (typeof document === 'undefined') return
  for (const elementId of [`d${id}`, id]) {
    const element = document.getElementById(elementId)
    if (element?.parentElement === document.body) element.remove()
  }
}

export interface MermaidRenderOptions {
  isDark: boolean
}

export interface MermaidRenderResult {
  svg: string
  /** Mermaid's own id, e.g. `flowchart-v2`. */
  diagramType: string
}

async function renderNow(source: string, options: MermaidRenderOptions): Promise<MermaidRenderResult> {
  const text = normalizeMermaidSource(source)
  if (!text) throw new Error('The diagram is empty.')
  const mermaid = await ensureInitialized(options.isDark)
  renderSequence += 1
  const id = `pi-mermaid-${Date.now().toString(36)}-${renderSequence}`
  try {
    const result = await mermaid.render(id, text)
    return { svg: result.svg, diagramType: result.diagramType }
  } finally {
    cleanupRenderArtifacts(id)
  }
}

/**
 * Render one fence body to SVG.
 *
 * Calls are serialised because `mermaid.initialize` is global state: the
 * configuration applied for one diagram must not be swapped underneath it.
 * A failed render rejects; the component catches it and keeps its last good
 * SVG rather than throwing into the transcript.
 */
export function renderMermaid(source: string, options: MermaidRenderOptions): Promise<MermaidRenderResult> {
  const task = renderQueue.then(() => renderNow(source, options))
  renderQueue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

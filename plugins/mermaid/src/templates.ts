/**
 * Pure Mermaid template builders.
 *
 * This module deliberately has no Pi imports: `tests/mermaid-plugin.test.ts`
 * bundles it straight through esbuild and exercises it with node:test.
 */

export type TemplateId =
  | 'flowchart'
  | 'swimlane'
  | 'sequence'
  | 'state'
  | 'journey'
  | 'gantt'
  | 'mindmap'
  | 'timeline'
  | 'quadrant'
  | 'requirement'
  | 'kanban'
  | 'architecture'
  | 'pie'

export interface TemplateInfo {
  id: TemplateId
  /** Short label shown in the /mermaid picker. */
  name: string
  /** One line the picker and README can show beside the name. */
  description: string
  /** When a product manager should reach for this diagram. */
  useWhen: string
}

export const TEMPLATES: readonly TemplateInfo[] = [
  {
    id: 'flowchart',
    name: 'Flowchart',
    description: 'Process steps and decision points',
    useWhen: 'Explain how work moves from request to outcome, including branches.'
  },
  {
    id: 'swimlane',
    name: 'Swimlane',
    description: 'Hand-offs across teams or roles',
    useWhen: 'Show who owns each step and where a request crosses a team boundary.'
  },
  {
    id: 'sequence',
    name: 'Sequence',
    description: 'Messages between people and systems over time',
    useWhen: 'Describe an interaction, API call, or approval conversation step by step.'
  },
  {
    id: 'state',
    name: 'State',
    description: 'Lifecycle of an item or workflow',
    useWhen: 'Show statuses, allowed transitions, and what happens at the end.'
  },
  {
    id: 'journey',
    name: 'User journey',
    description: 'Experience and pain points per stage',
    useWhen: 'Map how a user feels across discovery, onboarding, and usage.'
  },
  {
    id: 'gantt',
    name: 'Gantt',
    description: 'Schedule, dependencies and milestones',
    useWhen: 'Plan a release or rollout with dates, owners, and task order.'
  },
  {
    id: 'mindmap',
    name: 'Mindmap',
    description: 'Hierarchy of themes and ideas',
    useWhen: 'Break a problem, scope, or opportunity into related branches.'
  },
  {
    id: 'timeline',
    name: 'Timeline',
    description: 'Milestones in chronological order',
    useWhen: 'Tell the story of a launch or program quarter by quarter.'
  },
  {
    id: 'quadrant',
    name: 'Quadrant',
    description: 'Prioritisation on two axes',
    useWhen: 'Rank features by effort and impact, or urgency and importance.'
  },
  {
    id: 'requirement',
    name: 'Requirement',
    description: 'Requirements, risks and verification',
    useWhen: 'Capture what must be true and how each requirement will be verified.'
  },
  {
    id: 'kanban',
    name: 'Kanban',
    description: 'Work items in delivery columns',
    useWhen: 'Show the current shape of a backlog or a delivery board.'
  },
  {
    id: 'architecture',
    name: 'Architecture',
    description: 'Services and system boundaries',
    useWhen: 'Explain a product architecture without drawing implementation detail.'
  },
  {
    id: 'pie',
    name: 'Pie',
    description: 'Simple proportions',
    useWhen: 'Show one split such as effort allocation or traffic mix.'
  }
]

export const TEMPLATE_IDS: readonly TemplateId[] = TEMPLATES.map((template) => template.id)

const DEFAULT_TITLE = 'Untitled diagram'

/** Collapse whitespace so a title can never break a one-line Mermaid directive. */
export function normalizeTitle(title?: string): string {
  const value = (title ?? '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim()
  return value.length > 0 ? value : DEFAULT_TITLE
}

/**
 * A quoted Mermaid label. `#quot;` is Mermaid's own entity for a double quote,
 * so a title containing quotes cannot terminate the label early.
 */
export function quoteLabel(text: string): string {
  return `"${normalizeTitle(text).replace(/"/g, '#quot;')}"`
}

/**
 * Text for contexts that take a bare rest-of-line value (title directives,
 * requirement text, architecture labels). Structural brackets are removed so
 * the generated source can never unbalance the diagram.
 */
function plainText(text: string): string {
  return normalizeTitle(text).replace(/[[\]{}()]/g, '').replace(/\s+/g, ' ').trim() || DEFAULT_TITLE
}

function comment(name: string, hint: string): string {
  return `%% ${name} starter. ${hint}`
}

const BUILDERS: Record<TemplateId, (title: string) => string> = {
  flowchart: (title) => `${comment('Flowchart', 'Replace the placeholder labels; every node is one step or decision.')}
flowchart TD
  Start[${quoteLabel(`${title}: Start`)}] --> Step1[${quoteLabel('Collect requirements')}]
  Step1 --> Decision{${quoteLabel('Ready to build?')}}
  Decision -->|Yes| Build[${quoteLabel('Develop solution')}]
  Decision -->|No| Refine[${quoteLabel('Refine scope')}]
  Refine --> Step1
  Build --> Done[${quoteLabel('Launch and measure')}]`,

  swimlane: (title) => `${comment('Swimlane', 'One subgraph per lane; edges between lanes are hand-offs.')}
flowchart LR
  subgraph Customer[${quoteLabel('Customer')}]
    C1[${quoteLabel(`${title}: Raise request`)}] --> C2[${quoteLabel('Review status')}]
  end
  subgraph Product[${quoteLabel('Product')}]
    P1[${quoteLabel('Triage request')}] --> P2[${quoteLabel('Define scope')}]
  end
  subgraph Engineering[${quoteLabel('Engineering')}]
    E1[${quoteLabel('Estimate effort')}] --> E2[${quoteLabel('Build solution')}]
  end
  C2 --> P1
  P2 --> E1
  E2 --> C2`,

  sequence: (title) => `${comment('Sequence', 'Participants first, then messages in time order.')}
sequenceDiagram
  autonumber
  actor PM as Product Manager
  participant User
  participant Service as Delivery team
  User->>PM: ${plainText(`${title}: Request a feature`)}
  PM->>Service: Share the requirement
  Service-->>PM: Confirm scope and estimate
  PM-->>User: Agree the plan`,

  state: (title) => `${comment('State', 'States are stages; arrows are the allowed transitions.')}
stateDiagram-v2
  state ${quoteLabel(title)} as Draft
  [*] --> Draft
  Draft --> InReview: Submit
  InReview --> Approved: Approve
  InReview --> Draft: Request changes
  Approved --> [*]: Launch`,

  journey: (title) => `${comment('User journey', 'Each task has a score from 1 to 5 and the actors involved.')}
journey
  title ${plainText(title)}
  section Discover
    Find the problem: 5: PM
    Talk to users: 3: PM, Research
  section Define
    Write the brief: 4: PM
    Agree the scope: 3: PM, Engineering
  section Deliver
    Build the change: 3: Engineering
    Launch and measure: 5: PM, Marketing`,

  gantt: (title) => `${comment('Gantt', 'Set dateFormat first; tasks are grouped by section and ordered with after.')}
gantt
  title ${plainText(title)}
  dateFormat YYYY-MM-DD
  axisFormat %m-%d
  section Discovery
    Research users :done, research, 2026-01-05, 5d
    Define scope :active, scope, after research, 3d
  section Delivery
    Build solution :build, after scope, 10d
    Launch :milestone, launch, after build, 0d`,

  mindmap: (title) => `${comment('Mindmap', 'Indentation defines the hierarchy; quotes protect punctuation.')}
mindmap
  root((${quoteLabel(title)}))
    Goals
      ${quoteLabel('Clear outcome')}
      ${quoteLabel('Measurable success')}
    Users
      ${quoteLabel('Primary persona')}
      ${quoteLabel('Pain points')}
    Delivery
      ${quoteLabel('Milestones')}
      ${quoteLabel('Owners')}`,

  timeline: (title) => `${comment('Timeline', 'Add periods in order; each period can hold several events.')}
timeline
  title ${plainText(title)}
  section Q1
    2026-01 : Kickoff : Define goals
    2026-02 : Research : User interviews
  section Q2
    2026-04 : Build : First release
    2026-06 : Measure : Review results`,

  quadrant: (title) => `${comment('Quadrant', 'Place items with [x, y] values between 0 and 1.')}
quadrantChart
  title ${plainText(title)}
  x-axis Low effort --> High effort
  y-axis Low impact --> High impact
  quadrant-1 Quick wins
  quadrant-2 Strategic bets
  quadrant-3 Low priority
  quadrant-4 Revisit later
  Feature A: [0.2, 0.8]
  Feature B: [0.7, 0.7]
  Feature C: [0.3, 0.3]`,

  requirement: (title) => `${comment('Requirement', 'One requirement block plus an element that satisfies it.')}
requirementDiagram
  requirement R1 {
    id: R1
    text: ${quoteLabel(title)}
    risk: medium
    verifymethod: test
  }
  element Solution {
    type: system
  }
  Solution - satisfies -> R1`,

  kanban: (title) => `${comment('Kanban', 'Columns are top-level nodes; cards are indented under their column.')}
kanban
  todo[${quoteLabel(`${title}: To do`)}]
    task1[${quoteLabel('Collect requirements')}]
    task2[${quoteLabel('Confirm success metrics')}]
  doing[${quoteLabel('In progress')}]
    task3[${quoteLabel('Draft the specification')}]
  done[${quoteLabel('Done')}]
    task4[${quoteLabel('Project kickoff')}]`,

  architecture: (title) => `${comment('Architecture', 'Groups hold services; connect ports from left/right/top/bottom.')}
architecture-beta
  group product(cloud)[${plainText(`Product: ${title}`)}]
  service web(server)[${plainText('Web app')}] in product
  service api(server)[${plainText('API')}] in product
  service db(database)[${plainText('Database')}] in product
  web:R --> L:api
  api:R --> L:db`,

  pie: (title) => `${comment('Pie', 'Values are shares; showData prints the numbers next to the slices.')}
pie showData
  title ${plainText(title)}
  "Discovery" : 30
  "Design" : 25
  "Build" : 30
  "Launch" : 15`
}

/**
 * Build a complete, syntactically valid Mermaid starter for one template id.
 * The same id and title always produce the same source.
 */
export function buildTemplate(id: TemplateId, title?: string): string {
  const builder = BUILDERS[id]
  if (!builder) throw new Error(`Unknown Mermaid template: ${String(id)}`)
  return `${builder(title ?? DEFAULT_TITLE)}\n`
}

/** The human-readable label the /mermaid picker shows for a template id. */
export function templateLabel(id: TemplateId): string {
  const template = TEMPLATES.find((candidate) => candidate.id === id)
  return template ? `${template.name} — ${template.description}` : id
}

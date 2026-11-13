/**
 * Mermaid authoring policy for every Pi process Pi Desktop starts.
 *
 * The renderer turns a ```mermaid fence into a real diagram, but the model
 * still has to choose the right diagram type and write Mermaid that survives
 * a product manager's real content: Chinese labels, parentheses, commas and
 * long decision names. This extension appends a compact policy only when the
 * prompt actually asks for a diagram, so an ordinary coding turn pays nothing.
 *
 * The full, installable plugin lives in `plugins/mermaid`; this copy is the
 * baseline that makes diagrams readable out of the box in the desktop app.
 */

const MARKER = 'PI MERMAID POLICY'

const POLICY = `${MARKER}
When the user asks for a diagram, write Mermaid that a product manager can present:
- Pick the smallest correct type: flowchart TD for a process; flowchart LR with one subgraph per role for a swimlane (Mermaid has no native swimlane); sequenceDiagram for interaction over time; stateDiagram-v2 for a lifecycle; journey for experience; gantt for a plan; mindmap for a hierarchy; timeline for releases; quadrantChart for prioritisation; requirementDiagram for requirements; kanban for work states; pie for a share.
- One diagram per answer, with a short title or a one-line intro; explain it in 2-3 sentences after the fence. Do not print the diagram twice. Let the app theme colour the diagram; do not hardcode node fills unless the user asks for a status or risk colour.
- Node labels: short, verb-first for actions, noun-first for states; max ~20 nodes. Put the actor in the label only when handoffs matter. Label every decision edge with its condition (Yes/No, 金额超过10万, 审核通过).
- Use Chinese labels when the user writes Chinese; Mermaid accepts UTF-8. Quote any label containing parentheses, brackets, commas, colons or arrows: A["提交申请（含附件）"].
- Pitfalls: every subgraph needs its own end; never use the bare word end as a node id; do not put raw < or > in labels (use #lt; / #gt;); semicolons end statements; keep %% comments on their own line; gantt needs dateFormat; sequence participants need aliases before use.
- Before presenting, check: every edge has two valid endpoints, every subgraph closes, every decision has a labelled branch, and the happy path is obvious.`

export function mermaidPolicyExtension(): string {
  return `const MARKER = ${JSON.stringify(MARKER)};
const POLICY = ${JSON.stringify(POLICY)};
const DIAGRAM_HINT = /(mermaid|diagram|flowchart|flow chart|swimlane|swim lane|sequence diagram|state machine|gantt|mind ?map|timeline|quadrant|kanban|requirement diagram|architecture diagram|流程图|泳道图|时序图|状态图|甘特图|思维导图|时间线|路线图|象限图|看板|需求图|架构图|图表)/i;

export default function registerMermaidPolicy(pi) {
  pi.on("before_agent_start", async (event) => {
    if (event.messageType !== "user" || typeof event.prompt !== "string") return;
    if (!DIAGRAM_HINT.test(event.prompt)) return;
    if (event.systemPrompt.includes(MARKER)) return;
    return { systemPrompt: event.systemPrompt + "\\n\\n" + POLICY };
  });
}
`
}

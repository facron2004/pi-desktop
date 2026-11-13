import type { AppLanguage } from '@shared/types'

/**
 * One product-manager diagram template.
 *
 * `name` and `description` label the entry in the composer's `+` menu;
 * `prompt` is the complete instruction inserted into the composer. Every
 * prompt is self-contained because the user may send it without adding
 * anything: it names the diagram type, the layout, the output contract and
 * what to do when the request is thin.
 */
export interface MermaidTemplate {
  id: string
  name: { en: string; zh: string }
  description: { en: string; zh: string }
  prompt: { en: string; zh: string }
}

/**
 * The contract shared by every template. Keeping it in one place means each
 * template body only has to describe its diagram-specific conventions; the
 * output shape (one fence, short explanation, small readable graph, explicit
 * assumptions) can never drift between templates.
 */
const GUIDE = {
  en: `Return exactly one \`\`\`mermaid fenced code block followed by a short explanation (2–4 sentences), with no other code blocks. Write every diagram label and the explanation in English. Keep node labels short and verb-first (at most 8 words); label every decision branch with its condition; keep the diagram to 20 nodes or fewer. Use one accent at most, leave colours to the host theme, and do not write style/classDef blocks unless asked. If the details are missing or thin, make reasonable assumptions, list them in one line after the diagram, and continue without asking questions.`,
  zh: `只输出一个 \`\`\`mermaid 代码块，后面跟 2–4 句简短说明，不要再输出其他代码块。图中所有标签和说明都使用中文。节点标签要短，以动词开头（最多 8 个词）；每个判断分支都要标明条件；整张图不超过 20 个节点。最多使用一个强调色，颜色交给宿主主题，不要手写 style/classDef 块（除非用户明确要求）。如果信息缺失或不够具体，请做合理假设，在图后写一行假设并继续，不要反问。`
}

export const MERMAID_TEMPLATES: MermaidTemplate[] = [
  {
    id: 'flowchart',
    name: { en: 'Business Flowchart', zh: '业务流程图' },
    description: {
      en: 'Turn a process into clear steps, decisions and outcomes.',
      zh: '把业务流程拆成清晰的步骤、判断和结果。'
    },
    prompt: {
      en: `Create a clean business-process flowchart in Mermaid for the process I describe below (if I have not described one, use a realistic SaaS feature-request process as the example).
Use \`flowchart TD\` — a top-down process with one clear start event, explicit decision points and one business outcome. Mention the actor in a node only where it changes who does the work, and group related steps into at most four subgraphs only when that makes ownership clearer. Keep the main path obvious and push exceptions onto side branches.

${GUIDE.en}`,
      zh: `请用 Mermaid 画一张清晰的业务流程图，流程见下方描述（如果我没有描述具体流程，就用一个真实的 SaaS 功能需求处理流程作为示例）。
使用 \`flowchart TD\`，从一个明确的开始事件出发，经过清晰的判断节点，最终落到一个业务结果。只在需要说明由谁执行时点出角色；只有在确实有助于区分责任时才用最多 4 个 subgraph 分组。主流程要一眼可读，异常情况放到旁支。

${GUIDE.zh}`
    }
  },
  {
    id: 'swimlane',
    name: { en: 'Cross-functional Swimlane', zh: '跨职能泳道图' },
    description: {
      en: 'Show handoffs across roles and departments.',
      zh: '按角色或部门分泳道，展示跨部门交接。'
    },
    prompt: {
      en: `Create a cross-functional swimlane diagram in Mermaid for the process I describe below (if I have not described one, use a realistic B2B order-to-cash process as the example).
Mermaid has no native swimlane type, so build it with \`flowchart LR\` and exactly one \`subgraph\` per role or department (for example Sales, Finance, Operations), each subgraph titled with the role. Put every step inside the lane of the role that performs it, and draw cross-lane arrows for handoffs. Keep each lane to 3–5 steps and never nest subgraphs.

${GUIDE.en}`,
      zh: `请用 Mermaid 画一张跨职能泳道图，流程见下方描述（如果我没有描述具体流程，就用一个真实的 B2B 从下单到回款流程作为示例）。
Mermaid 没有原生泳道图，所以请用 \`flowchart LR\`，每个角色或部门对应一个 \`subgraph\`（例如销售、财务、运营），子图标题写角色名。每一步都放在实际执行它的角色泳道里，跨角色交接用跨泳道箭头连接。每条泳道 3–5 个步骤，不要嵌套 subgraph。

${GUIDE.zh}`
    }
  },
  {
    id: 'sequence',
    name: { en: 'Sequence Diagram', zh: '时序图' },
    description: {
      en: 'Map an interaction between users and systems over time.',
      zh: '按时间顺序描述用户与系统之间的交互。'
    },
    prompt: {
      en: `Create a Mermaid \`sequenceDiagram\` for the interaction I describe below (if I have not described one, use a realistic checkout-and-payment flow as the example).
Declare at most six participants with clear aliases, show the happy path from top to bottom, and use \`alt\` / \`else\` blocks only for the one or two branches that really change the flow — put each branch condition in the \`alt\` label. Label each message with a short verb-first phrase, show replies where they matter, and avoid notes unless they clarify a business rule.

${GUIDE.en}`,
      zh: `请用 Mermaid 的 \`sequenceDiagram\` 画出下方描述的交互（如果我没有描述，就用一个真实的结算与支付流程作为示例）。
参与者最多 6 个，用清晰的别名声明；按从上到下的顺序展示主流程；只对真正改变流程的 1–2 个分支使用 \`alt\` / \`else\`，并把分支条件写在 \`alt\` 标签里。每条消息用简短的动宾短语，重要的返回值要画出来；除非能说明业务规则，否则不要加 note。

${GUIDE.zh}`
    }
  },
  {
    id: 'state',
    name: { en: 'State Machine', zh: '状态机图' },
    description: {
      en: 'Model a lifecycle with states, events and guards.',
      zh: '用状态、事件和条件描述一个生命周期。'
    },
    prompt: {
      en: `Create a Mermaid \`stateDiagram-v2\` state machine for the lifecycle I describe below (if I have not described one, use a realistic subscription lifecycle: trial → active → past due → cancelled).
Mark the initial state with \`[*]\` and mark the terminal state explicitly; label every transition with a short event phrase and add a guard condition in square brackets when a transition depends on one. Cover the happy path plus the two or three exceptions that matter, and avoid duplicate paths.

${GUIDE.en}`,
      zh: `请用 Mermaid 的 \`stateDiagram-v2\` 画出下方描述的生命周期状态机（如果我没有描述，就用一个真实的订阅生命周期：试用 → 活跃 → 逾期 → 取消）。
用 \`[*]\` 标出初始状态，并明确标出终止状态；每条迁移都用简短的事件短语命名，需要条件才能触发时用方括号写出守卫条件。覆盖主流程和 2–3 个关键异常，不要画重复路径。

${GUIDE.zh}`
    }
  },
  {
    id: 'journey',
    name: { en: 'User Journey', zh: '用户旅程图' },
    description: {
      en: 'Chart each phase of the user experience and its satisfaction score.',
      zh: '分阶段展示用户体验与满意度评分。'
    },
    prompt: {
      en: `Create a Mermaid \`journey\` diagram for the user journey I describe below (if I have not described one, use a realistic first-week onboarding journey for a SaaS product).
Break the journey into three to five phase sections, and give every step the form \`Verb-first task: satisfaction score 1–5: actor\`. Keep four to seven steps per section, use the scores to make friction visible, and stay within 20 steps.

${GUIDE.en}`,
      zh: `请用 Mermaid 的 \`journey\` 画出下方描述的用户旅程（如果我没有描述，就用一个真实的 SaaS 产品首周引导旅程作为示例）。
把旅程拆成 3–5 个阶段 section，每个步骤按 \`动宾任务: 满意度评分 1–5: 角色\` 的格式编写。每个阶段 4–7 步，用评分体现体验摩擦点，总步骤不超过 20 个。

${GUIDE.zh}`
    }
  },
  {
    id: 'gantt',
    name: { en: 'Gantt Schedule', zh: '甘特图' },
    description: {
      en: 'Plan tasks, dependencies and milestones on a timeline.',
      zh: '在时间轴上规划任务、依赖和里程碑。'
    },
    prompt: {
      en: `Create a Mermaid \`gantt\` chart for the project plan I describe below (if I have not described one, use a realistic 12-week mobile-app launch plan).
Start with \`dateFormat YYYY-MM-DD\` and add \`axisFormat %m/%d\`. Split the plan into three to five sections (for example Discovery, Build, Launch), and give every task a short verb-first name, an id, a start date, and either an end date or a duration like \`5d\`. Add milestones for key decisions and releases, use two or three \`after\` dependencies where ordering is real, and keep the chart to 20 tasks.

${GUIDE.en}`,
      zh: `请用 Mermaid 的 \`gantt\` 画出下方描述的项目计划（如果我没有描述，就用一个真实的 12 周移动应用发布计划作为示例）。
以 \`dateFormat YYYY-MM-DD\` 开头，并加上 \`axisFormat %m/%d\`。把计划拆成 3–5 个 section（例如：调研、开发、发布），每个任务都要有简短的动宾名称、id、开始日期，以及结束日期或类似 \`5d\` 的工期。关键决策和发布要设里程碑，确实存在先后关系时用 2–3 个 \`after\` 依赖，总任务不超过 20 个。

${GUIDE.zh}`
    }
  },
  {
    id: 'mindmap',
    name: { en: 'Mind Map', zh: '思维导图' },
    description: {
      en: 'Break a topic into a balanced hierarchy.',
      zh: '把一个主题拆成层级清晰的思维导图。'
    },
    prompt: {
      en: `Create a Mermaid \`mindmap\` for the topic I describe below (if I have not described one, use a realistic product strategy for a subscription analytics tool).
Put the topic in the root as \`((Topic))\`, then create three to five first-level branches (for example Users, Problems, Solution, Metrics, Risks), each with two to four short leaves. Use indentation with exactly one level per step to define hierarchy, keep at most three levels and 20 nodes, and quote any label that contains spaces or punctuation.

${GUIDE.en}`,
      zh: `请用 Mermaid 的 \`mindmap\` 画出下方描述的主题（如果我没有描述，就用一个真实的订阅分析工具产品策略作为示例）。
根节点写成 \`((主题))\`，再分 3–5 个一级分支（例如：用户、问题、方案、指标、风险），每个分支下放 2–4 个简短叶子节点。用缩进表示层级，每级只缩进一次；最多 3 层、20 个节点；标签含空格或标点时要加引号。

${GUIDE.zh}`
    }
  },
  {
    id: 'timeline',
    name: { en: 'Roadmap Timeline', zh: '路线图时间线' },
    description: {
      en: 'Show releases and milestones over time.',
      zh: '按时间展示版本发布与关键里程碑。'
    },
    prompt: {
      en: `Create a Mermaid \`timeline\` for the roadmap I describe below (if I have not described one, use a realistic 12-month product roadmap from beta to general availability).
Add a \`title\`, then four to six time periods (quarters or months) as sections, and under each period list two to four short verb-first milestones using the form \`Period : Milestone : Milestone\`. Make the sequence of releases and theme changes obvious, with no more than 20 events.

${GUIDE.en}`,
      zh: `请用 Mermaid 的 \`timeline\` 画出下方描述的路线图（如果我没有描述，就用一个真实的 12 个月产品路线图：从内测到正式发布）。
先加 \`title\`，再用 4–6 个时间段（季度或月份）作为 section；每个时间段下列 2–4 个简短的动宾里程碑，格式为 \`时间 : 里程碑 : 里程碑\`。让版本发布顺序和主题变化一目了然，事件总数不超过 20 个。

${GUIDE.zh}`
    }
  },
  {
    id: 'quadrant',
    name: { en: 'Priority Quadrant', zh: '优先级象限图' },
    description: {
      en: 'Rank features or ideas by impact and effort.',
      zh: '按影响与成本给功能或想法排优先级。'
    },
    prompt: {
      en: `Create a Mermaid \`quadrantChart\` for the prioritisation I describe below (if I have not described one, use a realistic feature-priority matrix for a B2B SaaS product).
Give it a clear \`title\`, label both axes with their low-to-high meaning (for example \`x-axis Low effort --> High effort\` and \`y-axis Low impact --> High impact\`), and name the four quadrants so each one states what to do (for example Quick wins, Strategic bets, Fill-ins, Avoid). Plot six to twelve items as \`Name: [x, y]\` with x and y between 0 and 1, and use the quadrant logic to make the priority order obvious.

${GUIDE.en}`,
      zh: `请用 Mermaid 的 \`quadrantChart\` 画出下方描述的优先级分析（如果我没有描述，就用一个真实的 B2B SaaS 功能优先级矩阵作为示例）。
写好 \`title\`，两个坐标轴都要标出从低到高的含义（例如 \`x-axis 低成本 --> 高成本\`、\`y-axis 低影响 --> 高影响\`），四个象限的命名要直接说明该怎么处理（例如：速赢、战略下注、补位、放弃）。把 6–12 个事项画成 \`名称: [x, y]\`，x、y 在 0 到 1 之间，并让优先级顺序一眼可见。

${GUIDE.zh}`
    }
  },
  {
    id: 'requirement',
    name: { en: 'Requirement Diagram', zh: '需求图' },
    description: {
      en: 'Capture requirements, risks and the elements that satisfy them.',
      zh: '记录需求、风险以及满足需求的系统元素。'
    },
    prompt: {
      en: `Create a Mermaid \`requirementDiagram\` for the requirement set I describe below (if I have not described one, use a realistic checkout requirement set).
Define two to four \`requirement\` blocks with an \`id\`, a one-sentence \`text\`, a \`risk\` (low / medium / high) and a \`verifymethod\` (test / inspection / analysis); define the system \`element\`s that meet them and connect each requirement with \`satisfies\` or \`derives\`. Quote any text containing colons or punctuation, and keep the whole diagram to 20 items.

${GUIDE.en}`,
      zh: `请用 Mermaid 的 \`requirementDiagram\` 画出一组需求（如果我没有描述，就用一个真实的结算需求集作为示例）。
定义 2–4 个 \`requirement\` 块，每个都要有 \`id\`、一句话的 \`text\`、\`risk\`（low / medium / high）和 \`verifymethod\`（test / inspection / analysis）；再定义满足这些需求的系统 \`element\`，用 \`satisfies\` 或 \`derives\` 连线。文字里出现冒号或标点时要加引号，整张图不超过 20 项。

${GUIDE.zh}`
    }
  },
  {
    id: 'kanban',
    name: { en: 'Kanban Board', zh: '看板图' },
    description: {
      en: 'Visualize a workstream as columns and cards.',
      zh: '用列和卡片可视化工作流。'
    },
    prompt: {
      en: `Create a Mermaid \`kanban\` board for the workstream I describe below (if I have not described one, use a realistic product-launch workstream).
Use four to five columns that reflect real team states (for example Backlog, Ready, In progress, Review, Done) with the \`columnId[Column name]\` syntax, and three to five cards per column with short verb-first titles. Add an owner in parentheses only where it helps, make sure every card sits in exactly one column, and keep the board to 20 cards.

${GUIDE.en}`,
      zh: `请用 Mermaid 的 \`kanban\` 画出下方描述的工作流（如果我没有描述，就用一个真实的产品发布工作流作为示例）。
用 4–5 个反映团队真实状态的列（例如：待办、就绪、进行中、评审、已完成），列用 \`columnId[列名]\` 语法；每列放 3–5 张卡片，卡片标题用简短动宾短语。需要时在括号里标注负责人；每张卡片只能出现在一列中，整块看板不超过 20 张卡片。

${GUIDE.zh}`
    }
  },
  {
    id: 'architecture',
    name: { en: 'System Architecture', zh: '系统架构图' },
    description: {
      en: 'Lay out components by layer with labeled dependencies.',
      zh: '按分层展示系统组件及其依赖关系。'
    },
    prompt: {
      en: `Create a layered system-architecture flowchart in Mermaid for the system I describe below (if I have not described one, use a realistic web SaaS architecture).
Use \`flowchart TD\` with exactly one \`subgraph\` per layer — Client, Access/API, Services, Data — and place each component in its layer. Draw arrows only for real calls or data dependencies, and label the protocol where it matters (for example \`HTTPS\`, \`SQL\`). Keep node labels short — verb-first for actions, concise nouns for components — and keep the whole diagram to 20 nodes. Do not mix flow steps into a layer diagram.

${GUIDE.en}`,
      zh: `请用 Mermaid 画一张分层系统架构图（如果我没有描述，就用一个真实的 Web SaaS 架构作为示例）。
使用 \`flowchart TD\`，每一层对应一个 \`subgraph\`——客户端、接入/API、服务、数据——并把组件放进所属层。只画真实的调用或数据依赖箭头，关键位置标注协议（例如 \`HTTPS\`、\`SQL\`）。节点标签要短：动作以动词开头，组件用简洁名词；整张图不超过 20 个节点。不要把流程步骤混进分层架构图。

${GUIDE.zh}`
    }
  },
  {
    id: 'pie',
    name: { en: 'Pie Breakdown', zh: '饼图' },
    description: {
      en: 'Show how a total splits into a few parts.',
      zh: '展示总量如何拆分为几个部分。'
    },
    prompt: {
      en: `Create a Mermaid \`pie\` chart for the breakdown I describe below (if I have not described one, use a realistic split of product-discovery research effort).
Add \`showData\` and a clear title, use four to six short category labels, and give each slice one consistent number (raw counts or percentages). Order slices from largest to smallest and keep the chart to eight slices or fewer; use the short explanation to state the main takeaway.

${GUIDE.en}`,
      zh: `请用 Mermaid 的 \`pie\` 画出下方描述的占比（如果我没有描述，就用一次真实的产品调研投入分布作为示例）。
加上 \`showData\` 和清晰的标题，使用 4–6 个简短的分类标签，每个扇区给一个口径一致的数字（数量或百分比）。扇区从大到小排列，最多 8 个；在简短说明里点出最重要的结论。

${GUIDE.zh}`
    }
  }
]

/** Resolve the bilingual template catalogue for the current UI language. */
export function mermaidTemplateList(
  language: AppLanguage
): Array<{ id: string; name: string; description: string; prompt: string }> {
  const key = language === 'zh-CN' ? 'zh' : 'en'
  return MERMAID_TEMPLATES.map((template) => ({
    id: template.id,
    name: template.name[key],
    description: template.description[key],
    prompt: template.prompt[key]
  }))
}

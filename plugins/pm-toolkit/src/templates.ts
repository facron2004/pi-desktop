/**
 * Product-manager document starters.
 *
 * The templates are deliberately opinionated: each section names the decision
 * it supports, and placeholders tell the model or the PM what good looks like.
 * They are pure strings so they can be unit-tested and used from the tool,
 * the /pm command, or a skill without a model call.
 */

export type DocLanguage = 'zh-CN' | 'en'

export type DocKind =
  | 'prd'
  | 'user_story'
  | 'acceptance_criteria'
  | 'launch_checklist'
  | 'status_update'
  | 'interview_guide'
  | 'survey'
  | 'decision_log'
  | 'roadmap'
  | 'competitor_matrix'
  | 'release_notes'

export interface DocTemplate {
  kind: DocKind
  title: string
  description: string
}

export const DOC_TEMPLATES: readonly DocTemplate[] = [
  { kind: 'prd', title: 'PRD', description: '问题、目标、范围、用户故事、验收标准和风险' },
  { kind: 'user_story', title: '用户故事', description: '按 INVEST 拆分，并给出 Given/When/Then 验收标准' },
  { kind: 'acceptance_criteria', title: '验收标准', description: '可测试的 Given/When/Then 场景清单' },
  { kind: 'launch_checklist', title: '发布检查清单', description: '产品、运营、支持、监控与回滚的发布前检查' },
  { kind: 'status_update', title: '周报 / 干系人更新', description: '结论先行，说明进展、风险、需要谁做什么' },
  { kind: 'interview_guide', title: '用户访谈提纲', description: '目标、暖场、核心问题、追问和收尾' },
  { kind: 'survey', title: '用户问卷', description: '假设、问题结构、题型与防诱导检查' },
  { kind: 'decision_log', title: '决策记录', description: '背景、选项、决策、理由和后续动作' },
  { kind: 'roadmap', title: '产品路线图', description: 'Now / Next / Later 的目标、假设与风险' },
  { kind: 'competitor_matrix', title: '竞品分析', description: '按目标用户、能力、价格和差异化做矩阵' },
  { kind: 'release_notes', title: '发布说明', description: '面向用户的更新、修复、迁移和已知问题' }
]

export function isDocKind(value: string): value is DocKind {
  return DOC_TEMPLATES.some((template) => template.kind === value)
}

function cleanTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim() || '未命名文档'
}

function contextBlock(context: string | undefined, language: DocLanguage): string {
  const value = context?.trim()
  if (!value) return ''
  return language === 'zh-CN' ? `\n> 输入背景：${value}\n` : `\n> Context: ${value}\n`
}

const ZH: Record<DocKind, (title: string, context?: string) => string> = {
  prd: (title, context) => `# ${title} — 产品需求文档（PRD）
${contextBlock(context, 'zh-CN')}
## 1. 背景与问题
- 现状：
- 用户痛点（用用户语言）：
- 为什么现在做：
- 不解决的后果：

## 2. 目标与成功指标
- 业务目标：
- 用户目标：
- 主指标（North Star / KPI）：
- 护栏指标（不能被牺牲的指标）：
- 目标值与衡量周期：

## 3. 用户与场景
- 目标用户：
- 核心场景：
- 当前替代方案：
- 触发条件与使用频率：

## 4. 范围
- 本期包含：
- 明确不做（Non-goals）：
- 后续版本再考虑：

## 5. 用户故事
- 作为 <角色>，我希望 <能力>，以便 <价值>。

## 6. 验收标准
- Given <前置条件> When <动作> Then <可观察结果>。
- 异常与边界：

## 7. 方案与交互要点
- 核心流程：
- 关键状态与空态：
- 权限与隐私：

## 8. 指标与埋点
- 事件：
- 属性：
- 看板与负责人：

## 9. 风险、依赖与开放问题
- 风险：
- 依赖：
- 开放问题与决策人：
- 里程碑：

## 10. 上线与复盘
- 灰度策略：
- 回滚条件：
- 上线后 7/30 天复盘问题：`,

  user_story: (title, context) => `# ${title} — 用户故事
${contextBlock(context, 'zh-CN')}
## 故事
作为 <角色>，我希望 <能力>，以便 <价值>。

## INVEST 自检
- Independent：能独立交付吗？
- Negotiable：还有哪些方案空间？
- Valuable：用户价值是什么？
- Estimable：团队能估算吗？
- Small：能在一个迭代内完成吗？
- Testable：验收标准可测吗？

## 验收标准（Given / When / Then）
- Given <前置条件> When <动作> Then <结果>。
- Given <异常条件> When <动作> Then <可恢复/可解释的结果>。

## 不在范围
-

## 依赖与开放问题
-`,

  acceptance_criteria: (title, context) => `# ${title} — 验收标准
${contextBlock(context, 'zh-CN')}
| # | Given（前置条件） | When（动作） | Then（可观察结果） |
| --- | --- | --- | --- |
| 1 |  |  |  |
| 2 |  |  |  |
| 3 | 异常/边界 |  |  |

## 覆盖检查
- [ ] 正常路径
- [ ] 空状态
- [ ] 权限不足
- [ ] 网络失败 / 超时
- [ ] 重复提交
- [ ] 数据边界（0、最大、超长）
- [ ] 埋点与可观测性
- [ ] 回滚或恢复路径`,

  launch_checklist: (title, context) => `# ${title} — 发布检查清单
${contextBlock(context, 'zh-CN')}
## 产品与范围
- [ ] 范围冻结，验收标准全部通过
- [ ] 已知问题与不发布项已记录
- [ ] 发布说明和用户公告已评审

## 运营与支持
- [ ] 客服/销售 FAQ 与话术已更新
- [ ] 培训与演示环境已准备
- [ ] 客服负责人：

## 技术就绪
- [ ] 监控、告警和看板已就位
- [ ] 埋点与数据校验通过
- [ ] 性能、容量和安全评审通过
- [ ] 回滚方案与负责人：
- [ ] 数据迁移/兼容性：

## 发布策略
- [ ] 灰度比例与观察窗口：
- [ ] 放量条件：
- [ ] 停止/回滚条件：
- [ ] 发布窗口与值班表：

## 发布后
- [ ] 24 小时观察项：
- [ ] 7 天复盘负责人：
- [ ] 成功指标与复盘日期：`,

  status_update: (title, context) => `# ${title} — 干系人更新
${contextBlock(context, 'zh-CN')}
## 一句话结论
<本周最重要的判断/变化>

## 已完成
-

## 进行中
- 事项 — 负责人 — 预计完成时间

## 风险与阻塞
- 风险 — 影响 — 需要谁在何时做什么

## 需要决策 / 支持
- [ ] 决策事项 — 决策人 — 截止时间

## 下周计划
-

## 指标读数
- 主指标：
- 护栏指标：
- 与上周相比：`,

  interview_guide: (title, context) => `# ${title} — 用户访谈提纲
${contextBlock(context, 'zh-CN')}
## 研究目标
- 我们要回答的 2–3 个问题：
- 不在这轮回答的问题：

## 参与者
- 目标画像：
- 招募标准：
- 样本量与多样性：

## 访谈结构（45–60 分钟）
1. 暖场（5 分钟）：自我介绍、录音授权、没有标准答案
2. 最近一次真实经历（10 分钟）：请对方讲一次具体发生的事
3. 核心问题（25 分钟）：围绕目标问题追问，不问“你会不会用”
4. 影响与替代方案（10 分钟）：现在怎么解决、成本是什么
5. 收尾（5 分钟）：还有什么我没问到、可否后续联系

## 核心问题（开放、非诱导）
-

## 追问句式
- 能举一个最近发生的例子吗？
- 当时你先做了什么？然后呢？
- 最让你卡住的是什么？
- 如果今天没有这个方案，你会怎么办？

## 记录模板
- 原话摘录：
- 行为/情境：
- 痛点/机会：
- 假设与待验证：`,

  survey: (title, context) => `# ${title} — 用户问卷
${contextBlock(context, 'zh-CN')}
## 研究假设
- 我们相信：
- 如果成立，应该观察到：
- 如果证伪，我们应该：

## 样本与投放
- 目标人群：
- 样本量：
- 投放渠道与激励：

## 问题结构
1. 筛选题（确认符合目标人群）
2. 行为题（最近一次真实行为，不问意愿）
3. 痛点题（频率、严重度、替代方案）
4. 方案题（概念测试，避免提前透露答案）
5. 开放题（还有什么想补充）

## 题目
| # | 题目 | 题型 | 选项 / 量表 | 目的 |
| --- | --- | --- | --- | --- |
| 1 |  | 单选 |  | 筛选 |
| 2 |  | 多选 |  | 行为 |
| 3 |  | 量表 1–5 |  | 痛点 |

## 防诱导检查
- [ ] 没有“你是否同意这个好方案”式问题
- [ ] 选项互斥且覆盖完整
- [ ] 没有双重问题
- [ ] 量表锚点清晰
- [ ] 预计完成时间 < 8 分钟`,

  decision_log: (title, context) => `# ${title} — 决策记录
${contextBlock(context, 'zh-CN')}
- 日期：
- 决策人：
- 状态：提议 / 已决定 / 已撤销
- 关联需求/项目：

## 背景
<为什么现在必须做这个决定？约束是什么？>

## 选项
| 选项 | 优点 | 缺点 | 风险 |
| --- | --- | --- | --- |
| A |  |  |  |
| B |  |  |  |
| C（不行动） |  |  |  |

## 决策
<选择了什么，明确不做什么>

## 理由
<依据的数据、原则、权衡>

## 影响与后续
- 受影响团队/用户：
- 需要同步的人：
- 后续动作与负责人：
- 何时复盘：`,

  roadmap: (title, context) => `# ${title} — 产品路线图（Now / Next / Later）
${contextBlock(context, 'zh-CN')}
## 路线图原则
- 按结果组织，不按功能清单：
- 置信度与时间范围：
- 明确不承诺的项：

## Now（当前周期，高置信度）
| 目标 | 用户问题 | 成功指标 | 负责人 | 风险 |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Next（下一个周期，中置信度）
| 目标 | 假设 | 需要验证 | 依赖 |
| --- | --- | --- | --- |
|  |  |  |  |

## Later（探索中，低置信度）
| 机会 | 为什么值得探索 | 触发条件 |
| --- | --- | --- |
|  |  |  |

## 跨周期依赖与风险
-

## 复盘节奏
- 月度检查：
- 季度重排：
- 决策记录链接：`,

  competitor_matrix: (title, context) => `# ${title} — 竞品分析
${contextBlock(context, 'zh-CN')}
## 分析目的
- 支持什么决策（定价 / 定位 / 功能取舍）：
- 不做什么：

## 竞品清单
| 竞品 | 目标用户 | 核心场景 | 关键能力 | 价格/包装 | 差异化 |
| --- | --- | --- | --- | --- | --- |
| 我们 |  |  |  |  |  |
| A |  |  |  |  |  |
| B |  |  |  |  |  |

## 能力对比
| 能力 | 权重 | 我们 | A | B | 结论 |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

## 机会与威胁
- 机会：
- 威胁：
- 我们应该强化/放弃的能力：

## 证据来源
-

## 待验证假设
-`,

  release_notes: (title, context) => `# ${title} — 发布说明
${contextBlock(context, 'zh-CN')}
## 一句话摘要
<这次更新给用户带来的最重要变化>

## 新功能
-

## 改进
-

## 修复
-

##  Breaking changes / 迁移
- 影响范围：
- 用户需要做什么：
- 截止时间：

## 已知问题
-

## 相关链接
- 帮助文档：
- 反馈渠道：`
}

const EN: Record<DocKind, (title: string, context?: string) => string> = {
  prd: (title, context) => `# ${title} — Product Requirements Document
${contextBlock(context, 'en')}
## 1. Problem and context
- Current state:
- User pain (in their words):
- Why now:
- Cost of not solving it:

## 2. Goals and success metrics
- Business goal:
- User goal:
- Primary metric (North Star / KPI):
- Guardrail metric:
- Target and measurement window:

## 3. Users and scenarios
- Target users:
- Core scenario:
- Current alternative:
- Trigger and frequency:

## 4. Scope
- In scope:
- Explicit non-goals:
- Revisit later:

## 5. User stories
- As a <role>, I want <capability>, so that <value>.

## 6. Acceptance criteria
- Given <precondition> When <action> Then <observable result>.
- Edge cases and failure paths:

## 7. Solution and interaction notes
- Core flow:
- Key states and empty states:
- Permissions and privacy:

## 8. Metrics and instrumentation
- Events:
- Properties:
- Dashboard and owner:

## 9. Risks, dependencies and open questions
- Risks:
- Dependencies:
- Open questions and decision owner:
- Milestones:

## 10. Launch and review
- Rollout:
- Rollback trigger:
- Review questions at day 7/30:`,

  user_story: (title, context) => `# ${title} — User Story
${contextBlock(context, 'en')}
## Story
As a <role>, I want <capability>, so that <value>.

## INVEST check
- Independent:
- Negotiable:
- Valuable:
- Estimable:
- Small:
- Testable:

## Acceptance criteria (Given / When / Then)
- Given <precondition> When <action> Then <result>.
- Given <failure case> When <action> Then <recoverable result>.

## Out of scope
-

## Dependencies and open questions
-`,

  acceptance_criteria: (title, context) => `# ${title} — Acceptance Criteria
${contextBlock(context, 'en')}
| # | Given | When | Then |
| --- | --- | --- | --- |
| 1 |  |  |  |
| 2 |  |  |  |
| 3 | Edge case |  |  |

## Coverage
- [ ] Happy path
- [ ] Empty state
- [ ] Permission denied
- [ ] Network failure / timeout
- [ ] Duplicate submission
- [ ] Data boundaries (0, max, long text)
- [ ] Analytics and observability
- [ ] Recovery / rollback`,

  launch_checklist: (title, context) => `# ${title} — Launch Checklist
${contextBlock(context, 'en')}
## Product and scope
- [ ] Scope frozen and acceptance criteria pass
- [ ] Known issues and non-shipped items documented
- [ ] Release notes and user announcement reviewed

## GTM and support
- [ ] Support/sales FAQ updated
- [ ] Training and demo environment ready
- [ ] Support owner:

## Technical readiness
- [ ] Monitoring, alerts and dashboard ready
- [ ] Analytics validated
- [ ] Performance, capacity and security review passed
- [ ] Rollback plan and owner:
- [ ] Data migration / compatibility:

## Rollout
- [ ] Canary percentage and observation window:
- [ ] Criteria to expand:
- [ ] Criteria to pause/rollback:
- [ ] Release window and on-call:

## After launch
- [ ] 24-hour watch items:
- [ ] 7-day review owner:
- [ ] Success metric and review date:`,

  status_update: (title, context) => `# ${title} — Stakeholder Update
${contextBlock(context, 'en')}
## TL;DR
<The most important judgement or change this week>

## Shipped
-

## In progress
- Item — owner — expected date

## Risks and blockers
- Risk — impact — who needs to do what by when

## Decisions / asks
- [ ] Decision — owner — deadline

## Next week
-

## Metric readout
- Primary metric:
- Guardrail:
- Versus last week:`,

  interview_guide: (title, context) => `# ${title} — User Interview Guide
${contextBlock(context, 'en')}
## Research questions
- Two or three questions this study must answer:
- Out of scope:

## Participants
- Target profile:
- Screening criteria:
- Sample and diversity:

## Session structure (45–60 min)
1. Warm-up (5 min): introduction, recording consent, no right answers
2. Recent real experience (10 min): ask for a specific recent story
3. Core questions (25 min): past behaviour, not future intent
4. Impact and alternatives (10 min): current workaround and cost
5. Close (5 min): anything I missed, follow-up permission

## Core questions (open, non-leading)
-

## Probe phrases
- Can you walk me through the most recent time that happened?
- What did you do first? And then?
- Where did you get stuck?
- What would you do if this solution did not exist?

## Notes template
- Verbatim quote:
- Behaviour / context:
- Pain / opportunity:
- Assumption to test:`,

  survey: (title, context) => `# ${title} — User Survey
${contextBlock(context, 'en')}
## Hypothesis
- We believe:
- If true, we should observe:
- If false, we should:

## Sample and fielding
- Target population:
- Sample size:
- Channel and incentive:

## Structure
1. Screener
2. Behaviour (most recent real behaviour, not intent)
3. Pain (frequency, severity, workaround)
4. Concept test (do not reveal the answer)
5. Open text

## Questions
| # | Question | Type | Options / scale | Purpose |
| --- | --- | --- | --- | --- |
| 1 |  | Single choice |  | Screener |
| 2 |  | Multiple choice |  | Behaviour |
| 3 |  | 1–5 scale |  | Pain |

## Bias check
- [ ] No "do you agree this is a great idea" wording
- [ ] Options are mutually exclusive and exhaustive
- [ ] No double-barrelled questions
- [ ] Scale anchors are clear
- [ ] Completion time < 8 minutes`,

  decision_log: (title, context) => `# ${title} — Decision Log
${contextBlock(context, 'en')}
- Date:
- Decision owner:
- Status: proposed / decided / superseded
- Related requirement/project:

## Context
<Why must this be decided now? What constraints apply?>

## Options
| Option | Pros | Cons | Risks |
| --- | --- | --- | --- |
| A |  |  |  |
| B |  |  |  |
| C (do nothing) |  |  |  |

## Decision
<What was chosen, and explicitly what was not>

## Rationale
<Data, principles and trade-offs>

## Impact and follow-up
- Affected teams/users:
- Who needs to know:
- Follow-up actions and owners:
- Review date:`,

  roadmap: (title, context) => `# ${title} — Product Roadmap (Now / Next / Later)
${contextBlock(context, 'en')}
## Principles
- Organise by outcome, not a feature list:
- Confidence and horizon:
- Explicitly not committed:

## Now (current period, high confidence)
| Outcome | User problem | Success metric | Owner | Risk |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |

## Next (next period, medium confidence)
| Outcome | Assumption | To validate | Dependencies |
| --- | --- | --- | --- |
|  |  |  |  |

## Later (exploring, low confidence)
| Opportunity | Why explore | Trigger |
| --- | --- | --- |
|  |  |  |

## Cross-period dependencies and risks
-

## Review rhythm
- Monthly check:
- Quarterly re-plan:
- Decision log link:`,

  competitor_matrix: (title, context) => `# ${title} — Competitive Analysis
${contextBlock(context, 'en')}
## Purpose
- Decision this supports (pricing / positioning / scope):
- Out of scope:

## Competitors
| Competitor | Target user | Core scenario | Key capability | Pricing/packaging | Differentiation |
| --- | --- | --- | --- | --- | --- |
| Us |  |  |  |  |  |
| A |  |  |  |  |  |
| B |  |  |  |  |  |

## Capability comparison
| Capability | Weight | Us | A | B | Conclusion |
| --- | --- | --- | --- | --- | --- |
|  |  |  |  |  |  |

## Opportunities and threats
- Opportunities:
- Threats:
- Capabilities to strengthen or drop:

## Evidence
-

## Assumptions to verify
-`,

  release_notes: (title, context) => `# ${title} — Release Notes
${contextBlock(context, 'en')}
## Summary
<The most important change for users>

## New
-

## Improvements
-

## Fixes
-

## Breaking changes / migration
- Impact:
- What users need to do:
- Deadline:

## Known issues
-

## Links
- Help centre:
- Feedback:`
}

export function buildDoc(
  kind: DocKind,
  title: string,
  context?: string,
  language: DocLanguage = 'zh-CN'
): string {
  const builder = (language === 'zh-CN' ? ZH : EN)[kind]
  if (!builder) throw new Error(`Unknown document kind "${kind}".`)
  return `${builder(cleanTitle(title), context).trim()}\n`
}

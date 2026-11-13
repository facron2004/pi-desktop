# 产品经理工具包（PM Toolkit）

一个面向产品经理的 Pi 插件包：把日常产品工作里**可以标准化、可以计算、可以检查**的部分做成工具，把需要判断的部分留给模型和你。

## 适合做成插件的产品经理能力

| 工具包 | 为什么适合插件 | 对应实现 |
| --- | --- | --- |
| PRD / 需求文档 | 结构稳定、检查项明确，适合模板 + 完整性检查 | `pm_doc`、`pm_check` |
| 用户故事 / 验收标准 | 有固定格式（INVEST、Given/When/Then），适合生成和校验 | `pm_doc`、`pm_check` |
| 优先级排序 | RICE / ICE / MoSCoW / 价值 × 成本都是确定性公式 | `pm_prioritize` |
| 用户研究 | 访谈提纲、问卷、访谈归纳有可复用的方法论 | `pm-research` 技能 + `pm_doc` |
| 产品指标 | North Star、漏斗、A/B 样本量与显著性需要准确计算 | `pm_experiment`、`pm-metrics` 技能 |
| 路线图 / 发布 | Now/Next/Later、发布检查清单、回滚条件适合模板化 | `pm_doc`、`pm_check` |
| 干系人沟通 | 周报、发布说明、决策记录需要稳定格式 | `pm_doc`、`pm-comms` 技能 |
| 竞品分析 | 功能矩阵、定位和价格对比适合结构化输出 | `pm_doc` |
| 会议 / 决策记录 | 决策、理由、后续动作需要可追溯 | `pm_doc`（decision_log） |
| 定价 / 包装 | 价值指标、套餐矩阵可模板化 | 后续可扩展 |

## 安装

```bash
# 在 Pi Desktop 仓库根目录
pi install ./plugins/pm-toolkit
```

或在应用内「插件与技能 → 安装」中选择本地路径。

## 工具

### `pm_doc`

生成 11 种产品文档骨架：

- `prd`：PRD
- `user_story`：用户故事 + INVEST
- `acceptance_criteria`：Given/When/Then
- `launch_checklist`：发布检查清单
- `status_update`：周报 / 干系人更新
- `interview_guide`：用户访谈提纲
- `survey`：用户问卷
- `decision_log`：决策记录
- `roadmap`：Now / Next / Later 路线图
- `competitor_matrix`：竞品分析
- `release_notes`：发布说明

支持中英文模板（`language: "zh-CN" | "en"`）。

### `pm_prioritize`

- **RICE**：Reach × Impact × Confidence ÷ Effort
- **ICE**：Impact × Confidence × Ease
- **MoSCoW**：Must / Should / Could / Won't
- **价值 × 成本矩阵**：速赢 / 战略下注 / 补位 / 放弃

返回排序表、公式和输入警告，方便在评审会上解释排名。

### `pm_experiment`

- `sample_size`：给定基线、相对提升、α 和 power，计算每组样本量
- `significance`：两组转化率的 z 检验、p 值、置信区间
- `funnel`：逐步转化率、整体转化率和最大流失步骤

### `pm_check`

检查 PRD、用户故事、发布清单或周报是否缺少关键章节、是否有模糊表述、是否缺少可测试的验收标准。

## `/pm` 命令

在交互式 Pi 会话中输入 `/pm`，选择文档类型或计算任务，填写主题即可开始。适合不想记工具参数的时候。

## 技能

- `pm-product`：PRD、用户故事、优先级、路线图和发布计划
- `pm-research`：访谈提纲、研究归纳、Persona、JTBD 和问卷
- `pm-metrics`：North Star、漏斗、指标口径和实验设计
- `pm-comms`：周报、发布说明、决策记录和干系人沟通

## 相关插件

PM Toolkit 是产品经理插件套件的核心包，另外四个包可按需叠加：

- [pm-competitor](pm-plugin-suite.md)：竞品矩阵、battlecard、价格对比
- [pm-feedback](pm-plugin-suite.md)：用户反馈 / 工单关键词聚类与报告
- [pm-pricing](pm-plugin-suite.md)：Van Westendorp、套餐矩阵、价值指标
- [pm-connectors](pm-plugin-suite.md)：Jira、Linear、Notion、飞书等 MCP 连接配方

完整套件说明见 [产品经理插件套件](pm-plugin-suite.md)。

## 测试与验证

```bash
node tests/run.mjs
```

`tests/pm-toolkit.test.ts` 覆盖 RICE/ICE/MoSCoW/价值矩阵、样本量、显著性、漏斗、11 个模板和文档检查器。所有计算都在本地完成，不依赖模型或网络。

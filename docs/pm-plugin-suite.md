# 产品经理插件套件

一组可以独立安装、也可以一起使用的 Pi 产品经理插件。核心原则：**能确定性计算的就用工具，需要判断的交给模型，外部数据交给 MCP。**

## 插件一览

| 包 | 解决的问题 | 核心工具 | 技能 |
| --- | --- | --- | --- |
| [pm-toolkit](pm-toolkit.md) | 日常产品文档、优先级、实验、文档检查 | `pm_doc`、`pm_prioritize`、`pm_experiment`、`pm_check` | `pm-product`、`pm-research`、`pm-metrics`、`pm-comms` |
| [pm-competitor](../plugins/pm-competitor/README.md) | 竞品矩阵、功能差距、battlecard、价格对比 | `pm_competitor` | `pm-competitor` |
| [pm-feedback](../plugins/pm-feedback/README.md) | 用户反馈 / 工单 / 评论的主题聚类和报告 | `pm_feedback` | `pm-feedback` |
| [pm-pricing](../plugins/pm-pricing/README.md) | 定价研究、套餐矩阵、价值指标 | `pm_pricing` | `pm-pricing` |
| [pm-connectors](../plugins/pm-connectors/README.md) | Jira、Linear、Notion、Slack、飞书、分析、客服、CRM 的 MCP 连接配方 | `pm_connector` | `pm-connectors` |

## 安装

在 Pi Desktop 仓库根目录分别安装需要的包：

```bash
pi install ./plugins/pm-toolkit
pi install ./plugins/pm-competitor
pi install ./plugins/pm-feedback
pi install ./plugins/pm-pricing
pi install ./plugins/pm-connectors
```

也可以只安装与当前工作最相关的一个。所有包都遵循同一 schema：`package.json` 中的 `pi.extensions` 和 `pi.skills`，没有额外 npm 依赖。

## 怎么选

- **写 PRD、拆故事、排优先级、做实验**：从 `pm-toolkit` 开始，其他包按需叠加。
- **要回答“竞品在做什么、我们差在哪”**：`pm-competitor`。
- **有一批 app store 评论、客服工单、访谈记录**：`pm-feedback` 做确定性预聚类，模型再做语义归纳。
- **要设计套餐、涨价、做 Van Westendorp**：`pm-pricing`。
- **要把 Jira/Linear/Notion/Slack/飞书/分析/CRM 接进 Pi**：`pm-connectors` 先给只读 recipe 和权限边界，实际连接由 MCP 配置完成。

## 设计边界

1. **不把模型当计算器**：RICE、ICE、样本量、显著性、漏斗、VW 价格曲线都是本地公式，结果可复核。
2. **不伪造数据**：没有连接器就说没有；没有样本就标注样本量；不做“行业平均”的假引用。
3. **默认只读**：任何外部系统的写操作都要有人明确确认。
4. **隐私优先**：密钥只进 MCP 配置；用户反馈、工单、CRM 文本脱敏后再进入提示词。
5. **输出可评审**：Markdown 表格、来源、日期、假设和下一步动作缺一不可。

## 验证

每个包都有独立的 `tests/pm-*.test.ts`，覆盖各自的确定性逻辑和模板。统一运行：

```bash
node tests/run.mjs
```

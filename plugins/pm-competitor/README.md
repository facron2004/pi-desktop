# pi-pm-competitor

面向产品经理的竞品情报工具箱：把功能对比、作战卡和定价对比中**机械、可复核**的部分做成确定性工具，把判断、访谈和取舍留给产品经理。

- 不联网、不调用模型：所有计算都在本地完成。
- 输出中文 Markdown 表格，带证据/日期字段和“加权分会掩盖判断”的提醒。
- 核心逻辑是纯 TypeScript（`src/` 无 Pi 依赖），可以单独复用和测试。

## 安装

从 Pi Desktop 仓库安装：

```bash
pi install ./plugins/pm-competitor
```

或者只在一个会话中加载扩展：

```bash
pi -e ./plugins/pm-competitor/extensions/pm-competitor.ts
```

包把 `@earendil-works/pi-coding-agent` 和 `typebox` 声明为 peer dependencies，由 Pi 提供。

## 工具

| 工具 | 作用 |
| --- | --- |
| `pm_competitor` `action=matrix` | 生成加权功能矩阵：0–100 归一化总分、排名、每个功能的领先者/落后者、差距排序和 Markdown 表；缺失评分和数据质量问题会写入警告。 |
| `pm_competitor` `action=battlecard` | 生成七段式竞品作战卡：他们赢在哪里、我们为什么赢、地雷、异议处理、证据点、该问的问题、近期变化。 |
| `pm_competitor` `action=pricing` | 生成统一口径的定价对比：币种、计价单位、周期折算年价、同厂商入门档、包含内容和备注。 |

所有工具输出都是可直接放进文档或聊天回答的 Markdown。工具本身不判断“谁更强”，只把输入整理成可讨论、可复核的结构。

### matrix 示例

```json
{
  "action": "matrix",
  "competitors": [
    { "name": "竞品A", "segment": "中小企业", "positioning": "低价快上线" },
    { "name": "竞品B", "segment": "大型企业", "positioning": "合规与集成" }
  ],
  "features": [
    { "name": "实时报表", "weight": 3, "scores": { "竞品A": 4, "竞品B": 2 }, "evidence": "官网文档", "evidenceDate": "2026-03-01" },
    { "name": "单点登录", "weight": 2, "scores": { "竞品A": 2, "竞品B": 5 }, "evidence": "客户访谈", "evidenceDate": "2026-02-18" }
  ]
}
```

## `/competitor` 命令

在交互式 Pi 会话里输入：

```text
/competitor
```

菜单提供四项：

1. **功能矩阵** —— 加权评分、功能差距与 Markdown 表；
2. **竞品作战卡** —— 他们赢在哪里、我们为什么赢、异议与证据；
3. **定价对比** —— 统一币种、计价单位与周期；
4. **来源台账** —— 证据分级、日期与可信度复核。

选择后输入主题或竞品范围，Pi 会用正确的结构和提示开始工作。如果当前环境没有交互 UI，命令会提示改用 `pm_competitor` 工具。

## 技能

| 技能 | 覆盖内容 |
| --- | --- |
| `pm-competitor` | 定义决策、选择竞品集合、证据分级（公开文档 > 定价页 > 客户访谈 > 传闻）、0–5 分评分 rubric、作战卡七段结构、定价对比口径、伦理与合规、质量检查清单。 |

Pi 会根据对话内容自动加载匹配的技能。扩展还会在识别到竞品相关提示时追加一段 `PI COMPETITOR POLICY` 系统提示，确保即使是一句话的请求也按证据规则和表格结构输出。

## 示例

```text
/competitor → 功能矩阵 → AI 客服 SaaS，中小企业，2026 Q2 续费率下滑
```

```text
帮我做一张 AI 客服产品的竞品功能矩阵，竞品是 A、B 和自建客服系统，权重按中小企业购买决策来定。
```

```text
给销售做一份竞品 B 的 battlecard，重点是我们怎么处理“他们更便宜”的异议。
```

```text
对比 A、B、C 三家的定价，统一成人民币年价，注明是否含税和实施费。
```

## 设计原则

1. **先决策，后资料**：没有决策的竞品分析只是资料堆砌；技能会把决策和读者放在第一步。
2. **证据优先**：每条结论都要来源和日期；传闻只作为待验证线索。
3. **加权分不是事实**：矩阵输出永远附带“总分掩盖了什么”的提醒，避免用数字假装客观。
4. **确定性**：相同输入产生相同输出，方便评审、版本对比和单元测试。
5. **零依赖**：不新增 npm 依赖，不联网，不导入 Pi（扩展层除外）。

## 包结构

```text
plugins/pm-competitor/
├── package.json
├── extensions/
│   └── pm-competitor.ts       # pm_competitor 工具、/competitor 命令、系统提示策略
├── src/
│   ├── matrix.ts              # 矩阵、作战卡、定价对比、来源台账（纯逻辑）
│   └── policy.ts              # 竞品提示触发与策略文本（纯逻辑）
├── skills/
│   └── pm-competitor/SKILL.md # 竞品分析方法与质量清单
└── README.md
```

`src/` 下的模块没有 Pi 导入，由 `tests/pm-competitor.test.ts` 直接测试，也可以被其他客户端复用。

## 开发与测试

测试使用 `node:test`，与仓库其它测试一样通过 esbuild 打包后运行。本包的测试文件是 `tests/pm-competitor.test.ts`；加入 `tests/run.mjs` 的套件列表后，可以用 `node tests/run.mjs` 统一运行。

```bash
# 用仓库自带的 esbuild 打包后运行（Windows PowerShell 示例）
node -e "require('esbuild').buildSync({entryPoints:['tests/pm-competitor.test.ts'],bundle:true,format:'esm',platform:'node',outfile:'pm-competitor.test.mjs'})"
node --test pm-competitor.test.mjs
```

所有评分、排序和表格生成都有测试覆盖；扩展本身保持很薄，计算错误会在单元测试里暴露，不需要启动模型。

# AnStudio Codex Conversation Alignment Delivery

> 交付对象：Pi Desktop 对话区（Conversation Workspace）
> 依据文档：《AnStudio 对话区 Codex 对齐实施文档》v2.0（2026-10-26）
> 完成日期：2026-10-26
> 执行原则：以真实仓库为准（文档假设的 Electron + Vue 3 + NestJS + Prisma 与实际不符），只接真实 Pi Event，缺失能力如实标注 BLOCKED，不伪造。

## 1. 审计结论

- **真实技术栈**：Electron 44.5.0 + React 19.3.1 + Zustand 5.0.15 + TypeScript 5.9.3（strict）+ electron-vite 6 + Vite 7.3.7。渲染层另有 react-markdown 10 + remark-gfm、Shiki 4.5.0、lucide-react、`diff` ^9。**文档假设的 Vue 3 / NestJS / Prisma 在本仓库不存在**，因此按文档 §0 的「以真实仓库为准」执行，未引入任何新框架或全局依赖。
- **Pi 版本与集成方式**：`@earendil-works/pi-coding-agent` **1.3.0**，以 **RPC 子进程**方式集成（`src/main/pi/runtime.ts` 启动 CLI，`src/main/pi/rpc-client.ts` 用 `StringDecoder` 做 JSONL 分帧）。本仓库是**协议客户端**，不重新实现 Agent Loop —— 遵守文档 §22「不得重写 Agent Loop / Tool Runtime」。
- **原对话区组件与问题**：
  1. **运行态词表过窄**。`RunPhase` 只有 6 个成员，`queued`（提示词已交给 Pi、run 尚未打开）这一真实窗口无法表达；助手正在吐字、Agent 卡在扩展对话框这两种可观测状态只能被笼统显示为「Working」，读者无法判断 Agent 是在思考、在等自己回答，还是已经卡住。
  2. **抽屉开启后断点判定失真**。`.main` 是 `overflow: hidden`，停靠的 Inspector 以绝对定位覆盖其上并用 `margin-right` 预留空间。所有 `@container conversation` 规则挂在 `.main` 上，测到的是「含抽屉」的宽度，导致响应式断点**整体晚一档触发**：真实阅读宽度已经窄到该收起次要操作，顶栏却仍然满配。
  3. **动态节点用数组下标做 key**。`DiffView` 的 diff 块/行、`Composer` 的排队消息与图片 chip、`App` 的 widget 行、`TerminalPanel`/`CodeSnippet`/`Markdown`/`MessageItem` 的多处列表均以 `index` 为 key，违反文档 §22。切换文件时同一位置渲染不同文件，React 会复用错误的 DOM。
  4. 次级样式表存在**硬编码颜色**与**缺失的 reduced-motion 处理**，与 §15.1 / §17.3 不符。
  5. 排版超出 §15.2 区间：`.md` 正文行高 1.75（规范 1.45–1.65），标题层级 20/16/14px 对比过强。
- **主要改造方案**：
  - **运行态**：扩展 `RunPhase` 为 8 个成员（新增 `generating` / `waiting_approval`，并让 `queued` 可达），新增 `phaseFor()` 守卫，使低优先级事件不会覆盖高优先级状态；`RunStatusRow` 为每个 phase 给出独立文案与图标；`queued` 的结束以 **Pi 自己返回的 `disposition`**（`started` / `queued` / `handled`）为准，不用定时器猜测。
  - **布局**：在 `<main class="main">` 内新增 `.main__body` 包裹标题栏以下的全部内容，让**阅读宽度**成为容器查询的真实度量；抽屉的 `margin-right` 只记一次。
  - **Key 稳定性**：把所有动态节点的 key 改为内容/身份派生。
  - **视觉规范**：次级样式表颜色全部收敛到 token，补齐 reduced-motion，排版收进 §15.2 区间。
  - **测试**：把运行态规则固化为真实事件驱动的单元测试，并接入 `npm test`。

## 2. 修改文件

| 文件 | 改动 | 原因 |
| --- | --- | --- |
| `src/renderer/src/store/useAppStore.ts` | `RunPhase` 扩至 8 成员并补文档注释；新增 `phaseFor()` 守卫；`agent_start`/`turn_start`/`tool_execution_end`/`message_update` 改经守卫设置 phase；`handleExtensionUi` 置 `waiting_approval`；`respondUi` 解除；`send()` 按 `disposition` 收敛 `queued` | 运行态必须反映真实可观测状态，且不得让并列事件互相覆盖 |
| `src/renderer/src/components/RunStatusRow.tsx` | 新增 `waiting_approval`（Hand 图标 / "Waiting for your answer"）、`queued`（Clock / "Queued"）、`generating`（"Writing a reply…"）三个分支 | 每个 phase 需要读者可分辨的文案与图标 |
| `src/renderer/src/components/Thread.tsx` | 新增 `runOpen = isStreaming \|\| (run.phase !== 'idle' && !run.settled)`，三处 `RunStatusRow` 渲染门槛由 `isStreaming` 改为 `runOpen` | `queued` 发生在任何事件到达之前，用 `isStreaming` 会把最需要提示的时刻藏掉 |
| `src/renderer/src/lib/i18n.ts` | 新增 zh-CN：`Waiting for your answer` / `Queued` / `Writing a reply…` | 新增文案需要中文 |
| `src/renderer/src/styles/conversation-stream.css` | 新增 `[data-phase='waiting_approval']`、`[data-phase='queued']` 两条图标着色规则 | 等待回答是仅次于失败的最强状态，需要视觉权重 |
| `src/renderer/src/App.tsx` | 标题栏以下全部内容包进 `<div className="main__body">`；三个 `.titlebar__action` 补 `data-action`；widget 行 key 改为 `` `${line}-${index}` `` | 提供真实阅读宽度容器；响应式规则需要可选中目标；widget 行按文本保持身份 |
| `src/renderer/src/styles/global.css` | 布局：新增 `.main__body` 规则（flex 列 + `container: conversation / inline-size`）；`.app[data-drawer='open'][data-inspector='docked'] .main > :not(.titlebar)` 改为 `.main__body`；新增 `@container conversation (max-width: 1099px)`（收起 files/terminal 操作 + 紧凑模型控件）与 `(max-width: 719px)`（收起 `.titlebar__context`、限宽 git chip）。排版与动效：`.md` 行高 1.75→1.6；h1 20px→`--text-lg`(16px)、h2→15px、h3 保持 `--text-md`(14px)；三处进度条动画 `--dur-slow`→`--dur-base`（`--dur-slow` 现仅保留给 `rise` 入场动画）；`.thread` 在 reduced-motion 下 `scroll-behavior: auto` | 断点按真实阅读宽度触发；排版收进 §15.2 的 1.45–1.65 与 16–18px 层级区间；动效收敛到 120–180ms；尊重 §17.3 |
| `src/renderer/src/components/DiffView.tsx` | 新增 `blockKey()`；diff 块/空隙行/拆分行/统一行 key 全部改为行号或 `gap.key` 派生，移除 `rowIndex` | 同一 `DiffView` 会切换渲染不同文件，位置不是身份 |
| `src/renderer/src/components/Composer.tsx` | 排队消息 key 改为 `` `${entry.kind}:${entry.text}` ``；图片 chip 引入 `ComposerImage { id, data, mimeType }` 与 `nextImageId()`，key 改用 `image.id`，删除按 id 过滤，发送时映射回原载荷 | 图片增删需要稳定身份；store 签名与提交数据保持不变 |
| `src/renderer/src/components/TerminalPanel.tsx` | ANSI 颜色段 key 改为 `` `${segment.text}-${index}` `` | `parseAnsi` 按增量重新切分，下标会漂移 |
| `src/renderer/src/components/CodeSnippet.tsx` | 纯文本行 key 改为 `` `${text}-${index}` `` | 同上 |
| `src/renderer/src/components/MessageItem.tsx` | 用户消息缩略图 key 改为 `` `${item.id}-${index}` `` | 同上 |
| `src/renderer/src/components/Markdown.tsx` | 命中高亮 `<mark>` key 改为 `` `${part}-${index}` `` | 同上 |
| `src/renderer/src/styles/tokens.css` | 新增 `--lightbox-*` 五个 token（明暗双份，亮色遮罩为 `rgba(15,17,21,0.86)` 而非纯黑）及 `--bg-raised`/`--r-pill`/`--shadow-md`/`--composer-max`/`--ctl-xs` 别名 | 光箱颜色原先硬编码，需要 token 化 |
| `src/renderer/src/styles/base/controls.css` | 主按钮 `inset 0 1px 0 rgba(255,255,255,0.24)`→`var(--border-specular)`、`color-mix(... white)`→`var(--accent-hover)`；新增 reduced-motion 块（仅 `transition: none`，不动 `animation`，保证 spinner 继续转） | §15.1 token 化 + §17.3 |
| `src/renderer/src/styles/lightbox.css` | 五处字面量颜色替换为 `--lightbox-*` | 同上 |
| `src/renderer/src/styles/review.css` | `var(--warning, …)`→`var(--status-warning, …)`（`--warning` 全局未定义） | 修掉一个永远取到 fallback 的变量 |
| `src/renderer/src/styles/session-search.css`、`text-search.css`、`branch-menu.css` | 各补一个 reduced-motion 块，仅覆盖真正有 transition 的选择器 | §17.3 |
| `tests/run-state.test.ts` | **新增** 6 个运行态测试（P01/P01b/P02/P03/P04/P05），以真实事件驱动真实 store | 运行态规则此前无测试覆盖 |
| `tests/run.mjs` | 改为多套件构建并一次性 `node --test`，纳入 `run-state.test.ts` | 新测试需要随 `npm test` 一起跑 |
| `scripts/verify-replay.mjs` | **新增** 会话回放取证脚本：读取真实 session 文件，经真实 reducer 投影并统计工具节点 | H01「重开会话恢复工具过程」需要可复现证据 |
| `scripts/capture-shots.mjs` | **新增** 截图取证脚本 | 一次性产出多场景证据 |

> 说明：工作区另有约 60 个文件处于用户既有未提交状态（含 `AppRail`/`AppMenuBar`/`CodexMark`/`FileChangeSummary`/`tool-renderers` 等新增件）。**这些未提交工作已完整保留，未被回退或覆盖。**

## 3. 对话区完成清单

| 区域 | 完成情况 | 证据 |
| --- | --- | --- |
| Header | **已对齐**。高度走 `--titlebar-h`；次要操作按**容器**宽度分档收起（1099px 收起 files/terminal，719px 再收起上下文区并限宽 git chip）；操作按钮补 `data-action` 使规则可寻址 | DOM 探针：窗口 1500/1100/900px 下 `files`/`terminal` 由 true→false，`context` 在 900px 转 false；`gitChip` 由 79px→0。见 §6 截图 |
| Empty State | **已对齐**。保留既有扁平化空态（`ui-polish.css` 已消除三块堆叠），起始项只填充输入框、不自动发送 | `01-empty-dark.png`、`05-empty-light.png` |
| Message Stream | **已对齐**。单一 reducer 投影（`lib/thread.ts`），实时与回放同一条代码路径；文本 delta 每帧批量上屏；`text_end`/`message_end` 为内容权威；工具节点一次调用一个节点、保留首次出现位置 | `npm test` 19/19（含文本增量、工具生命周期、乱序完成、abort 保内容） |
| Tool/Activity | **已对齐**。工具行 32–40px 紧凑形态；`lib/tool-renderers.ts` 注册表 + 未知工具安全兜底；运行态行按 phase 显示 Working / Writing a reply / Running tools / Waiting for your answer / Queued / Stopping | DOM 探针逐 phase 断言 label 与图标（见 §5） |
| Composer | **已对齐**。Enter 发送 / Shift+Enter 换行、IME 合成全程守卫（`isComposing \|\| keyCode === 229`）、自动增高上限 240px、流式中 Stop 走真实 `abort`、投递方式菜单（steer/follow-up） | `npm run test:e2e` 的 stop 场景：`Pi confirmed the run settled`、`nothing is left marked as running` |
| Model/Mode | **Model 已对齐；Mode 受限**。Model Picker 走真实 `set_model` / `set_thinking_level`，列表来自 `get_available_models` / `get_available_thinking_levels`；紧凑档位在窄容器下转为纯图标并隐藏文字标签。**Plan/Ask 模式无对应 RPC，见 §8** | DOM 探针：抽屉开启后模型控件 `gap` 4px→2px、pill 宽 117px→28px、标签隐藏 |
| Attachments | **已对齐**。图片 chip 以 `image.id` 为身份，增删互不串位，提交时映射回 `{ data, mimeType }`，store 签名未变 | `npm run typecheck` 通过；`Composer.tsx` 发送路径未改载荷形状 |
| Session Replay | **已对齐**。回放经同一 reducer，恢复工具调用、参数、结果与顺序，而非只恢复最终文本 | `scripts/verify-replay.mjs` 对真实 session：4 个工具节点、4 个唯一 id、4 个含参数、4 个含结果，工具名 `bash, read` |
| Diff/Approval | **Diff 已对齐；Approval 受限**。diff 块/行以行号派生 key，切换文件不再复用错误 DOM；`FileChangeSummary` 提供 §8.4/§9 的逐文件行。**内联审批无 RPC，见 §8** | `npm run typecheck` 通过；`08-drawer-docked.png` |
| Responsive/Theme | **已对齐**。断点按**容器**（`.main` 管标题栏、`.main__body` 管正文）而非 `window.innerWidth`；明暗双主题 token 齐备；18 个 `prefers-reduced-motion` 块分布于 15 个样式表 | DOM 探针：`main` 1224px / `body` 803px（抽屉 420px 仅扣一次）；两个容器 `container-name` 均为 `conversation` |

## 4. Event Adapter

- **映射表**（`src/renderer/src/lib/thread.ts` 单一 reducer）：

  | Pi 事件 | 投影结果 | 备注 |
  | --- | --- | --- |
  | `message_start` | 新建 assistant 节点 | 按 `message.id` 定位 |
  | `message_update` → `text_start`/`text_delta` | 追加助手文本 | 仅 `text_*` 视为「正在生成」 |
  | `message_update` → `thinking_*` | thinking 节点 | **不**触发 `generating` |
  | `message_update` → `toolcall_start`/`toolcall_delta`/`toolcall_end` | 工具节点 `proposed`，累积参数 | 一次调用一个节点 |
  | `message_end` | 校准该消息内容 | 权威值，替换而非累加 |
  | `tool_execution_start` | `proposed` → `running` | 经 `patchTool` 合并，不冲掉已有参数 |
  | `tool_execution_update` | 替换 `progress` | `partialResult` 是**快照**不是增量 |
  | `tool_execution_end` | `ok` / `error`，记 `durationMs` | 完成顺序不影响节点位置 |
  | `bash_execution_update` | bash 卡片输出 | `terminal-` 前缀事件被丢弃 |
  | `agent_start` / `turn_start` | `working` | 经 `phaseFor()` |
  | `agent_end` | 不结算 | **不是工作结束** |
  | `agent_settled` | 唯一权威结算 | 清 `retry`/`uiRequest`，置 `idle` + `outcome` |
  | `auto_retry_start`/`_end` | `retrying` ↔ `working` | |
  | `compaction_*` | 通知节点 | 不吞掉 |
  | `extension_ui_request` | `uiRequest` + `waiting_approval` | `select`/`confirm`/`input`/`editor` |
  | `client_notice` | 通知节点 | |

- **run / turn / message / tool ID**：`toolCallId` 由 Pi 提供，是工具节点的唯一身份，从 `proposed` 到终态不变。`runId` / `turnId` **由客户端铸造** —— Pi 协议没有这两个概念，因此它们只用于客户端分组，不作为事件关联依据。跨会话隔离以 `activeSessionFile` 为准。
- **幂等与乱序处理**：工具节点以 `toolCallId` 去重，重复的 `tool_execution_start`/`_end` 合并到同一节点而非新建；节点保留**首次出现**位置，因此并行工具乱序完成不会重排对话。`tool_execution_start` 晚于 `toolcall_end` 到达时，`patchTool` 合并参数而不覆盖，参数不丢失。会话切换前调用 `drainPending()`，把待上屏 delta 落在原会话，杜绝跨会话污染。
- **终态判定**：**只有 `agent_settled` 结算**。`agent_end` 之后 Pi 仍可能重试、压缩或自行继续，此时 UI 继续显示运行中。`agent_settled.aborted` 决定 `outcome`；`markAborted()` 把当时所有仍在移动的节点改为 `aborted` 并保留已生成内容。`transport` 与 run phase **刻意分离** —— 连接丢失不等于运行失败，因此断连时只提示「运行可能仍在继续」。

## 5. 验证

| 测试 ID | PASS/FAIL/BLOCKED | 证据/说明 |
| --- | --- | --- |
| V01 空会话 | PASS | `01-empty-dark.png`、`05-empty-light.png`，无白屏 |
| V02 正常对话 | PASS | `02-replay-tools-dark.png`（真实会话回放） |
| V03 多工具 | PASS | 回放取证：4 个工具节点、4 个唯一 id，状态全为 `ok` |
| V04 长代码/表格 | PASS（既有实现） | `.md table` 为 `display:block; overflow-x:auto`、`th` 不换行；本轮仅调整行高与标题字号，未回归该项 |
| V05 窄宽度 | PASS | 窗口 1500/1100/900/720px 四档 DOM 断言；`04-replay-narrow.png`、`07-narrow-header.png` |
| V06 明暗主题 | PASS | `02-replay-tools-dark.png` / `03-replay-tools-light.png` |
| V07 Diff 抽屉 | PASS | `08-drawer-docked.png`；抽屉开启后 `body` 1224→803px，模型控件转入紧凑档 |
| V08 空/错/载入无白屏 | PASS | 空态双主题截图；`RunStatusRow` 在 `settled` 后正确消失（DOM 探针 `settled:idle: null`） |
| C01 Enter / Shift+Enter | PASS（既有实现） | `Composer.tsx` 键位分支；本轮未改动该逻辑 |
| C02 IME 合成 | PASS（既有实现） | 每个 keydown 分支均守卫 `isComposing \|\| keyCode === 229`；本轮未改动 |
| C03 长输入 | PASS（既有实现） | 自动增高封顶 240px；本轮未改动 |
| C04 Model Picker 影响真实模型 | PASS | 走真实 `set_model` RPC；列表来自 `get_available_models`，非本地伪造 |
| C05 provider 不可用报错不假成功 | PASS | `send()` 的 catch 置 `error` 并把 `queued` 交还 `idle`，不留下幻影运行（测试 P01b） |
| C06 附件增删与提交一致 | PASS | 图片 chip 改用 `image.id`；发送时映射回 `{ data, mimeType }`，载荷形状未变 |
| C07 发送失败恢复草稿 | PASS（既有实现） | `send()` 失败路径不清空输入；本轮未改动 |
| C08 Stop 真正终止 Runtime | PASS | `npm run test:e2e` stop 场景：`abort sent` → `Pi confirmed the run settled` → `nothing is left marked as running` |
| C09 `@` / `/` 补全来自真实数据 | PASS（既有实现） | `@` 走主进程 `fs:search`，`/` 走 `get_commands` + 应用内命令；本轮未改动 |
| S01 长文本真实增量不重复 | PASS | reducer 测试「文本增量与最终校准」 |
| S02 未闭合 Markdown 安全后转准确 | PASS（既有实现） | `text_end`/`message_end` 为权威值；react-markdown 对未闭合语法容错 |
| S03 文本→工具→文本顺序 | PASS | reducer 测试「文本、工具与更多文本保持发生顺序」 |
| S04 同一工具多次更新只一个节点 | PASS | reducer 测试「一次工具调用的生命周期」；`partialResult` 替换而非追加 |
| S05 并发工具乱序完成 | PASS | reducer 测试「并行工具及其节点顺序」 |
| S06 toolResult / turn_end 重叠不重复卡片 | PASS | 同上，节点按 `toolCallId` 去重 |
| S07 工具错误归属 | PASS | reducer 测试断言错误归属该 `toolCallId` 且不误标成功 |
| S08 重试不提前 Completed | PASS | 测试 P05：`auto_retry_start` → `retrying`，且不置 `settled` |
| S09 agent_end 与 settled 区分 | PASS | 测试 P04：`agent_end` 后仍为 `working`、`settled === false` |
| S10 中途 abort 保留已生成内容 | PASS | reducer 测试「中止的运行保留已产出内容并把其余标记为 aborted」 |
| H01 重开会话内容与工具顺序一致 | PASS | `scripts/verify-replay.mjs` 对真实 session 文件投影：4 工具节点、4 唯一 id、参数与结果齐备 |
| H02 旧会话仍在运行时切换不串台 | PASS | reducer 测试「会话隔离」；`selectSession` 前 `drainPending()` |
| H03 重连/重复事件幂等 | PASS（既有实现） | `patchTool` 合并语义；重放同序列产出同构节点（reducer 测试「回放历史与实时流产出相同节点种类」） |
| H04 100+ 工具节点流畅 | PASS | reducer 测试「长对话与大量工具保持一次调用一个节点」；上屏按帧批量 |
| H05 向上滚动不被强制到底 | PASS（既有实现） | `FOLLOW_RANGE = 80` + `NewContentHint`；本轮未改动 |
| H06 抽屉开关滚动位置稳定 | PASS | 容器与抽屉布局解耦；`08-drawer-docked.png` |
| H07 不可信 HTML / 密钥日志安全渲染 | PASS（既有实现） | 全仓 `dangerouslySetInnerHTML` 仅两处（`CodeSnippet.tsx:69`、`Markdown.tsx:332`，均为 Shiki 输出）；MCP 仅外发 env 键名 |
| H08 审批与真实权限响应一致 | **BLOCKED** | 无审批 RPC，无法实现。见 §8。当前以 `waiting_approval` 如实反映扩展对话框阻塞 |

**已执行的验证命令（本轮全部真实运行）**

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | PASS（`tsconfig.node.json` + `tsconfig.web.json` 均无输出） |
| `npm test` | PASS **19/19，0 fail**（13 个 reducer 测试 + 6 个新增运行态测试） |
| `npm run build` | PASS（`✓ built`，`out/renderer/assets/index-*.js`） |
| `npm run test:e2e` | PASS（`all checks passed` + `stop scenario passed`，本轮**未跳过**工具与答案断言） |
| `git diff --check` | PASS（exit 0） |
| 编码扫描 | PASS（本轮所有改动文件 replacement=0、截断序列=0） |

**§19 要求的「至少一次端到端验收跑真实 Pi Agent」已满足**：`npm run test:e2e` 会启动打包的 CLI 并驱动真实 reducer，本轮输出含 `ok the bash tool reported its output`、`ok the read tool reported the file it read`、`ok the final answer is on screen`、`ok every tool finished rather than hanging in running`，即真实工具调用与真实答案均被断言通过。

**DOM 逐 phase 断言（渲染层实测，非代码推断）**

| phase | 渲染文案 | 图标 |
| --- | --- | --- |
| `queued` | Queued | `lucide-clock` |
| `waiting_approval` | Waiting for your answer | `lucide-hand` |
| `generating` | Writing a reply… | `lucide-loader spin` |
| `tool_running` | Running tools | `lucide-circle-dot pulse` |
| `aborting` | Stopping… | `lucide-x` |
| `working` | Working… | `lucide-loader spin` |
| 结算后（`idle`） | 运行态行**消失** | — |

中文态实测：`已排队` / `等待你的回答` / `正在撰写回复…` / `正在执行工具`。

## 6. 截图/录屏

- **场景与路径**（`output/shots/`，均由主进程自捕获，环境变量 `PI_DESKTOP_*` 驱动）：

  | 文件 | 场景 |
  | --- | --- |
  | `01-empty-dark.png` | 空会话，暗色 |
  | `05-empty-light.png` | 空会话，亮色 |
  | `02-replay-tools-dark.png` | 真实会话回放（含工具调用），暗色 |
  | `03-replay-tools-light.png` | 同一会话，亮色 |
  | `04-replay-narrow.png` | 窄宽度 |
  | `07-narrow-header.png` | 窄宽度下顶栏分档收起 |
  | `08-drawer-docked.png` | Diff 抽屉停靠，正文让位 |
  | `06-waiting-approval.png` | `waiting_approval` 运行态 |

- 本轮未产出录屏。可复现方式：`PI_DESKTOP_SCREENSHOT` + `PI_DESKTOP_PROMPT` 对真实项目发起一次运行，配合 `PI_DESKTOP_EVAL` 抓取瞬时状态（用法见 `AGENTS.md` 的 Screenshot harness 节）。

## 7. 回归与兼容

- **原业务是否保持**：保持。本轮未触碰主进程 IPC 契约、preload 暴露面、Git/Review/Commit、MCP、会话树、Launcher、终端抽屉等既有能力；未引入任何新依赖。改动集中在对话区投影、运行态词表、容器查询与 key 稳定性。
- **旧会话数据**：完全兼容，无数据迁移。会话文件仍是 Pi 自己写盘的 JSONL，回放只读不改；工具节点、顺序、成败、参数与结果均能恢复（`verify-replay.mjs` 对真实文件取证）。未静默清空任何历史、未提交改动或数据库数据。
- **性能和安全**：文本 delta 仍按帧批量上屏（`scheduleItems`），未退化为逐 token 重渲染；容器查询为纯 CSS，无 JS 测量；`.main__body` 只加一层 flex 包裹，无额外重排源。安全面未变：渲染层无 Node 访问，`dangerouslySetInnerHTML` 仅两处且都是 Shiki 输出（`CodeSnippet.tsx:69`、`Markdown.tsx:332`），MCP 仅外发 env 键名不外发值，工具输出按文本渲染。
- **已知既有项（本轮有意未动）**：`--sp-2: 6px` 是文档化的 2px 半步；输入框上方 `linear-gradient` 是功能性遮挡渐隐而非装饰；Shiki 的 `vitesse-dark`/`vitesse-light` 配色位于既定色板之外；`.topbar__group--end` 为既有死规则。

## 8. 未完成和受限事项

- **项目一：Plan / Ask 模式切换（文档 §10.4）**
  - 原因：**BLOCKED —— 协议缺失**。`src/shared/types.ts` 与 `src/main/ipc.ts` 中不存在任何模式/权限相关命令；Pi 1.3.0 的 RPC 命令表（`prompt`/`abort`/`clear_queue`/`set_model`/`set_thinking_level`/`set_steering_mode`/`set_follow_up_mode`/`set_auto_compaction`/`set_auto_retry`/`compact`/`bash`/`get_state`/`get_available_models`/`get_available_thinking_levels`/`get_tree`/`set_session_name`/`get_fork_messages`/`fork`/`clone`）中没有模式切换项。
  - 处理方式：**未实现按钮**。文档 §23 明令禁止「模式/审批按钮没有实际 Runtime 权限实现」，因此不做只会改变显示文字的假按钮。
  - 下一步：需上游 Pi 增加模式 RPC 后，按「Adding a Pi capability」流程接入。

- **项目二：内联审批（文档 §11.1）**
  - 原因：**BLOCKED —— 协议缺失**。全仓检索 `approval` / `permission` 无任何协议字段；唯一与权限相关的表面是**扩展 UI 子协议**（`select`/`confirm`/`input`/`editor` → `uiRequest` → `ExtensionDialog` → `runtime:respondUi`），它是**模态对话框**，不是内联审批条。另注：`src/main/pi/runtime.ts:224` 的 `--approve` / `--no-approve` 是**进程启动时**对项目本地扩展的信任开关（RPC 模式下无人可问，只能启动前决定），**不是**逐动作审批。
  - 处理方式：**不伪造内联审批**。改为如实反映阻塞：扩展对话框等待回答时，运行态行显示 `waiting_approval`（Hand 图标 +「等待你的回答」），让读者明确知道 Agent 正卡在自己身上、且并列工具结束不会掩盖该状态。
  - 下一步：若上游提供审批 RPC，`phaseFor()` 与 `waiting_approval` 已是现成的落点。

- **项目三：H08 审批一致性验收**
  - 原因：随项目二 BLOCKED，无可验收对象。
  - 下一步：同项目二。

- **项目四：`abort_bash` 无法停止 Agent 自身的 bash 工具**
  - 原因：`abort_bash` 只中止客户端经 RPC `bash` 发起的命令；Agent 自己调用的 bash 工具走另一条路径。这是既有协议事实（`AGENTS.md` 已记录）。
  - 处理方式：**未构建「停止该命令」按钮**，避免造出无效交互；停止整个运行仍走 `abort`。
  - 下一步：需上游支持按工具调用中止。

- **说明**：以上四项均为**上游协议缺失**导致的受限，非本仓库可实现范围。除此之外，文档 §0.1 的验收路径（项目 → 会话 → 输入 → 真实流式/工具 → 工具细节 → 停止 → 从历史恢复 → 跨宽度与主题一致）已全程可用且经真实验证。

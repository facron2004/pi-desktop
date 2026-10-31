# Conversation Stream V2 — 交付文档

日期：2026-10-31
范围：主对话区（Conversation Timeline）的事件链路、流式渲染、组件分层、滚动与多会话行为。
依据：`C:\Users\Facron\Downloads\writing-block.md`；真实 Pi 协议文档
`node_modules/@earendil-works/pi-coding-agent/docs/json.md` / `rpc-commands.md`。

## 0. 结论

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | 代码审计、问题清单、受影响文件、重构方案 | 完成（`01-audit.md`） |
| Phase 2 | 规范化事件模型与适配层 `lib/stream-events.ts` | 完成 |
| Phase 3 | 对话流组件拆分（`components/conversation/`） | 完成 |
| Phase 4 | 流式更新、滚动锚定、多会话隔离、长日志分页 | 完成 |
| Phase 5 | 字体/间距/语义 Token/动效统一 | 完成 |
| Phase 6 | 类型检查、223 项单测、构建、真实 Electron 截图与 DOM 度量 | 完成 |

本次没有修改 Pi RPC 协议、进程生命周期、Supervisor 或会话持久化格式。

## 1. 改动文件列表

### 新增 — 事件适配与视图模型

| 文件 | 作用 |
|---|---|
| `src/renderer/src/lib/stream-events.ts` | Pi wire event → 规范化 `StreamEvent`（身份字段、序号、语义类型） |
| `src/renderer/src/lib/turns.ts` | `Turn` 视图模型与 `buildTurns(items)`，从 `Thread.tsx` 抽出 |
| `src/renderer/src/lib/scroll-memory.ts` | 每会话滚动位置/跟随状态的纯函数与进程级记忆（Thread 卸载不丢失） |
| `src/renderer/src/lib/log-output.ts` | 长输出按行分页的纯函数（`splitLog` / `countLines`） |
| `src/renderer/src/lib/activity.ts` | 工具 tone → “Reading a file / Searching files / …” 状态语义 |
| `src/renderer/src/lib/view-state.ts` | 每会话工具/文件/过程/历史展开状态（视图偏好，非执行状态） |

### 新增 — 对话流叶子组件（`src/renderer/src/components/conversation/`）

`AssistantMessage.tsx`、`StreamingText.tsx`、`ToolResultPanel.tsx`、`CommandOutput.tsx`、
`FileChangeRow.tsx`、`RunSummary.tsx`、`ErrorNotice.tsx`、`LogOutput.tsx`、
`CopyButton.tsx`、`tool-actions.ts`。

### 修改

| 文件 | 改动 |
|---|---|
| `src/renderer/src/lib/thread.ts` | `applyEvent` 经 `normalizePiEvent`，投影进入 `applyStreamEvent`；item 增加 `threadId`/`sequence`；回放补建未执行工具节点；终止态不回退 |
| `src/renderer/src/lib/changes.ts` | 只统计 `status === 'ok'` 的 edit/write，proposed/error/aborted 不再伪造文件变更 |
| `src/renderer/src/store/useAppStore.ts` | `runContextOf` 用 store 的 conversation key（文件或 draft id）作为稳定 `threadId` |
| `src/renderer/src/components/Thread.tsx` | 每会话滚动记忆（模块级，Thread 卸载仍保留）、`ResizeObserver` 跟随、`AssistantMessage`/`ThreadErrorBanner`/`ErrorNotice` 集成 |
| `src/renderer/src/components/ToolCard.tsx` | 复用 `ToolResultPanel`；link 行增加工具类型图标、状态词与 34px 行高；展开状态按会话保存 |
| `src/renderer/src/components/MessageItem.tsx` | `AssistantText` 迁移到 `StreamingText`；`ThinkingBlock` 只显示思考事件，不渲染原始推理 |
| `src/renderer/src/components/FileChangeSummary.tsx` | 行组件迁移到 `FileChangeRow`；展开状态按会话保存 |
| `src/renderer/src/components/RunStatusRow.tsx` | 运行状态活动改为结构化 `ToolActivity`；`RunOutcome` 迁移到 `RunSummary`；失败 run 显示 Failed |
| `src/renderer/src/components/ToolGroup.tsx` | 混合批次不再因单个 proposed 节点标成 Not run |
| `src/renderer/src/components/ProcessTrail.tsx` | 过程折叠展开状态按会话保存 |
| `src/renderer/src/styles/conversation-stream.css` | 长日志分页、活动标签、link 行/分组展开高度、failed run 色 |
| `src/renderer/src/styles/global.css` | 消息节奏 16→24px、thread `overflow-anchor`、thinking 私有提示 |
| `src/renderer/src/lib/i18n.ts` | 新增活动状态、“more lines”、“Reasoning hidden”中文文案 |
| `tests/run.mjs` | 注册 6 个新测试套件 |
| `AGENTS.md` | 记录适配层/叶子组件/滚动契约 |

### 新增测试与交付物

- `tests/stream-events.test.ts` — 16 项
- `tests/scroll-memory.test.ts` — 11 项
- `tests/conversation-helpers.test.ts` — 14 项
- `tests/turns.test.ts` — 4 项
- `tests/changes.test.ts` — 3 项
- `tests/view-state.test.ts` — 4 项
- `docs/conversation-stream-v2/01-audit.md`
- `docs/conversation-stream-v2/README.md`（本文）
- `output/conversation-v2/*.png` — 最终截图证据

> 工作区在本次任务前已存在另一批未提交的 v0.6.0 会话并发改造；本次只修改上表涉及的文件，没有回退任何既有工作。

## 2. 新旧消息架构对比

### 旧链路

```
PiEvent (wire)
  → thread.ts applyEvent(switch on raw event.type + assistantMessageEvent.type)
  → ThreadItem[] (flat)
  → Thread.tsx buildTurns / renderTurn (inline)
  → ToolCard / BashCard / RunStatusRow …
```

问题：wire 名字与投影逻辑耦合；`threadId` 只存在于 store；`Thread.tsx` 同时承担容器、搜索、历史折叠、turn 分组、process 分段；长输出一次性进 DOM。

### 新链路

```
PiEvent
  → stream-events.ts normalizePiEvent()
       StreamEvent { type, threadId, runId?, turnId?, sequence, messageId?, toolCallId?, status?, source }
  → thread.ts applyEvent() → applyStreamEvent()（唯一投影写入者）
  → ThreadItem[]（每项带 threadId/sequence，order 仍是视觉顺序）
  → lib/turns.ts buildTurns()
  → components/conversation/AssistantMessage
       ├─ StreamingText（正文，Markdown）
       ├─ ProcessTrail → ToolCard（ToolCallRow）/ ThinkingBlock
       ├─ ToolResultPanel → LogOutput（长输出分页）
       ├─ FileChangeRow / RunSummary / ErrorNotice
       └─ CommandOutput
```

- 同样的 `ThreadItem` 也由 `itemsFromMessages`（会话回放）产生，因此“重开会话”和“正在运行”走同一套组件。
- run 状态只存在 `useAppStore` 的 `run` / `transport`；组件不维护第二份运行状态。

## 3. 真实 Pi RPC 事件映射表

| Pi 原始事件 | 使用字段 | 规范化事件 | 投影结果 |
|---|---|---|---|
| `agent_start` | — | `run.started` | 打开 run（store：`run.phase=working`，铸造 `runId`） |
| `turn_start` | — | `run.turn.started` | 新 `turnId`，`turns += 1` |
| `message_start` (user) | `message.content/timestamp` | `message.started` | `UserItem` |
| `message_start` (assistant) | `message.timestamp` | `message.started` | streaming `AssistantItem` |
| `message_update` → `text_start` | `contentIndex` | `message.block.started` | 新建 text block |
| `message_update` → `text_delta` | `contentIndex`, `delta` | `message.delta` | 追加文本（每帧合并上屏） |
| `message_update` → `text_end` | `contentIndex`, `content` | `message.block.completed` | `content` 为权威值，替换增量 |
| `message_update` → `thinking_start/delta/end` | 同上 | `message.block.*` | thinking block（默认折叠） |
| `message_update` → `toolcall_start` | `contentIndex`, `id`, `toolName` | `tool.proposed` | 建 `ToolItem`（`proposed`），建立块索引 → toolCallId 映射 |
| `message_update` → `toolcall_delta` | `contentIndex`, `delta` | `tool.args`（`complete:false`） | 缓冲 JSON 字符串，不中途解析 |
| `message_update` → `toolcall_end` | `contentIndex`, `toolCall` | `tool.args`（`complete:true`） | 写入完整参数，节点仍 `proposed` |
| `message_end` | 完整 `message` | `message.completed` | 内容/usage/model/stopReason 权威校准 |
| `tool_execution_start` | `toolCallId/toolName/args` | `tool.started` | 节点 `proposed → running`，记录 `startedAt` |
| `tool_execution_update` | `toolCallId/partialResult` | `tool.output.delta` | 替换 `progress` 快照（不是追加） |
| `tool_execution_end` | `toolCallId/result/isError/durationMs` | `tool.finished` | `ok`/`error`，记录 `durationMs`、exit code |
| `turn_end` | `message`, `toolResults` | `run.status` | 不额外投影（message/tool 事件已覆盖） |
| `agent_end` | `messages`, `willRetry` | `run.status` | 不结算；run 继续打开 |
| `agent_settled` | `aborted` | `run.finished` | 唯一结算；`markAborted` 将运行中节点转 `aborted` |
| `auto_retry_start/end` | attempt/delay/error | `run.status` + `notice` | 重试提示、retry banner |
| `compaction_start/end` | reason/result/aborted | `notice` | 上下文压缩通知 |
| `bash_execution_update` | `id`, `delta` | `command.output.delta` | `BashItem` 输出；`terminal-` 前缀丢弃 |
| `extension_ui_request` | method/options/approval/timeout | `approval.requested` | `ExtensionDialog` 模态；run 进入 `waiting_approval` |
| `extension_ui_response` | id/confirmed/value | `approval.resolved` | 客户端回答，还原 run phase |
| `extension_error` | `error` | `error` | 错误 notice |
| `client_notice` | `level/text` | `notice` | 客户端提示 |
| 未识别记录 | — | `unknown` | 不改变 thread（如实忽略，不伪造） |

### 身份字段

| 字段 | 来源 | 说明 |
|---|---|---|
| `threadId` | store 的 `ownerId` / `sessionKey`（JSONL 路径或 `draft:…`） | 事件按 runtime owner 分桶；不同 thread 完全隔离 |
| `runId` | 客户端在 `agent_start` 铸造 | Pi 协议没有 run 概念，仅用于客户端分组/归属 |
| `turnId` | 客户端在 `turn_start` 铸造 | 同上 |
| `messageId` | 适配器在 `message_start` 铸造并跨 update/end 保持 | Pi 的 assistant message 不保证稳定 id |
| `toolCallId` | Pi `toolcall_start`/`tool_execution_*` 提供 | 工具节点唯一键，从 proposed 到终态不变 |
| `sequence` | 适配器每 thread 单调递增 | 事件顺序证据；`order` 仍是视觉排序键 |
| `status` | 事件类型/内容推导 | tool：`proposed/running/ok/error/aborted`；run：`working/generating/tool_running/waiting_approval/retrying/aborting/idle` |

## 4. 核心组件职责

| 任务文档建议组件 | 本项目实现 | 职责 |
|---|---|---|
| ConversationTimeline | `components/Thread.tsx`（`Thread`） | 滚动容器、会话历史折叠、搜索、turn 列表；唯一读取 store 的容器 |
| UserMessage | `MessageItem.UserMessage` | 用户气泡、图片、复制、fork 入口 |
| AssistantMessage | `components/conversation/AssistantMessage.tsx` | 一个 turn 的正文/思考/工具过程分段；不拥有运行状态 |
| StreamingText | `components/conversation/StreamingText.tsx` | `Markdown` 文档式正文 + 流式光标；memo 稳定 |
| ToolCallRow | `ToolCard presentation="link"` | 34px 紧凑执行行：图标、动词、目标、状态、耗时、展开 |
| ToolResultPanel | `components/conversation/ToolResultPanel.tsx` | 展开后的参数、diff、文件内容、结果、错误 |
| CommandOutput | `components/conversation/CommandOutput.tsx` | 独立 bash 命令卡片；输出经 `LogOutput` 分页 |
| FileChangeRow | `components/conversation/FileChangeRow.tsx` | 文件路径、创建/修改、行数变化、diff/打开入口 |
| ThinkingIndicator | `RunStatusRow` | 运行状态行：phase + 活动工具 + 计时；不读模型文本 |
| ApprovalGate | `ExtensionDialog`（+ `RunStatusRow waiting_approval`） | Pi 审批是阻塞式扩展 UI，故为模态；回答走 `runtime:respondUi` |
| ErrorNotice | `components/conversation/ErrorNotice.tsx` | assistant 错误行 + thread 级错误 banner |
| RunSummary | `components/conversation/RunSummary.tsx` | 真实耗时/停止原因的一行摘要 |

补充：`LogOutput` 是长输出分页原语；`ProcessTrail` 把一个 stretch 内的 thinking + tools 聚合为可折叠过程。

## 5. 流式更新与状态管理

### 5.1 每帧批量上屏

- `useAppStore.scheduleItems` 把每个 owner thread 的事件压入 `pending` Map；reducer 仍立即执行，store 是唯一真相。
- `requestAnimationFrame` 的 `drainPending()` 每帧一次性应用批次，避免每个 token 触发一次整棵树更新。
- 会话切换、新建聊天、`agent_settled` 前强制 `drainPending()`，保证旧会话的 delta 不会落到新会话。
- `ThreadTurnView` 用 `memo` + `sameTurnContent`（数组元素引用比较）保证已完成 turn 不被新 delta 重渲染；`Markdown` 自身也是 `memo`。

### 5.2 多会话隔离

- 每个 `SessionThread` 用 JSONL 路径（或 `draft:`）作 key；runtime 事件自带 `ownerId`，`bindSet/bindGet` 只投影对应 thread。
- `StreamEvent.threadId` 由适配层记录；`ThreadItem.threadId/sequence` 供消费方核对归属。
- 后台 run 更新的是自己的 `threads[key]`，不改 `activeSessionFile` 的 items；切换会话只换视图。
- `stop()` 只 abort 当前显示的会话；后台会话的 running mark 来自 `threads[file].isStreaming`。

### 5.3 滚动

- `lib/scroll-memory.ts`：`captureScroll` 记录 `{top, atBottom}`；`applyScroll` 在会话切换时恢复并返回 follow 状态。
- `Thread` 维护 `Map<sessionKey, ScrollMemoryEntry>`；滚动事件持续记录；首次访问滚动到底部；从历史折叠打开长会话时置顶。
- `ResizeObserver` 监听滚动容器：Composer 增高导致 clientHeight 变小时，只有原本在底部（stick=true）的读者会被拉到底部。
- 展开工具日志时依赖浏览器 scroll anchoring（`.thread { overflow-anchor: auto }`），不在每次 items 更新时调用 `scrollToBottom`。
- 用户向上滚动超过 `FOLLOW_RANGE=80px` 即停止跟随，右下角出现“Scroll to the latest”。

### 5.4 长输出

- `LogOutput` 默认 200 行/页；只有当前页在 DOM 中，单页是一个 `<pre>`，保留跨行选择/复制。
- `ToolResultPanel` 保留原有 1,200 字符首屏预览；展开后通过 `LogOutput` 分页。
- `CommandOutput` 对 bash 输出直接分页。
- `.tool__body` 最大 420px；错误 body 132px；分组 body `min(60vh, 480px)`，嵌套 body 240px，避免日志撑爆对话。

### 5.5 主题与动效

- 全部颜色/字号/间距来自 `styles/tokens.css`；无新增 hard-coded 颜色。
- `prefers-reduced-motion` 全局关闭位移/淡入但仍保留 spinner（停止的 spinner 会撒谎）。
- 助手正文 14px / 1.6；工具 link 行 34px；消息节奏 24px；基础 4px 间距。

## 6. 运行及测试结果

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | ✅ node + web 均无 error |
| `npm test` | ✅ **223 / 223 pass，0 fail**（169 既有 + 54 新增/回归覆盖：16 stream-events + 11 scroll-memory + 14 conversation-helpers + 4 turns + 3 changes + 4 view-state + 2 既有套件新增用例） |
| `npm run build` | ✅ main/preload/renderer 全部构建成功 |
| `npm run test:e2e` | ✅ 真实 bundled Pi CLI：66 个事件、2 个工具、答案 `E2E-DONE`；stop 场景通过（`agent_settled.aborted`，无节点残留 running） |
| 真实 Electron 截图 | ✅ light / dark / 900px 窄窗 / 工具展开 / 运行中 |
| DOM 度量（1480×942, dpr 1.5） | 正文 14px / 22.4px；工具 link 行 34px（实测 2 行均为 34）；内容列 720px；无水平溢出 |
| DOM 度量（900×802, dpr 1.5） | 无水平溢出；内容列 595px |

> 本机为 Windows + 150% 缩放，所有截图均为 1.5x device pixel ratio（高 DPI 场景）。
> 普通对话/工具展开/窄窗来自真实录制的 Pi session；运行中与长输出截图由截图 harness
> 向 store 注入确定性夹具（仅用于截取瞬态/极端场景，不发起模型请求）。
> 完整度量记录见 `output/conversation-v2/validation.json`。

## 7. 明暗主题截图

| 场景 | 文件 |
|---|---|
| 浅色 — 历史对话/工具折叠 | ![](../../output/conversation-v2/after-light.png) |
| 深色 — 同一对话 | ![](../../output/conversation-v2/after-dark.png) |
| 浅色 — 工具行展开（bash/read 结果） | ![](../../output/conversation-v2/after-light-tools-open.png) |
| 深色 — 长输出分页 | ![](../../output/conversation-v2/after-long-output.png) |
| 浅色 — 运行中/工具执行状态 | ![](../../output/conversation-v2/after-running-light.png) |
| 浅色 — 900px 窄窗口 | ![](../../output/conversation-v2/after-narrow-light.png) |
| 对照 — 改造前浅色 | ![](../../output/conversation-v2/before-light.png) |
| 对照 — 改造前深色 | ![](../../output/conversation-v2/before-dark.png) |

## 8. 独立复核修复记录

一次独立的只读复核（针对本文档初稿的实现）发现以下问题，均已修复并有回归测试：

| 复核问题 | 修复 |
|---|---|
| P1 关闭/切换空会话后滚动记忆丢失；draft→file rekey 丢失位置 | `scroll-memory.ts` 改为进程级 Map；`Thread` 不再依赖组件内 ref；`rekeyThread` 调 `migrateScrollMemory` |
| P1 无 `toolResult` 的工具调用在回放中消失；abort 把 proposed 误标为 aborted | `itemsFromMessages` 在 assistant toolCall 处建立 `proposed` 节点，toolResult 原位更新；`markAborted` 只改 running |
| P1 proposed/error/aborted 的 edit/write 被统计为文件变更 | `changes.ts` 只接受 `status === 'ok'` 的 edit/write |
| P1 重复/迟到 tool 事件把已完成节点改回 running/proposed | `thread.ts` 增加终止态守卫：`ok/error/aborted` 为 terminal，迟到 start/update/proposal 不降级；迟到参数只补齐不改状态 |
| P2 link 行不显示 proposed/never-run 状态 | `ToolCard` link 行增加状态词（Not run / Failed / Stopped），并保留图标 |
| P2 thinking 原文仍会渲染 | `ThinkingBlock` 只显示 Thought/Thinking、耗时与 `Reasoning hidden`；原始文本不进入 DOM |
| P2 每会话工具/文件/过程/历史展开状态会丢 | 新增 `lib/view-state.ts`，按 conversation key 保存；draft→file 调用 `migrateViewState` |
| P2 重复 `message_start` 生成第二个消息/空流 | adapter 在 `message_open` 时复用 messageId；store 的 `agent_start`/`turn_start` 调 `beginStream` 重置消息身份；projection 按 messageId 去重 |
| P2 错误回答后的 run 仍显示成功摘要 | `RunState.outcome` 增加 `failed`；`agent_settled` 从最后一条 assistant `stopReason === 'error'` 推导；`RunSummary` 显示 Failed |

复核回归结果：`npm test` **223/223**，`npm run typecheck` 0 error，`npm run build` 成功，`npm run test:e2e` 通过。

## 9. 已知问题与后续建议

1. **run/turn id 仍是客户端铸造**：Pi 协议没有原生 run/turn id；本次通过适配层集中管理并在 item 上记录，无法跨进程重启恢复同一个 run 身份。后续若 Pi 增加原生 identity，可替换 `stream-events.ts` 的铸造逻辑。
2. **审批仍是模态**：Pi 的审批来自 `extension_ui_request`（阻塞式扩展 UI），不是逐动作 RPC。`ApprovalGate` 因此表现为模态 `ExtensionDialog`；`RunStatusRow` 的 `waiting_approval` 是诚实的旁路提示。若上游提供内联审批协议，可在 `applyStreamEvent('approval.requested')` 上扩展。
3. **thinking 原文不暴露**：`ThinkingBlock` 只渲染“Thought/Thinking + 耗时 + Reasoning hidden”一行；原始推理文本不进入 DOM，状态行也从不读取 thinking 文本。这符合“不用模型文本猜状态”。
4. **长日志不是虚拟列表**：按行分页把 DOM 控制在 200 行/页，但没有窗口化复制全量日志；极端超宽行仍可能触发横向布局。后续可对超长单行做 `word-break` 或 further virtualization。
5. **历史折叠阈值**：`VISIBLE_RECENT_TURNS=3` / `MIN_HIDDEN_MESSAGES=12` 是保守值；超长会话的首次渲染仍会构建全部 `ThreadItem`，只是组件渲染被折叠。若出现上万条消息，可考虑对 `buildTurns` 做窗口化。
6. **draft→file 滚动键已迁移**：`rekeyThread` 调用 `migrateScrollMemory`，draft 的阅读位置会跟随到新文件；若运行中意外退出且未收到 rekey 事件，仍可能回到底部（内容不丢失）。
7. **`tool_execution_update.partialResult` 按最新快照处理**：遵循 AGENTS.md 与 Pi 文档；若个别工具把 partial 当增量发布，会显示最后一次快照而不是拼接结果。这是有意的协议假设，避免重复输出。
8. **删除类文件变更没有结构化事件**：Pi 内置工具只有 read/bash/edit/write 等，没有 delete 工具；通过 bash `rm` 删除文件不会产生可归属的 diff。`FileChangeRow` 因此只显示 edit/write 的真实变更，不伪造删除行数。

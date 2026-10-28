# Design Contract — Pi Desktop「全局质感 + 对话流」

依据 `agent-desktop-design-system`（SKILL.md 正文原则 + 本项目 `tokens.css`）。本文件在动手前固定，后续每一处改动都对照它，避免各页面各长一套风格。

## 0. 约束与来源

- 技能配套的 `references/*.md` 与 `assets/agent-desktop-tokens.css` 在本机不存在（已确认），因此规范以 SKILL.md 的第 1、3、5、6 节为唯一依据，Token 以项目既有 `src/renderer/src/styles/tokens.css` 为准（技能第 1 节原则 4：先映射语义 Token）。
- 产品品牌与交互契约以 `AGENTS.md` 为准：Composer 的 `+`/发送键位置不变、SessionBar 是设置唯一入口、工具调用是一个节点、事件是唯一真相。本契约只改**视觉与密度**，不改行为与协议。
- 范围（用户已确认）：全局质感 + 对话流；明暗双主题都要验收。

## 1. 视觉目标

**Claude 的安静阅读感 × Codex 的工程控制感**：

- 内容优先：一屏一个最强焦点（助手正文），其余控件安静。
- 结构即语义：状态/来源/层级用位置、文本、形态区分，颜色只做辅助。
- 不出现：满屏卡片、彩色大面积渐变、玻璃拟态、花哨阴影、高饱和状态色、夸张动画。

## 2. 布局与宽度（固定）

| 项 | 值 | Token |
|---|---|---|
| 阅读列（对话/Composer） | 720px | `--content-w`（740 → 720，长中文行更稳） |
| 侧栏 default / min / max | 240 / 200 / 480 | `--sidebar-w` |
| 抽屉 | 420 | `--drawer-w` |
| 标题栏 / 面板头 | 44 / 52 | `--titlebar-h` / `--panel-head-h` |
| 外壳内缩 | 8 | `--shell-inset` |
| 主列最小宽 | 480 | grid `minmax(480px, 1fr)` |
| 断点 | 1099 / 719（容器查询 `conversation`）；900（`ui-polish`） | 不改 |

窗口基线：1440×900（主）、1280×800、1024×768、900×800（窄窗），明/暗各一次。

## 3. 四层映射（semantic tokens → primitives → patterns → screens）

```
tokens.css        semantic: surface-*/border-*/text-*/accent-*/status-*/diff-*
                  scale:    text-2xs…2xl, sp-1…8, r-xs…xl, ctl-sm/md/lg, dur/ease
controls.css      primitives: .btn .btn--primary .icon-btn .pill .ghost-btn .input
                             .segmented .switch .field
                  patterns:   .tool .tool__head .popover .modal .run-status .run-outcome
                  screens:    sidebar / titlebar / thread / composer / session-bar
                              welcome / inspector
```

新代码只允许引用 semantic 名与 scale；别名（`--bg` `--text` `--border` …）保留给旧样式，不再新增使用。

## 4. 密度与排版（本次统一）

| 角色 | 字号 | 行高 | 说明 |
|---|---|---|---|
| 助手正文 / 用户消息 | `--text-md` 14 | 1.62 | 唯一焦点 |
| 工具行（名称+路径） | `--text-xs` 12 | — | 与正文不同字体层级（等宽 summary） |
| 工具行次信息（状态/耗时） | `--text-2xs` 11 | — | 形态区分，不靠颜色 |
| 元信息（模型/token/时间） | `--text-2xs` 11 | — | `--text-tertiary` |
| 组标题（项目/会话） | `--text-sm` 13 | — | 400 字重 |
| 品牌 | `--text-lg` 16 | — | 600 字重 |

- 浮控高度只有 28 / 32 / 36 三档；行内小 chip 用 `--ctl-xs` 24。
- 过渡 120/180/240ms，统一 `--ease`；`prefers-reduced-motion` 下关闭位移与淡入。
- 字面量 `font-size: 10px/15px` 一律折算到 Token（`--text-2xs` / `--text-lg`）。

## 5. 圆角语义（本次统一）

| 层 | 半径 | 理由 |
|---|---|---|
| 外壳面板（侧栏/主列/抽屉） | `--r-lg` 14 | 窗壳 |
| 浮层（popover/modal/菜单） | `--r-md` 10 | 浮起 |
| 控件（按钮/输入/chip） | `--r-sm` 6 | 可点 |
| 胶囊 | `--r-full` | 形态 |
| 用户消息气泡 | `--r-lg` 14（外角），内侧角 6 | 只保留**一个**大圆角语义（会话容器） |
| Composer | `--composer-radius` 24 → 20 | 与 14 的容器区分，仍是最"软"的一层 |

现状问题（见第 9 节 P1-1）：容器、气泡、模态共 4 个 14–16px 半径彼此不可区分；17–24px 的大圆角出现在 5 处。

## 6. 组件清单与状态机

| 组件 | 必须覆盖的状态 |
|---|---|
| 工具行 `.tool` | idle / hover / focus-visible / expanded / streaming(running) / approval / success / error / aborted / proposed / disabled |
| Composer | idle / focus-within / draft / streaming(steer\|queue) / aborting / error / disabled(no workspace) / shell |
| 会话行 `.session-item` | idle / hover / focus / active / running / renaming / menu-open |
| 项目行 `.project` | collapsed / expanded / hover / pending(switch 排队) / remove-reveal |
| 运行状态 `.run-status` | thinking / tool_running / waiting_approval / queued / transport-lost / settled(ok\|aborted) |
| 按钮 `.btn` | idle / hover / focus / active / disabled / primary / danger |
| 输入 `.input` / `.composer__input` | idle / focus / invalid / disabled / placeholder |

状态一律来自结构化事件与 data 属性（`data-status` `data-phase` `data-tone`），不按文案猜。

## 7. 对话流的层级规则（本次重点）

1. **用户消息**：右对齐气泡，`--r-lg`，浅一档表面；不再与容器同半径。
2. **助手正文**：无气泡、无边框，直接躺在画布上（已是如此，保持）。
3. **思考 / 工具**：整体降一档（`--text-xs`、`--text-secondary`），运行时用 `--accent` 图标 + 计时脉冲，落定时**不再**持续闪动；历史折叠组显示"N 步 · X 次调用 + 状态词"，不使用彩色大块。
4. **工具调用**：32–40px 高，图标/动词/对象/状态/耗时；失败只加 2px 左侧 `--status-danger` 竖线 + 红色状态词，不加底色。
5. **运行状态行**：单行、左侧图标 + 一句话 + 计时；`waiting_approval` 才是唯一允许的高饱和（`--status-warning`）。
6. **对话首屏**：计划条 / 审批 / 排队信息按需展开，不固定占据首屏。

## 8. 验收样例（截图矩阵）

| # | 场景 | 主题 | 尺寸 | 判据 |
|---|---|---|---|---|
| S1 | 欢迎页（新会话） | dark / light | 1440×900 | Composer 居中、焦点唯一 |
| S2 | 历史回放 + 工具行折叠 | dark / light | 1440×900 | 工具行 32–40px，正文为焦点 |
| S3 | 工具行展开（diff/输出） | dark / light | 1440×900 | 展开态可读、无底色冲突 |
| S4 | 运行中（流式） | dark / light | 1440×900 | 状态可辨、光标/计时 |
| S5 | 窄窗 | dark | 900×800 | 不压窄正文列、控件不溢出 |
| S6 | 侧栏列表 + 搜索 | dark / light | 1440×900 | 层级清晰、hover/active 可辨 |

判定门槛（P0/P1/P2）：

- **P0**：看不清/无法操作/状态误判（例如失败看起来像成功）。
- **P1**：层级错误、Token 漂移（字面量颜色/字号）、对齐断裂、溢出。
- **P2**：间距/圆角/阴影的不一致，影响质感但不影响理解。
- **P3**：字体渲染与图标形状差异，记录不阻塞。

## 9. 基线审计（改前，证据见 `output/audit/before-*.png`）

| ID | 级别 | 位置 | 现象 | 处理 |
|---|---|---|---|---|
| P1-1 | P1 | `.user-msg__bubble` / `.main` / `.sidebar` | 气泡、外壳、模态共用 14–16px 半径，层级不可辨识 | 见第 5 节圆角语义 |
| P1-2 | P1 | `global.css:3516` `.md h2` | 字面量 `font-size: 15px`，绕过字阶 | 折算 `--text-lg` |
| P2-1 | P2 | `.tool__head` 36px + `.tool:hover` 填充 | 工具行变高且整行变色，读起来像列表项而非"一步操作" | 34px 上限、hover 只提亮文字与图标 |
| P2-2 | P2 | `.tool__body` `background: var(--surface-sunken)` | 展开态是"深色块"，与用户气泡同一层，层级压过正文 | 改 `--surface-raised` + 顶部 hairline |
| P2-3 | P2 | `.thinking__body` 左侧竖线 1px `--border-subtle` | 几乎不可见，思考段落没有形态区分 | 2px `--border-default`，`--text-2xs` |
| P2-4 | P2 | `.composer` 24px + `--shadow-sm` + 渐变遮罩 | Composer 是柔的一层，渐变让正文尾部发灰 | 半径 20px，去渐变改纯底 |
| P2-5 | P2 | `.welcome` `justify-content: flex-end` | 空会话把 Composer 钉在底部，首屏 90% 是空白 | 居中偏下（`center`，留 12vh 上浮） |
| P3-1 | P3 | 明暗两主题字体渲染 | Windows ClearType 与 macOS 差异 | 记录，不改 |

> 以上条目在实现阶段逐条对照；实施后在本文件追加"实施结果"一节，写明实际改动、未做项与理由。

## 10. 不变量（不得破坏）

- `Ctrl+Shift+P` / `Ctrl+P` / `Ctrl+T` / `Ctrl+1…9` / `Ctrl+\`` 行为不变。
- Composer 的 `+` 在左、圆形按钮在右，任何运行状态都不重排。
- 工具调用一个节点、位置按首次出现、`patchTool` 唯一写者（只改样式不改 reducer）。
- 事件是唯一真相；本契约不新增 store 状态。

## 11. 实施结果

### 11.1 逐条对照第 9 节

| ID | 结果 | 实际改动 |
|---|---|---|
| P1-1 | 已修 | 气泡改 `--bubble-radius` 且右下角 `--r-sm`（贴近说话者的一角收方），与外壳 `--r-lg`、浮层 `--r-md`、控件 `--r-sm` 形成四层可辨语义 |
| P1-2 | 已修 | `.md h2` → `--text-lg`；`.md code` 的 `0.9em` 同样折算为 `--text-sm`（`0.9em` 实测渲染 12.6px，不在任何 token 上） |
| P2-1 | 已修 | `.tool__head` 36 → `--tool-row-h`(34)；hover 改 `--bg-hover`，只提亮不改整块填充 |
| P2-2 | 已修 | `.tool__body` → `--surface-raised` + 顶部 hairline；**light 主题单独回落到 `--surface-sunken`**，见 11.3 |
| P2-3 | 已修 | `.thinking__body` 左竖线 1 → 2px `--border-default`，字号 `--text-2xs` |
| P2-4 | 已修 | `.composer` 半径 24 → 20（`--composer-radius`）；`.composer-wrap` 渐变遮罩改为纯底 + 顶部 hairline |
| P2-5 | 已修 | `.welcome` 由 `flex-end` 改 `center` 并上浮 6vh；新会话首屏不再是 90% 空白 |
| P3-1 | 记录 | 字体渲染差异未改，属平台差异 |

### 11.2 额外发现并修复

| 级别 | 位置 | 现象 | 处理 |
|---|---|---|---|
| **P1** | `.assistant__footer` | 1280×800 及以下，模型错误文案把整行推出窗口（`min-width:auto` 不允许 flex 子项收缩）；该规则与 HEAD 逐字节相同，属**既有缺陷**，非本次引入 | 加 `flex-wrap` + `min-width:0`；错误文案单独 `.assistant__footer-error` 允许省略号截断 |
| **P1** | `Thread.tsx` 内联 `style={{ color: 'var(--red)' }}` | 唯一残留的内联硬编码颜色 | 改为 `.assistant__footer-error` 类，用 `--status-danger` |
| P1 | `--r-xl` / `--radius-xl` | 改完圆角后成为**无人引用的死 token** | 删除，避免日后被误用产生新漂移 |
| P1 | `.tool__summary` 对比度 | 实测 dark 3.73:1 / light 3.19:1，低于 11px 文本所需的 4.5:1 | 回到 `--text-secondary`，实测 dark **7.09** / light **5.57** |
| **P1** | `.titlebar__context`（`App.tsx` + `global.css`） | **违反 AGENTS.md**：标题栏同时渲染项目与分支，而 `SessionBar` 已用可操作的项目菜单与 `BranchMenu` 承载同一信息——"两处同一个事实"正是仓库明令禁止的 | 删除标题栏的重复块与其 CSS（含窄窗容器查询里的隐藏规则），标题栏只留会话名与应用动作；实测 `duplicated: false` |
| **P1** | `.session-bar` / `.session-bar__item` | `--text-faint`（=`--text-tertiary`）11px，实测 dark 3.7:1 / light 3.2:1，低于 4.5:1 | 改 `--text-secondary`，实测 dark **7.09** / light **5.57** |
| **P1** | `.app-rail__stop` 的 `color: #fff` / `color-mix(..., #000)` | 全仓库仅剩的字面量颜色（SKILL.md 明令禁止）。更关键的是：`--status-danger` 在 dark 是**浅红** `#f87171`，白字在其上仅 **2.77:1**，连图标的 3:1 门槛都不过 | 新增 `--status-danger-ink` 并按主题取值（dark `#0b0d11` 7.03:1，light `#ffffff` 4.83:1）；实测两主题均过 3:1。这是"一个 token 值无法同时服务两主题"的实例 |
| P2 | `Composer.tsx` | `SlashMatch` 接口重复声明两次 | 合并并补注释 |
| P2 | `ui-polish.css` `.modal` | 浮层没有自己的圆角，靠继承 | 显式 `--r-lg` + 单层 `--shadow-md` |
| P2 | `.composer__queue` | 用 `--r-xl`(18) 与 Composer 的 20 抢同一层 | 改 `--composer-radius`，排队区与盒子同一外廓 |

### 11.3 明暗双主题的陷阱（本次最大教训）

`--surface-raised` 与 `--surface-overlay` 在 **light 主题下都是 `#ffffff`，与 `--surface-canvas` 完全相同**。
任何"抬高一档"的表面在 light 主题里等于隐形。本次踩到两次并都验证修复：

1. `.tool__body` 用 `--surface-raised` → light 下与画布同色，展开输出看不见。改 light 回落 `--surface-sunken`。
2. `.tool:hover` 用 `color-mix(--surface-raised)` → light 下白叠白，hover 无反馈。改语义 `--bg-hover`。

验证方式见 11.5 的 `toolBody.distinct`：实测 dark `rgb(13,15,19)` vs 画布 `rgb(22,24,29)`；light `rgb(242,242,242)` vs 画布 `rgb(255,255,255)`。

### 11.4 未做项与理由

- **侧栏版式未重构**：现状已符合第 3、7 节（侧栏是列表不是开关）。只做了 Token 与圆角对齐，没有改版式——按 SKILL.md 第 1 节"结构先于装饰"，没有结构问题就不动结构。
- **标题栏做了删减而非重构**：删掉与 `SessionBar` 重复的项目/分支块后，标题栏只剩会话名与应用动作，正是 AGENTS.md 要求的形态。
- **欢迎页仍不加大标题/建议列表**：`Welcome.tsx` 的极简是 AGENTS.md 的既有决定（只留 Composer）。本次只把它从"钉在底部"改为"居中偏上"，未新增内容。
- **`--ctl-sm`/`--ctl-md` 未再压缩**：Composer 的两个固定控件与 SessionBar 的高度受 AGENTS.md 契约约束，继续压缩会破坏 32px 命中目标。
- **字体渲染差异（P3-1）**：Windows ClearType 与 macOS 的差异无法在本机验证 macOS 侧。

### 11.5 验收证据

> **重要说明**：本次验收**没有依赖人眼看图**。运行环境中的图像读取对当前模型返回 "image omitted"，因此改用**真实 DOM 测量**作为主证据，截图作为留档。这比看截图更严格：断言的是可度量的数值。

测量脚本（`output/audit/`）：

| 脚本 | 作用 |
|---|---|
| `shots.mjs` | 10 个场景 × 明暗双主题截图（`before-S*` / `after-S*`） |
| `measure.js` + `measure.mjs` | 在真实渲染器内测：Token 值、正文列宽、工具行高、各层圆角、实际渲染字号是否在字阶上、对比度、工具展开体是否与画布可区分、横向溢出 |
| `responsive.js` + `responsive.mjs` | 1440/1280/1024/900 四档宽度下正文列宽与溢出 |
| `surface-audit.mjs` | 找出在某一主题下与画布同色的表面 token |
| `verify-pairs.py` | 逐对比较改前/改后的像素变化率与变化纵向范围 |
| `verify-baseline.py` | 证明 `before-*` 确实是改动前的基线（用 Composer 重心位置反推） |
| `danger-ink.mjs` | 按主题算出填充危险色上的正确字色 |
| `char-inventory.mjs` / `scan-encoding.mjs` | 编码完整性校验（见 11.6） |

实测结果（明暗两主题）：

| 判据 | dark | light |
|---|---|---|
| `--content-w` 正文列 | 720px | 720px |
| 工具行高 | 34px（全部 34，区间 34–34） | 34px |
| 圆角分层 | 外壳 `0 14 14 0` / 侧栏 `14 0 0 14` / 气泡 `14 14 6 14` / Composer `20` / 工具 `6` | 同左 |
| 字阶外的渲染字号 | **无**（`offScale: []`） | **无** |
| 工具摘要对比度 | 7.09:1 | 5.57:1 |
| 会话栏对比度 | 7.09:1 | 5.57:1 |
| 侧栏会话行对比度 | 16.89:1 | 14.62:1 |
| 正文对比度 | 16.13:1 | 15.52:1 |
| 停止按钮图标 / 底色 | 7.03:1 | 4.83:1 |
| 工具展开体 vs 画布 | 可区分 | 可区分 |
| 横向溢出 | 无 | 无 |

响应式（四档宽度）：正文列 720 / 720 / 719 / 595，**在 1280 与 1024 下没有为腾空间而压窄正文列**（符合第 1 节原则），全部无溢出。

截图对照的**有效性本身也做了验证**，而不是假设：

- `verify-pairs.py`：10 对改前/改后的像素变化率 2.5–12.2%，变化纵向覆盖 88–95% 画面高度——是整版重排，不是个别控件抖动。
- `verify-baseline.py`：欢迎页 Composer 的纵向重心由 0.723 → 0.634（dark）、0.745 → 0.627（light），与 `flex-end` → 居中 的改动方向一致，证明 `before-*` 确实是改动前的基线。
- 10 张 after 截图两两不同（SHA-256 校验）。**过程中发现 S7 原本与 S5 逐字节相同**：`.thread` 只有约 120px 溢出，25% 与 100% 都夹到同一位置，该场景实际没提供任何证据。已改为展开工具组并在组体内滚动（改用有 5600px 输出的会话），并加哈希校验防止再次发生。

代码门禁：`npm run build` 通过；`npm run typecheck` **0 error**；`npm test` **19/19 pass**。

### 11.6 编码事故与修复（必须记录）

实现过程中我用 `Get-Content -Raw` + `[IO.File]::WriteAllText` 做了一次换行符归一化。
PowerShell 5.1 的 `Get-Content` 对**无 BOM 的 UTF-8 文件按系统 ANSI 代码页（GBK）解码**，于是文件被二次编码：

- `—`(U+2014) → `鈥`(U+9225) + `?`，且**吞掉了后面的空格**（`— the` → `—the`）
- `·`(U+00B7) → `路`(U+8DEF)，这是待切换项目行上的**可见字符**

修复：用 Node 按码点还原（`output/audit/fix-encoding.mjs`、`fix-dash-space.mjs`），并以 `char-inventory.mjs` 对照 `HEAD` 校验：修复后非 ASCII 字符集合为 `—` ×7 + `·` ×1，与 HEAD 的 3 个 `—` + 1 个 `·` 相比**只多出我新增注释里的 4 个 `—`，没有字符丢失或多余**；3 条既有注释与 HEAD 逐字节相同。

后续规则：**不再用 PowerShell 的 `Get-Content`/`Set-Content` 处理本仓库的 UTF-8 源文件**，改用 `read`/`edit`/`write` 工具或 Node。

### 11.7 未验证项

- macOS 侧字体渲染与窗口装饰（本机为 Windows）。
- 真实鼠标 hover / focus-visible 的动画观感（只验证了样式值与 reduced-motion 规则存在，未逐帧核对 120–180ms 曲线）。
- 高 DPI（>1.5×）缩放下的像素对齐：截图在约 1.5× 下取得，未单独测 2×。
- 视觉"好看"的判断：本次以度量与规范一致性为准，未做主观审美评审。

# 开发文档

[返回项目首页](../README.md) · [使用指南](user-guide.md) · [贡献约定](../AGENTS.md)

## 环境与启动

需要 Node.js 22.19+、npm 和 Git。Pi 作为项目依赖安装，当前锁定为 1.4.0。

```bash
git clone https://github.com/facron2004/pi-desktop.git
cd pi-desktop
npm ci
npm run dev
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动 Electron 开发环境与热更新。 |
| `npm run typecheck` | 检查主进程、preload 与渲染器的 TypeScript 类型。 |
| `npm test` | 运行事件投影、运行状态、项目路径、Git 统计及差异折叠测试。 |
| `npm run build` | 生成生产构建到 `out/`。 |
| `npm run start` | 预览已构建的应用。 |
| `npm run dist` | 按 electron-builder 配置生成发布包到 `release/`。 |
| `npm run dist:dir` | 生成解包应用目录。 |
| `npm run icon` | 重新生成应用图标。 |

协议冒烟检查：

```bash
node scripts/rpc-smoke.mjs "C:/path/to/project"
node scripts/rpc-ui-smoke.mjs
```

`rpc-smoke` 会启动真实内置 CLI 并操作测试会话；运行前确认指定的工作目录。`rpc-ui-smoke` 通过临时扩展检查 select、confirm、input、editor 等 UI 往返。

`npm run test:e2e` 会发起真实模型任务并验证事件投影与停止流程，需要已有供应商认证，可能产生模型调用费用。

## 项目结构

```text
src/
├─ main/                    Electron 主进程、窗口、IPC、设置与会话索引
│  ├─ pi/                   CLI 定位、RPC 客户端与运行时
│  ├─ git.ts                分支、工作区、差异和提交操作
│  ├─ sessions.ts           会话读取、搜索与用量汇总
│  └─ screenshot.ts         显式启用的截图辅助入口
├─ preload/                 contextBridge，渲染器访问主进程的唯一入口
├─ shared/types.ts          共享协议及业务类型
└─ renderer/src/
   ├─ components/           会话、输入框、设置、工具面板和查看器
   ├─ lib/thread.ts         Pi 事件与历史会话的统一投影
   ├─ lib/tool-renderers.ts  工具类型与摘要
   ├─ store/useAppStore.ts   运行状态、会话切换和应用操作
   └─ styles/               CSS、主题和设计 Token
```

## Pi 协议与状态

Pi Desktop 通过子进程的 stdin/stdout 与 Pi RPC 通信，stderr 仅用于诊断。应用不重新实现 Pi agent。

- JSONL 只按 LF 换行符（U+000A）拆帧，不能使用 readline，因为 JSON 字符串允许包含 U+2028 和 U+2029。
- 请求通过 `id` 关联响应，不能依赖返回顺序。
- 会话由 [`lib/thread.ts`](../src/renderer/src/lib/thread.ts) 投影，实时事件和历史回放共用同一 reducer。
- 工具以 `toolCallId` 去重并保留首次出现的位置；partial result 是最新快照，不是增量。
- `agent_settled` 才表示本次运行落定，不能把 `agent_end` 当作工作结束。
- 扩展对话框必须使用 Pi 原始请求 id 回答，不能创建新 id。
- 在会话切换等操作前清空待绘制更新，防止内容写入另一会话。

新增 Pi 能力时先检查上游协议文档，依次补齐共享类型、IPC、preload、store 和必要的事件投影。完整约定见 [AGENTS.md](../AGENTS.md)。

## 渲染器与窗口

渲染器开启 `contextIsolation`，不启用 `nodeIntegration`。文件、Git、系统字体及其他本机操作必须经过类型化桥接，MCP 的凭证值不得进入渲染器。

窗口可能在 Pi 停止前销毁。发送事件使用 `sendToWindow`，访问窗口前检查 `isDestroyed()`；延迟保存等计时器也需要在关闭时清理。

## 样式与界面验证

使用普通 CSS 和 [`tokens.css`](../src/renderer/src/styles/tokens.css) 中的语义变量，保持明暗主题、字体缩放和窄窗口下的可用性。

修改会话或交互后，除类型与单元测试外，还应运行实际 Electron 界面。主进程提供由环境变量显式启用的截图入口：

```powershell
$env:PI_DESKTOP_SCREENSHOT = 'output/screenshot.png'
$env:PI_DESKTOP_USER_DATA = 'output/screenshot-profile'
$env:PI_DESKTOP_WORKSPACE = 'C:/path/to/project'
$env:PI_DESKTOP_THEME = 'light'
npm run build
npx electron .
```

使用独立 `PI_DESKTOP_USER_DATA` 保护日常配置。协议或会话验证还应指定独立的 `PI_CODING_AGENT_SESSION_DIR`。全部截图参数见 [AGENTS.md 的 Screenshot harness](../AGENTS.md#screenshot-harness)。

## 提交与发布

提交前运行 `npm run typecheck`、相关测试和 `git diff --check`。对界面与打包改动，应同时保存实际运行证据。

发布时同步 `package.json` 与 `package-lock.json` 的版本，更新 [`CHANGELOG.md`](../CHANGELOG.md) 和版本说明。构建后的 EXE、ZIP 与校验文件通过 GitHub Release 分发，不提交到 Git。

发布包应在独立配置与会话目录中实际启动，检查应用版本、内置 Pi、关键页面与正常退出，并核对包中构建文件。ARM64 构建成功与在 ARM64 设备实际运行是不同的验证范围，发布说明应分别记录。

# Helix

Helix 是一个 **AI 编码助手桌面应用**——基于 Tauri（Rust 后端）+ React/TypeScript 前端的 Electron 壳层重写版。它把 pi 编码智能体（`@earendil-works/pi-coding-agent`）作为底层引擎，提供对话式编程、代码编辑、文件/git 操作、终端、MCP 工具接入、计划与后台任务等一整套桌面开发体验。

## 功能

- **AI 对话与代码生成**：对话面板驱动 pi 智能体读写代码、执行命令、跑工具。
- **多会话 / serve 网关双模**：渲染层直连 `helix serve` 的 WS JSON-RPC + REST 网关，与旧的 ACP IPC 桥保持同形接口；每个会话独立 pi 子进程，多对话并行不互相干扰。
- **代码编辑器 + Diff**：内置 CodeMirror，支持变更预览、文件树、diff 侧栏。
- **Git 集成**：分支切换、状态、提交历史，命令走 `execFile` 防注入。
- **交互式终端**：PTY 终端，SSH 连接管理。
- **MCP**：读写 pi 智能体的 MCP 服务器配置（`~/.pi/agent` 下 `mcp_servers` 块 + `mcp.json` 镜像），本地/远程 server。
- **计划 / 定时任务**：`~/.pi/agent/pi-cron` 共享 cron jobs，前端计划面板同步；支持 cron / once 调度。
- **后台任务**：长任务（构建、爬虫等）detached 运行，注册表跨 pi 会话共享，前端「后台任务」面板可查 / 可停。
- **记忆 / 技能 / 子代理 / 委派**：MEMORY.md / USER.md 记忆、文件式 SKILL.md、pi-subagents 自定义 agent、子代理转录回放。
- **HTTP 代理**：模型、MCP、工具命令与应用出口流量统一走代理。
- **视觉 / 图像模型**：可选接入视觉与文生图模型。

## 技术栈

- **前端**：React 19、TypeScript、Vite、Tailwind CSS 4、Zustand、CodeMirror、xterm、shiki、KaTeX
- **后端**：Rust（Tauri 2）、tokio、reqwest、tauri-plugin-*
- **智能体引擎**：pi（外部 npm 包 `@earendil-works/pi-coding-agent`，多实例 stdio 适配器 `pi --mode rpc`）

## 目录结构

```
├── src/                  前端（React/TS）
│   ├── app/              应用入口
│   ├── components/       UI 组件（Helix 面板、设置、编辑器等）
│   ├── hooks/            React hooks
│   ├── lib/              逻辑库（serve-gateway、tauri-bridge、mcp、persist…）
│   ├── stores/           Zustand store（helix-store + 按域拆分 slices）
│   └── types/            共享类型
├── src-tauri/            Rust 后端
│   ├── src/              Tauri commands（gateway、git、terminal、ssh、mcp、
│   │                     scheduled_tasks、background_tasks、memory、subagents…）
│   ├── capabilities/     Tauri 权限声明
│   └── resources/        内嵌资源
└── .github/workflows/    CI（build-windows.yml）
```

## 开发

```bash
# 安装依赖
npm install
cd src-tauri && cargo build   # 或按需

# 前端 dev（Vite）
npm run dev

# Tauri 全栈 dev（前端 + Rust 热重载）
npm run tauri:dev

# 构建
npm run build          # tsc + vite build
npm run tauri:build    # 打 Tauri 安装包
```

校验脚本：

```bash
npm run lint           # eslint
npm run lint:fix       # eslint --fix
npx tsc --noEmit       # 前端类型检查
cargo check            # 在 src-tauri/ 下跑 Rust 编译
```

## 构建产物

`npm run tauri:build` 生成桌面安装包（Windows 走 `.github/workflows/build-windows.yml` 的 CI 流水线）。

## 说明

- 智能体是**外部依赖**，Helix 通过 `~/.pi/agent` 下 pi 的配置 / 扩展接入（models、auth、MCP、定时任务、子代理、后台任务注册表等）。
- `serve` 模式下每个会话对应一个独立 pi 子进程；配置 / 模型变更经 `helix serve` 网关 live 生效，必要时 respawn。

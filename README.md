# Helix

**Helix** 是一个 AI 编码助手桌面应用：Tauri 2（Rust 后端）+ React 19 / TypeScript / Vite 前端。它把 **Pi 编码智能体**（`@earendil-works/pi-coding-agent`）作为底层引擎，把对话、文件编辑、Git、终端、SSH、MCP、计划任务、后台任务、记忆 / 技能 / 子代理等能力整合到一个桌面工作台里。

> Helix 本身不内置模型推理 —— 智能体能力来自外部的 Pi 运行时与其配置（模型、API key、MCP 等）。

```
┌──────────────────────────────  Helix 桌面应用  ──────────────────────────────┐
│  React 19 UI（对话 / 编辑器 / Diff / 文件树 / Git / 终端 / 设置 / 任务…）        │
│  ─────────────────────────────────────────────────────────────────────────  │
│  前端桥：window.electron（ACP 风格） ── tauri-bridge.ts ── Tauri invoke/事件   │
│  ─────────────────────────────────────────────────────────────────────────  │
│  Rust 后端：Tauri 2（fs / git / terminal(ConPTY) / ssh / mcp / cron / …）     │
│  ─────────────────────────────────────────────────────────────────────────  │
│  pi_gateway：为每个会话 spawn 独立 `pi --mode rpc` 子进程（JSONL stdio）       │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 前端入口：`src/main.tsx` → 安装 Tauri 桥，默认懒加载 `src/components/Helix/helix-layout.tsx`。
- Rust 入口：`src-tauri/src/main.rs` → `helix_lib::run()`（建窗、安装 Tauri 插件、启动 Pi RPC 网关、轮询计划任务、注册全部 `invoke` 命令）。

---

## 功能

- **AI 对话与代码生成**：左侧对话面板驱动 Pi 智能体读代码、写文件、跑命令、执行工具；右侧可接 Diff、代码编辑器（CodeMirror）、文件树。
- **多会话 Pi 实例**：`src-tauri/src/pi_gateway.rs` 为每个对话维护独立 `pi --mode rpc` 子进程；无会话上下文的全局 RPC 走主实例。支持空闲回收、热备实例、会话恢复与 context 超窗裁剪（`trim_session_if_oversized`）。
- **会话协议适配**：前端保留 `window.electron.helix` 的 ACP 风格接口；`src/lib/tauri-bridge.ts` 把它映射到 Tauri `invoke` / 事件，`src/lib/serve-gateway.ts` 为 `helix serve` 的 WS 网关提供同形适配（现有调用点零逻辑改动）。
- **文件与 Git**：Tauri 命令提供读 / 写 / 编辑 / 重命名 / 删除 / 扫描目录；Git 支持 status、diff、stage、commit、分支、worktree、push/pull/fetch，全部通过 `execFile` 参数数组执行（无 shell，防命令注入）。
- **交互式终端与 SSH**：`src-tauri/src/terminal.rs` 在 Windows 上使用 ConPTY；`ssh.rs` 提供连接、执行、状态与断开。
- **MCP 配置**：读写 Pi 的 MCP server 配置（`~/.pi/agent` 下 `mcp_servers` 块和 `mcp.json` 镜像），支持本地 / 远程 server 配置编辑。
- **计划 / 定时任务**：`scheduled_tasks.rs` 管理 `~/.pi/agent/pi-cron` 的共享 cron jobs；前端计划面板支持列表、创建、删除、立即运行。
- **后台任务**：`background_tasks.rs` 暴露跨 Pi 会话共享的 detached 任务注册表（`~/.pi/agent/tasks.json`），前端可查看输出、终止任务。
- **记忆 / 技能 / 子代理**：读写 `MEMORY.md` / `USER.md`、`SKILL.md` 文件式技能、Pi subagents 配置，并提供子代理转录回放与 delegation 查看。
- **视觉 / 图像模型**：`vision.rs` 读取 `config.yaml` 的 `vision:` 块；粘贴图片时，`pi_gateway.rs` 会先调用视觉模型把图片转成文字描述拼进 prompt，同时仍把图片透传给支持多模态的 Pi 模型。
- **嵌入式侧边栏浏览器**：`page_fetch.rs` 抓取静态 HTML（srcdoc 同源 iframe），配合 `helix::open_browser_url` 等命令做页面读取、点击、填表；外链则开独立 `WebviewWindow`。
- **代理**：`proxy.rs` 为应用出口流量、渲染层、模型 / MCP 请求统一设置 HTTP 代理（跨 WebKitGTK / WebView2 / WKWebView）。

---

## 技术栈

- **前端**：React 19、TypeScript、Vite（端口 1430）、Tailwind CSS 4、Zustand（slices 分域）、CodeMirror、xterm、shiki、KaTeX、React Markdown、lucide-react、Radix UI。
- **后端**：Rust、Tauri 2、tokio、reqwest（rustls）、serde + serde_yaml、`tauri-plugin-opener / dialog / single-instance`；Windows 下 `windows` 0.61（ConPTY），Linux 下 `webkit2gtk`（渲染层代理）。
- **智能体引擎**：外部 Pi 编码智能体（`@earendil-works/pi-coding-agent`），以 `pi --mode rpc` 的 JSONL stdio 协议运行。
- **UI 基础**：shadcn/ui 风格组件（`components.json`：`new-york`、lucide、Tailwind CSS 变量）。

---

## 目录结构

```text
.
├── index.html                     # Vite 入口 HTML（防闪烁主题自举）
├── package.json                  # 前端脚本与依赖
├── vite.config.ts                # Vite dev/build（固定端口 1430、no-store 缓存头）
├── tsconfig.json                 # 前端 TS 配置（ES2021、bundler、@ → src）
├── components.json               # shadcn/ui 配置
├── src/
│   ├── main.tsx                  # 前端入口：installTauriBridge() + 懒加载 HelixLayout
│   ├── env-shim.ts               # 非 Tauri / 浏览器环境的 window shim
│   ├── app/                      # 全局样式（globals.css、keyframes、Tailwind 主题）
│   ├── components/
│   │   ├── Helix/                # 主面板、编辑器、Git、终端、设置、任务、技能、代理等
│   │   └── ui/                   # 基础 UI 组件（shadcn 风格）
│   ├── hooks/                    # React hooks（use-check-update / use-git-change-stat）
│   ├── lib/                      # Tauri/serve 桥接、持久化、MCP、工具展示等
│   ├── stores/                   # Zustand store + 分域 slices（agent/git/panel/terminal…）
│   └── types/                    # 共享类型（electron.d.ts：IPC 桥契约）
├── src-tauri/
│   ├── src/                      # Rust 后端命令与 Pi RPC 网关
│   ├── capabilities/            # Tauri capability 声明（default.json）
│   ├── tests/                   # Rust 集成测试（trim_session）
│   └── tauri.conf.json          # Tauri 应用配置
└── .github/workflows/
    └── build-windows.yml        # Windows tag 构建与发布流水线
```

### Rust 后端模块一览（`src-tauri/src/`）

| 模块 | 职责 |
| --- | --- |
| `main.rs` | 二进制入口（Linux 软件渲染自举）→ `helix_lib::run()` |
| `lib.rs` | 建窗、装 Tauri 插件、系统托盘、`invoke_handler` 注册全部命令 |
| `pi_gateway.rs` | 多实例 `pi --mode rpc` 适配器（spawn / 回收 / 裁剪 / 子代理映射） |
| `gateway.rs` | 子进程生命周期辅助 |
| `helix.rs` | `helix:*` 协议面（对话 / 配置 / 模型 / 记忆 / 个性化 / 插件 / Pi 包管理） |
| `fs.rs` | 路径校验的文件操作（读 / 写 / 编辑 / 重命名 / 删除 / 扫描） |
| `git.rs` | Git 全量命令（execFile 参数数组） |
| `terminal.rs` | ConPTY 交互式终端（Windows） |
| `ssh.rs` | 系统 SSH 客户端的会话管理 |
| `mcp.rs` | `config.yaml` 的 `mcp_servers` 块读写 |
| `scheduled_tasks.rs` | `~/.pi/agent/pi-cron` 共享 cron + 事件轮询 |
| `background_tasks.rs` | detached 任务注册表读写 |
| `memory.rs` | `MEMORY.md` / `USER.md` 同步 |
| `skills.rs` | `SKILL.md` 技能目录与子代理开关 |
| `subagents.rs` | `config.yaml` 的 `subagents:` 块读写（镜像到扩展 settings.json） |
| `delegations.rs` | 子代理委派转录 / 时间线回放 |
| `vision.rs` / `image_model.rs` | 视觉 / 图像模型配置与调用 |
| `hooks.rs` | `config.yaml` 的 `hooks:` 块读写 |
| `proxy.rs` | 跨平台 HTTP 代理（模型 / MCP / 渲染层） |
| `profile.rs` | 模型 profile 缓存与激活 |
| `security.rs` | AES-GCM 机器密钥加解密、shell / 文件对话框 |
| `page_fetch.rs` | 页面抓取（嵌入式浏览器） |
| `app.rs` | work dir / data root 持久化与切换、doctor / update |
| `config.rs` | Pi 的 settings / models 文件读写 |
| `paths.rs` | 数据目录解析与 `~/.helix → ~/.pi/agent/helix` 迁移 |
| `state.rs` | `AppState` + 全局 `APP_HANDLE` / `APP_STATE` |
| `window.rs` | 窗口 / 拖拽命令 |

---

## 开发与构建

### 前置条件

- Node.js 20
- Rust 工具链（`stable`，MSRV 1.77）
- Tauri 系统依赖（Linux 需要 WebKitGTK 等）
- 本地可用的 Pi 智能体环境与配置（模型、API key、MCP 等放在 Pi 数据目录；Pi CLI 路径可通过 `config.yaml` 的 `pi.cli_path` 或 `HELIX_PI_CLI` 环境变量指定）

### 常用命令

```bash
npm install

# 前端 dev server（Vite，固定端口 1430）
npm run dev

# Tauri 全栈 dev（自动执行 beforeDevCommand，并热重载 Rust/前端）
npm run tauri:dev

# 前端构建
npm run build

# 打 Tauri 安装包
npm run tauri:build
```

### 校验

```bash
npm run lint            # ESLint
npm run lint:fix        # 自动修复
npx tsc --noEmit        # 前端类型检查
cd src-tauri && cargo check
cd src-tauri && cargo test
```

`src-tauri/tests/trim_session.rs` 包含 Pi 会话裁剪的集成测试：优先使用合成数据，若本机存在对应 `~/.pi/agent/sessions` 文件则还会做真实数据交叉校验。

---

## CI

`.github/workflows/build-windows.yml` 在 `v*` tag 或手动触发时运行：

1. 安装 Node 20 与 Rust stable；
2. `npm ci`；
3. 按 tag 同步版本号到 `Cargo.toml` 与 `tauri.conf.json`；
4. `npx tauri build` 产出 MSI / NSIS EXE；
5. 上传工件并自动创建 GitHub Release。

---

## 配置与数据目录

- **运行时数据**：默认在 `~/.pi/agent` 下（路径由 `src-tauri/src/paths.rs` 决定）；旧的 `~/.helix` 会在启动时自动迁移到 `~/.pi/agent/helix`。
- **非模型类配置**（视觉模型、MCP、hooks、subagents、代理等）集中在 `config.yaml`；模型 / provider 的 settings / models 文件由 `config.rs` 直接读写 Pi 目录。
- **计划任务** 共享于 `~/.pi/agent/pi-cron`；**后台任务** 注册表由 Pi 扩展共享于 `~/.pi/agent/tasks.json`。
- **工作目录 / 数据根**：应用支持切换，见 `app.rs` 的 `sync_work_dir` / `set_work_dir` / `get_data_root` / `set_data_root`。
- **Pi CLI 解析优先级**（`pi_gateway.rs`）：`HELIX_PI_CLI`（dev 逃生舱）→ `config.yaml` 的 `pi.cli_path` → 全局 npm 安装 → PATH 下的 shim。

---

## 说明

- Helix 由 Electron shell 重写为 Tauri 2；部分后端模块头部注释保留了「Port of `electron/ipc/...`」的来源说明。
- 前端沿用历史 Electron 桥命名（`window.electron`），在 Tauri 运行时由 `installTauriBridge()` 模拟为 Tauri IPC 接口，业务调用点无需改造。
- `serve` 模式下，每个会话可映射到独立 Pi 子进程；配置变更通过网关 live 生效或 respawn。

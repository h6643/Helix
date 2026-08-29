# Helix

> 本地优先的桌面 AI Agent 工作台 —— 把对话、代码、终端与 Agent 执行流收拢在一个轻量原生窗口里。

Helix 是一个基于 **Tauri v2 + React + TypeScript** 构建的桌面应用，内置 **hermes-agent**（经定制化的 AI Agent 引擎，作为 Git 子模块集成）作为后端运行时。你可以在本地与模型对话、让 Agent 读写文件 / 执行命令 / 检索网页，并通过「审批模式」控制 Agent 的自主程度。

- 当前版本：`0.1.17`
- 应用标识：`com.helix.desktop`
- 仓库：`https://github.com/h6643/Helix`（默认分支 `hd`）

---

## 主要特性

- **对话式 Agent 工作台**：流式输出、Markdown 渲染（含数学公式 KaTeX / 代码高亮）、消息复制与「分叉对话」。
- **审批模式（Approval Modes）**：按信任程度切换 Agent 的自主级别，无需改代码：
  - `请求批准` —— 所有操作均请求批准（含文件写入与命令执行）
  - `替我审批` —— 仅对检测到的风险操作请求批准
  - `完全访问权限` —— 可不受限制地访问互联网和本机文件
  - `制定计划` —— 先规划方案，批准后才动手执行
- **思考过程可视化**：Agent 的「思考 / 推理 / 工具调用」被折叠为「思考过程 / 已结束」卡片，默认收起；连续的推理与工具执行分段呈现，正文（总结）与思考段落交替展示，点开才看细节。
- **模型与 API 配置**：内置 API 设置面板，支持自定义 `baseUrl` + `apiKey`，并提供 DeepSeek 模型快捷切换；历史配置按 `baseUrl+apiKey` 去重并按网关分组。
- **网页搜索**：可选接入 Tavily / Exa / Brave / DuckDuckGo 等搜索引擎（API Key 持久化到本地 `.env`），让 Agent 具备联网检索能力。
- **会话历史**：左侧历史对话分页加载（每页 10 条），并支持会话内消息定位（history-strip）。
- **代码与文件工作区**：内置文件树、代码编辑器、Diff 预览，Agent 的文件改动可在合并前逐项审阅。
- **终端与后台任务**：集成 xterm 终端与后台任务面板，Agent 的命令执行实时可见。
- **MCP 与记忆**：支持 MCP 工具接入与记忆（memory）管理，扩展 Agent 能力边界。
- **看板 / 委托 / 活动流 / 学习视图**：提供 Kanban 面板、Delegations、Activity Feed、Learning View 等协作与可观测性面板。
- **外观自定义**：多套暗色主题（Rosé Pine、Notion 暗橙、咖啡、墨绿等），可微调正文字号，整体偏紧凑极简。

---

## 技术架构

| 层 | 技术 |
|---|---|
| 前端 | React 19 + TypeScript + Tailwind CSS + Zustand（状态管理） |
| 桌面壳 | Tauri v2（Rust），跨 Windows / Linux / macOS |
| Agent 引擎 | hermes-agent（Python，Git 子模块 `hermes-agent/`，通过 ACP 协议与前端通信） |
| 运行时 | 打包时由 `scripts/prepare-runtime.sh` 拉取 python-build-standalone，构建隔离 venv 并 `pip install` hermes-agent |

数据默认存放在本机：`%LOCALAPPDATA%\hermes\`（配置 `config.yaml`、密钥 `.env`、运行时数据库与记忆等），**不强制上云**。

---

## 环境要求

- **Node.js** 18+（推荐 20+）
- **Rust** 稳定版工具链（用于编译 Tauri 后端）
- **Git**（需支持子模块）
- **Windows 额外依赖**：Microsoft C++ 生成工具（MSVC）+ WebView2；`prepare-runtime.sh` 需用 **Git Bash** 运行
- **Linux 额外依赖**：`webkit2gtk`、`librsvg`、`patchelf` 等 Tauri v2 系统库

---

## 安装与运行

### 1. 克隆仓库（含子模块）

```bash
git clone --recurse-submodules git@github.com:h6643/Helix.git
cd Helix
```

若已克隆但子模块为空，补拉：

```bash
git submodule update --init --recursive
```

### 2. 安装前端依赖

```bash
npm install
# 或 pnpm install
```

### 3. 准备 hermes 运行时

该步骤会下载 Python 独立解释器、构建隔离 venv 并把 hermes-agent 安装进去（产物落在 `src-tauri/resources/hermes-runtime/`，已被 `.gitignore` 忽略，不参与版本管理）：

```bash
# Windows 请在 Git Bash 中执行
bash scripts/prepare-runtime.sh
```

> 脚本幂等：若运行时已存在则跳过下载与构建；删除该目录可强制重建。

### 4. 开发模式（热重载）

```bash
npm run tauri:dev
```

这会同时启动 Vite 开发服务器与 Tauri 窗口，前端改动实时生效。

### 5. 打包发行

```bash
npm run tauri:build
```

产物（安装包 / 可执行文件）位于 `src-tauri/target/release/` 或对应打包输出目录。

---

## 使用指南

1. **配置 API**：打开设置 → API，填入你的模型网关 `baseUrl` 与 `apiKey`，选择模型（或一键切换 DeepSeek）。保存后即在本地持久化。
2. **（可选）配置网页搜索**：设置 → 网页搜索，选择引擎并填入对应 API Key；重启后 Key 仍会保留。
3. **选择审批模式**：在输入框附近的模式下拉中，按你对本次任务的信任程度选择「请求批准 / 替我审批 / 完全访问权限 / 制定计划」。
4. **开始对话**：输入需求，Agent 会流式返回；过程中生成的「思考过程」默认折叠，点开可查看推理与工具调用细节，正文（总结）与思考段落交替呈现。
5. **审阅改动**：Agent 产生的文件改动会以 Diff 预览展示，可在审批弹窗中逐项允许 / 拒绝。
6. **历史与分叉**：左侧查看历史会话（分页），对任一轮助手消息可「分叉对话」另开分支继续探索。

---

## 项目结构（简览）

```
Helix/
├── src/                  # 前端（React + TS）
│   ├── components/Helix/ # 各 UI 面板（对话、设置、看板、终端等）
│   ├── stores/           # Zustand 状态
│   ├── lib/              # 工具与格式化
│   └── app/              # 应用入口与全局样式
├── src-tauri/            # Rust 后端（Tauri v2）
│   ├── resources/hermes-runtime/  # 构建产物（gitignore，不入库）
│   └── src/              # Rust 逻辑（kernel / config / web_search ...）
├── hermes-agent/         # Git 子模块：AI Agent 引擎（Python）
├── scripts/
│   └── prepare-runtime.sh# 构建 hermes 运行时
└── package.json / tauri.conf.json
```

---

## 常见问题

- **网页搜索 Key 重启后丢失？** 已修复：启动时的 `.env` 同步逻辑现在会保留 `TAVILY/EXA/BRAVE_SEARCH_API_KEY`，不再被误清。
- **运行时目录 `hermes-runtime` 看不到？** 它是构建产物、被 `.gitignore` 忽略，需先执行 `prepare-runtime.sh` 才会生成。
- **只想改 hermes-agent 源码即时生效？** 可在运行时 venv 内对该子模块执行 editable 安装（`pip install -e <hermes-agent 路径> --no-deps`），无需重建运行时。

---

## 许可

详见仓库根目录许可证文件。Helix 前端以本项目许可证发布；内置的 hermes-agent 引擎遵循其自身（上游 / fork）许可证。

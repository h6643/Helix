# Helix 工作区改动差异报告（2026-07-29 快照）

> 基准：git HEAD（`36f4ae3` 删除多余功能）。状态：全部为未提交改动。
> 总览：**33 个文件改动（+5224 / −2641 行）** + 一批未跟踪文件。
> 本文档在「回退 Tauri 移植线」与「清理 IPC 残留」**之前**生成，作为 review 基线。

## 一、改动分类总览

| 分类 | 性质 | 文件数 | 说明 |
|---|---|---|---|
| A. serve 网关迁移（主线） | 本轮核心 | ~12 | 让 Hermes 走 `hermes serve` 网关而非 ACP/IPC |
| B. 渲染层门面化 | 配套机械替换 | ~12 | `window.electron.hermes` → `hermesApi()` |
| C. Tauri 移植线 | 并行独立线 | 6 | 把 Helix 移植到 Tauri，与 serve 无依赖 |
| D. hermes-ui API 重构 | 独立 | 4 | DeltaQueue / 审批 API / 模型预设 |
| E. 小改 | 独立 | 3 | fs 放行、typography 插件、format 工具 |
| F. 未跟踪新增 | 混合 | 9 | serve 探针、Tauri 文件、设置面板等 |

## 二、A. serve 网关迁移（与原 acp 版的本质差异）

| 文件 | 增/删 | 关键内容 |
|---|---|---|
| `src/lib/serve-gateway.ts` | **新增 ~484** | ACP↔serve WS/REST 协议适配器，UI 零改；`setModel` 走 IPC 规避 CORS |
| `electron/main.js` | +185 | serve 模式启动、动态端口跟随、`restartGatewayDebounced` 在 serve 模式短路 |
| `src/lib/config-sync.ts` | +160 | 按 `getGatewayMode()` 分流，serve 走 REST 不落 IPC |
| `src/lib/electron-bridge.ts` | +62 | Proxy 不变量修复（空对象 target + 闭包）；`hermesApi()` 门面 |
| `src/stores/helix-store.ts` | +67 | 默认 `apiConfig` → ant-ling |
| `src/hooks/use-hermes.ts` | +56 | 模式感知调用 |
| `src/stores/hermes-store.ts` | +44 | 模式感知 |
| `electron/ipc/security.js` | +12 | 死端点守卫（apihub/stepfun）、`APIHUB_DEFAULT→ant-ling` |
| `electron/preload.js` | +12 | 暴露 `hermes.setModel` IPC |
| `src/stores/slices/api-config-slice.ts` | +16 | 默认 ant-ling |
| `src/stores/helix-types.ts` | +4 | 类型 |
| `src/types/electron.d.ts` | +6 | 类型 |

## 三、B. 渲染层门面化（机械替换，无逻辑变化）

`window.electron.hermes` 直摸改为 `hermesApi()`，便于桥层按模式分流：

- `src/components/Helix/agent-flow-panel.tsx` (+347)
- `src/components/Helix/api-settings.tsx` (+557)
- `src/components/Helix/approval-dialog.tsx` (+366)
- `src/components/Helix/context-usage.tsx` (+258)
- `src/components/Helix/inline-tool-group.tsx` (+330)
- `src/components/Helix/helix-layout.tsx` (+79)
- `src/components/Helix/customize-panel.tsx` (+16)
- `src/components/Helix/scheduled-tasks-panel.tsx` (+3)
- `src/components/Helix/settings-content-new.tsx` (+9)
- `src/lib/scheduled-task-runner.ts` (+3)
- `src/lib/tool-display-utils.tsx` (+16)
- `src/stores/slices/agent-settings-slice.ts` (+106)

> 注：其中 `api-settings.tsx` / `approval-dialog.tsx` / `agent-flow-panel.tsx` / `inline-tool-group.tsx` 改动量较大，除门面替换外还可能含 UI 重构，serve 关键词占比极低（≤3 行），属非迁移本体。

## 四、C. Tauri 移植线（并行，与 serve 无依赖）

引用完全隔离，仅以下文件含 `tauri` 字样，**无任何 serve 主线代码引用**：

- `src/lib/tauri-bridge.ts`（新增，Tauri 命令 shim，注释 "phased migration to Rust backend"）
- `src/lib/shims/next-dynamic.tsx`（新增，Vite/Tauri 专用 `next/dynamic` 别名）
- `vite.config.ts`（新增，Tauri 构建入口）
- `index.html`（新增，引用不存在的 `/src/main-tauri.tsx`）
- `package.json`：+5 个 `@tauri-apps/*` 依赖 + `tauri`/`vite` 脚本
- `.gitignore`：+ Tauri 忽略
- `package-lock.json`：+4257（tauri 依赖树，回退后回缩）

## 五、D. hermes-ui API 层重构（独立）

- `src/hermes-ui/api-client.ts` (+653)：DeltaQueue、审批 API、模型预设（serve 关键词仅 1 行）
- `src/hermes-ui/use-chat.ts` (+158)
- `src/hermes-ui/types.ts` (+20)
- `src/hermes-ui/index.ts` (+7)

## 六、E. 小改

- `electron/ipc/fs.js` (+3)：放行 `hermes/memory` 目录（学习视图）
- `src/app/globals.css` (+1)：加 `@tailwindcss/typography`
- `src/lib/format.ts` (+28)：工具函数新增

## 七、F. 未跟踪新增文件

```
docs/                                  （serve-migration.md 等迁移文档）
index.html                             （Tauri 入口，见第四节）
scripts/test-serve-handshake.js        （serve 握手探针）
scripts/test-serve-prompt.js           （serve 会话 E2E 探针）
src/components/Helix/appearance-settings-panel.tsx   （新增设置面板）
src/components/Helix/general-settings-panel.tsx
src/components/Helix/git-settings-panel.tsx
src/lib/serve-gateway.ts               （serve 核心适配器，见第二节）
src/lib/shims/                         （Tauri 专用，见第四节）
src/lib/tauri-bridge.ts                （Tauri shim，见第四节）
vite.config.ts                         （Tauri 构建，见第四节）
```

## 八、未 git 跟踪的本机运行配置（用户目录，不在仓库）

这些不进 git，是「现网」生效状态：

- `C:\Users\hyt\AppData\Local\hermes\config.yaml` → ant-ling
- `C:\Users\hyt\AppData\Local\hermes\.env` → `OPENAI_BASE_URL=https://api.ant-ling.com/v1`
- `C:\Users\hyt\AppData\Roaming\helix\active-profile.json` → ant-ling

## 九、回退/清理计划（后续执行）

1. **回退 Tauri 线（任务 B）**：删除 `tauri-bridge.ts` / `shims/` / `vite.config.ts` / `index.html`，移除 `package.json` 的 `@tauri-apps/*` 依赖与 `tauri`/`vite` 脚本、`.gitignore` 的 Tauri 忽略。
2. **清理 IPC 残留（任务 C / 原任务65）**：彻底删除旧 ACP IPC 转发层与 `pushModelConfig` 直写残留，使 serve 模式完全脱离原 acp 链路；删后保证 `tsc --noEmit` 通过。

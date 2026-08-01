# Helix → hermes serve 网关迁移蓝图

> 生成于 2026-07-28，基于本地 hermes-agent 0.18.2 源码全扫（两个 Explore 代理 + 阶段0实测）。
> 迁移策略：渐进双链路（serve 与 acp 并存，开关切换，随时回退）；最终渲染层直连 HTTP/WS，去掉 IPC 中转。

## 阶段0 实测结论（已验证）

- `hermes serve --host 127.0.0.1 --port 0` 可正常启动（Python 冷启动约 40-60s 首次，端口实测 60185）。
- 本地 loopback 模式 `auth_required=false`，REST 无 token 也返回 200。
- WS 仍需 `?token=<_SESSION_TOKEN>`（loopback 模式常量时间比对）。
- OpenAPI 共 229 条 REST 路由（`curl http://127.0.0.1:<port>/openapi.json`）。
- REST 里**没有**发消息端点——聊天主流程全部走 WS `/api/ws`。

## 1. 启动与握手（官方桌面版做法）

- 命令：`hermes [--profile <p>] serve --host 127.0.0.1 --port 0`
  （参考 `apps/desktop/electron/backend-command.ts:20-24`）
- 关键 env：
  - `HERMES_SERVE_HEADLESS=1` — 禁 SPA 只留 API/WS（`web_server.py:15742`）
  - `HERMES_DASHBOARD_SESSION_TOKEN=<token>` — 固定 session token（否则随机）
- 握手行（stdout）：`HERMES_BACKEND_READY port=<N>`
  解析正则：`/^HERMES_(?:BACKEND|DASHBOARD)_READY port=(\d+)/m`（`backend-ready.ts:6`）
  超时默认 90s（慢 AV 下限 45s）；子进程提前退出/超时 → reject → respawn。

## 2. WebSocket 协议

- 端点：`ws://127.0.0.1:<port>/api/ws?token=<SESSION_TOKEN>`（`web_server.py:15610`）
- 连接后服务端立即推 hello：
  `{"jsonrpc":"2.0","method":"event","params":{"type":"gateway.ready","payload":{"skin":...}}}`
- 封包（每条 WS 文本消息 = 一个 JSON 对象）：
  - 请求：`{"jsonrpc":"2.0","id":<str|num>,"method":<str>,"params":<obj>}`
  - 响应：`{"jsonrpc":"2.0","id":<id>,"result":<any>}` 或 `{...,"error":{"message":<str>}}`
  - 事件：`{"jsonrpc":"2.0","method":"event","params":{"type":<事件名>,"session_id"?,"payload"?}}`
- 高频帧 `message.delta`/`reasoning.delta`/`thinking.delta` 服务端批量合并（`tui_gateway/ws.py:53-60`）。

## 3. WS RPC 方法集（`server.py` `@method` 分发表）

核心：`session.create/list/resume/close/interrupt/steer/branch/compress`、
`prompt.submit {session_id,text}`、`prompt.background`、`approval.respond {choice,session_id}`、
`clarify.respond`、`sudo.respond {password,request_id}`、`secret.respond {request_id,value}`、
`config.set/get`、`model.options/save_key/disconnect`、`slash.exec`、`shell.exec`、`cli.exec`、
`command.dispatch`、`reload.mcp`、`tools.list`、`skills.manage`、`subagent.interrupt`。

## 4. 服务端推送事件全集

| 事件 | payload |
|---|---|
| `gateway.ready` | `{skin}` |
| `session.info` | 会话元数据 |
| `message.start` → `message.delta {text}` → `message.complete {text,rendered?,usage?}` | 流式回复 |
| `thinking.delta {text}` / `reasoning.delta {text}` / `reasoning.available {text,verbose?}` | 思考流 |
| `status.update {kind,text}` | 状态（kind=lifecycle→compacting） |
| `tool.start {tool_id,name,args,context,args_text?}` | 工具开始 |
| `tool.progress` / `tool.generating {name}` | 工具进行中 |
| `tool.complete {tool_id,name,args,duration_s?,result,summary?,result_text?,todos?,inline_diff?}` | 工具结束 |
| `approval.request`（command 已脱敏）/ `clarify.request` / `sudo.request` / `secret.request` | 审批类 |
| `error {message}` | 错误 |
| 其他 | `reaction` `moa.*` `session.title` `skin.changed` `subagent.*` `terminal.close` 等 |

## 5. 聊天主流程

发送：`prompt.submit {session_id,text}` → `message.start` → N×`message.delta`/`reasoning.delta`
→ `tool.start`→`tool.complete`（循环）→ `message.complete`。
中断：`session.interrupt`。审批：收 `approval.request` → 发 `approval.respond {choice,session_id}`。

## 6. 模型配置

- 走 REST：`POST /api/model/set`，body = `{scope:'main'|'auxiliary',provider,model,task?,base_url?,api_key?,confirm_expensive_model?}`
- 后端落 `~/.hermes/config.yaml` 的 `model` 块（不是 state.db；state.db 只存会话转录）。
- **只影响新会话**；运行中会话热切换用会话内 `/model` slash。
- → 可整体替代 Helix 的 pushModelConfig 直写 config.yaml + 三真相源问题（stepfun 复活 bug 根治点）。

## 7. Helix 现有调用点盘点（迁移清单）

### 要替换（hermes 面）
- **聊天/会话核心（难度高，~30 处）**：`hermes-ui/api-client.ts`（session/cancel:262,286; setModel:328; session/resume:341; session/new:353; session/prompt:440; approval/respond:689,703,728; onEvent:217,772）、`hooks/use-hermes.ts`（105,237,270,288,359,389,442,462,477,487,494）、`agent-flow-panel.tsx`（onEvent:697,1549,1897; interrupt:1291; session/new:1571; set_mode:1592,3023; prompt:2041; approve:2887,2905）、`scheduled-task-runner.ts:32`
- **模型/配置（中，~14 处）**：`api-settings.tsx`（getConfig:252; listPersonalities:293; setYamlKey:312; tools/list:350; fetchModels:439; setConfig:485,561,750）、`lib/config-sync.ts`（27-101 pushModelConfig/pushConfigKeyValue/pushAgentConfigLive）、`helix-store.ts:1736`（MCP setYamlKey）
- **记忆（中，7 处）**：`helix-store.ts:1373-1485` listMemories/add/removeMemoryEntry
- **任务/自动化（中高，~10 处）**：`helix-layout.tsx:645`、`task-list-panel.tsx:36,74`、`scheduled-tasks-panel.tsx`、`runtime-panel.tsx:48`
- **上下文（低，3 处）**：`context-usage.tsx:91,154,167`（compaction.compact / context_breakdown）
- **技能（中，6 处）**：`skill-panel.tsx:158,160` 等 hermesSkills.*

### 要保留（非 hermes 面）
窗口控制、fs、shell、secure、terminal(pty)、git、dialog、app、diagnostics、hooks —— 约 40 处，不动。

### 主进程短路逻辑（迁移后需对齐语义）
- `tools/list`→`{tools:[]}`(main.js:1288)、`hermes:getTasks`→`{tasks:[]}`(1295)、`session.context_breakdown`→`null`(1303)
- `session/prompt` session_not_found 自动重建 + `usage:prompt-complete` 转发（1306-1345）
- config.yaml/.env 直写：`writeHermesConfig`(477-587)、setYamlKey(1500)、setAgentConfig(1520)、setReasoningEffort(1541)、setConfigKeyValue(1563)、setPersonality(1669)、memories(1932-1980)、skills(1827-2110)
- 事件转发通道：`webContents.send('hermes:event', method, params)`（main.js:147）

## 8. 迁移顺序（铁律：还原 hermes 定制层必须最后做）

```
阶段0 ✅ serve 可启动、API 实测、协议清单齐
阶段1 ✅ main.js 双链路：HELIX_GATEWAY_MODE=serve 时 spawn serve+握手，默认仍 acp
阶段2 ✅(代码) 渲染层网关适配器 + 调用点切换完毕，tsc 0 错；待 serve 模式运行时验证
阶段3 → 双链路验证 OK：删 IPC 转发、删 pushModelConfig 直写
阶段4 → git restore 还原 hermes 1962 行定制（确认无任何功能走 acp 后才可做）
```

## 9. 阶段2 实现记录（2026-07-28）

**方案 A：协议适配器**（用户确认）。UI 零逻辑改动，serve 事件在适配器内翻译成 ACP 形状双发。

新增/改动文件：
- `src/lib/serve-gateway.ts`（新建）：`ServeGatewayClient`（WS JSON-RPC，换行分帧、断线重连、4401 停止重连）
  - 方法翻译：`session/new`→`session.create`、`session/prompt`→`prompt.submit`（**ack 后挂起等 message.complete 才 resolve 并携带 usage**，保住"resolve=回合结束"语义）、`session/cancel`→`session.interrupt`（同时 resolve pending prompt 防悬挂）、`session/set_mode`→`config.set yolo`、`session/approve`+`approval/respond`→`approval.respond`（FIFO）、`command/dispatch`→`command.dispatch`（拆 name/arg）、`tools/list`→`tools.list`（toolsets 拍平）
  - 事件双发：serve 原生直通（`tool_id`→`tool_call_id` 别名）+ 合成 `session/update`（agent_message_chunk/agent_thought_chunk/tool_call/tool_call_update/permission_request/run_complete）
  - `setModel`→REST `POST /api/model/set`（模型唯一真相源移到后端）
  - **常驻路由器门面** `getServeHermesFacade()`：有 `getGatewayInfo`（新 preload）即返回；send/status 等先 await init 再分流；onEvent 先挂 IPC、serve 就绪后自动补挂 WS——避免早期订阅者（api-client constructor）漏 WS 事件的时序洞
- `src/lib/electron-bridge.ts`：`getElectronAPI()` 返回 Proxy 分流 `.hermes`；新增 `hermesApi()`
- 调用点切换（→`hermesApi()`）：`use-hermes.ts`（setModel/waitForGatewayReady/session-new/prompt/command-dispatch/setPersonality）、`agent-flow-panel.tsx`（cancel×2/interrupt/session-new/set_mode×2/主事件流 onEvent/prompt/approve×2）、`scheduled-task-runner.ts`、`scheduled-tasks-panel.tsx`、`api-settings.tsx`（tools/list）
- `helix-layout.tsx`：`__hermes_set_reasoning__` 控制令牌是本地 ACP 定制层专属，serve 模式改走 `config.set`（否则被当用户消息执行）

### 阶段2 排障记录（运行时验证发现的 4 个坑，均已修）

1. **网关重启端口漂移**：主进程 `restartGatewayDebounced`（setConfig/setYamlKey/setAgentConfig/setPersonality/setModel 都触发）kill+respawn serve，`--port 0` 新端口 → 渲染层死磕旧 wsUrl 无限 ERR_CONNECTION_REFUSED。修：`updateInfo()` + 重连前 `getGatewayInfo` 刷新 + 订阅 `gateway.serveInfo` 推送。
2. **CONNECTING 窗口 rpc 被误拒**："模型不输出"嫌疑之一。`initServeGateway` 在 `connect()` 发起后立即返回 client，WS 仍 CONNECTING 时第一批 rpc 直接 reject。修：`rpc()` 先 `waitOpen()`（15s，onopen 唤醒）。
3. **REST POST 需要 token**（“模型不输出”直接根因之一）：阶段0 “loopback REST 免 token”只对 `_PUBLIC_API_PATHS` 白名单 GET 成立；`POST /api/model/set` 需 `X-Hermes-Session-Token` 头，否则 401 → 适配器静默回落 IPC setModel → 又触发 restartGatewayDebounced 杀网关（连锁：坑1）。修：带 token 头 + **失败绝不回落 IPC**。
4. **provider 映射错误**（"模型不输出"直接根因之二）：REST `ModelAssignment` 只在 provider=custom/local 时接受 `base_url`/`api_key`；适配器原发 `provider:'openai'` → 端点静默丢弃 → 后端拿 HERMES_HOME(AppData) config.yaml 里陈旧的 stepfun 配置 → agent 构建 30s 超时（`_wait_agent` 5032）→ 只推 `error` 事件无任何 delta。修：有 baseUrl 一律映射 `provider:'custom'`。

**E2E 探针**：`scripts/test-serve-prompt.js`（spawn serve → WS → 可选 REST model/set → session.create → prompt.submit → 事件流断言）。最终验证：model/set 200、agent 构建成功、`message.start`+`thinking.delta` 正常产出（沙箱内 APIConnectionError 属环境限制，与代码无关）。

**注意**：serve 真正读的配置是 `HERMES_HOME`（`AppData\Local\hermes\config.yaml`），不是 `~/.hermes/config.yaml`；`HERMES_MODEL` 环境变量优先级高于 config.yaml（`_resolve_model`）。
- `config-sync.ts`：serve 模式 `pushConfigKeyValue`→WS `config.set`；`pushModelConfig`→REST setModel（不再 setConfig 直写+重启）

**有意保留 IPC 的点**（生命周期/主进程职责）：use-hermes:235/259（gateway 生命周期+status）、agent-flow-panel:697（gateway.sessionInvalidated）、1549（gateway.ready 等待）、hermesSkills/记忆/setYamlKey/setConfig/fetchModels/listPersonalities 等配置面（任务65 处理）。

**验证方式**：`HELIX_GATEWAY_MODE=serve` + `env -u ELECTRON_RUN_AS_NODE npm run electron:dev`，验证聊天流/工具卡/审批/停止/模型切换；不设环境变量默认 acp 全走老链路（零风险回退）。

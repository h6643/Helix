# Helix + Hermes 跨机器迁移手册

> 生成于 2026-08-02。本文档说明：只把 Helix 仓库推到 GitHub 不够，换电脑后为什么跑不起来，以及如何把整套环境完整迁移。

---

## 1. 为什么只 clone Helix 不够（机制）

Helix 仓库（`D:\Project\Helix`）只是**外壳**：

- 前端：Next.js（渲染聊天 / 文件树 / 代码编辑器 UI）
- 壳层：Electron 主进程 + IPC（`electron/main.js`、`electron/ipc/*.js`）
- 真正的后端：**Hermes gateway**，由 `electron/main.js` 硬编码路径启动：

```js
// electron/main.js（resolveHermesCmd）
path.join(os.homedir(), 'AppData', 'Local', 'hermes',
          'hermes-agent', 'venv', 'Scripts', 'python.exe')
```

`hermes-agent` **不在 Helix 的 git 内**（不是 submodule，是独立 clone 到用户目录的仓库），且带我们**手工 patch 的集成层**。所以只 clone Helix：

- `resolveHermesCmd()` 找不到 `venv\Scripts\hermes.exe` → serve 网关起不来 → 卡「正在连接 Hermes 网关」遮罩
- 即使从官方 GitHub 重装 hermes，也会**丢失集成补丁**（serve 的 WebSocket 事件流、活动面板心跳等），且官方 `hermes update` 会 `git reset --hard` 清空补丁

### 关键事实：hermes-agent 是自包含的

探查结果（本机）：

- venv 由 **`uv 0.12.0`** 创建，`pyvenv.cfg` 标记 `relocatable = true`
- venv 里**没有 pip、没有 uv**（`python -m pip` → `No module named pip`）
- Python runtime 是嵌入的 **`.hermes-runtime`**（127M，在 `hermes-agent/.hermes-runtime/` 下）
- 依赖已冻结在 venv 中，**无法用 pip/uv 重新导出或重装**

→ **结论：整目录复制 hermes-agent 即可带走全部依赖，无需重装。**

---

## 2. 当前状态快照（2026-08-02）

| 项 | 值 |
|---|---|
| 分支 | `helix-rebase-try` |
| 版本 | Hermes Agent v0.19.1 (2026.7.30) |
| upstream commit | `eb08467a` |
| local commit | `0f5980e2` (+3 carried commits) |
| 位置 | `C:\Users\hyt\AppData\Local\hermes\hermes-agent` |
| runtime | `.hermes-runtime`（cpython-3.11，127M，内嵌） |

### 集成层核心文件（我们真正改过的）

来自 rebase commit `30178136b`（其余大量 commit 是上游 `origin/main` 自身演进，非我们的补丁）：

- `acp_adapter/events.py` ← 实时终端输出流、活动面板心跳
- `acp_adapter/session.py`
- `agent/prompt_builder.py`
- `agent/tool_executor.py`
- `tools/environments/base.py` ← 集成层重写核心（set_output_callback 等）

> ⚠️ **工作树有未提交改动**：`plugins/video_gen/deepinfra/__init__.py` 与 `plugin.yaml` 被删除（status: ` D`）。复制会带上此状态；建议迁移前先 `git checkout -- .` 还原，或接受（deepinfra 删除不影响主流程）。

---

## 3. 推荐方案：整目录复制（最稳）

### 3.1 备份（在本机）

复制整个 `hermes-agent` 目录到移动盘 / 私有仓库。排除运行时缓存即可（`.git` 要保留，含分支与补丁）：

```bat
robocopy "C:\Users\hyt\AppData\Local\hermes\hermes-agent" ^
         "D:\backup\hermes-agent" ^
         /E /R:1 /W:1 ^
         /XD __pycache__ .pytest_cache cache audio_cache build ^
         /XF *.pyc *.pyo *.lock
```

### 3.2 恢复到新电脑

放到**同样路径结构**（用户名相同最稳；不同则见 §5）：

```bat
robocopy "D:\backup\hermes-agent" ^
         "C:\Users\<新用户名>\AppData\Local\hermes\hermes-agent" ^
         /E /R:1 /W:1
```

### 3.3 验证

```bat
C:\Users\<新用户名>\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe --version
```

应输出 `Hermes Agent v0.19.1 ...`（版本号可能随上游变化，能出版本即成功）。

### 3.4 新机器需重配（不随目录走，含密钥）

| 配置 | 位置 | 说明 |
|---|---|---|
| Hermes `config.yaml` | `C:\Users\...\AppData\Local\hermes\config.yaml` | 模型 / API key，**敏感，新机器重填** |
| Hermes `auth.json` | 同上目录 `auth.json` | 认证 token，**敏感，重新登录** |
| Helix 设置 | Electron IndexedDB（`settings` store） | 模型选择 / 历史，首次启动重设 |
| 邮箱授权码 | `userData/active-profile.json` + safeStorage | 邮箱功能需重新填授权码 |

> config.yaml / auth.json 在 `AppData\Local\hermes\` **根目录**（不是 hermes-agent 子目录），本机 `ls` 可见。它们含密钥，**不要复制**，在新机器由 Helix 设置页 / hermes 登录重新生成。

### 3.5 启动 Helix

```bat
cd D:\Project\Helix
env -u ELECTRON_RUN_AS_NODE npm run electron:dev
```

**改了主进程 / hermes 路径相关代码必须彻底重启**（确认 PID 变更），HMR 只刷渲染层。

---

## 4. 备选方案：官方重装 + 重放补丁（理论可行，实际受限）

> 本机 venv 无 pip/uv，且官方 GitHub 在国内拉取困难、官方 `hermes update` 会清补丁。此方案仅在你已有 hermes 私有镜像且新机器装了 `uv` 时考虑。

1. 新机器装 `uv`（独立安装，非 hermes 自带）
2. 基于私有镜像 clone 到 `AppData\Local\hermes\hermes-agent`，切到 `helix-rebase-try`
3. 导出本机补丁（在**本机**执行，趁还能跑）：
   ```bat
   cd C:\Users\hyt\AppData\Local\hermes\hermes-agent
   git diff origin/main HEAD -- acp_adapter/events.py acp_adapter/session.py ^
     agent/prompt_builder.py agent/tool_executor.py tools/environments/base.py ^
     > D:\backup\helix-integration.patch
   ```
4. 新机器 `git apply D:\backup\helix-integration.patch`
5. `uv venv && uv pip install -r requirements.txt`（需先有 requirements，见下）

> 注意：`git diff origin/main HEAD` 会混杂上游 4705 个 commit 的改动，上例已限定到我们 5 个核心文件，更可控。

### 导出依赖清单（可选备份）

本机 venv 无 pip/uv 可调用，无法直接 `freeze`。若新机器有 `uv`，可在**新机器重建后**执行：

```bat
uv pip freeze > requirements.txt
```

旧机器无法生成，故本节仅作新机器重建参考，不依赖它。

---

## 5. 注意事项

- **路径敏感**：`.hermes-runtime` 是相对 hermes-agent 的嵌入 runtime；用户名不同理论上 relocatable venv 能解析，但首次务必跑 `hermes.exe --version` 验证。
- **工作树脏状态**：迁移前先 `git status` 确认无未提交改动（当前有 2 个 deepinfra 文件删除），避免把半成品带过去。
- **GitHub 被墙**：不要试图在新机器 `git clone github.com/NousResearch/hermes`（或类似官方源），国内拉取失败且会丢失补丁。优先整目录复制。
- **不要跑 `hermes update/install`**：会 `git reset --hard origin/main`，清空集成层 → 遮罩「无法连接」。
- **Node 依赖**：Helix 的 `node_modules`（含新增的 nodemailer/imapflow/mailparser）被 `.gitignore` 忽略，新机器需 `npm install`。

---

## 6. 最小迁移检查清单

- [ ] 复制 `hermes-agent` 整目录到新机器 `AppData\Local\hermes\hermes-agent`（含 `.hermes-runtime` + `venv`）
- [ ] `hermes.exe --version` 验证通过
- [ ] `git clone` Helix 仓库 + `npm install`
- [ ] 重填 Hermes `config.yaml`（模型 / API key）
- [ ] 重登 Hermes 账号（生成 `auth.json`）
- [ ] 首次启动重设 Helix 模型选择 / 历史
- [ ] 邮箱功能重填授权码（如用到）
- [ ] `env -u ELECTRON_RUN_AS_NODE npm run electron:dev` 彻底重启

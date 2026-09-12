import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ElectronAPI } from "@/types/electron";

/**
 * Tauri 运行时桥：把 `window.electron`（Electron contextBridge 的形状）映射到
 * Tauri v2 的 `invoke` 通道。Rust 命令默认用函数名（snake_case），参数键默认
 * camelCase——本桥统一转译，让前端代码完全无感。
 *
 * 事件：Rust 端统一 `app.emit("helix:event", { method, params })`，本桥订阅一次
 * 后按 method 原样分发给所有 `helix.onEvent` 回调（与 Electron 的推送一致）。
 */

let installed = false;
const eventListeners = new Set<(method: string, params?: unknown) => void>();
const terminalListeners = new Set<
  (payload: { id: number; data: string }) => void
>();
let unlistenPromise: Promise<UnlistenFn> | null = null;
let terminalUnlistenPromise: Promise<UnlistenFn> | null = null;

/** 检测是否运行在 Tauri 环境。 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Open a URL in a real in-app browser window (Tauri `WebviewWindow`).
 *
 * WHY this is needed: Tauri's main webview cannot embed external sites via
 * `<iframe>` (the OS webview engine blocks cross-origin framing / navigation the
 * way Electron's `<webview>` guest tag does). So the embedded sidebar browser is
 * dead for external links in Tauri. A `WebviewWindow` is a SEPARATE, fully
 * functional browser instance that loads any URL — this is the Tauri-native
 * equivalent of "open the link in the in-app browser".
 *
 * One reusable window is kept: re-clicking a link navigates the existing window
 * instead of spawning a new one each time.
 */
let tauriBrowserLabel = "helix-browser";
export async function openTauriBrowser(url: string): Promise<void> {
  if (!isTauri()) return;
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  // Tauri's JS API has no runtime "navigate to URL" method on an existing
  // webview, so to reuse one browser window we close any existing one first and
  // open a fresh window at the target URL (keyed by a stable label).
  try {
    const existing = await WebviewWindow.getByLabel(tauriBrowserLabel);
    if (existing) await existing.close().catch(() => {});
  } catch {
    /* fall through to create */
  }

  // Position the new window to the right of the main window, sized to ~60% width.
  let x = 140;
  let y = 80;
  let w = 1000;
  let h = 760;
  try {
    const win = getCurrentWindow();
    const outer = await win.outerPosition(); // PhysicalPosition (device px)
    const sf = await win.scaleFactor();
    const size = await win.innerSize(); // PhysicalSize (device px)
    const lx = outer.x / sf;
    const ly = outer.y / sf;
    const lw = size.width / sf;
    const lh = size.height / sf;
    w = Math.max(640, Math.min(1280, Math.round(lw * 0.62)));
    h = Math.max(480, Math.round(lh * 0.9));
    x = Math.round(lx + lw - w - 24);
    y = Math.round(ly + 36);
  } catch {
    /* use defaults */
  }

  const win = new WebviewWindow(tauriBrowserLabel, {
    url,
    title: "Helix 浏览器",
    width: w,
    height: h,
    x,
    y,
    resizable: true,
    decorations: true,
    focus: true,
  });
  win.once("tauri://error", (e: unknown) => {
    console.error("[helix] browser window failed to open:", e);
  });
}

async function subscribeHelixEvents(): Promise<void> {
  if (unlistenPromise) return;
  unlistenPromise = (async () => {
    try {
      return await listen("helix:event", (event) => {
        const payload = event.payload as { method?: string; params?: unknown };
        if (typeof payload?.method !== "string") return;
        const params = payload.params;
        for (const cb of eventListeners) {
          try {
            cb(payload.method, params);
          } catch {
            /* listener threw — don't break the dispatch loop */
          }
        }
      });
    } catch (e) {
      console.error("[tauri-bridge] 订阅 helix:event 失败:", e);
      return () => {};
    }
  })();
}

async function subscribeTerminalEvents(): Promise<void> {
  if (terminalUnlistenPromise) return;
  terminalUnlistenPromise = (async () => {
    try {
      return await listen("terminal:data", (event) => {
        // Backend emits `{ id, data }` so each multi-tab terminal only receives
        // its own output; tolerate a plain string payload (legacy) as id 0.
        const raw = event.payload as unknown;
        let id = 0;
        let data = "";
        if (typeof raw === "string") {
          data = raw;
        } else if (raw && typeof raw === "object") {
          const obj = raw as Record<string, unknown>;
          id = Number(obj.id) || 0;
          data = String(obj.data ?? "");
        }
        for (const cb of terminalListeners) {
          try {
            cb({ id, data });
          } catch {
            /* listener threw — keep dispatching to the rest */
          }
        }
      });
    } catch (e) {
      console.error("[tauri-bridge] 订阅 terminal:data 失败:", e);
      return () => {};
    }
  })();
}

function onTerminalData(
  callback: (payload: { id: number; data: string }) => void,
): () => void {
  terminalListeners.add(callback);
  void subscribeTerminalEvents();
  return () => {
    terminalListeners.delete(callback);
  };
}

/** 返回取消订阅函数（同步，符合 Electron onEvent 的形状）。 */
function onHelixEvent(
  callback: (method: string, params?: unknown) => void,
): () => void {
  eventListeners.add(callback);
  void subscribeHelixEvents();
  return () => {
    eventListeners.delete(callback);
  };
}

/** 最大化状态监听：Tauri 没有原生 maximized 事件，用 resize 事件触发后轮询。
 * 返回同步取消函数，兼容 Electron win.onMaximizedChange。 */
function onMaximizedChange(callback: (maximized: boolean) => void): () => void {
  let last: boolean | null = null;
  let cancelled = false;
  let unlistenResize: UnlistenFn | null = null;

  const check = async () => {
    try {
      const maximized = await getCurrentWindow().isMaximized();
      if (cancelled) return;
      if (last !== null && maximized !== last) {
        try {
          callback(maximized);
        } catch {
          /* listener threw */
        }
      }
      last = maximized;
    } catch {
      /* window gone — ignore */
    }
  };

  void getCurrentWindow()
    .onResized(() => {
      void check();
    })
    .then((unlisten) => {
      if (cancelled) unlisten() as unknown;
      else unlistenResize = unlisten;
    })
    .catch(() => {});
  void check();

  return () => {
    cancelled = true;
    if (unlistenResize) {
      try {
        unlistenResize();
      } catch {
        /* noop */
      }
      unlistenResize = null;
    }
  };
}

function stubError(message: string) {
  return { ok: false, error: message };
}

function buildTauriAPI(): ElectronAPI {
  const api: Record<string, unknown> = {};

  // ── fs ──────────────────────────────────────────────────────────────────
  api.fs = {
    read: (filePath: string) => invoke("read", { filePath }),
    write: (filePath: string, content: string) =>
      invoke("write", { filePath, content }),
    edit: (filePath: string, oldString: string, newString: string) =>
      invoke("edit", { filePath, oldString, newString }),
    readdir: (dirPath: string) => invoke("readdir", { dirPath }),
    helixMemoryDir: () => invoke("helix_memory_dir"),
    stat: (filePath: string) => invoke("stat", { filePath }),
    rename: (oldPath: string, newPath: string) =>
      invoke("rename", { oldPath, newPath }),
    delete: (filePath: string) => invoke("delete", { filePath }),
    scanTree: (dirPath?: string) =>
      invoke("scan_tree", { relativePath: dirPath ?? null }),
    allowRoot: (dirPath: string) => invoke("allow_root", { dir: dirPath }),
  };

  // ── helixSkills ────────────────────────────────────────────────────────
  api.helixSkills = {
    getDir: () => invoke("helix_get_skills_dir"),
    getPluginsDir: () => invoke("helix_get_plugins_dir"),
    readdir: (dirPath: string) => invoke("helix_read_dir", { dirPath }),
    readFile: (filePath: string) => invoke("helix_read_file", { filePath }),
    deleteDir: (dirPath: string) => invoke("helix_delete_dir", { dirPath }),
    listSkills: () => invoke("helix_list_skills"),
    trackSkillCall: (skillName: string) =>
      invoke("helix_track_skill_call", { skillName }),
  };

  // ── shell ───────────────────────────────────────────────────────────────
  api.shell = {
    // Route URL opening through the opener plugin (tauri_plugin_opener registers
    // the `plugin:opener|open_url` command). The previous `invoke('open', ...)`
    // had no matching Rust command in this project, so it silently failed in
    // Tauri — that's why the "open in external browser" button did nothing.
    open: (target: string) =>
      invoke("plugin:opener|open_url", { url: target, with: null }),
    showItemInFolder: (relativePath: string) =>
      invoke("show_item_in_folder", { relativePath }),
    openPath: (dir: string) => invoke("open_path", { dir }),
  };

  // ── terminal ───────────────────────────────────────────────────────────
  api.terminal = {
    start: (id: number, cols?: number, rows?: number, cwd?: string) =>
      invoke("terminal_start", {
        id,
        cols: cols ?? null,
        rows: rows ?? null,
        cwd: cwd ?? null,
      }),
    write: (id: number, command: string) => {
      void invoke("terminal_write", { id, data: command }).catch(() => {});
    },
    resize: (id: number, cols: number, rows: number) => {
      void invoke("terminal_resize", { id, cols, rows }).catch(() => {});
    },
    kill: (id: number) => invoke("terminal_kill", { id }),
    onData: onTerminalData,
  };

  // ── secure ──────────────────────────────────────────────────────────────
  api.secure = {
    available: () => invoke("secure_available"),
    encrypt: (plaintext: string) => invoke("secure_encrypt", { plaintext }),
    decrypt: (blob: string) => invoke("secure_decrypt", { blob }),
  };

  // ── scheduledTasks ──────────────────────────────────────────────────────
  api.scheduledTasks = {
    list: () => invoke("scheduled_tasks_list"),
    create: (params: unknown) => invoke("create", { params }),
    update: (params: unknown) => invoke("update", { params }),
    remove: (params: unknown) => invoke("remove", { params }),
  };

  // ── dialog ──────────────────────────────────────────────────────────────
  api.dialog = {
    openDirectory: (defaultPath?: string) =>
      invoke("open_directory", { defaultPath: defaultPath ?? null }),
    openFile: (options?: unknown) =>
      invoke("open_file", { options: options ?? null }),
    saveFile: (options?: unknown) =>
      invoke("save_file", { options: options ?? null }),
  };

  // ── app ─────────────────────────────────────────────────────────────────
  api.app = {
    getInfo: () => invoke("get_info"),
    readEnvKey: (key: string) => invoke("read_env_key", { key }),
    setWorkDir: (dir: string) => invoke("set_work_dir", { dir }),
    syncWorkDir: (dir: string) => invoke("sync_work_dir", { dir }),
    getHelixVersion: () => invoke("get_helix_version"),
    getDataRoot: () => invoke("get_data_root"),
    setDataRoot: (path: string) => invoke("set_data_root", { path }),
    // HTTP 代理（修改后需重启应用生效）
    proxyGet: () => invoke("proxy_get"),
    proxySet: (url: string) => invoke("proxy_set", { url }),
  };

  // ── helix ──────────────────────────────────────────────────────────────
  api.helix = {
    send: (method: string, params?: unknown) =>
      invoke("helix_send", { method, params: params ?? null }),
    notify: (method: string, params?: unknown) => {
      void invoke("helix_notify", { method, params: params ?? null });
    },
    interrupt: (sessionId: string) => invoke("helix_interrupt", { sessionId }),
    status: () => invoke("helix_status"),
    getGatewayInfo: () => invoke("helix_get_gateway_info"),
    setConfig: (config: unknown) => invoke("helix_set_config", { config }),
    getConfig: () => invoke("helix_get_config"),
    getRawConfig: () => invoke("helix_get_raw_config"),
    setRawConfig: (patch: unknown) => invoke("helix_set_raw_config", { patch }),
    getMemoryStatus: () => invoke("helix_get_memory_status"),
    // Memory provider config commands were serve-backend stubs; removed with
    // the pi migration (no backend implementation, no UI callers).
    setYamlKey: (key: string, value: unknown) =>
      invoke("helix_set_yaml_key", { key, value }),
    setDelegationIdentities: (identities: unknown) =>
      invoke("helix_set_delegation_identities", { identities }),
    listPersonalities: () => invoke("helix_list_personalities"),
    setPersonality: (params: unknown) =>
      invoke("helix_set_personality", { params }),
    setModel: (params: unknown) => invoke("helix_set_model", { params }),
    setAgentConfig: (params: unknown) =>
      invoke("helix_set_agent_config", { params }),
    setReasoningEffort: (params: unknown) =>
      invoke("helix_set_reasoning_effort", { params }),
    fetchModels: (params: { baseUrl: string; apiKey: string }) =>
      invoke("helix_fetch_models", {
        baseUrl: params.baseUrl,
        apiKey: params.apiKey,
      }),
    onEvent: onHelixEvent,
    listMemories: () => invoke("helix_list_memories"),
    addMemoryEntry: (target: "memory" | "user", text: string) =>
      invoke("helix_add_memory_entry", { target, text }),
    removeMemoryEntry: (target: "memory" | "user", text: string) =>
      invoke("helix_remove_memory_entry", { target, text }),
    setConfigKeyValue: (params: unknown) =>
      invoke("helix_set_config_key_value", { params }),
    approvalRespond: (params: unknown) =>
      invoke("helix_approval_respond", { params }),
    update: () => invoke("helix_update"),
    installPlugin: (identifier: string, force?: boolean) =>
      invoke("helix_install_plugin", { identifier, force: force ?? false }),
    // Pi agent commands (extensions / skills / prompts / models)
    piGetCommands: () => invoke("pi_get_commands"),
    piListInstalled: () => invoke("pi_list_installed"),
    piGetAvailableModels: () => invoke("pi_get_available_models"),
    piGetState: () => invoke("pi_get_state"),
    piSetModel: (provider: string, modelId: string) =>
      invoke("pi_set_model", { provider, modelId }),
    piSetThinkingLevel: (level: string) =>
      invoke("pi_set_thinking_level", { level }),
    piSetThinkingLevelAll: (level: string) =>
      invoke("pi_set_thinking_level_all", { level }),
    piCompact: () => invoke("pi_compact"),
    piGetSessionStats: () => invoke("pi_get_session_stats"),
    piSearchPackages: (query: string) => invoke("pi_search_packages", { query }),
    piInstallPackage: (pkg: string) => invoke("pi_install_package", { package: pkg }),
    piUninstallPackage: (pkg: string) => invoke("pi_uninstall_package", { package: pkg }),
    piSetPackageEnabled: (pkg: string, enabled: boolean) =>
      invoke("pi_set_package_enabled", { package: pkg, enabled }),
    piCheckUpdates: () => invoke("pi_check_updates"),
    piPackageLatest: (name: string) => invoke("pi_package_latest", { name }),
    cronList: () => invoke("helix_cron_list"),
    cronCreate: (schedule: string, command: string, name?: string) =>
      invoke("helix_cron_create", { schedule, command, name: name ?? null }),
    cronDelete: (jobId: string) => invoke("helix_cron_delete", { jobId }),
    cronRun: (jobId: string) => invoke("helix_cron_run", { jobId }),
    doctor: () => invoke("helix_doctor"),
  };

  // ── profile ─────────────────────────────────────────────────────────────
  api.profile = {
    cacheConfig: (cfg: unknown) => invoke("cache_config", { cfg }),
  };

  // ── git ─────────────────────────────────────────────────────────────────
  api.git = {
    status: (cwd?: string | null) =>
      invoke("status", { targetCwd: cwd ?? null }),
    diff: (filePath?: string, staged?: boolean) =>
      invoke("diff", { filePath: filePath ?? null, staged: staged ?? null }),
    diffHead: (filePath?: string) =>
      invoke("diff_head", { filePath: filePath ?? null }),
    diffNumstat: (cwd?: string | null) =>
      invoke("diff_numstat", { targetCwd: cwd ?? null }),
    revert: (filePath?: string) =>
      invoke("revert", { filePath: filePath ?? null }),
    stage: (filePath?: string) =>
      invoke("stage", { filePath: filePath ?? null }),
    unstage: (filePath?: string) =>
      invoke("unstage", { filePath: filePath ?? null }),
    commit: (message?: string) =>
      invoke("commit", { message: message ?? null }),
    branchList: (cwd?: string | null) =>
      invoke("branch_list", { targetCwd: cwd ?? null }),
    branchSwitch: (branch: string, cwd?: string | null) =>
      invoke("branch_switch", { branch, targetCwd: cwd ?? null }),
    branchCreate: (branch: string, cwd?: string | null) =>
      invoke("branch_create", { branch, targetCwd: cwd ?? null }),
    currentBranch: (cwd?: string | null) =>
      invoke("current_branch", { targetCwd: cwd ?? null }),
    log: (count?: number) => invoke("log", { count: count ?? null }),
    worktreeList: () => invoke("worktree_list"),
    worktreeAdd: (opts: unknown) => invoke("worktree_add", { opts }),
    worktreeRemove: (wtPath: string) => invoke("worktree_remove", { wtPath }),
    worktreeLock: (wtPath: string) => invoke("worktree_lock", { wtPath }),
    worktreeUnlock: (wtPath: string) => invoke("worktree_unlock", { wtPath }),
    worktreePrune: () => invoke("worktree_prune"),
    push: (opts?: unknown) => invoke("push", { opts: opts ?? null }),
    pull: (opts?: unknown) => invoke("pull", { opts: opts ?? null }),
    fetch: (opts?: unknown) => invoke("fetch", { opts: opts ?? null }),
  };

  // ── external (TCP probe + SSH implemented) ──────────────────────────────
  api.external = {
    testConnection: (host: string, port: number | string, timeoutMs?: number) =>
      invoke("test_connection", { host, port, timeoutMs: timeoutMs ?? null }),
    sshConnect: (params: {
      host: string;
      port: number;
      username: string;
      authType: string;
      secret: string;
    }) => invoke("ssh_connect", params),
    sshExec: (params: { conn_id: string; command: string }) =>
      invoke("ssh_exec", params),
    sshStatus: (conn_id: string) => invoke("ssh_status", { conn_id }),
    sshDisconnect: (conn_id: string) => invoke("ssh_disconnect", { conn_id }),
    onSshConnected: () => () => {},
    onSshList: () => () => {},
  };

  // ── email (not ported) ──────────────────────────────────────────────────
  api.email = {
    configure: () => Promise.resolve({ configured: false }),
    getConfig: () => Promise.resolve({ configured: false }),
    list: () =>
      Promise.resolve({
        ok: false,
        messages: [],
        error: "Email 功能在 Linux Tauri 版暂不可用",
      }),
    get: () =>
      Promise.resolve({
        uid: 0,
        subject: "",
        from: "",
        to: "",
        date: 0,
        text: "",
        html: "",
        attachments: [],
      }),
    send: () => Promise.resolve({ accepted: [], messageId: "" }),
    notify: () => Promise.resolve({ accepted: [], messageId: "" }),
    test: () =>
      Promise.resolve({
        ok: false,
        imap: { ok: false, message: "Email 功能暂不可用" },
        smtp: { ok: false, message: "Email 功能暂不可用" },
        debug: { user: "", authCodeLength: 0 },
      }),
  };

  // ── hooks ───────────────────────────────────────────────────────────────
  api.hooks = {
    getConfig: () => invoke("hooks_list"),
    setConfig: (config: unknown) => invoke("hooks_save", { config }),
  };

  // ── web search ─────────────────────────────────────────────────────────
  api.webSearch = {
    getConfig: () => invoke("web_search_list"),
    setConfig: (config: unknown) => invoke("web_search_save", { config }),
  };

  // ── vision model (auxiliary.vision) ───────────────────────────────────
  api.vision = {
    getConfig: () => invoke("vision_config_list"),
    setConfig: (config: unknown) => invoke("vision_config_save", { config }),
    describe: (image: string, prompt?: string) =>
      invoke<string>("vision_describe", { image, prompt: prompt ?? null }),
  };

  // ── gateway MCP servers (config.yaml mcp_servers, read/write) ────────
  api.mcpConfig = {
    list: () => invoke("mcp_config_list"),
    save: (servers: unknown) => invoke("mcp_config_save", { servers }),
  };

  // ── delegations ─────────────────────────────────────────────────────────
  api.delegations = {
    list: (sessionId?: string) =>
      invoke("delegations_list", { sessionId: sessionId ?? null }),
    readLog: (path: string, lines?: number) =>
      invoke("delegations_read_log", { path, lines: lines ?? null }),
  };

  // ── diagnostics ─────────────────────────────────────────────────────────
  api.diagnostics = {
    getStatus: () => invoke("get_status"),
  };

  // ── window controls (used by title bar) ─────────────────────────────────
  api.window = {
    minimize: () => invoke("minimize"),
    maximize: () => invoke("maximize"),
    unmaximize: () => invoke("unmaximize"),
    close: () => invoke("close"),
    isMaximized: () => invoke("is_maximized"),
    toggleDevTools: () => invoke("toggle_devtools"),
    newWindow: () => invoke("new_window"),
    startDrag: () => invoke("start_drag"),
    onMaximizedChange,
  };

  // ── top-level fields ────────────────────────────────────────────────────
  api.platform = "linux";
  api.isElectron = true;

  return api as unknown as ElectronAPI;
}

/**
 * 安装 Tauri 桥：把 `window.electron` 填成 Tauri invoke 的实现。幂等。
 * 在 Electron / 浏览器里调用是 no-op。
 */
export function installTauriBridge(): void {
  if (installed) return;
  if (!isTauri()) return;
  installed = true;
  (window as unknown as { electron: ElectronAPI }).electron = buildTauriAPI();
  void subscribeHelixEvents();
}

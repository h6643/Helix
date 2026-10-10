import type { HooksConfig } from "@/lib/hooks-config";
import type { ScheduledTask } from "@/stores/helix-store";
import type { PermissionScopeId } from "@/stores/helix-types";

/** `helix_get_permission_mode` / set / clear 的作用域身份（不传 = 只看全局格）。 */
export type PermissionScopeQuery = {
  sessionId?: string | null;
  cwd?: string | null;
};

/** 写入层。`disabled` 是读方向才有的来源（扩展总开关关着），不可写。 */
export type PermissionScopeWriteId = PermissionScopeId;

/** 一层档位格子（global / session / project 共用同一形状）。 */
export interface PermissionModeCell {
  /** Helix 档位：ask / auto / full。 */
  mode: string;
  /** 扩展原生档位：strict / auto / yolo。归一会抹平差异，两个都要读。 */
  extension_mode: string;
}

/** set 命令额外带回：这次实际写了哪一格。 */
export interface PermissionModeScopeWrite {
  scope: PermissionScopeWriteId;
  key: string | null;
  mode: string;
  extension_mode: string;
  previous: PermissionModeCell | null;
  changed: boolean;
}

/** clear 命令额外带回：删掉了哪些同键旧拼法（项目键可能有多份历史写法）。 */
export interface PermissionModeCleared {
  scope: PermissionScopeWriteId;
  key: string;
  removed: string[];
}

/**
 * 三份 permission 命令共用的视图（后端 `permission_mode_view` 一处构造）。
 *
 * `mode` 顶层键**一直是生效档**，旧前端只读它仍然正确。
 * `ok=false` 时除了 `mode: null` 还会给 `exists` / `reason`：读不到真相就
 * 别编一个档位回去（扩展在文件缺失/坏 JSON 时一律回落 yolo = 全放行）。
 */
export interface PermissionModeView {
  ok: boolean;
  mode: string | null;
  extension_mode?: string;
  /** 生效档 + 它来自哪一层（session / project / global / disabled）。 */
  effective?: {
    mode: string;
    extension_mode: string;
    source: PermissionScopeId | "disabled";
    key: string | null;
  } | null;
  global?: (PermissionModeCell & { unparsable?: boolean }) | null;
  session?: (PermissionModeCell & { key: string }) | null;
  project?: (PermissionModeCell & { key: string }) | null;
  /** 生效档来自覆盖表（不是全局）。 */
  override_active?: boolean;
  scope?: {
    session_id: string | null;
    cwd: string | null;
    remote: boolean;
  };
  /** 审批卡超时秒数（30–3600 已归一）；ok=false 时为 null。 */
  approvalTimeoutSec?: number | null;
  /** 扩展总开关：false ⇒ 覆盖表整个不跑，实际全放行。 */
  enabled?: boolean;
  /** ok=false 时给出：文件是否存在。 */
  exists?: boolean;
  reason?: string;
  error?: string;
  config_path?: string;
}

/**
 * `git.diffNumstatFull` 失败时后端给的原因分类（`src-tauri/src/git.rs`）。
 * 前端据此分别说人话：把这些都渲染成「没有未提交的更改」会让「云端对话 /
 * 不是 git 仓库 / 找不到 git / 目录不存在」看起来像「确实没改动」。
 */
export type GitNumstatFailureCode =
  | "work_dir_not_found"
  | "git_unavailable"
  | "git_timeout"
  | "not_a_repository"
  | "git_failed";

/** `src-tauri/src/diagnostics.rs`：项目自带的类型检查/lint 命令（不是 LSP）。 */
export interface DiagnosticCheck {
  id: string;
  label: string;
  program: string;
  args: string[];
  timeoutSecs: number;
  source: string;
}

export interface DiagnosticProblem {
  /** 相对项目根、'/' 分隔——与 fs 桥和编辑器 tab 的路径形状一致。 */
  file: string;
  absPath: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "info";
  message: string;
  code?: string;
}

export interface DiagnosticRunResult {
  ok: boolean;
  checkId?: string;
  label?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  cwd?: string;
  problems?: DiagnosticProblem[];
  counts?: { errors: number; warnings: number; total: number };
  truncated?: boolean;
  rawTail?: string;
  code?: "no_check_available" | "tool_unavailable" | string;
  error?: string;
}

export interface ElectronAPI {
  fs: {
    read: (filePath: string) => Promise<string>;
    write: (filePath: string, content: string) => Promise<{ success: boolean }>;
    edit: (
      filePath: string,
      oldString: string,
      newString: string,
    ) => Promise<{ success: boolean }>;
    readdir: (
      dirPath: string,
    ) => Promise<Array<{ name: string; isDirectory: boolean }>>;
    helixMemoryDir: () => Promise<string>;
    stat: (filePath: string) => Promise<{
      isFile: boolean;
      isDirectory: boolean;
      size: number;
      mtime: number;
    }>;
    rename: (oldPath: string, newPath: string) => Promise<{ success: boolean }>;
    delete: (filePath: string) => Promise<{ success: boolean }>;
    scanTree: (dirPath?: string) => Promise<
      Array<{
        id: string;
        name: string;
        type: "file" | "folder";
        children?: any[];
      }>
    >;
    allowRoot: (dirPath: string) => Promise<{ success: boolean }>;
    /** 会话级文件快照：run 前存「改动前」内容，供卡片「撤销本轮」整体还原 */
    snapshotSave: (
      runId: string,
      sessionId: string,
      files: string[],
    ) => Promise<{
      ok: boolean;
      saved?: number;
      skipped?: string[];
      error?: string;
    }>;
    snapshotRestore: (runId: string) => Promise<{
      ok: boolean;
      restored?: string[];
      failed?: string[];
      error?: string;
    }>;
    snapshotDiscard: (runId: string) => Promise<{ ok: boolean }>;
  };

  helixSkills: {
    getDir: () => Promise<string | null>;
    readdir: (
      dirPath: string,
    ) => Promise<Array<{ name: string; isDirectory: boolean }>>;
    readFile: (filePath: string) => Promise<string | null>;
    deleteDir: (dirPath: string) => Promise<boolean>;
    listSkills: () => Promise<any>;
  };

  shell: {
    open: (target: string) => Promise<void>;
    showItemInFolder: (fullPath: string) => Promise<void>;
    openPath: (dir: string) => Promise<void>;
  };

  secure: {
    available: () => Promise<boolean>;
    /** Returns base64 ciphertext, or null if safeStorage is unavailable. */
    encrypt: (plaintext: string) => Promise<string | null>;
    /** Returns plaintext, or null if decryption failed / unavailable. */
    decrypt: (b64: string) => Promise<string | null>;
  };

  terminal: {
    start: (
      id: number,
      cols?: number,
      rows?: number,
      cwd?: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    write: (id: number, command: string) => void;
    resize: (id: number, cols: number, rows: number) => void;
    kill: (id: number) => Promise<{ ok: boolean }>;
    onData: (
      callback: (payload: { id: number; data: string }) => void,
    ) => () => void;
  };

  // Background tasks (pi-background-tasks extension's shared registry
  // ~/.pi/agent/tasks.json — see src-tauri/src/background_tasks.rs).
  backgroundTasks: {
    list: (sessionId?: string) => Promise<{
      ok: boolean;
      tasks?: Array<{
        id: string;
        command: string;
        pid: number;
        session_id: string;
        started_at: number;
        status: "running" | "completed" | "failed" | "killed";
        exit_code?: number;
        finished_at?: number;
        output_file: string;
      }>;
    }>;
    read: (
      taskId: string,
      tailBytes?: number,
    ) => Promise<{
      ok: boolean;
      text?: string;
      total_bytes?: number;
      error?: string;
    }>;
    kill: (taskId: string) => Promise<{
      ok: boolean;
      already_finished?: boolean;
      error?: string;
    }>;
  };

  scheduledTasks: {
    list: () => Promise<{
      ok: boolean;
      tasks?: ScheduledTask[];
      error?: string;
    }>;
    create: (params: {
      name?: string;
      prompt?: string;
      scheduleText?: string;
      cronExpression?: string;
      nextRunAt?: number;
    }) => Promise<{
      ok: boolean;
      id?: string;
      nextRunAt?: number | null;
      error?: string;
    }>;
    update: (params: {
      id: string;
      enabled: boolean;
    }) => Promise<{ ok: boolean; error?: string }>;
    remove: (params: {
      id: string;
    }) => Promise<{ ok: boolean; error?: string }>;
  };

  dialog: {
    openDirectory: (defaultPath?: string) => Promise<string | null>;
    openFile: (options?: {
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => Promise<string | null>;
    saveFile: (options?: {
      filters?: Array<{ name: string; extensions: string[] }>;
    }) => Promise<string | null>;
  };

  app: {
    getInfo: () => Promise<{
      version: string;
      piVersion?: string;
      platform: string;
      workDir: string;
    }>;
    setWorkDir: (dir: string) => Promise<{ success: boolean; workDir: string; error?: string }>;
    syncWorkDir: (
      dir: string,
    ) => Promise<{ success: boolean; workDir: string; error?: string }>;
    getDataRoot: () => Promise<{
      dataRoot: string;
      dataRootDefault: string;
      dataRootCustom: boolean;
    }>;
    /** 默认会话工作目录（~/.pi/agent/sessions），未选择项目时使用 */
    getSessionsDir: () => Promise<{ sessionsDir: string }>;
    setDataRoot: (path: string) => Promise<{
      success: boolean;
      dataRoot: string;
      dataRootDefault: string;
      dataRootCustom: boolean;
      copied: boolean;
      bytes?: number;
    }>;
    proxyGet: () => Promise<{ url: string }>;
    proxySet: (url: string) => Promise<{ success: boolean; url: string }>;
    /** 系统通知开关。真相是 config.yaml 的 `notifications:` 块，网关每次弹之前
     *  现读，所以改完即生效（不用重启）。turnEndMode: never|unfocused|always。 */
    notificationConfig: () => Promise<{
      ok: boolean;
      turnEndMode?: string;
      approvalEnabled?: boolean;
      clarifyEnabled?: boolean;
      configPath?: string;
      error?: string;
    }>;
    /** 只提交要改的键；返回体里的三个字段是回读到的**生效值**（写失败时 UI 不撒谎）。 */
    setNotificationConfig: (updates: {
      turnEndMode?: string;
      approvalEnabled?: boolean;
      clarifyEnabled?: boolean;
    }) => Promise<{
      ok: boolean;
      turnEndMode?: string;
      approvalEnabled?: boolean;
      clarifyEnabled?: boolean;
      changed?: string[];
      error?: string;
    }>;
    /** 跳到系统的通知设置页（Windows: ms-settings:notifications）。 */
    openNotificationSettings: () => Promise<{ ok: boolean; error?: string }>;
    /** Poll pending pi-extension browser requests (emits helix:browser-request
     *  events with the full payload; navigate also emits the legacy
     *  helix:open-browser for the sidebar-open path). */
    pollBrowserRequests: () => Promise<{ ok: boolean; opened: string[] }>;
    /** Write a browser automation result (<reqId>.result.json) for the pi
     *  extension's request-response protocol. */
    browserWriteResult: (
      reqId: string,
      result: unknown,
    ) => Promise<{ ok: boolean; error?: string }>;
  };

  helix: {
    send: (method: string, params?: any) => Promise<any>;
    notify: (method: string, params?: any) => void;
    interrupt: (sessionId: string) => Promise<any>;
    status: () => Promise<any>;
    // Gateway connection info (serve-migration Phase 1).
    // acp mode  → { mode:'acp' }
    // serve mode→ { mode:'serve', port, token, baseUrl, wsUrl } or { mode:'serve', pending:true }
    getGatewayInfo: () => Promise<
      | { mode: "acp" }
      | {
          mode: "serve";
          pending?: boolean;
          port?: number;
          token?: string;
          baseUrl?: string;
          wsUrl?: string;
        }
    >;
    setConfig: (config: any) => Promise<any>;
    setConfigKeyValue: (payload: {
      key: string;
      value: unknown;
      session_id?: string;
    }) => Promise<any>;
    getConfig: () => Promise<any>;
    setYamlKey: (key: string, value: any) => Promise<any>;
    // 一键远程连接（agent 远程跑）：scp bridge + 远端起 node + 本机 ssh -L 隧道
    // + 写 pi.remote_rpc / pi.remote_cwd。
    remoteConnect: (params: {
      host: string;
      port: number;
      username: string;
      remote_path: string;
    }) => Promise<{
      ok: boolean;
      local_port?: number;
      remote_host?: string;
      remote_port?: number;
      username?: string;
      remote_path?: string;
    }>;
    remoteDisconnect: () => Promise<{ ok: boolean }>;
    remotePreflight: (params: {
      host: string;
      port: number;
      username: string;
    }) => Promise<{
      ok: boolean;
      home: string;
      uname: string;
      node_path: string;
      node_version: string;
      pi_path: string;
      pi_cli_js: string;
      error: string;
    }>;
    remoteListPaths: (params: {
      host: string;
      port: number;
      username: string;
      path: string;
      include_hidden?: boolean;
    }) => Promise<{ cwd: string; paths: string[] }>;
    remoteTunnelStatus: () => Promise<{
      connected: boolean;
      local_port?: number;
      remote_host?: string;
      remote_port?: number;
      username?: string;
      remote_path?: string | null;
    }>;
    /** 审批档位 ⇄ pi-permission 扩展配置。前端下拉直写扩展的 settings.json，
     *  因为真正 block 工具执行的是扩展的 tool_call 钩子。
     *  档位可分三层（全局 / 本项目 / 本会话），覆盖表也在同一个文件里，
     *  由扩展自己按「会话 → 项目 → 全局」解析 —— 见 `PermissionModeView`。 */
    getPermissionMode: (scope?: PermissionScopeQuery) => Promise<PermissionModeView>;
    setPermissionMode: (
      mode: string,
      scope?: PermissionScopeQuery & { scope?: PermissionScopeWriteId },
    ) => Promise<PermissionModeView & { scope_written?: PermissionModeScopeWrite }>;
    /** 删掉某一层覆盖，回到「下一层说了算」。global 没有清除（它就是兜底层）。 */
    clearPermissionOverride: (
      scope: Extract<PermissionScopeWriteId, "project" | "session">,
      target?: PermissionScopeQuery,
    ) => Promise<PermissionModeView & { cleared?: PermissionModeCleared }>;
    setApprovalTimeoutSec: (
      seconds: number,
    ) => Promise<{
      ok: boolean;
      /** 生效值：越界输入被收敛后的结果（如 10 → 30） */
      approvalTimeoutSec?: number;
      changed?: boolean;
      config_path?: string;
      error?: string;
    }>;
    setDelegationIdentities: (
      identities: Array<{ name: string; system_prompt: string }>,
    ) => Promise<{ success: boolean; changed?: boolean; error?: string }>;
    setModel: (params: {
      model: string;
      baseUrl?: string;
      apiKey?: string;
      provider?: string;
    }) => Promise<any>;
    /** Register a provider + model list into pi's models.json WITHOUT changing
     *  pi's default model and WITHOUT restarting the gateway. Per-conversation
     *  model switching uses this instead of setModel. */
    registerProviderModels: (config: {
      provider: string;
      baseUrl: string;
      apiKey?: string;
      api?: string;
      models: Array<{ id: string; contextWindow?: number; reasoning?: boolean }>;
    }) => Promise<{ success: boolean; wrote?: boolean }>;
    fetchModels: (params: any) => Promise<any>;
    onEvent: (callback: (method: any, params: any) => void) => () => void;
    // ── Memory sync (Helix backend memory_manager: MEMORY.md / USER.md) ──
    listMemories: () => Promise<{
      memory: string[];
      user: string[];
      manual: string[];
    }>;
    addMemoryEntry: (
      target: "memory" | "user",
      text: string,
    ) => Promise<{ ok: boolean; entries?: string[]; error?: string }>;
    removeMemoryEntry: (
      target: "memory" | "user",
      text: string,
    ) => Promise<{ ok: boolean; entries?: string[] }>;
    // pi-hermes-memory 概览 + 开关（设置「记忆」页）
    memoryOverview: () => Promise<{
      ok: boolean;
      global: {
        enabled: boolean;
        file_count: number;
        last_updated: number;
        dir?: string;
      };
      current_project: string;
      projects: {
        name: string;
        enabled: boolean;
        file_count: number;
        last_updated: number;
        dir?: string;
      }[];
      config_path?: string;
    }>;
    setMemoryEnabled: (
      scope: "global" | "project",
      enabled: boolean,
    ) => Promise<{ ok: boolean; scope: string; enabled: boolean; error?: string }>;
    memoryConfig: () => Promise<{ ok: boolean; config: Record<string, unknown> }>;
    setMemoryConfig: (
      updates: Record<string, unknown>,
    ) => Promise<{ ok: boolean; error?: string }>;
    deleteMemory: (
      scope: "global" | "project",
      project?: string,
    ) => Promise<{
      ok: boolean;
      removed: number;
      dir?: string;
      errors?: string[];
      error?: string;
    }>;
    // Codemode（pi settings.json 的 defaultTools + codemode 块）
    codemodeConfig: () => Promise<{
      ok: boolean;
      enabled: boolean;
      mode: "on" | "only";
      inlineBudget: number;
    }>;
    setCodemodeConfig: (updates: {
      enabled?: boolean;
      mode?: "on" | "only";
      inlineBudget?: number;
    }) => Promise<{ ok: boolean; error?: string }>;
    // Subagent global settings (config.yaml `subagents:` block, read/write;
    // mirrored into the pi-subagents extension's settings.json on save).
    listSubagentSettings: () => Promise<{
      ok: boolean;
      settings?: Record<string, unknown>;
      error?: string;
    }>;
    saveSubagentSettings: (settings: Record<string, unknown>) => Promise<{
      ok: boolean;
      error?: string;
    }>;
    // pi-subagents agent types, merged the way the extension resolves them:
    // compiled defaults (general-purpose/Explore/Plan) overlaid by
    // <work_dir>/.pi/agents, <work_dir>/.agents/agents and ~/.pi/agent/agents
    // .md files (project overrides global on a type clash).
    listSubagents: () => Promise<
      Array<{
        id: string;
        name: string;
        description: string;
        tools: string[];
        model: string;
        thinking: string;
        systemPromptMode: string;
        systemPrompt: string;
        path: string;
        disabled: boolean;
        source: "default" | "project" | "workspace" | "global";
      }>
    >;
    // Enable/disable an agent by writing/removing `enabled: false` in its
    // frontmatter — the same edit the extension's own /agents command makes.
    setSubagentEnabled: (name: string, enabled: boolean) => Promise<void>;
    // Set the `model:` frontmatter field on an agent's .md.
    // Empty string clears the field (inherit parent model).
    setSubagentModel: (name: string, model: string) => Promise<void>;
    // Delete a custom agent's .md (the extension's Delete unlinks the file).
    deleteSubagent: (name: string) => Promise<void>;
    // Pi agent commands (extensions / skills / prompts / models)
    piListInstalled: () => Promise<{
      items: Array<{
        name: string;
        type: "extension" | "skill" | "prompt";
        source: "pi" | "pi-rpc" | "pi-package" | "pi-npm" | "helix";
        description?: string;
        version?: string;
        path?: string;
        location?: string;
        /** npm: package id ("npm:<name>") for toggling via settings.json. */
        packageId?: string;
        /** Whether the plugin's resources are currently loaded. */
        enabled?: boolean;
      }>;
    }>;
    piSetPackageEnabled: (
      pkg: string,
      enabled: boolean,
    ) => Promise<{ success: boolean; package: string; enabled: boolean }>;
    piGetAvailableModels: () => Promise<{
      // Pi's Model objects. Everything except `id`/`provider` is optional here:
      // custom-providers.json entries routinely omit cost/contextWindow, and a
      // hard-required shape would make the settings dropdown throw on them.
      models: Array<{
        id: string;
        provider: string;
        name?: string;
        /** Endpoint the model resolves to — lets the settings panel auto-fill
         *  Base URL when the user picks a Pi-configured provider. */
        baseUrl?: string;
        /** Wire format, e.g. "openai-completions" | "anthropic-messages". */
        api?: string;
        reasoning?: boolean;
        input?: string[];
        contextWindow?: number;
        maxTokens?: number;
        cost?: {
          input: number;
          output: number;
          cacheRead: number;
          cacheWrite: number;
        };
      }>;
    }>;
    /**
     * 读 pi `models.json` 里的自定义 provider（Helix 每次保存模型时写下的那份），
     * 供冷启动「profile 列表读空了」时重建模型配置。只读。带 apiKey —— 这是
     * `piGetAvailableModels` 的 RPC 快照里没有的字段，也是重建 profile 必需的。
     */
    piReadCustomProviders: () => Promise<{
      providers: Array<{
        /** pi 注册名（models.json 的 key），同时用作 profile 的 provider。 */
        id: string;
        baseUrl: string;
        apiKey: string;
        /** 线协议，如 "openai-completions"；缺失时由调用方回落默认格式。 */
        api?: string;
        models: Array<{
          id: string;
          name?: string;
          contextWindow?: number;
          reasoning?: boolean;
          input?: string[];
        }>;
      }>;
      defaultProvider: string;
      defaultModel: string;
    }>;
    piSetThinkingLevelAll: (level: string) => Promise<{ success: boolean }>;
    /**
     * 渠道中心：一次性 pi RPC 进程执行 pi-connect 的 `/connect` 命令，
     * 返回扩展的 notify 文本（见 src-tauri/src/pi_connect.rs）。
     * checkin 的结果后跟着一段 status 刷新（复用同一进程）。
     */
    piConnectQuery: (action: "status" | "checkin") => Promise<{
      results: Array<{
        prompt: string;
        success: boolean;
        messages: Array<{
          message: string;
          type: "info" | "warning" | "error" | string;
        }>;
      }>;
    }>;
    /**
     * pi.dev 官方包目录搜索。
     * query 为空 = 不限（返回最热门）；pkgType / sort / page 直接下推给服务端。
     */
    piSearchPackages: (
      query?: string,
      pkgType?: string,
      sort?: string,
      page?: number,
    ) => Promise<{
      packages: Array<{
        name: string;
        description: string;
        version: string;
        type: "extension" | "skill" | "theme" | "prompt" | "package";
        author: string;
        npmUrl: string;
        installCmd: string;
        downloads: number;
        date: string;
        piUrl?: string;
      }>;
      /** 过滤后的总数（服务端筛选后的命中数） */
      total?: number;
      page?: number;
      pageSize?: number;
      source?: string;
    }>;
    piInstallPackage: (pkg: string) => Promise<{
      success: boolean;
      message: string;
      output?: string;
    }>;
    piUninstallPackage: (pkg: string) => Promise<{
      success: boolean;
      message: string;
      output?: string;
    }>;
    piCheckUpdates: () => Promise<{
      pi: {
        installed: string | null;
        latest: string | null;
        hasUpdate?: boolean;
      };
      packages: Array<{
        name: string;
        installed: string;
        latest: string | null;
        hasUpdate?: boolean;
      }>;
    }>;
    /** 检查 Helix 应用自身更新（tauri-plugin-updater，读 GitHub Release 的
     *  latest.json）。离线 / release 尚无清单时 reject，调用方按静默降级处理。 */
    update: () => Promise<{
      available: boolean;
      current?: string;
      version?: string;
      notes?: string | null;
      date?: string | null;
    }>;
    /** 下载并安装 Helix 应用更新。进度经 app_update_progress /
     *  app_update_installing 事件回推；Windows 上安装器拉起后进程退出，
     *  成功路径没有返回值，失败才 reject。 */
    updateInstall: () => Promise<void>;
  };

  profile: {
    cacheConfig: (cfg: {
      model?: string;
      provider?: string;
      baseUrl?: string;
      apiKey?: string;
    }) => Promise<{ success: boolean; error?: string }>;
  };

  git: {
    status: (
      cwd?: string | null,
    ) => Promise<{ ok: boolean; output?: string; error?: string }>;
    diff: (
      filePath?: string,
      staged?: boolean,
    ) => Promise<{ ok: boolean; diff?: string; error?: string }>;
    diffHead: (
      filePath?: string,
    ) => Promise<{ ok: boolean; diff?: string; error?: string }>;
    diffNumstat: (
      cwd?: string | null,
    ) => Promise<{ ok: boolean; output?: string; error?: string }>;
    diffNumstatFull: (
      cwd?: string | null,
    ) => Promise<{
      ok: boolean;
      code?: GitNumstatFailureCode;
      files?: {
        path: string;
        added: number;
        removed: number;
        binary: boolean;
        untracked: boolean;
      }[];
      added?: number;
      removed?: number;
      error?: string;
    }>;
    revert: (filePath?: string) => Promise<{ ok: boolean; error?: string }>;
    stage: (filePath?: string) => Promise<{ ok: boolean; error?: string }>;
    unstage: (filePath?: string) => Promise<{ ok: boolean; error?: string }>;
    commit: (
      message?: string,
    ) => Promise<{ ok: boolean; output?: string; error?: string }>;
    branchList: (
      cwd?: string | null,
    ) => Promise<{ ok: boolean; branches?: string[]; error?: string }>;
    branchSwitch: (
      branch: string,
      cwd?: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    branchCreate: (
      branch: string,
      cwd?: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    currentBranch: (
      cwd?: string | null,
    ) => Promise<{ ok: boolean; branch?: string; error?: string }>;
    log: (
      count?: number,
    ) => Promise<{ ok: boolean; output?: string; error?: string }>;
    // Worktree operations
    worktreeList: () => Promise<{
      ok: boolean;
      worktrees?: Array<{
        path: string;
        head?: string;
        branch?: string;
        bare?: boolean;
        detached?: boolean;
        locked?: boolean;
        prunable?: boolean;
        isMain?: boolean;
      }>;
      error?: string;
    }>;
    worktreeAdd: (opts: {
      path: string;
      branch?: string;
      newBranch?: string;
    }) => Promise<{ ok: boolean; error?: string }>;
    worktreeRemove: (
      wtPath: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    worktreeLock: (wtPath: string) => Promise<{ ok: boolean; error?: string }>;
    worktreeUnlock: (
      wtPath: string,
    ) => Promise<{ ok: boolean; error?: string }>;
    worktreePrune: () => Promise<{ ok: boolean; error?: string }>;
    // Remote operations
    push: (opts?: {
      remote?: string;
      branch?: string;
      force?: boolean;
    }) => Promise<{ ok: boolean; output?: string; error?: string }>;
    pull: (opts?: {
      remote?: string;
      branch?: string;
    }) => Promise<{ ok: boolean; output?: string; error?: string }>;
    fetch: (opts?: {
      remote?: string;
    }) => Promise<{ ok: boolean; output?: string; error?: string }>;
  };

  /**
   * PR 闭环（`src-tauri/src/github.rs`）。装了 gh 就走命令行直建；没装或没登录
   * 也照样把分支推上去并返回 GitHub 的 compare 链接（标题/正文预填），最后一步
   * 在浏览器里点一下。两条路都不需要 Helix 存 token。
   */
  github: {
    ghStatus: (cwd?: string | null) => Promise<{
      ok: boolean;
      available: boolean;
      authenticated: boolean;
      path?: string;
      version?: string;
      hint?: string;
      authError?: string;
      error?: string;
    }>;
    repo: (cwd?: string | null) => Promise<{
      ok: boolean;
      code?: "no_remote" | "bad_remote" | string;
      error?: string;
      host?: string;
      owner?: string;
      repo?: string;
      remoteUrl?: string;
      head?: string | null;
      base?: string;
      uncommitted?: number;
    }>;
    prCreate: (opts?: {
      title?: string;
      body?: string;
      base?: string;
      head?: string;
      draft?: boolean;
      cwd?: string;
    }) => Promise<{
      ok: boolean;
      code?:
        | "uncommitted_changes"
        | "on_base_branch"
        | "detached_head"
        | "push_failed"
        | "gh_unavailable"
        | "no_remote"
        | "bad_remote"
        | string;
      error?: string;
      method?: "gh" | "compare";
      url?: string;
      head?: string;
      base?: string;
      pushed?: boolean;
      ghError?: string;
      files?: string[];
      note?: string;
    }>;
    prList?: (opts?: {
      state?: "open" | "closed" | "merged" | "all";
      limit?: number;
      cwd?: string;
    }) => Promise<{
      ok: boolean;
      code?: string;
      error?: string;
      prs?: Array<{
        number: number;
        title: string;
        url: string;
        headRefName: string;
        baseRefName: string;
        isDraft: boolean;
      }>;
    }>;
  };

  /** 项目自带的类型检查/lint（`src-tauri/src/diagnostics.rs`）。 */
  diagnostics: {
    detect: (cwd?: string | null) => Promise<{
      ok: boolean;
      cwd?: string;
      note?: string;
      checks?: DiagnosticCheck[];
    }>;
    run: (opts?: {
      checkId?: string;
      cwd?: string;
    }) => Promise<DiagnosticRunResult>;
  };

  platform: string;

  // ── External services (server / VM TCP reachability probe) ──
  external: {
    // Real SSH session management (ssh2 in main process; secret decrypted in main).
    sshConnect: (params: {
      host: string;
      port: number | string;
      username: string;
      authType?: "password" | "key";
      secretEncrypted?: boolean;
      secret: string;
    }) => Promise<{ ok: boolean; error?: string; banner?: string }>;
    onSshConnected: (
      cb: (data: { host: string; username: string }) => void,
    ) => () => void;
  };

  isElectron: boolean;

  // ── Hooks (written into Helix' config.yaml `hooks:` block; backend fires them) ──
  hooks: {
    getConfig: () => Promise<{
      ok: boolean;
      config?: HooksConfig;
      error?: string;
    }>;
    setConfig: (
      config: HooksConfig,
    ) => Promise<{ ok: boolean; error?: string }>;
  };

  // ── Image-generation model (config.yaml `image:` block) ───────────────
  image: {
    getConfig: () => Promise<{
      ok: boolean;
      config?: {
        provider: string;
        model: string;
        baseUrl: string;
        apiKey: string;
      };
      error?: string;
    }>;
    setConfig: (config: {
      provider: string;
      model: string;
      baseUrl: string;
      apiKey: string;
    }) => Promise<{ ok: boolean; error?: string }>;
  };

  // ── 联网搜索（config.yaml `web_search:` 块，供 web-access 扩展消费）─────
  // 后端只回「有没有 key / key 由什么提供」，值一个字节都不出来，所以这里也
  // 不存在展示密钥的可能。
  webSearch: {
    getConfig: () => Promise<{
      ok: boolean;
      /**
       * 文件里存着「扩展认、但 Helix 不再配置」的档位（遗留 perplexity）时非空。
       * Helix 只走 Tavily，所以没有档位可选，这一项只用于如实播报生效值。
       */
      unmanagedSearchProvider?: string;
      secrets?: Record<
        "tavilyApiKey",
        {
          configured: boolean;
          /** none | literal | env | command —— env/command 不是密钥本身 */
          source: "none" | "literal" | "env" | "command";
          envVar: string | null;
          /** 环境变量优先级高于这份文件，所以要单独告知当前进程里有没有 */
          processEnvSet: boolean;
        }
      >;
      configPath?: string;
      extensionLoaded?: boolean;
      extensionPackage?: string | null;
      restartNeeded?: boolean;
      error?: string;
    }>;
    /** 字段缺省 = 不改这一项；空串 = 清除。密钥不回显，所以必须这么约定。 */
    setConfig: (config: { tavilyApiKey?: string }) => Promise<{
      ok: boolean;
      changedKeys?: string[];
      configPath?: string;
      error?: string;
    }>;
  };
}

declare global {
  interface Window {
    // Non-optional: runtime access is always guarded by `isElectron()`, and a
    // non-optional type avoids forcing `window.electron?.…` / non-null assertions
    // at every single call site across the codebase.
    electron: ElectronAPI;
  }
}

export {};

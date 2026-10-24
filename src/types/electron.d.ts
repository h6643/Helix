import type { HooksConfig } from "@/lib/hooks-config";
import type { McpServerConfig, ScheduledTask } from "@/stores/helix-types";
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
    /** 按字节读文件，返回 base64（侧栏文档/媒体预览用，走 `fs:read_binary`）。 */
    readBinary: (filePath: string) => Promise<string>;
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
    /** 本机 PowerPoint COM 导出 PPTX 逐页 PNG（base64）。可选：旧 preload /
     *  非 Windows 没有这条通道，调用方需降级。 */
    exportSlidesPng?: (filePath: string) => Promise<{ slides: string[] }>;
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
    /** 开关技能「模型自动调用」（翻转 SKILL.md frontmatter 的
     *  `disable-model-invocation`）。返回值 `disabled` 是修改后的状态。 */
    setSkillModelInvocation: (skillPath: string, enabled: boolean) =>
      Promise<{ changed: boolean; disabled: boolean } | null>;
    /** 开关技能「启用 / 禁用」（正文文件在 SKILL.md ↔ SKILL.md.disabled
     *  之间改名，禁用后 pi 根本不加载）。返回值 `enabled` 是修改后的状态。 */
    setSkillEnabled: (skillPath: string, enabled: boolean) =>
      Promise<{ changed: boolean; enabled: boolean; deferred: boolean } | null>;
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
    /** 远程项目的后台任务：SSH 读远端 ~/.pi/agent/tasks.json。 */
    remoteList: (params: {
      host: string;
      port: number;
      username: string;
      auth_type?: string;
      secret?: string;
    }) => Promise<{
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
      error?: string;
    }>;
  };

  // Delegations（src-tauri/src/delegations.rs）。wire 形状来自 .pi/state/
  // delegations.json，消费方（agent-work-panel / delegations-panel）各自维护
  // 本地 `Delegation` 接口并自行 cast —— 所以这里只声明信封字段，不重复建模。
  delegations: {
    // 传一个 sid，或传「这个对话历史上用过的全部 sid」——后端
    // delegations_list 两种都接（session/new、restart 后的 resume 都会换 sid）。
    list: (sessionId?: string | string[]) => Promise<{
      ok: boolean;
      delegations?: unknown[];
      error?: string;
    }>;
    readLog: (path: string, lines?: number) => Promise<{
      ok: boolean;
      content?: string;
      error?: string;
    }>;
    // pi-subagents 子代理的 .output 转录时间线。agentId 是扩展自己的子代理 id；
    // cwd/sessionId 用于直捣转录目录，缺失时后端全盘扫描兜底。
    timeline: (
      agentId: string,
      cwd?: string,
      sessionId?: string,
      tail?: number,
    ) => Promise<{
      ok: boolean;
      found: boolean;
      entries?: unknown[];
      error?: string;
    }>;
  };

  // 父 Agent 工具调用 id → 扩展子代理 id 的映射（+ 当前状态），供侧边栏把
  // 实时卡片定位到对应的 .output 转录。
  subagentMap: {
    list: (sessionId?: string) => Promise<{
      ok: boolean;
      agents?: unknown[];
      error?: string;
    }>;
  };

  scheduledTasks: {
    list: () => Promise<{
      ok: boolean;
      tasks?: ScheduledTask[];
      error?: string;
    }>;
    // 字段集合照 scheduled_tasks.rs 的 create()：只读 name / prompt /
    // cronExpression / nextRunAt / sessionMode。scheduleText 不在其中（后端按
    // cron 自己渲染展示串），调用点传了也只是随行数据。
    create: (params: {
      name?: string;
      prompt?: string;
      scheduleText?: string;
      cronExpression?: string;
      nextRunAt?: number;
      /** 缺省 fresh（认不出的值也当 fresh）。 */
      sessionMode?: "fresh" | "reuse";
    }) => Promise<{
      ok: boolean;
      id?: string;
      nextRunAt?: number | null;
      error?: string;
    }>;
    // update() 是「显式传了才改」的 partial update：缺省 enabled 不会把任务
    // 意外暂停。
    update: (params: {
      id: string;
      enabled?: boolean;
      sessionMode?: "fresh" | "reuse";
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
      handoffEnabled?: boolean;
      configPath?: string;
      error?: string;
    }>;
    /** 只提交要改的键；返回体里的四个字段是回读到的**生效值**（写失败时 UI 不撒谎）。 */
    setNotificationConfig: (updates: {
      turnEndMode?: string;
      approvalEnabled?: boolean;
      clarifyEnabled?: boolean;
      handoffEnabled?: boolean;
    }) => Promise<{
      ok: boolean;
      turnEndMode?: string;
      approvalEnabled?: boolean;
      clarifyEnabled?: boolean;
      handoffEnabled?: boolean;
      changed?: string[];
      error?: string;
    }>;
    /** 系统侧到底让不让弹。两个值都可能是 null = 注册表里没写过（Windows 只在用户
     *  手动关掉时才写），缺省按「开」解释。`aumid` 是这条 toast 实际带出去的身份：
     *  dev 下插件不设身份、系统兜底成 PowerShell，所以那时查的是 PowerShell 的开关。 */
    notificationStatus: () => Promise<{
      ok: boolean;
      aumid?: string;
      dev?: boolean;
      systemEnabled?: boolean | null;
      appEnabled?: boolean | null;
      error?: string;
    }>;
    /** 跳到系统的通知设置页（Windows 走 ms-settings URI）。 */
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
      auth_type?: string;
      secret?: string;
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
      auth_type?: string;
      secret?: string;
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
      auth_type?: string;
      secret?: string;
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
     *  文件里可分三层（全局 / 本项目 / 本会话），覆盖表也在同一个文件里，由扩展
     *  自己按「会话 → 项目 → 全局」解析 —— 见 `PermissionModeView`。
     *  **Helix 的界面只写 session 那一层**（档位只影响当前对话）；global 只在首次
     *  建文件时由前端落一次默认档，project 那层界面已不再暴露。 */
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
      models: Array<{
        id: string;
        contextWindow?: number;
        reasoning?: boolean;
        input?: string[];
      }>;
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
    // 高级 pi 设置（settings.json 的 retry / compaction / 思考 / 模型循环 /
    // 缓存 / 队列 / 工具集）。get 回来的值已按 pi 文档补齐默认值，
    // __present 标出哪些键是文件里真的写了。
    piAdvancedConfig: () => Promise<{
      ok: boolean;
      settings?: Record<string, unknown>;
      error?: string;
    }>;
    piAdvancedSet: (updates: Record<string, unknown>) => Promise<{
      ok: boolean;
      changed?: boolean;
      written?: number;
      error?: string;
      errors?: string[];
    }>;
    // 项目信任：Helix 只决定 spawn pi 时加不加 --approve / --no-approve。
    // 只保留 always/never 两档（RPC 模式无法交互询问，ask 等同 never）。
    projectTrust: () => Promise<{
      ok: boolean;
      mode: "always" | "never";
      error?: string;
    }>;
    setProjectTrust: (
      mode: "always" | "never",
    ) => Promise<{ ok: boolean; mode?: string; error?: string }>;
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
    /**
     * pi **扩展**注册的斜杠命令（`get_commands` 里 `source == "extension"` 的
     * 子集）：`/connect` 这类命令由扩展在运行期注册，前端 `/` 菜单要靠它才会
     * 出现。命令本体仍由 pi 的 prompt() 执行，前端不需要执行通道。
     */
    piListCommands: () => Promise<{
      commands: Array<{ name: string; description: string }>;
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
    /** 自动压缩开关广播：开启/关闭 pi 的回合内阈值压缩（压缩后继续任务）。 */
    piSetAutoCompactionAll: (enabled: boolean) => Promise<{ success: boolean }>;
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
      cwd?: string | null,
    ) => Promise<{ ok: boolean; diff?: string; error?: string }>;
    diffHead: (
      filePath?: string,
      context?: number,
      cwd?: string | null,
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
    revert: (
      filePath?: string,
      cwd?: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    stage: (
      filePath?: string,
      cwd?: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    unstage: (
      filePath?: string,
      cwd?: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    commit: (
      message?: string,
      cwd?: string | null,
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
      cwd?: string | null,
    ) => Promise<{ ok: boolean; output?: string; error?: string }>;
    // Worktree operations
    worktreeList: (cwd?: string | null) => Promise<{
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
      cwd?: string | null;
    }) => Promise<{ ok: boolean; error?: string }>;
    worktreeRemove: (
      wtPath: string,
      cwd?: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    worktreeLock: (
      wtPath: string,
      cwd?: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    worktreeUnlock: (
      wtPath: string,
      cwd?: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    worktreePrune: (
      cwd?: string | null,
    ) => Promise<{ ok: boolean; error?: string }>;
    // Remote operations
    push: (opts?: {
      remote?: string;
      branch?: string;
      force?: boolean;
      cwd?: string | null;
    }) => Promise<{ ok: boolean; output?: string; error?: string }>;
    pull: (opts?: {
      remote?: string;
      branch?: string;
      cwd?: string | null;
    }) => Promise<{ ok: boolean; output?: string; error?: string }>;
    fetch: (opts?: {
      remote?: string;
      cwd?: string | null;
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
    // 运行时自检（app.rs get_status）：版本 / 平台 / 架构 / pid。
    getStatus: () => Promise<{
      version: string;
      platform: string;
      arch: string;
      pid: number;
    }>;
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

  // ── 窗口控制（标题栏用；bridge 里 api.window = {...}）────────────────
  window: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    unmaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    toggleDevTools: () => Promise<void>;
    newWindow: () => Promise<void>;
    onMaximizedChange: (
      cb: (maximized: boolean) => void,
    ) => () => void;
  };

  // ── 视觉模型（config.yaml `auxiliary.vision` 块）─────────────────────
  vision: {
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
    describe: (image: string, prompt?: string) => Promise<string>;
  };

  // ── 网关 MCP servers（config.yaml `mcp_servers:` 块，读写）──────────
  mcpConfig: {
    list: (includeEnv?: boolean) => Promise<{
      ok: boolean;
      servers?: Record<string, McpServerConfig>;
      error?: string;
    }>;
    save: (
      servers: Record<string, McpServerConfig>,
    ) => Promise<{ ok: boolean; error?: string }>;
  };

  // ── 子 agent 设置（config.yaml `subagents:` 块，存写时同步镜像到扩展
  //     的 settings.json）───────────────────────────────────────────────
  subagentsConfig: {
    list: () => Promise<{ ok: boolean; settings?: SubagentsSettings }>;
    save: (settings: SubagentsSettings) => Promise<{ ok: boolean; error?: string }>;
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
      /** @deprecated 用 extensionStatus；保留是为了旧调用点不缺字段。 */
      extensionLoaded?: boolean;
      /**
       * web-access 扩展的装载四态（后端按 pi 的发现规则判：
       * 目录自动发现 + `extensions` override，**不是**只看 packages）：
       * - loaded：pi 会加载它（工具在跑）；
       * - disabled：磁盘上有、但被扩展开关关掉 ⇒ 该去打开，不是去安装；
       * - absent：确实没找到 ⇒ 该去安装；
       * - unknown：连扩展根目录都读不到 ⇒ 不下结论，面板不报警。
       */
      extensionStatus?: "loaded" | "disabled" | "absent" | "unknown";
      extensionPackage?: string | null;
      extensionKnown?: boolean;
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

/** `subagents:` 块的内容。字段集合由后端定义，前端只原样透传。 */
export type SubagentsSettings = Record<string, unknown>;

export {};

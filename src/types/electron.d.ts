import type { HooksConfig } from "@/lib/hooks-config";
import type { ScheduledTask } from "@/stores/helix-store";

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
  };

  helixSkills: {
    getDir: () => Promise<string | null>;
    readdir: (
      dirPath: string,
    ) => Promise<Array<{ name: string; isDirectory: boolean }>>;
    readFile: (filePath: string) => Promise<string | null>;
    deleteDir: (dirPath: string) => Promise<boolean>;
    listSkills: () => Promise<any>;
    trackSkillCall: (skillName: string) => Promise<number>;
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
    setWorkDir: (dir: string) => Promise<{ success: boolean; workDir: string }>;
    syncWorkDir: (
      dir: string,
    ) => Promise<{ success: boolean; workDir: string }>;
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
    piSetThinkingLevelAll: (level: string) => Promise<{ success: boolean }>;
    piSearchPackages: (query: string) => Promise<{
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
      }>;
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

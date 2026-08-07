import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { ElectronAPI } from '@/types/electron'

/**
 * Tauri 运行时桥：把 `window.electron`（Electron contextBridge 的形状）映射到
 * Tauri v2 的 `invoke` 通道。Rust 命令默认用函数名（snake_case），参数键默认
 * camelCase——本桥统一转译，让前端代码完全无感。
 *
 * 事件：Rust 端统一 `app.emit("hermes:event", { method, params })`，本桥订阅一次
 * 后按 method 原样分发给所有 `hermes.onEvent` 回调（与 Electron 的推送一致）。
 */

let installed = false
const eventListeners = new Set<(method: string, params?: unknown) => void>()
const terminalListeners = new Set<(data: string) => void>()
let unlistenPromise: Promise<UnlistenFn> | null = null
let terminalUnlistenPromise: Promise<UnlistenFn> | null = null

/** 检测是否运行在 Tauri 环境。 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function subscribeHermesEvents(): Promise<void> {
  if (unlistenPromise) return
  unlistenPromise = (async () => {
    try {
      return await listen('hermes:event', (event) => {
        const payload = event.payload as { method?: string; params?: unknown }
        if (typeof payload?.method !== 'string') return
        const params = payload.params
        for (const cb of eventListeners) {
          try {
            cb(payload.method, params)
          } catch {
            /* listener threw — don't break the dispatch loop */
          }
        }
      })
    } catch (e) {
      console.error('[tauri-bridge] 订阅 hermes:event 失败:', e)
      return () => {}
    }
  })()
}

async function subscribeTerminalEvents(): Promise<void> {
  if (terminalUnlistenPromise) return
  terminalUnlistenPromise = (async () => {
    try {
      return await listen('terminal:data', (event) => {
        const data = typeof event.payload === 'string' ? event.payload : String(event.payload ?? '')
        for (const cb of terminalListeners) {
          try {
            cb(data)
          } catch {
            /* listener threw — keep dispatching to the rest */
          }
        }
      })
    } catch (e) {
      console.error('[tauri-bridge] 订阅 terminal:data 失败:', e)
      return () => {}
    }
  })()
}

function onTerminalData(callback: (data: string) => void): () => void {
  terminalListeners.add(callback)
  void subscribeTerminalEvents()
  return () => {
    terminalListeners.delete(callback)
  }
}

/** 返回取消订阅函数（同步，符合 Electron onEvent 的形状）。 */
function onHermesEvent(callback: (method: string, params?: unknown) => void): () => void {
  eventListeners.add(callback)
  void subscribeHermesEvents()
  return () => {
    eventListeners.delete(callback)
  }
}

/** 最大化状态监听：Tauri 没有原生 maximized 事件，用 resize 事件触发后轮询。
 * 返回同步取消函数，兼容 Electron win.onMaximizedChange。 */
function onMaximizedChange(callback: (maximized: boolean) => void): () => void {
  let last: boolean | null = null
  let cancelled = false
  let unlistenResize: UnlistenFn | null = null

  const check = async () => {
    try {
      const maximized = await getCurrentWindow().isMaximized()
      if (cancelled) return
      if (last !== null && maximized !== last) {
        try { callback(maximized) } catch { /* listener threw */ }
      }
      last = maximized
    } catch { /* window gone — ignore */ }
  }

  void getCurrentWindow()
    .onResized(() => { void check() })
    .then((unlisten) => { if (cancelled) unlisten() as unknown; else unlistenResize = unlisten })
    .catch(() => {})
  void check()

  return () => {
    cancelled = true
    if (unlistenResize) {
      try { unlistenResize() } catch { /* noop */ }
      unlistenResize = null
    }
  }
}

function stubError(message: string) {
  return { ok: false, error: message }
}

function buildTauriAPI(): ElectronAPI {
  const api: Record<string, unknown> = {}

  // ── fs ──────────────────────────────────────────────────────────────────
  api.fs = {
    read: (filePath: string) => invoke('read', { filePath }),
    write: (filePath: string, content: string) => invoke('write', { filePath, content }),
    edit: (filePath: string, oldString: string, newString: string) => invoke('edit', { filePath, oldString, newString }),
    readdir: (dirPath: string) => invoke('readdir', { dirPath }),
    hermesMemoryDir: () => invoke('hermes_memory_dir'),
    stat: (filePath: string) => invoke('stat', { filePath }),
    rename: (oldPath: string, newPath: string) => invoke('rename', { oldPath, newPath }),
    delete: (filePath: string) => invoke('delete', { filePath }),
    scanTree: (dirPath?: string) => invoke('scan_tree', { relativePath: dirPath ?? null }),
    allowRoot: (dirPath: string) => invoke('allow_root', { dir: dirPath }),
  }

  // ── hermesSkills ────────────────────────────────────────────────────────
  api.hermesSkills = {
    getDir: () => invoke('hermes_get_skills_dir'),
    getPluginsDir: () => invoke('hermes_get_plugins_dir'),
    readdir: (dirPath: string) => invoke('hermes_read_dir', { dirPath }),
    readFile: (filePath: string) => invoke('hermes_read_file', { filePath }),
    deleteDir: (dirPath: string) => invoke('hermes_delete_dir', { dirPath }),
    listSkills: () => invoke('hermes_list_skills'),
    trackSkillCall: (skillName: string) => invoke('hermes_track_skill_call', { skillName }),
  }

  // ── shell ───────────────────────────────────────────────────────────────
  api.shell = {
    open: (target: string) => invoke('open', { target }),
    showItemInFolder: (relativePath: string) => invoke('show_item_in_folder', { relativePath }),
    openPath: (dir: string) => invoke('open_path', { dir }),
  }

  // ── terminal ───────────────────────────────────────────────────────────
  api.terminal = {
    start: (cols?: number, rows?: number, cwd?: string) =>
      invoke('terminal_start', {
        cols: cols ?? null,
        rows: rows ?? null,
        cwd: cwd ?? null,
      }),
    write: (command: string) => {
      void invoke('terminal_write', { data: command }).catch(() => {})
    },
    resize: (cols: number, rows: number) => {
      void invoke('terminal_resize', { cols, rows }).catch(() => {})
    },
    kill: () => invoke('terminal_kill'),
    onData: onTerminalData,
  }

  // ── secure ──────────────────────────────────────────────────────────────
  api.secure = {
    available: () => invoke('secure_available'),
    encrypt: (plaintext: string) => invoke('secure_encrypt', { plaintext }),
    decrypt: (blob: string) => invoke('secure_decrypt', { blob }),
  }

  // ── scheduledTasks ──────────────────────────────────────────────────────
  api.scheduledTasks = {
    list: () => invoke('scheduled_tasks_list'),
    create: (params: unknown) => invoke('create', { params }),
    update: (params: unknown) => invoke('update', { params }),
    remove: (params: unknown) => invoke('remove', { params }),
  }

  // ── dialog ──────────────────────────────────────────────────────────────
  api.dialog = {
    openDirectory: (defaultPath?: string) => invoke('open_directory', { defaultPath: defaultPath ?? null }),
    openFile: (options?: unknown) => invoke('open_file', { options: options ?? null }),
    saveFile: (options?: unknown) => invoke('save_file', { options: options ?? null }),
  }

  // ── app ─────────────────────────────────────────────────────────────────
  api.app = {
    getInfo: () => invoke('get_info'),
    setWorkDir: (dir: string) => invoke('set_work_dir', { dir }),
    syncWorkDir: (dir: string) => invoke('sync_work_dir', { dir }),
    getHermesVersion: () => invoke('get_hermes_version'),
  }

  // ── hermes ──────────────────────────────────────────────────────────────
  api.hermes = {
    send: (method: string, params?: unknown) => invoke('hermes_send', { method, params: params ?? null }),
    notify: (method: string, params?: unknown) => {
      void invoke('hermes_notify', { method, params: params ?? null })
    },
    interrupt: (sessionId: string) => invoke('hermes_interrupt', { sessionId }),
    status: () => invoke('hermes_status'),
    getGatewayInfo: () => invoke('hermes_get_gateway_info'),
    setConfig: (config: unknown) => invoke('hermes_set_config', { config }),
    getConfig: () => invoke('hermes_get_config'),
    getRawConfig: () => invoke('hermes_get_raw_config'),
    setRawConfig: (patch: unknown) => invoke('hermes_set_raw_config', { patch }),
    getMemoryStatus: () => invoke('hermes_get_memory_status'),
    getMemoryProviderConfig: (name: string) => invoke('hermes_get_memory_provider_config', { name }),
    setMemoryProviderConfig: (name: string, values: Record<string, unknown>) =>
      invoke('hermes_set_memory_provider_config', { name, values }),
    setYamlKey: (key: string, value: unknown) => invoke('hermes_set_yaml_key', { key, value }),
    setDelegationIdentities: (identities: unknown) => invoke('hermes_set_delegation_identities', { identities }),
    listPersonalities: () => invoke('hermes_list_personalities'),
    setPersonality: (params: unknown) => invoke('hermes_set_personality', { params }),
    setModel: (params: unknown) => invoke('hermes_set_model', { params }),
    setAgentConfig: (params: unknown) => invoke('hermes_set_agent_config', { params }),
    setReasoningEffort: (params: unknown) => invoke('hermes_set_reasoning_effort', { params }),
    fetchModels: (params: { baseUrl: string; apiKey: string }) =>
      invoke('hermes_fetch_models', { baseUrl: params.baseUrl, apiKey: params.apiKey }),
    onEvent: onHermesEvent,
    listMemories: () => invoke('hermes_list_memories'),
    addMemoryEntry: (target: 'memory' | 'user', text: string) => invoke('hermes_add_memory_entry', { target, text }),
    removeMemoryEntry: (target: 'memory' | 'user', text: string) => invoke('hermes_remove_memory_entry', { target, text }),
    setConfigKeyValue: (params: unknown) => invoke('hermes_set_config_key_value', { params }),
    approvalRespond: (params: unknown) => invoke('hermes_approval_respond', { params }),
    update: () => invoke('hermes_update'),
    installPlugin: (identifier: string, force?: boolean) =>
      invoke('hermes_install_plugin', { identifier, force: force ?? false }),
    cronList: () => invoke('hermes_cron_list'),
    cronCreate: (schedule: string, command: string, name?: string) =>
      invoke('hermes_cron_create', { schedule, command, name: name ?? null }),
    cronDelete: (jobId: string) => invoke('hermes_cron_delete', { jobId }),
    cronRun: (jobId: string) => invoke('hermes_cron_run', { jobId }),
    doctor: () => invoke('hermes_doctor'),
  }

  // ── profile ─────────────────────────────────────────────────────────────
  api.profile = {
    cacheConfig: (cfg: unknown) => invoke('cache_config', { cfg }),
  }

  // ── git ─────────────────────────────────────────────────────────────────
  api.git = {
    status: (cwd?: string | null) => invoke('status', { targetCwd: cwd ?? null }),
    diff: (filePath?: string, staged?: boolean) => invoke('diff', { filePath: filePath ?? null, staged: staged ?? null }),
    diffHead: (filePath?: string) => invoke('diff_head', { filePath: filePath ?? null }),
    revert: (filePath?: string) => invoke('revert', { filePath: filePath ?? null }),
    stage: (filePath?: string) => invoke('stage', { filePath: filePath ?? null }),
    unstage: (filePath?: string) => invoke('unstage', { filePath: filePath ?? null }),
    commit: (message?: string) => invoke('commit', { message: message ?? null }),
    branchList: (cwd?: string | null) => invoke('branch_list', { targetCwd: cwd ?? null }),
    branchSwitch: (branch: string, cwd?: string | null) => invoke('branch_switch', { branch, targetCwd: cwd ?? null }),
    branchCreate: (branch: string, cwd?: string | null) => invoke('branch_create', { branch, targetCwd: cwd ?? null }),
    currentBranch: (cwd?: string | null) => invoke('current_branch', { targetCwd: cwd ?? null }),
    log: (count?: number) => invoke('log', { count: count ?? null }),
    worktreeList: () => invoke('worktree_list'),
    worktreeAdd: (opts: unknown) => invoke('worktree_add', { opts }),
    worktreeRemove: (wtPath: string) => invoke('worktree_remove', { wtPath }),
    worktreeLock: (wtPath: string) => invoke('worktree_lock', { wtPath }),
    worktreeUnlock: (wtPath: string) => invoke('worktree_unlock', { wtPath }),
    worktreePrune: () => invoke('worktree_prune'),
    push: (opts?: unknown) => invoke('push', { opts: opts ?? null }),
    pull: (opts?: unknown) => invoke('pull', { opts: opts ?? null }),
    fetch: (opts?: unknown) => invoke('fetch', { opts: opts ?? null }),
  }

  // ── external (TCP probe implemented; SSH not ported to Tauri yet) ──────
  api.external = {
    testConnection: (host: string, port: number | string, timeoutMs?: number) =>
      invoke('test_connection', { host, port, timeoutMs: timeoutMs ?? null }),
    sshConnect: () => Promise.resolve(stubError('SSH 会话在 Linux Tauri 版暂不可用')),
    sshExec: () => Promise.resolve(stubError('SSH 会话在 Linux Tauri 版暂不可用')),
    sshStatus: () => Promise.resolve({ connected: false }),
    sshDisconnect: () => Promise.resolve({ ok: true }),
    onSshConnected: () => () => {},
    onSshList: () => () => {},
  }

  // ── email (not ported) ──────────────────────────────────────────────────
  api.email = {
    configure: () => Promise.resolve({ configured: false }),
    getConfig: () => Promise.resolve({ configured: false }),
    list: () => Promise.resolve({ ok: false, messages: [], error: 'Email 功能在 Linux Tauri 版暂不可用' }),
    get: () =>
      Promise.resolve({ uid: 0, subject: '', from: '', to: '', date: 0, text: '', html: '', attachments: [] }),
    send: () => Promise.resolve({ accepted: [], messageId: '' }),
    notify: () => Promise.resolve({ accepted: [], messageId: '' }),
    test: () =>
      Promise.resolve({
        ok: false,
        imap: { ok: false, message: 'Email 功能暂不可用' },
        smtp: { ok: false, message: 'Email 功能暂不可用' },
        debug: { user: '', authCodeLength: 0 },
      }),
  }

  // ── hooks ───────────────────────────────────────────────────────────────
  api.hooks = {
    getConfig: () => invoke('hooks_list'),
    setConfig: (config: unknown) => invoke('hooks_save', { config }),
  }

  // ── kanban ──────────────────────────────────────────────────────────────
  api.kanban = {
    invoke: (verb: string, args?: string[], json?: boolean, board?: string) =>
      invoke('command', { params: { verb, args: args ?? [], json: json ?? false, board: board ?? '' } }),
  }

  // ── diagnostics ─────────────────────────────────────────────────────────
  api.diagnostics = {
    getStatus: () => invoke('get_status'),
  }

  // ── window controls (used by title bar) ─────────────────────────────────
  api.window = {
    minimize: () => invoke('minimize'),
    maximize: () => invoke('maximize'),
    unmaximize: () => invoke('unmaximize'),
    close: () => invoke('close'),
    isMaximized: () => invoke('is_maximized'),
    toggleDevTools: () => invoke('toggle_devtools'),
    newWindow: () => invoke('new_window'),
    startDrag: () => invoke('start_drag'),
    onMaximizedChange,
  }

  // ── top-level fields ────────────────────────────────────────────────────
  api.platform = 'linux'
  api.isElectron = true

  return api as unknown as ElectronAPI
}

/**
 * 安装 Tauri 桥：把 `window.electron` 填成 Tauri invoke 的实现。幂等。
 * 在 Electron / 浏览器里调用是 no-op。
 */
export function installTauriBridge(): void {
  if (installed) return
  if (!isTauri()) return
  installed = true
  ;(window as unknown as { electron: ElectronAPI }).electron = buildTauriAPI()
  void subscribeHermesEvents()
}

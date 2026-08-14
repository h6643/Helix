import type { HooksConfig } from '@/lib/hooks-config'
import type { ScheduledTask } from '@/stores/helix-store'

export interface MemoryProviderInfo {
  name: string
  description?: string
  available: boolean
  configured: boolean
  status: 'missing' | 'unavailable' | 'needs_config' | 'ready'
}

export interface MemoryProviderField {
  key: string
  label: string
  kind: 'text' | 'secret' | 'select' | 'bool' | 'number' | 'json'
  description: string
  placeholder: string
  required: boolean
  value: string | number | boolean
  is_set: boolean
  options?: Array<{ value: string; label: string; description?: string }>
  url?: string
  when?: unknown
}

export interface ElectronAPI {
  fs: {
    read: (filePath: string) => Promise<string>
    write: (filePath: string, content: string) => Promise<{ success: boolean }>
    edit: (filePath: string, oldString: string, newString: string) => Promise<{ success: boolean }>
    readdir: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean }>>
    hermesMemoryDir: () => Promise<string>
    stat: (filePath: string) => Promise<{
      isFile: boolean
      isDirectory: boolean
      size: number
      mtime: number
    }>
    rename: (oldPath: string, newPath: string) => Promise<{ success: boolean }>
    delete: (filePath: string) => Promise<{ success: boolean }>
    scanTree: (dirPath?: string) => Promise<Array<{ id: string; name: string; type: 'file' | 'folder'; children?: any[] }>>
    allowRoot: (dirPath: string) => Promise<{ success: boolean }>
  }

  hermesSkills: {
    getDir: () => Promise<string | null>
    getPluginsDir: () => Promise<string | null>
    readdir: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean }>>
    readFile: (filePath: string) => Promise<string | null>
    deleteDir: (dirPath: string) => Promise<boolean>
    listSkills: () => Promise<any>
    trackSkillCall: (skillName: string) => Promise<number>
  }

  shell: {
    open: (target: string) => Promise<void>
    showItemInFolder: (fullPath: string) => Promise<void>
    openPath: (dir: string) => Promise<void>
  }

  secure: {
    available: () => Promise<boolean>
    /** Returns base64 ciphertext, or null if safeStorage is unavailable. */
    encrypt: (plaintext: string) => Promise<string | null>
    /** Returns plaintext, or null if decryption failed / unavailable. */
    decrypt: (b64: string) => Promise<string | null>
  }

  terminal: {
    start: (cols?: number, rows?: number, cwd?: string) => Promise<{ ok: boolean; error?: string }>
    write: (command: string) => void
    resize: (cols: number, rows: number) => void
    kill: () => Promise<{ ok: boolean }>
    onData: (callback: (data: string) => void) => () => void
  }

  scheduledTasks: {
    list: () => Promise<{ ok: boolean; tasks?: ScheduledTask[]; error?: string }>
    create: (params: { name?: string; prompt?: string; scheduleText?: string; cronExpression?: string; nextRunAt?: number }) => Promise<{ ok: boolean; id?: string; nextRunAt?: number | null; error?: string }>
    update: (params: { id: string; enabled: boolean }) => Promise<{ ok: boolean; error?: string }>
    remove: (params: { id: string }) => Promise<{ ok: boolean; error?: string }>
  }

  dialog: {
    openDirectory: (defaultPath?: string) => Promise<string | null>
    openFile: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
    saveFile: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
  }

  app: {
    getInfo: () => Promise<{ version: string; platform: string; workDir: string }>
    setWorkDir: (dir: string) => Promise<{ success: boolean; workDir: string }>
    syncWorkDir: (dir: string) => Promise<{ success: boolean; workDir: string }>
    getHermesVersion: () => Promise<string | null>;
    getDataRoot: () => Promise<{ dataRoot: string; dataRootDefault: string; dataRootCustom: boolean }>;
    setDataRoot: (path: string) => Promise<{ success: boolean; dataRoot: string; dataRootDefault: string; dataRootCustom: boolean; copied: boolean; bytes?: number }>;
    proxyGet: () => Promise<{ url: string }>;
    proxySet: (url: string) => Promise<{ success: boolean; url: string }>;
  }

  hermes: {
    send: (method: string, params?: any) => Promise<any>
    notify: (method: string, params?: any) => void
    interrupt: (sessionId: string) => Promise<any>
    status: () => Promise<any>
    // Gateway connection info (serve-migration Phase 1).
    // acp mode  → { mode:'acp' }
    // serve mode→ { mode:'serve', port, token, baseUrl, wsUrl } or { mode:'serve', pending:true }
    getGatewayInfo: () => Promise<{ mode: 'acp' } | { mode: 'serve'; pending?: boolean; port?: number; token?: string; baseUrl?: string; wsUrl?: string }>
    setConfig: (config: any) => Promise<any>
    getConfig: () => Promise<any>
    // Raw config.yaml read/write via the gateway REST API (memory/compression settings).
    getRawConfig: () => Promise<{ ok: boolean; config?: Record<string, any>; error?: string }>
    setRawConfig: (patch: Record<string, any>) => Promise<{ ok: boolean; error?: string }>
    // External memory provider config (serve gateway /api/memory/*).
    getMemoryStatus: () => Promise<{
      ok: boolean
      status?: {
        active: string
        providers: Array<MemoryProviderInfo>
        builtin_files: Record<string, number>
      }
      error?: string
    }>
    getMemoryProviderConfig: (name: string) => Promise<{
      ok: boolean
      config?: { name: string; label?: string; fields: MemoryProviderField[]; setup?: any }
      error?: string
    }>
    setMemoryProviderConfig: (name: string, values: Record<string, any>) => Promise<{
      ok: boolean
      result?: any
      error?: string
    }>
    memoryProviderSetup: (name: string) => Promise<{
      ok: boolean
      result?: any
      error?: string
    }>
    setYamlKey: (key: string, value: any) => Promise<any>
    setDelegationIdentities: (identities: Array<{ name: string; system_prompt: string }>) => Promise<{ success: boolean; changed?: boolean; error?: string }>
    listPersonalities: () => Promise<any>
    setPersonality: (params: { name: string; prompt?: string }) => Promise<any>
    setModel: (params: { model: string; baseUrl?: string; apiKey?: string; provider?: string }) => Promise<any>
    setAgentConfig: (params: { reasoningEffort?: string; personality?: string; fastMode?: boolean }) => Promise<any>
    // Fast path: persist agent.reasoning_effort without a gateway restart.
    setReasoningEffort: (params: { reasoningEffort: string }) => Promise<any>
    fetchModels: (params: any) => Promise<any>
    onEvent: (callback: (method: any, params: any) => void) => () => void
    // ── Memory sync (Hermes backend memory_manager: MEMORY.md / USER.md) ──
    listMemories: () => Promise<{ memory: string[]; user: string[]; manual: string[] }>
    addMemoryEntry: (target: 'memory' | 'user', text: string) => Promise<{ ok: boolean; entries?: string[]; error?: string }>
    removeMemoryEntry: (target: 'memory' | 'user', text: string) => Promise<{ ok: boolean; entries?: string[] }>
    // External memory provider auto-install (spawns `hermes plugins install`).
    installPlugin: (identifier: string, force?: boolean) => Promise<{
      ok: boolean
      message?: string
      error?: string
    }>
    cronList: () => Promise<{ success: boolean; jobs?: unknown; error?: string }>
    cronCreate: (schedule: string, command: string, name?: string) => Promise<{ success: boolean; output?: string; error?: string }>
    cronDelete: (jobId: string) => Promise<{ success: boolean; output?: string; error?: string }>
    cronRun: (jobId: string) => Promise<{ success: boolean; output?: string; error?: string }>
    doctor: () => Promise<{ success: boolean; output?: string; error?: string }>
  }

  profile: {
    cacheConfig: (cfg: { model?: string; provider?: string; baseUrl?: string; apiKey?: string }) => Promise<{ success: boolean; error?: string }>
  }

  git: {
    status: (cwd?: string | null) => Promise<{ ok: boolean; output?: string; error?: string }>
    diff: (filePath?: string, staged?: boolean) => Promise<{ ok: boolean; diff?: string; error?: string }>
    diffHead: (filePath?: string) => Promise<{ ok: boolean; diff?: string; error?: string }>
    revert: (filePath?: string) => Promise<{ ok: boolean; error?: string }>
    stage: (filePath?: string) => Promise<{ ok: boolean; error?: string }>
    unstage: (filePath?: string) => Promise<{ ok: boolean; error?: string }>
    commit: (message?: string) => Promise<{ ok: boolean; output?: string; error?: string }>
    branchList: (cwd?: string | null) => Promise<{ ok: boolean; branches?: string[]; error?: string }>
    branchSwitch: (branch: string, cwd?: string | null) => Promise<{ ok: boolean; error?: string }>
    branchCreate: (branch: string, cwd?: string | null) => Promise<{ ok: boolean; error?: string }>
    currentBranch: (cwd?: string | null) => Promise<{ ok: boolean; branch?: string; error?: string }>
    log: (count?: number) => Promise<{ ok: boolean; output?: string; error?: string }>
    // Worktree operations
    worktreeList: () => Promise<{ ok: boolean; worktrees?: Array<{ path: string; head?: string; branch?: string; bare?: boolean; detached?: boolean; locked?: boolean; prunable?: boolean; isMain?: boolean }>; error?: string }>
    worktreeAdd: (opts: { path: string; branch?: string; newBranch?: string }) => Promise<{ ok: boolean; error?: string }>
    worktreeRemove: (wtPath: string) => Promise<{ ok: boolean; error?: string }>
    worktreeLock: (wtPath: string) => Promise<{ ok: boolean; error?: string }>
    worktreeUnlock: (wtPath: string) => Promise<{ ok: boolean; error?: string }>
    worktreePrune: () => Promise<{ ok: boolean; error?: string }>
    // Remote operations
    push: (opts?: { remote?: string; branch?: string; force?: boolean }) => Promise<{ ok: boolean; output?: string; error?: string }>
    pull: (opts?: { remote?: string; branch?: string }) => Promise<{ ok: boolean; output?: string; error?: string }>
    fetch: (opts?: { remote?: string }) => Promise<{ ok: boolean; output?: string; error?: string }>
  }

  platform: string

  // ── External services (server / VM TCP reachability probe) ──
  external: {
    testConnection: (host: string, port: number | string, timeoutMs?: number) => Promise<{ ok: boolean; error?: string; latencyMs?: number }>
    // Real SSH session management (ssh2 in main process; secret decrypted in main).
    sshConnect: (params: {
      host: string
      port: number | string
      username: string
      authType?: 'password' | 'key'
      secretEncrypted?: boolean
      secret: string
    }) => Promise<{ ok: boolean; error?: string; banner?: string }>
    sshExec: (params: { command: string; cwd?: string }) => Promise<{ ok: boolean; stdout?: string; stderr?: string; code?: number; error?: string }>
    sshStatus: () => Promise<{ connected: boolean; host?: string; username?: string }>
    sshDisconnect: () => Promise<{ ok: boolean }>
    onSshConnected: (cb: (data: { host: string; username: string }) => void) => () => void
    onSshList: (cb: (data: string) => void) => () => void
  }
  isElectron: boolean

  // ── Email (IMAP inbox / SMTP send / notifications) ─────────────────────────
  email: {
    configure: (partial: {
      user: string
      authCode: string
      fromName?: string
      imapHost?: string
      imapPort?: number
      imapSecure?: boolean
      smtpHost?: string
      smtpPort?: number
      smtpSecure?: boolean
    }) => Promise<{ configured: boolean; user?: string; imapHost?: string; smtpHost?: string } & Record<string, any>>
    getConfig: () => Promise<{ configured: boolean; hasAuthCode?: boolean } & Record<string, any>>
    list: (opts?: { limit?: number }) => Promise<{
      ok: boolean
      messages: Array<{
        uid: number
        from: string
        fromAddress: string
        subject: string
        date: number
        seen: boolean
      }>
      error?: string
    }>
    get: (uid: number) => Promise<{
      uid: number
      subject: string
      from: string
      to: string
      date: number
      text: string
      html: string
      attachments: Array<{ filename: string; size: number; contentType: string }>
    }>
    send: (msg: { to: string; subject?: string; text?: string; html?: string }) => Promise<{ accepted: string[]; messageId: string }>
    notify: (msg: { to?: string; subject?: string; text?: string }) => Promise<{ accepted: string[]; messageId: string }>
    test: () => Promise<{ ok: boolean; imap: { ok: boolean; message: string }; smtp: { ok: boolean; message: string }; debug: { user: string; authCodeLength: number } }>
  }

  // ── Hooks (written into Hermes' config.yaml `hooks:` block; backend fires them) ──
  hooks: {
    getConfig: () => Promise<{ ok: boolean; config?: HooksConfig; error?: string }>
    setConfig: (config: HooksConfig) => Promise<{ ok: boolean; error?: string }>
  }

  // ── Kanban (hermes kanban CLI bridge via the main process) ─────────────
  kanban: {
    invoke: (verb: string, args?: string[], json?: boolean, board?: string) => Promise<{
      ok: boolean
      data?: unknown
      stdout?: string
      stderr?: string
      code?: number
      error?: string
    }>
  }
}

declare global {
  interface Window {
    // Non-optional: runtime access is always guarded by `isElectron()`, and a
    // non-optional type avoids forcing `window.electron?.…` / non-null assertions
    // at every single call site across the codebase.
    electron: ElectronAPI
  }
}

export {}

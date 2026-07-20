import type { ScheduledTask } from '@/stores/helix-store'
import type { HooksConfig } from '@/lib/hooks-config'

export interface ElectronAPI {
  fs: {
    read: (filePath: string) => Promise<string>
    write: (filePath: string, content: string) => Promise<{ success: boolean }>
    edit: (filePath: string, oldString: string, newString: string) => Promise<{ success: boolean }>
    readdir: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean }>>
    stat: (filePath: string) => Promise<{
      isFile: boolean
      isDirectory: boolean
      size: number
      mtime: number
    }>
    rename: (oldPath: string, newPath: string) => Promise<{ success: boolean }>
    scanTree: (dirPath?: string) => Promise<Array<{ id: string; name: string; type: 'file' | 'folder'; children?: any[] }>>
  }

  hermesSkills: {
    getDir: () => Promise<string | null>
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
    openDirectory: () => Promise<string | null>
    openFile: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
    saveFile: (options?: { filters?: Array<{ name: string; extensions: string[] }> }) => Promise<string | null>
  }

  app: {
    getInfo: () => Promise<{ version: string; platform: string; workDir: string }>
    setWorkDir: (dir: string) => Promise<{ success: boolean; workDir: string }>
  }

  hermes: {
    send: (method: string, params?: any) => Promise<any>
    notify: (method: string, params?: any) => void
    interrupt: (sessionId: string) => Promise<any>
    status: () => Promise<any>
    setConfig: (config: any) => Promise<any>
    getConfig: () => Promise<any>
    setYamlKey: (key: string, value: any) => Promise<any>
    listPersonalities: () => Promise<any>
    setPersonality: (params: { name: string; prompt?: string }) => Promise<any>
    setModel: (params: { model: string; baseUrl?: string; apiKey?: string; provider?: string }) => Promise<any>
    setAgentConfig: (params: { temperature?: number; maxOutputTokens?: number; reasoningEffort?: string; customInstructions?: string; personality?: string }) => Promise<any>
    // Fast path: persist agent.reasoning_effort without a gateway restart.
    setReasoningEffort: (params: { reasoningEffort: string }) => Promise<any>
    fetchModels: (params: any) => Promise<any>
    onEvent: (callback: (method: any, params: any) => void) => () => void
    // ── Memory sync (Hermes backend memory_manager: MEMORY.md / USER.md) ──
    listMemories: () => Promise<{ memory: string[]; user: string[]; manual: string[] }>
    addMemoryEntry: (target: 'memory' | 'user', text: string) => Promise<{ ok: boolean; entries?: string[]; error?: string }>
    removeMemoryEntry: (target: 'memory' | 'user', text: string) => Promise<{ ok: boolean; entries?: string[] }>
  }

  profile: {
    cacheConfig: (cfg: { model?: string; provider?: string; baseUrl?: string; apiKey?: string }) => Promise<{ success: boolean; error?: string }>
  }

  git: {
    status: () => Promise<{ ok: boolean; output?: string; error?: string }>
    diff: (filePath?: string, staged?: boolean) => Promise<{ ok: boolean; diff?: string; error?: string }>
    diffHead: (filePath?: string) => Promise<{ ok: boolean; diff?: string; error?: string }>
    revert: (filePath?: string) => Promise<{ ok: boolean; error?: string }>
    stage: (filePath?: string) => Promise<{ ok: boolean; error?: string }>
    unstage: (filePath?: string) => Promise<{ ok: boolean; error?: string }>
    commit: (message?: string) => Promise<{ ok: boolean; output?: string; error?: string }>
    branchList: () => Promise<{ ok: boolean; branches?: string[]; error?: string }>
    branchSwitch: (branch: string) => Promise<{ ok: boolean; error?: string }>
    branchCreate: (branch: string) => Promise<{ ok: boolean; error?: string }>
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
  isElectron: boolean

  // ── Hooks (written into Hermes' config.yaml `hooks:` block; backend fires them) ──
  hooks: {
    getConfig: () => Promise<{ ok: boolean; config?: HooksConfig; error?: string }>
    setConfig: (config: HooksConfig) => Promise<{ ok: boolean; error?: string }>
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

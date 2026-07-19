const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods via contextBridge
contextBridge.exposeInMainWorld('electron', {
  // ── Hermes Bridge ──────────────────────────────────────────────────────
  hermes: {
    // Send JSON-RPC request to Hermes
    send: (method, params) => ipcRenderer.invoke('hermes:send', method, params),

    // Send JSON-RPC notification to Hermes (no response expected)
    notify: (method, params) => ipcRenderer.send('hermes:notify', method, params),
    
    // Interrupt current operation
    interrupt: (sessionId) => ipcRenderer.invoke('hermes:interrupt', sessionId),
    
    // Check connection status
    status: () => ipcRenderer.invoke('hermes:status'),
    
    // Update Hermes configuration (model, provider, baseUrl, apiKey)
    setConfig: (config) => ipcRenderer.invoke('hermes:setConfig', config),

    // Read the effective Hermes config (model, provider, baseUrl, hasApiKey)
    getConfig: () => ipcRenderer.invoke('hermes:getConfig'),

    // Set a single nested config.yaml key (e.g. 'compression.enabled')
    setYamlKey: (key, value) => ipcRenderer.invoke('hermes:setYamlKey', { key, value }),

    // List predefined personalities from config.yaml
    listPersonalities: () => ipcRenderer.invoke('hermes:listPersonalities'),

    // Apply a personality by writing agent.system_prompt into Hermes config.yaml
    setPersonality: (params) => ipcRenderer.invoke('hermes:setPersonality', params),
    setModel: (params) => ipcRenderer.invoke('hermes:setModel', params),
    
    // Fetch available models from API endpoint
    fetchModels: (params) => ipcRenderer.invoke('hermes:fetchModels', params),
    
    // Listen for Hermes events (message.delta, tool.start, approval.request, etc.)
    onEvent: (callback) => {
      const handler = (_event, methodName, params) => {
        callback(methodName, params)
      }
      ipcRenderer.on('hermes:event', handler)
      return () => {
        ipcRenderer.removeListener('hermes:event', handler)
      }
    },

    // ── Memory sync (Hermes backend memory_manager: MEMORY.md / USER.md) ──
    listMemories: () => ipcRenderer.invoke('hermes:listMemories'),
    addMemoryEntry: (target, text) => ipcRenderer.invoke('hermes:addMemoryEntry', { target, text }),
    removeMemoryEntry: (target, text) => ipcRenderer.invoke('hermes:removeMemoryEntry', { target, text }),
  },

  // ── Window Controls ────────────────────────────────────────────────────
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    maximize: () => ipcRenderer.invoke('window:maximize'),
    unmaximize: () => ipcRenderer.invoke('window:unmaximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChange: (callback) => {
      ipcRenderer.on('window:maximized-changed', (_event, maximized) => callback(maximized))
    },
    toggleDevTools: () => ipcRenderer.invoke('window:toggleDevTools'),
    newWindow: () => ipcRenderer.invoke('window:newWindow'),
  },

  // ── Active Profile cache (renderer -> main, persisted for cold-start re-assert) ──
  profile: {
    cacheConfig: (cfg) => ipcRenderer.invoke('profile:cacheConfig', cfg),
  },

  // ── File System (for UI file browsing) ─────────────────────────────────
  fs: {
    read: (filePath) => ipcRenderer.invoke('fs:read', filePath),
    write: (filePath, content) => ipcRenderer.invoke('fs:write', filePath, content),
    edit: (filePath, oldString, newString) => ipcRenderer.invoke('fs:edit', filePath, oldString, newString),
    readdir: (dirPath) => ipcRenderer.invoke('fs:readdir', dirPath),
    stat: (filePath) => ipcRenderer.invoke('fs:stat', filePath),
    rename: (oldPath, newPath) => ipcRenderer.invoke('fs:rename', oldPath, newPath),
    scanTree: (dirPath) => ipcRenderer.invoke('fs:scanTree', dirPath),
  },

  // ── Hermes Skills (bypasses working directory restriction) ─────────────
  hermesSkills: {
    getDir: () => ipcRenderer.invoke('hermes:getSkillsDir'),
    readdir: (dirPath) => ipcRenderer.invoke('hermes:readDir', dirPath),
    readFile: (filePath) => ipcRenderer.invoke('hermes:readFile', filePath),
    deleteDir: (dirPath) => ipcRenderer.invoke('hermes:deleteDir', dirPath),
    listSkills: () => ipcRenderer.invoke('hermes:listSkills'),
    trackSkillCall: (skillName) => ipcRenderer.invoke('hermes:trackSkillCall', skillName),
  },

  // ── Shell ──────────────────────────────────────────────────────────────
  // NOTE: arbitrary command execution (`shell:exec`) was intentionally removed
  // — it exposed a full RCE surface to any content running in the renderer.
  // Shell output the app needs should go through a purpose-specific, validated
  // IPC handler instead.
  shell: {
    open: (target) => ipcRenderer.invoke('shell:open', target),
    showItemInFolder: (fullPath) => ipcRenderer.invoke('shell:showItemInFolder', fullPath),
    openPath: (dir) => ipcRenderer.invoke('shell:openPath', dir),
  },

  // ── OS-backed secret storage (safeStorage) ─────────────────────────────
  secure: {
    available: () => ipcRenderer.invoke('secure:available'),
    encrypt: (plaintext) => ipcRenderer.invoke('secure:encrypt', plaintext),
    decrypt: (b64) => ipcRenderer.invoke('secure:decrypt', b64),
  },

  // ── Interactive Terminal (PowerShell) ──────────────────────────────────
  terminal: {
    start: (cols, rows, cwd) => ipcRenderer.invoke('terminal:start', cols, rows, cwd),
    write: (command) => ipcRenderer.send('terminal:write', command),
    resize: (cols, rows) => ipcRenderer.send('terminal:resize', cols, rows),
    kill: () => ipcRenderer.invoke('terminal:kill'),
    onData: (callback) => {
      const handler = (_event, data) => callback(data)
      ipcRenderer.on('terminal:data', handler)
      return () => ipcRenderer.removeListener('terminal:data', handler)
    },
  },

  // ── Scheduled Tasks (Hermes backend sync) ──────────────────────────────
  scheduledTasks: {
    list: () => ipcRenderer.invoke('scheduled-tasks:list'),
    create: (params) => ipcRenderer.invoke('scheduled-tasks:create', params),
    update: (params) => ipcRenderer.invoke('scheduled-tasks:update', params),
    remove: (params) => ipcRenderer.invoke('scheduled-tasks:remove', params),
  },

  // ── Hooks (Codex-compatible lifecycle hooks, run in the main process) ──
  hooks: {
    getConfig: () => ipcRenderer.invoke('hooks:getConfig'),
    setConfig: (config) => ipcRenderer.invoke('hooks:setConfig', config),
  },

  // ── Git Operations ──────────────────────────────────────────────────────
  git: {
    status: () => ipcRenderer.invoke('git:status'),
    diff: (filePath, staged) => ipcRenderer.invoke('git:diff', filePath, staged),
    diffHead: (filePath) => ipcRenderer.invoke('git:diffHead', filePath),
    revert: (filePath) => ipcRenderer.invoke('git:revert', filePath),
    stage: (filePath) => ipcRenderer.invoke('git:stage', filePath),
    unstage: (filePath) => ipcRenderer.invoke('git:unstage', filePath),
    commit: (message) => ipcRenderer.invoke('git:commit', message),
    branchList: () => ipcRenderer.invoke('git:branchList'),
    branchSwitch: (branch) => ipcRenderer.invoke('git:branchSwitch', branch),
    branchCreate: (branch) => ipcRenderer.invoke('git:branchCreate', branch),
    log: (count) => ipcRenderer.invoke('git:log', count),
    // Worktree operations
    worktreeList: () => ipcRenderer.invoke('git:worktreeList'),
    worktreeAdd: (opts) => ipcRenderer.invoke('git:worktreeAdd', opts),
    worktreeRemove: (wtPath) => ipcRenderer.invoke('git:worktreeRemove', wtPath),
    worktreeLock: (wtPath) => ipcRenderer.invoke('git:worktreeLock', wtPath),
    worktreeUnlock: (wtPath) => ipcRenderer.invoke('git:worktreeUnlock', wtPath),
    worktreePrune: () => ipcRenderer.invoke('git:worktreePrune'),
    push: (opts) => ipcRenderer.invoke('git:push', opts),
    pull: (opts) => ipcRenderer.invoke('git:pull', opts),
    fetch: (opts) => ipcRenderer.invoke('git:fetch', opts),
  },

  // ── Dialogs ────────────────────────────────────────────────────────────
  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
    openFile: (options) => ipcRenderer.invoke('dialog:openFile', options),
    saveFile: (options) => ipcRenderer.invoke('dialog:saveFile', options),
  },

  // ── App Info ───────────────────────────────────────────────────────────
  app: {
    getInfo: () => ipcRenderer.invoke('app:getInfo'),
    setWorkDir: (dir) => ipcRenderer.invoke('app:setWorkDir', dir),
  },

  // ── Diagnostics & Runtime (gateway health, logs, signature, hosted runtime) ──
  diagnostics: {
    getStatus: () => ipcRenderer.invoke('diagnostics:getStatus'),
  },
  runtime: {
    action: (action) => ipcRenderer.invoke('runtime:action', action),
  },

  // ── Platform ───────────────────────────────────────────────────────────
  platform: process.platform,
  isElectron: true,
})

import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import { defaultFiles } from '@/lib/seed-data'
import { generateId } from '@/lib/format'
import { debug, warn, error as logError } from '@/lib/logger'
import { isElectron, getElectronAPI, electronFS, electronApp } from '@/lib/electron-bridge'
import type { McpServerConfig } from '@/stores/hermes-store'
import { useHermesStore } from '@/stores/hermes-store'
export type { McpServerConfig } from '@/stores/hermes-store'
import type {
  FileNode, ImageAttachment, FileAttachment, ExecutionStep,
  StreamingResponseBlock, StreamingDraft, ConnectionNotice,
  ChatMessage, EditorTab, CursorPosition, ToastMessage, PendingChange,
  ApiProvider, AgentEngine, ApiConfig, ApiProfile, Skill,
  MemoryCategory, MemoryEntry, AvailableCommand, TaskNode,
  SessionCheckpoint, ScheduledTask,
  ToolCallEntry, SubAgent, CustomShortcutEntry, ProviderConfig,
} from './helix-types'
import { PROVIDER_PRESETS, DEFAULT_SHORTCUTS } from './helix-types'
import { createGitSlice, type GitSlice } from './slices/git-slice'
import { createToastSlice, type ToastSlice } from './slices/toast-slice'
import { createTerminalSlice, type TerminalSlice } from './slices/terminal-slice'
import { createAgentSettingsSlice, type AgentSettingsSlice } from './slices/agent-settings-slice'
import { createPanelSlice, type PanelSlice } from './slices/panel-slice'
import { createApiConfigSlice, type ApiConfigSlice } from './slices/api-config-slice'
import { createSkillSlice, type SkillSlice } from './slices/skill-slice'

export type {
  FileNode, ImageAttachment, FileAttachment, ExecutionStep,
  StreamingResponseBlock, StreamingDraft, ConnectionNotice,
  ChatMessage, EditorTab, CursorPosition, ToastMessage, PendingChange,
  ApiProvider, AgentEngine, ApiConfig, ApiProfile, Skill,
  MemoryCategory, MemoryEntry, AvailableCommand, TaskNode,
  SessionCheckpoint, ScheduledTask,
  SubAgent, CustomShortcutEntry, ProviderConfig,
}
export { PROVIDER_PRESETS, DEFAULT_SHORTCUTS }

interface HelixState extends GitSlice, ToastSlice, TerminalSlice, AgentSettingsSlice, PanelSlice, ApiConfigSlice, SkillSlice {
  // File system
  files: FileNode[]
  selectedFileId: string | null
  expandedFolders: Set<string>

  // Sub-agents
  subAgents: SubAgent[]

  // Editor
  openTabs: EditorTab[]
  activeTabId: string | null
  cursorPosition: CursorPosition

  // API Configuration — see slices/api-config-slice.ts

  // Chat
  chatMessages: ChatMessage[]
  isChatLoading: boolean

  // Skills
  // Skills — see slices/skill-slice.ts

  // Terminal — see slices/terminal-slice.ts

  // Goal
  goal: string | null

  // Memory
  memories: MemoryEntry[]
  userMemories: MemoryEntry[]
  notes: string
  checkpoints: SessionCheckpoint[]

  // Tasks
  tasks: TaskNode[]

  // Scheduled Tasks
  scheduledTasks: ScheduledTask[]
  showScheduledTasksPanel: boolean

  showRuntimePanel: boolean

  // MCP Servers
  mcpServers: Record<string, McpServerConfig>

  // Custom Shortcuts
  customShortcuts: Record<string, { keys: string[], action: string, description: string }>
  customizedShortcutIds: Set<string>

  // Customize
  // showCustomizePanel — see slices/panel-slice.ts

  // Agent Execution
  isAgentRunning: boolean
  setIsAgentRunning: (v: boolean) => void
  streamingDrafts: Record<string, StreamingDraft>
  tabInputs: Record<string, string>
  pendingUpdate: string | null
  setPendingUpdate: (version: string | null) => void
  setTabInput: (sessionId: string, text: string) => void
  clearTabInput: (sessionId: string) => void
  setStreamingDraft: (sessionId: string, draft: Partial<StreamingDraft>) => void
  clearStreamingDraft: (sessionId: string) => void
  connectionNotice: ConnectionNotice | null
  setConnectionNotice: (notice: ConnectionNotice | null) => void
  agentExecutionSteps: Array<{ type: string; toolName?: string; path?: string; content?: string; toolParams?: Record<string, unknown>; timestamp: number }>
  accessedDirectories: string[]
  selectedFiles: string[]
  selectedWorkDir: string | null
  setSelectedWorkDir: (dir: string | null) => void
  workDirEpoch: number
  setWorkDir: (relativePath: string) => Promise<void>
  sessionSaveVersion: number
  currentSessionId: string | null
  activeSessionWorkDir: string | null
  setCurrentSessionId: (id: string | null) => void
  sessionHistory: string[]
  sessionHistoryIndex: number
  navigateSession: (direction: 'back' | 'forward') => Promise<void>
  addExecutionStep: (step: { type: string; toolName?: string; toolKind?: string; path?: string; content?: string; toolParams?: Record<string, unknown> }) => void
  addAccessedDirectory: (dir: string) => void
  addSelectedFile: (filePath: string) => void
  removeSelectedFile: (filePath: string) => void
  clearSelectedFiles: () => void
  clearExecutionFlow: () => void
  modelUsage: Record<string, { prompt: number; completion: number; total: number; cost: number }>
  addModelUsage: (model: string, usage: { prompt: number; completion: number; total: number; cost: number }) => void
  contextUsage: { size: number; used: number } | null
  setContextUsage: (size: number, used: number) => void
  sessionUsageStats: {
    requestCount: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    thoughtTokens: number
    cachedReadTokens: number
    cachedWriteTokens: number
    totalCost: number
  }
  addSessionUsageStats: (
    model: string,
    usage: {
      totalTokens?: number
      inputTokens?: number
      outputTokens?: number
      thoughtTokens?: number
      cachedReadTokens?: number
      cachedWriteTokens?: number
    }
  ) => void
  notifySessionSaved: () => void
  flushSessionPersist: () => void

  // UI
  editorTheme: 'vs-dark' | 'light'
  fontFamily: string
  fontSize: number
  interfaceFont: string
  transcriptFontSize: number
  // Toast — see slices/toast-slice.ts
  pendingChanges: PendingChange[]
  // Panel toggles — see slices/panel-slice.ts

  // Agent Settings — see slices/agent-settings-slice.ts

  // Actions - Agent Settings
  // (declared in slices/agent-settings-slice.ts)

  // Actions - Files
  setFiles: (files: FileNode[]) => void
  syncFilesFromDisk: () => Promise<void>
  selectFile: (fileId: string) => void
  toggleFolder: (folderId: string) => void
  createFile: (parentId: string | null, name: string, type: 'file' | 'folder') => void
  deleteFile: (fileId: string) => void
  updateFileContent: (fileId: string, content: string) => void
  getFileById: (fileId: string) => FileNode | null
  renameFile: (fileId: string, newName: string) => Promise<boolean>

  // Actions - Tabs
  openFile: (fileId: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void

  // Actions - Skills — see slices/skill-slice.ts

  // Actions - Chat
  addChatMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => string
  updateChatMessage: (messageId: string, content: string) => void
  setChatMessageStreaming: (messageId: string, isStreaming: boolean) => void
  clearChat: () => void
  clearChatAndPersist: () => Promise<void>
  setChatLoading: (loading: boolean) => void

  // Actions - Editor
  setCursorPosition: (pos: CursorPosition) => void
  markTabSaved: (tabId: string) => void

  // Terminal actions — see slices/terminal-slice.ts

  // Actions - UI
  // Panel toggles — see slices/panel-slice.ts
  setEditorTheme: (theme: 'vs-dark' | 'light') => void
  setFontFamily: (font: string) => void
  setFontSize: (size: number) => void
  setInterfaceFont: (font: string) => void
  setTranscriptFontSize: (size: number) => void
  // Toast actions — see slices/toast-slice.ts

  // Actions - File modifications
  applyFileChange: (fileId: string, newContent: string) => void
  createOrUpdateFile: (filePath: string, content: string) => void
  addPendingChange: (change: Omit<PendingChange, 'id'>) => string
  applyPendingChange: (changeId: string) => void
  rejectPendingChange: (changeId: string) => void
  applyAllPendingChanges: () => void
  rejectAllPendingChanges: () => void
  // setShowDiffPreview — see slices/panel-slice.ts

  // Actions - Goal
  setGoal: (goal: string | null) => void

  // Actions - Memory
  addMemory: (entry: Omit<MemoryEntry, 'id' | 'createdAt'>) => Promise<void>
  removeMemory: (id: string) => Promise<void>
  loadMemories: () => Promise<void>
  // User profile (Hermes USER.md) — separate from the agent's MEMORY.md.
  addUserMemory: (entry: Omit<MemoryEntry, 'id' | 'createdAt'>) => Promise<void>
  removeUserMemory: (id: string) => Promise<void>
  loadUserMemories: () => Promise<void>
  updateNotes: (notes: string) => void
  saveCheckpoint: (label?: string) => void

  // Actions - Tasks
  addTask: (label: string, parentId?: string) => string
  updateTask: (taskId: string, updates: Partial<Pick<TaskNode, 'label' | 'status'>>) => void
  removeTask: (taskId: string) => void
  clearCompletedTasks: () => void

  // Actions - Scheduled Tasks
  addScheduledTask: (task: Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }) => string
  updateScheduledTask: (taskId: string, updates: Partial<Omit<ScheduledTask, 'id' | 'createdAt'>>) => void
  removeScheduledTask: (taskId: string) => void
  toggleScheduledTask: (taskId: string) => void
  toggleScheduledTasksPanel: () => void

  toggleRuntimePanel: () => void

  // Actions - MCP Servers
  addMcpServer: (name: string, config: McpServerConfig) => void
  removeMcpServer: (name: string) => void
  updateMcpServer: (name: string, config: McpServerConfig) => void
  toggleMcpServer: (name: string) => void

  // Actions - Artifacts
  // (removed — unused)

  // Actions - Custom Shortcuts
  addCustomShortcut: (id: string, shortcut: { keys: string[], action: string, description: string }) => void
  removeCustomShortcut: (id: string) => void
  updateCustomShortcut: (id: string, shortcut: { keys: string[], action: string, description: string }) => void

  // Actions - Panels
  // Panel toggles — see slices/panel-slice.ts

  // API Config — see slices/api-config-slice.ts

  // Actions - Sub-agents
  spawnSubAgent: (name: string, description: string, parentId?: string) => string
  completeSubAgent: (agentId: string, result?: string, filesModified?: string[]) => void
  failSubAgent: (agentId: string, error?: string) => void
  cancelSubAgent: (agentId: string) => void
  clearCompletedSubAgents: () => void
  addSubAgentToolCall: (agentId: string, toolCall: { toolName: string; params: string; status: 'running' | 'success' | 'error' }) => void

  // Git — see slices/git-slice.ts

  // Actions - Persistence
  persistToStorage: () => Promise<void>
  restoreFromStorage: () => Promise<void>
  saveCheckpointChat: () => Promise<void>

  // Helpers
  getAllFiles: () => FileNode[]
  getFilePath: (fileId: string) => string
  findFileByPath: (path: string) => FileNode | null
  getMemoryContext: () => string
  getTaskContext: () => string
}

function getLanguageFromName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    cpp: 'cpp', c: 'c', cs: 'csharp', php: 'php', swift: 'swift',
    kt: 'kotlin', html: 'html', css: 'css', scss: 'scss', json: 'json',
    yaml: 'yaml', yml: 'yaml', md: 'markdown', sql: 'sql', sh: 'shell',
    dockerfile: 'dockerfile', xml: 'xml', svg: 'xml',
  }
  if (name.toLowerCase() === 'dockerfile') return 'dockerfile'
  if (name.toLowerCase() === 'makefile') return 'makefile'
  return langMap[ext] || 'plaintext'
}



function findFileById(nodes: FileNode[], id: string): FileNode | null {
  for (const node of nodes) {
    if (node.id === id) return node
    if (node.children) {
      const found = findFileById(node.children, id)
      if (found) return found
    }
  }
  return null
}

function updateFileInTree(nodes: FileNode[], fileId: string, updater: (node: FileNode) => FileNode): FileNode[] {
  return nodes.map(node => {
    if (node.id === fileId) return updater(node)
    if (node.children) {
      return { ...node, children: updateFileInTree(node.children, fileId, updater) }
    }
    return node
  })
}

function removeFileFromTree(nodes: FileNode[], fileId: string): FileNode[] {
  return nodes
    .filter(node => node.id !== fileId)
    .map(node => {
      if (node.children) {
        return { ...node, children: removeFileFromTree(node.children, fileId) }
      }
      return node
    })
}

function addFileToTree(nodes: FileNode[], parentId: string, newFile: FileNode): FileNode[] {
  return nodes.map(node => {
    if (node.id === parentId && node.type === 'folder') {
      return { ...node, children: [...(node.children || []), newFile] }
    }
    if (node.children) {
      return { ...node, children: addFileToTree(node.children, parentId, newFile) }
    }
    return node
  })
}

function updateTaskInTree(tasks: TaskNode[], taskId: string, updates: Partial<Pick<TaskNode, 'label' | 'status'>>): TaskNode[] {
  return tasks.map(t => {
    if (t.id === taskId) return { ...t, ...updates }
    if (t.children) return { ...t, children: updateTaskInTree(t.children, taskId, updates) }
    return t
  })
}

function removeTaskFromTree(tasks: TaskNode[], taskId: string): TaskNode[] {
  return tasks
    .filter(t => t.id !== taskId)
    .map(t => t.children ? { ...t, children: removeTaskFromTree(t.children, taskId) } : t)
}

function collectAllFileIds(nodes: FileNode[]): string[] {
  const ids: string[] = []
  for (const node of nodes) {
    if (node.type === 'folder') {
      ids.push(node.id)
      if (node.children) ids.push(...collectAllFileIds(node.children))
    }
  }
  return ids
}

// Debounced chat persistence: saves to IndexedDB after messages change
let sessionPersistTimer: ReturnType<typeof setTimeout> | null = null
function collectFiles(nodes: FileNode[]) {
  return nodes.map(n => ({
    id: n.id, name: n.name, type: n.type,
    content: n.content, language: n.language,
    children: n.children ? collectFiles(n.children) : undefined,
  }))
}
// Core save logic, shared by the debounced scheduler and the synchronous flush.
async function persistCurrentSessionNow(): Promise<void> {
  try {
    const { persistence } = await import('@/lib/persist')
    const state = useHelixStore.getState()
    const firstUser = state.chatMessages.find(m => m.role === 'user')
    // Don't persist empty sessions (no user messages and no assistant responses).
    // This prevents auto-creating sessions with timestamp labels when switching
    // projects or losing focus on an empty conversation.
    if (!firstUser && state.chatMessages.every(m => m.role !== 'assistant')) return
    const sessionId = state.currentSessionId || 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
    const label = firstUser ? firstUser.content.slice(0, 50) : new Date().toLocaleString('zh-CN')

    // If a stream is mid-flight for this session, also persist its buffered
    // partial text so quitting / reloading mid-generation doesn't silently
    // drop the in-progress assistant reply. This is injected AT PERSIST TIME
    // only — the live chatMessages array is NOT mutated, so the running stream
    // and its eventual `done` handler are unaffected. Once the run completes,
    // clearStreamingDraft() drops the draft and the partial stops being
    // injected (the real message, added by done, takes its place).
    const msgsToSave = state.chatMessages.map(m => ({
      id: m.id, sessionId, role: m.role,
      content: m.content, images: m.images, timestamp: m.timestamp, isStreaming: m.isStreaming ?? false,
      reasoning: m.reasoning,
      steps: m.steps,
    }))
    const draft = state.streamingDrafts[sessionId]
    if (draft?.isAgentRunning && draft.textBuffer && draft.textBuffer.trim()) {
      msgsToSave.push({
        id: 'draft-partial-' + sessionId,
        sessionId,
        role: 'assistant',
        content: draft.textBuffer + '\n\n*[生成中断，仅保存部分内容]*',
        images: undefined,
        reasoning: draft.thoughtBuffer || undefined,
        timestamp: Date.now(),
        isStreaming: false,
        steps: undefined,
      })
    }

    await persistence.saveSession({
      id: sessionId,
      label,
      workDir: state.activeSessionWorkDir ?? state.selectedWorkDir,
      goal: state.goal,
      memories: state.memories,
      tasks: state.tasks,
      notes: state.notes,
      checkpoints: state.checkpoints,
      chatMessages: msgsToSave,
      files: collectFiles(state.files),
      openTabs: state.openTabs.map(tab => ({
        id: tab.id, fileId: tab.fileId, name: tab.name, language: tab.language, isDirty: tab.isDirty,
      })),
    })
    // Pin the session id so subsequent saves land on the same session,
    // and refresh the sidebar list so the conversation shows up immediately.
    if (!state.currentSessionId) {
      useHelixStore.getState().setCurrentSessionId(sessionId)
    }
    useHelixStore.setState((st) => ({ sessionSaveVersion: st.sessionSaveVersion + 1 }))
  } catch (e) {
    logError('Failed to persist session:', e)
    // Avoid toast-spam: only surface once per failure burst via getState.
    useHelixStore.getState().showToast({ type: 'error', title: '会话保存失败', description: '当前对话未能写入本地，切换或关闭可能丢失' })
  }
}

function scheduleSessionPersist() {
  if (sessionPersistTimer) clearTimeout(sessionPersistTimer)
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null
    void persistCurrentSessionNow()
  }, 200)
}

// Synchronously flush any pending session save (used before switching conversations
// so unsaved messages in the current chat are not lost when state is swapped).
function flushSessionPersist(): Promise<void> {
  if (sessionPersistTimer) {
    clearTimeout(sessionPersistTimer)
    sessionPersistTimer = null
  }
  return persistCurrentSessionNow()
}

export const useHelixStore = create<HelixState>()((set, get, store) => ({
  ...createGitSlice(set, get, store),
  ...createToastSlice(set, get, store),
  ...createTerminalSlice(set, get, store),
  ...createAgentSettingsSlice(set, get, store),
  ...createPanelSlice(set, get, store),
  ...createApiConfigSlice(set, get, store),
  ...createSkillSlice(set, get, store),
  // File system
  files: defaultFiles,
  selectedFileId: 'file-app',
  expandedFolders: new Set(['root-src', 'folder-components']),

  // Editor
  openTabs: [
    { id: 'tab-app', fileId: 'file-app', name: 'App.tsx', language: 'typescript', isDirty: false },
  ],
  activeTabId: 'tab-app',
  cursorPosition: { line: 1, column: 1 },

  // Chat
  chatMessages: [],
  isChatLoading: false,

  // Skills — in slices/skill-slice.ts

  // Terminal — in slices/terminal-slice.ts

  // UI
  // Panel state — in slices/panel-slice.ts
  editorTheme: 'light' as const,
  fontFamily: "'Geist Mono', 'Fira Code', 'Consolas', monospace" as const,
  fontSize: 14 as const,
  interfaceFont: 'var(--font-geist-sans)' as const,
  transcriptFontSize: 14,
  // Toast — in slices/toast-slice.ts
  pendingChanges: [],
  // Agent Settings — in slices/agent-settings-slice.ts

  // Agent Execution
  isAgentRunning: false,
  setIsAgentRunning: (v) => set({ isAgentRunning: v }),
  streamingDrafts: {},
  tabInputs: {} as Record<string, string>,
  pendingUpdate: null as string | null,
  setTabInput: (sessionId: string, text: string) => set((state) => ({
    tabInputs: { ...state.tabInputs, [sessionId]: text },
  })),
  clearTabInput: (sessionId: string) => set((state) => {
    const { [sessionId]: _, ...rest } = state.tabInputs
    return { tabInputs: rest }
  }),
  setPendingUpdate: (version) => set({ pendingUpdate: version }),
  connectionNotice: null,
  setConnectionNotice: (notice) => set({ connectionNotice: notice }),
  setStreamingDraft: (sessionId, draft) =>
    set((state) => {
      const existing = state.streamingDrafts[sessionId] || {
        responseBlocks: [],
        streamThinking: '',
        steps: [],
        isAgentRunning: false,
      }
      return {
        streamingDrafts: {
          ...state.streamingDrafts,
          [sessionId]: { ...existing, ...draft },
        },
      }
    }),
  clearStreamingDraft: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.streamingDrafts
      return { streamingDrafts: rest }
    }),
  agentExecutionSteps: [],
  accessedDirectories: [],
  selectedFiles: [],
  selectedWorkDir: null,
  workDirEpoch: 0,
  sessionSaveVersion: 0,
  currentSessionId: null,
  activeSessionWorkDir: null,
  sessionHistory: [],
  sessionHistoryIndex: -1,
  // Panel state — in slices/panel-slice.ts
  modelUsage: {},
  contextUsage: null,
  sessionUsageStats: {
    requestCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
    totalCost: 0,
  },
  showSessionManager: false,

  // Agent Settings — in slices/agent-settings-slice.ts

  // UI — init values for non-panel UI state
  subAgents: [],

  // API Configuration — seeslices/api-config-slice.ts

  // Git — in slices/git-slice.ts

  // Goal
  goal: null,

  // Memory
  memories: [],
  userMemories: [],
  notes: '',
  checkpoints: [],

  // Tasks
  tasks: [],

  // Scheduled Tasks
  scheduledTasks: [],
  showScheduledTasksPanel: false,

  showRuntimePanel: false,

  // MCP Servers
  mcpServers: {
    tavily: {
      type: 'local',
      command: ['npx', '-y', 'tavily-mcp'],
      enabled: true,
      environment: {
        TAVILY_API_KEY: '',
      },
    },
    github: {
      type: 'local',
      command: ['npx', '-y', '@modelcontextprotocol/server-github'],
      enabled: true,
      environment: {
        GITHUB_PERSONAL_ACCESS_TOKEN: '',
      },
    },
  },

  // Custom Shortcuts
  customShortcuts: { ...DEFAULT_SHORTCUTS },
  customizedShortcutIds: new Set<string>(),

  // Actions - Files
  setFiles: (files) => set({ files }),
  syncFilesFromDisk: async () => {
    // Files are now managed by Hermes, not local API
    set({ files: [] })
  },
  selectFile: (fileId) => set({ selectedFileId: fileId }),
  toggleFolder: (folderId) =>
    set((state) => {
      const next = new Set(state.expandedFolders)
      if (next.has(folderId)) next.delete(folderId)
      else next.add(folderId)
      return { expandedFolders: next }
    }),

  createFile: (parentId, name, type) => {
    const id = generateId()
    const newFile: FileNode = {
      id,
      name,
      type,
      ...(type === 'file'
        ? { content: '', language: getLanguageFromName(name) }
        : { children: [] }),
    }

    if (parentId) {
      set((state) => ({ files: addFileToTree(state.files, parentId, newFile) }))
    } else {
      set((state) => ({ files: [...state.files, newFile] }))
    }

    if (type === 'file') {
      get().openFile(id)
    } else {
      set((state) => {
        const next = new Set(state.expandedFolders)
        next.add(id)
        return { expandedFolders: next }
      })
    }
  },

  deleteFile: (fileId) => {
    const file = get().getFileById(fileId)
    set((state) => {
      const newFiles = removeFileFromTree(state.files, fileId)
      const newTabs = state.openTabs.filter((t) => t.fileId !== fileId)
      const newActiveTabId =
        state.activeTabId && state.openTabs.find((t) => t.id === state.activeTabId)?.fileId === fileId
          ? newTabs[newTabs.length - 1]?.id || null
          : state.activeTabId
      return { files: newFiles, openTabs: newTabs, activeTabId: newActiveTabId }
    })
    if (file?.type === 'folder') {
      // Remove all tabs for files in this folder
      const allFolderFileIds: string[] = []
      const collectIds = (nodes: FileNode[]) => {
        for (const n of nodes) {
          if (n.type === 'file') allFolderFileIds.push(n.id)
          if (n.children) collectIds(n.children)
        }
      }
      if (file.children) collectIds(file.children)
    }
  },

  updateFileContent: (fileId, content) =>
    set((state) => ({
      files: updateFileInTree(state.files, fileId, (n) => ({ ...n, content })),
      openTabs: state.openTabs.map((t) =>
        t.fileId === fileId ? { ...t, isDirty: true } : t
      ),
    })),

  getFileById: (fileId) => findFileById(get().files, fileId),

  renameFile: async (fileId, newName) => {
    const state = get()
    const file = findFileById(state.files, fileId)
    if (!file) return false
    const relativePath = state.getFilePath(fileId)
    if (relativePath && state.selectedWorkDir && isElectron()) {
      const newRelativePath = relativePath.replace(/[^/]+$/, newName)
      try {
        await electronFS.rename(relativePath, newRelativePath)
      } catch (err) {
        logError('renameFile fs error:', err)
        return false
      }
    }
    set((state) => ({
      files: updateFileInTree(state.files, fileId, (n) => ({
        ...n,
        name: newName,
        language: n.type === 'file' ? getLanguageFromName(newName) : n.language,
      })),
      openTabs: state.openTabs.map((t) =>
        t.fileId === fileId
          ? { ...t, name: newName, language: getLanguageFromName(newName) }
          : t
      ),
    }))
    return true
  },

  // Actions - Tabs
  openFile: (fileId) => {
    const state = get()
    const file = findFileById(state.files, fileId)
    if (!file || file.type !== 'file') return

    const existingTab = state.openTabs.find((t) => t.fileId === fileId)
    if (existingTab) {
      set({ activeTabId: existingTab.id, selectedFileId: fileId })
      return
    }

    const newTab: EditorTab = {
      id: `tab-${fileId}`,
      fileId,
      name: file.name,
      language: file.language || getLanguageFromName(file.name),
      isDirty: false,
    }
    set((s) => ({
      openTabs: [...s.openTabs, newTab],
      activeTabId: newTab.id,
      selectedFileId: fileId,
    }))
  },

  closeTab: (tabId) =>
    set((state) => {
      const idx = state.openTabs.findIndex((t) => t.id === tabId)
      const newTabs = state.openTabs.filter((t) => t.id !== tabId)
      let newActiveTabId = state.activeTabId
      if (state.activeTabId === tabId) {
        if (newTabs.length > 0) {
          newActiveTabId = newTabs[Math.min(idx, newTabs.length - 1)]?.id || null
        } else {
          newActiveTabId = null
        }
      }
      return { openTabs: newTabs, activeTabId: newActiveTabId }
    }),

  setActiveTab: (tabId) =>
    set((state) => ({
      activeTabId: tabId,
      selectedFileId: state.openTabs.find((t) => t.id === tabId)?.fileId || null,
    })),

  // Actions - Skills
  addSkill: (skill) => {
    const id = generateId()
    set((state) => ({
      skills: [...state.skills, { ...skill, id, createdAt: Date.now() }],
    }))
    return id
  },

  updateSkill: (skillId, updates) =>
    set((state) => ({
      skills: state.skills.map((s) =>
        s.id === skillId ? { ...s, ...updates } : s
      ),
    })),

  removeSkill: (skillId) =>
    set((state) => ({
      skills: state.skills.filter((s) => s.id !== skillId || s.isBuiltin),
    })),

  toggleSkillPanel: () => set((s) => ({ showSkillPanel: !s.showSkillPanel })),

  toggleRuntimePanel: () => set((s) => ({ showRuntimePanel: !s.showRuntimePanel })),

  // Actions - Chat
  addChatMessage: (message) => {
    const id = generateId()
    set((state) => {
      const newState: Record<string, any> = {
        chatMessages: [...state.chatMessages, { ...message, id, sessionId: message.sessionId || state.currentSessionId || undefined, timestamp: Date.now() }],
      }
      return newState
    })
    scheduleSessionPersist()
    return id
  },

  updateChatMessage: (messageId, content) => {
    set((state) => ({
      chatMessages: state.chatMessages.map((m) =>
        m.id === messageId ? { ...m, content } : m
      ),
    }))
    scheduleSessionPersist()
  },

  setChatMessageStreaming: (messageId, isStreaming) =>
    set((state) => ({
      chatMessages: state.chatMessages.map((m) =>
        m.id === messageId ? { ...m, isStreaming } : m
      ),
    })),

  clearChat: () => {
    if (sessionPersistTimer) clearTimeout(sessionPersistTimer)
    const prevId = get().currentSessionId
    set({
      chatMessages: [],
      currentSessionId: null,
      activeSessionWorkDir: null,
      selectedWorkDir: null,
      contextUsage: null,
    })
    // Reset the Hermes backend session so a fresh ACP session is created on the
    // next prompt. Without this the UI clears but Hermes keeps the full
    // conversation history, so the model still answers with prior context.
    import('@/stores/hermes-store').then(({ useHermesStore }) => {
      useHermesStore.getState().setHermesSessionId(null)
    })
    if (prevId) {
      // NOTE: We no longer delete chatMessages here. Since we switched to the
      // 'sessions' object store (via persistCurrentSessionNow), clearing the
      // legacy 'chatMessages' store would not affect session data, and doing
      // so inside clearChat was causing a race where flushSessionPersist saved
      // messages only for clearChat to immediately discard them.
    }
  },
  clearChatAndPersist: async () => {
    get().clearChat()
  },

  setChatLoading: (loading) => set({ isChatLoading: loading }),

  // Terminal — in slices/terminal-slice.ts

  // Actions - Editor
  setCursorPosition: (pos) => set({ cursorPosition: pos }),
  markTabSaved: (tabId) =>
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.id === tabId ? { ...t, isDirty: false } : t
      ),
    })),

  // Actions - UI
  // Panel toggles — in slices/panel-slice.ts
  setEditorTheme: (theme) => set({ editorTheme: theme }),
  setFontFamily: (fontFamily) => {
    set({ fontFamily })
    document.documentElement.style.setProperty('--helix-font-family', fontFamily)
    document.body.style.fontFamily = fontFamily
    localStorage.setItem('helix-font-family', fontFamily)
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('fontFamily', fontFamily))
  },
  setFontSize: (fontSize) => {
    set({ fontSize })
    document.documentElement.style.setProperty('--helix-font-size', `${fontSize}px`)
    localStorage.setItem('helix-font-size', String(fontSize))
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('fontSize', fontSize))
  },
  setInterfaceFont: (font) => {
    set({ interfaceFont: font })
    document.documentElement.style.setProperty('--helix-interface-font', font)
    document.body.style.fontFamily = font
    localStorage.setItem('helix-interface-font', font)
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('interfaceFont', font))
  },
  setTranscriptFontSize: (size) => {
    set({ transcriptFontSize: size })
    document.documentElement.style.setProperty('--helix-transcript-size', `${size}px`)
    localStorage.setItem('helix-transcript-size', String(size))
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('transcriptFontSize', size))
  },

  // Toast — in slices/toast-slice.ts

  // Agent Settings — in slices/agent-settings-slice.ts

  // Actions - Agent Execution
  addExecutionStep: (step) =>
    set((state) => ({
      agentExecutionSteps: [...state.agentExecutionSteps, { ...step, timestamp: Date.now() }],
    })),
  addAccessedDirectory: (dir) =>
    set((state) => {
      if (state.accessedDirectories.includes(dir)) return state
      return { accessedDirectories: [...state.accessedDirectories, dir] }
    }),
  addSelectedFile: (filePath) =>
    set((state) => {
      if (state.selectedFiles.includes(filePath)) return state
      return { selectedFiles: [...state.selectedFiles, filePath] }
    }),
  removeSelectedFile: (filePath) =>
    set((state) => ({ selectedFiles: state.selectedFiles.filter(p => p !== filePath) })),
  clearSelectedFiles: () =>
    set({ selectedFiles: [] }),
  setSelectedWorkDir: (dir: string | null) => {
    const isDriveRoot = typeof dir === 'string' && /^[a-zA-Z]:[\\/]?$/.test(dir)
    if (dir === '/' || dir === '\\' || isDriveRoot || !dir) {
      // Let the main process decide the real project directory; the renderer's
      // process.cwd() is unreliable (often resolves to a drive root like D:\).
      set({ selectedWorkDir: '' })
    } else {
      set({ selectedWorkDir: dir })
    }
  },

  setWorkDir: async (relativePath: string) => {
    const isDriveRoot = typeof relativePath === 'string' && /^[a-zA-Z]:[\\/]?$/.test(relativePath)
    if (!relativePath || relativePath === '/' || relativePath === '\\' || isDriveRoot) {
      get().showToast({ title: '无效的工作目录，已回退到项目目录', type: 'warning' })
      const fallbackDir = typeof process !== 'undefined' ? process.cwd() : ''
      const info = isElectron() ? await electronApp.getInfo() : { workDir: fallbackDir }
      set({ selectedWorkDir: info.workDir || fallbackDir, workDirEpoch: get().workDirEpoch + 1 })
      return
    }
    const api = getElectronAPI()
    if (!api) {
      // Don't auto-save the current session when switching projects.
      // Just clear the current session so new messages go to the new project.
      get().setCurrentSessionId(null)
      set({ selectedWorkDir: relativePath, workDirEpoch: get().workDirEpoch + 1 })
      return
    }
    try {
      const res = await api.app.setWorkDir(relativePath)
      const absDir = res?.workDir || relativePath
      // Don't auto-save the current session when switching projects.
      // Just clear the current session so new messages go to the new project.
      get().setCurrentSessionId(null)
      // 先更新工作目录与 epoch，保证即使扫描失败，目录标签也是正确的。
      set({ selectedWorkDir: absDir, workDirEpoch: get().workDirEpoch + 1 })
      // 文件树扫描降级为尽力而为：scanTree 不可用时不影响工作目录切换。
      try {
        const tree = await electronFS.scanTree(absDir)
        set({ files: tree as FileNode[] })
      } catch (scanErr) {
        logError('[setWorkDir] scanTree failed:', scanErr)
      }
    } catch (err) {
      logError('[setWorkDir]', err)
      get().showToast({ title: '切换工作目录失败', type: 'error' })
    }
  },
  clearExecutionFlow: () =>
    set({ agentExecutionSteps: [], accessedDirectories: [] }),
  addModelUsage: (model, usage) =>
    set((state) => {
      const existing = state.modelUsage[model] || { prompt: 0, completion: 0, total: 0, cost: 0 }
      return {
        modelUsage: {
          ...state.modelUsage,
          [model]: {
            prompt: existing.prompt + usage.prompt,
            completion: existing.completion + usage.completion,
            total: existing.total + usage.total,
            cost: existing.cost + usage.cost,
          },
        },
      }
    }),
  setContextUsage: (size, used) => set({ contextUsage: { size, used } }),
  addSessionUsageStats: (model, usage) =>
    set((state) => {
      const input = usage.inputTokens || 0
      const output = usage.outputTokens || 0
      const thought = usage.thoughtTokens || 0
      const cachedRead = usage.cachedReadTokens || 0
      const cachedWrite = usage.cachedWriteTokens || 0
      const total = usage.totalTokens || input + output + thought
      const rates: Record<string, { input: number; output: number }> = {
        'agnes-2.0-flash': { input: 0.4, output: 1.6 },
        'agnes-2.0': { input: 0.4, output: 1.6 },
        'claude-sonnet-4': { input: 3.0, output: 15.0 },
        'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
        'gpt-4o': { input: 2.5, output: 10.0 },
        'gpt-4o-mini': { input: 0.15, output: 0.6 },
        'deepseek-chat': { input: 0.14, output: 0.28 },
        'deepseek-reasoner': { input: 0.55, output: 2.19 },
        'custom:step-3.7-flash': { input: 0.5, output: 2.0 },
        'step-3.7-flash': { input: 0.5, output: 2.0 },
        'custom:step-router-v1': { input: 0.5, output: 2.0 },
      }
      const rate = rates[model] || { input: 1.0, output: 5.0 }
      const cost = (input * rate.input + output * rate.output) / 1_000_000
      return {
        sessionUsageStats: {
          requestCount: state.sessionUsageStats.requestCount + 1,
          totalTokens: state.sessionUsageStats.totalTokens + total,
          inputTokens: state.sessionUsageStats.inputTokens + input,
          outputTokens: state.sessionUsageStats.outputTokens + output,
          thoughtTokens: state.sessionUsageStats.thoughtTokens + thought,
          cachedReadTokens: state.sessionUsageStats.cachedReadTokens + cachedRead,
          cachedWriteTokens: state.sessionUsageStats.cachedWriteTokens + cachedWrite,
          totalCost: state.sessionUsageStats.totalCost + cost,
        },
      }
    }),
  setCurrentSessionId: (id) => set((state) => {
    if (!id) return { currentSessionId: id, activeSessionWorkDir: null }
    // Skip if clicking the same session that's already loaded
    if (id === state.currentSessionId) return {}
    const history = [...state.sessionHistory]
    const idx = state.sessionHistoryIndex
    // Check if the target ID already exists at the current position (deduplicate)
    if (history[idx] === id) {
      return { currentSessionId: id }
    }
    // Remove any forward history when navigating to a new session
    const newHistory = [...history.slice(0, idx + 1), id]
    return {
      currentSessionId: id,
      sessionHistory: newHistory,
      sessionHistoryIndex: newHistory.length - 1,
    }
  }),
  navigateSession: async (direction) => {
    const state = get()
    const { sessionHistory, sessionHistoryIndex } = state
    if (sessionHistory.length === 0) return
    let newIndex = sessionHistoryIndex
    if (direction === 'back' && newIndex > 0) {
      newIndex--
    } else if (direction === 'forward' && newIndex < sessionHistory.length - 1) {
      newIndex++
    } else {
      return
    }
    const targetId = sessionHistory[newIndex]
    if (!targetId) return

    // Flush current session first so we don't lose unsaved messages
    if (state.currentSessionId) {
      await state.flushSessionPersist()
    }

    try {
      const { persistence } = await import('@/lib/persist')
      const all = await persistence.loadSessions()
      const session = all.find(s => s.id === targetId)
      if (!session) {
        // Session may have been deleted — just update the index
        set({ currentSessionId: targetId, sessionHistoryIndex: newIndex })
        return
      }

      const msgs = session.chatMessages.map(msg => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
        images: msg.images,
        timestamp: msg.timestamp,
        reasoning: msg.reasoning,
        steps: msg.steps,
      }))

      useHelixStore.getState().clearExecutionFlow()
      useHermesStore.getState().setHermesSessionId(null)

      const panelState = get()
      if (panelState.showScheduledTasksPanel || panelState.showSkillPanel) {
        useHelixStore.setState({ showScheduledTasksPanel: false, showSkillPanel: false })
      }

      set({
        chatMessages: msgs,
        selectedWorkDir: session.workDir || null,
        activeSessionWorkDir: session.workDir ?? null,
        currentSessionId: targetId,
        sessionHistoryIndex: newIndex,
      })

      // Persist the updated history index
      const { persistence: persistMod } = await import('@/lib/persist')
      await Promise.all([
        persistMod.saveSetting('sessionHistoryIndex', newIndex),
        persistMod.saveSetting('sessionHistory', get().sessionHistory),
      ])

      if (session.workDir) {
        await persistence.saveProjectFolder(session.workDir)
      }
    } catch (e) {
      logError('[navigateSession] failed:', e)
      get().showToast({ type: 'error', title: '会话加载失败' })
    }
  },
  notifySessionSaved: () =>
    set((state) => ({ sessionSaveVersion: state.sessionSaveVersion + 1 })),

  flushSessionPersist: () => {
    return flushSessionPersist()
  },

  // Actions - File modifications
  applyFileChange: (fileId, newContent) =>
    set((state) => ({
      files: updateFileInTree(state.files, fileId, (n) => ({ ...n, content: newContent })),
      openTabs: state.openTabs.map((t) =>
        t.fileId === fileId ? { ...t, isDirty: false } : t
      ),
    })),

  createOrUpdateFile: (filePath, content) => {
    const state = get()
    const existing = state.findFileByPath(filePath)
    if (existing) {
      get().applyFileChange(existing.id, content)
      get().openFile(existing.id)
      return
    }
    // Create new file
    const segments = filePath.split('/')
    const fileName = segments.pop()!
    let parentId: string | null = null

    // Ensure parent folders exist
    for (const folderName of segments) {
      if (!parentId) {
        let folder = state.files.find(f => f.type === 'folder' && f.name === folderName)
        if (!folder) {
          const id = generateId()
          const newFolder: FileNode = { id, name: folderName, type: 'folder', children: [] }
          set((s) => ({ files: [...s.files, newFolder] }))
          const expanded = new Set(get().expandedFolders)
          expanded.add(id)
          set({ expandedFolders: expanded })
          parentId = id
        } else {
          parentId = folder.id
          if (!state.expandedFolders.has(folder.id)) {
            get().toggleFolder(folder.id)
          }
        }
      } else {
        const parent = get().getFileById(parentId)
        let folder = parent?.children?.find(f => f.type === 'folder' && f.name === folderName)
        if (!folder) {
          const id = generateId()
          const newFolder: FileNode = { id, name: folderName, type: 'folder', children: [] }
          set((s) => ({
            files: addFileToTree(s.files, parentId!, newFolder)
          }))
          const expanded = new Set(get().expandedFolders)
          expanded.add(id)
          set({ expandedFolders: expanded })
          parentId = id
        } else {
          parentId = folder.id
        }
      }
    }

    const fileId = generateId()
    const newFile: FileNode = {
      id: fileId,
      name: fileName,
      type: 'file',
      content,
      language: getLanguageFromName(fileName),
    }
    if (parentId) {
      set((s) => ({ files: addFileToTree(s.files, parentId!, newFile) }))
    } else {
      set((s) => ({ files: [...s.files, newFile] }))
    }
    get().openFile(fileId)
  },

  addPendingChange: (change) => {
    const id = generateId()
    set((state) => ({
      pendingChanges: [...state.pendingChanges, { ...change, id }],
    }))
    return id
  },

  applyPendingChange: (changeId) =>
    set((state) => {
      const change = state.pendingChanges.find(c => c.id === changeId)
      if (!change) return state
      return {
        files: updateFileInTree(state.files, change.fileId, (n) => ({ ...n, content: change.newContent })),
        pendingChanges: state.pendingChanges.filter(c => c.id !== changeId),
        openTabs: state.openTabs.map((t) =>
          t.fileId === change.fileId ? { ...t, isDirty: false } : t
        ),
      }
    }),

  rejectPendingChange: (changeId) =>
    set((state) => ({
      pendingChanges: state.pendingChanges.filter(c => c.id !== changeId),
    })),

  applyAllPendingChanges: () =>
    set((state) => {
      let files = state.files
      let openTabs = state.openTabs
      for (const change of state.pendingChanges) {
        files = updateFileInTree(files, change.fileId, (n) => ({ ...n, content: change.newContent }))
        openTabs = openTabs.map((t) =>
          t.fileId === change.fileId ? { ...t, isDirty: false } : t
        )
      }
      return { files, openTabs, pendingChanges: [] }
    }),

  rejectAllPendingChanges: () => set({ pendingChanges: [] }),

  // setShowDiffPreview — in slices/panel-slice.ts

  // Actions - Goal
  setGoal: (goal) => set({ goal }),

  // Actions - Memory
  // Helix's manual memories are synchronized with Hermes's backend memory_manager
  // (memories/MEMORY.md). Hermes is the single source of truth; the local `memories`
  // array is an optimistic cache re-synced from the backend so the two systems
  // stop keeping separate copies.
  addMemory: async (entry) => {
    const content = entry.content.trim()
    if (!content) return
    // optimistic local update (category kept for display only)
    set((state) => ({
      memories: [...state.memories, { ...entry, id: generateId(), createdAt: Date.now(), source: 'manual' }],
    }))
    if (isElectron()) {
      try {
        await getElectronAPI()?.hermes.addMemoryEntry('memory', content)
        await get().loadMemories()
      } catch (e) {
        logError('[helix] addMemory sync failed:', e)
      }
    } else {
      const { persistence } = await import('@/lib/persist')
      persistence.saveMemories(get().memories)
    }
  },
  removeMemory: async (id) => {
    const item = get().memories.find((m) => m.id === id)
    if (!item) return
    set((state) => ({ memories: state.memories.filter((m) => m.id !== id) }))
    if (isElectron()) {
      try {
        await getElectronAPI()?.hermes.removeMemoryEntry('memory', item.content)
      } catch (e) {
        logError('[helix] removeMemory sync failed:', e)
      }
    }
  },
  loadMemories: async () => {
    if (!isElectron()) {
      warn('[helix] loadMemories skipped: not running in Electron')
      return
    }
    try {
      const api = getElectronAPI()
      if (!api) {
        warn('[helix] loadMemories skipped: electron API not available (did you restart Electron?)')
        return
      }
      debug('[helix] loadMemories: calling listMemories...')
      let res = await api.hermes.listMemories()
      debug('[helix] loadMemories: response', { memoryLen: res?.memory?.length, userLen: res?.user?.length, manualLen: res?.manual?.length })
      if (!res) {
        warn('[helix] loadMemories: got null/undefined response from IPC')
        return
      }
      // One-time migration: if Hermes is empty but legacy local memories exist,
      // push them into Hermes so nothing is lost on first sync.
      if ((res.memory?.length ?? 0) === 0) {
        const { persistence } = await import('@/lib/persist')
        const local = await persistence.loadMemories()
        if (local && local.length) {
          for (const m of local) {
            await api.hermes.addMemoryEntry('memory', m.content)
          }
          res = await api.hermes.listMemories()
        }
      }
      const hashText = (s: string) => {
        let h = 5381
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
        return (h >>> 0).toString(36)
      }
      const manualSet = new Set(res.manual || [])
      const list: MemoryEntry[] = (res.memory || []).map((text) => ({
        id: 'hm_' + hashText(text),
        content: text,
        category: 'user' as MemoryCategory,
        createdAt: 0,
        source: manualSet.has(text) ? 'manual' : 'auto',
      }))
      set({ memories: list })
    } catch (e) {
      logError('[helix] loadMemories failed:', e)
    }
  },
  // ── User profile (USER.md) ────────────────────────────────────────────────
  // Separate from MEMORY.md: profile facts about the user that Hermes keeps in
  // USER.md. No origin tagging here — everything in USER.md is user-provided.
  addUserMemory: async (entry) => {
    const content = entry.content.trim()
    if (!content) return
    set((state) => ({
      userMemories: [...state.userMemories, { ...entry, id: generateId(), createdAt: Date.now() }],
    }))
    if (isElectron()) {
      try {
        await getElectronAPI()?.hermes.addMemoryEntry('user', content)
        await get().loadUserMemories()
      } catch (e) {
        logError('[helix] addUserMemory sync failed:', e)
      }
    }
  },
  removeUserMemory: async (id) => {
    const item = get().userMemories.find((m) => m.id === id)
    if (!item) return
    set((state) => ({ userMemories: state.userMemories.filter((m) => m.id !== id) }))
    if (isElectron()) {
      try {
        await getElectronAPI()?.hermes.removeMemoryEntry('user', item.content)
      } catch (e) {
        logError('[helix] removeUserMemory sync failed:', e)
      }
    }
  },
  loadUserMemories: async () => {
    if (!isElectron()) {
      warn('[helix] loadUserMemories skipped: not running in Electron')
      return
    }
    try {
      const api = getElectronAPI()
      if (!api) {
        warn('[helix] loadUserMemories skipped: electron API not available')
        return
      }
      debug('[helix] loadUserMemories: calling listMemories...')
      const res = await api.hermes.listMemories()
      debug('[helix] loadUserMemories: response', { userLen: res?.user?.length })
      const hashText = (s: string) => {
        let h = 5381
        for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
        return (h >>> 0).toString(36)
      }
      const list: MemoryEntry[] = (res.user || []).map((text) => ({
        id: 'up_' + hashText(text),
        content: text,
        category: 'user' as MemoryCategory,
        createdAt: 0,
      }))
      set({ userMemories: list })
    } catch (e) {
      logError('[helix] loadUserMemories failed:', e)
    }
  },
  updateNotes: (notes) => set({ notes }),
  saveCheckpoint: (label) =>
    set((state) => ({
      checkpoints: [
        ...state.checkpoints,
        {
          id: generateId(),
          label: label || `Checkpoint ${state.checkpoints.length + 1}`,
          timestamp: Date.now(),
          taskIds: state.tasks.map(t => t.id),
          memorySnapshot: state.memories.map(m => m.content).join('\n'),
        },
      ],
    })),

  // Actions - Tasks
  addTask: (label, parentId) => {
    const id = generateId()
    const newTask: TaskNode = {
      id,
      label,
      status: 'pending',
      parentId: parentId || null,
      depth: 0,
    }
    if (parentId) {
      set((state) => ({
        tasks: state.tasks.map(t =>
          t.id === parentId
            ? { ...t, children: [...(t.children || []), { ...newTask, depth: t.depth + 1 }] }
            : t
        ),
      }))
    } else {
      set((state) => ({ tasks: [...state.tasks, newTask] }))
    }
    return id
  },

  updateTask: (taskId, updates) =>
    set((state) => ({
      tasks: updateTaskInTree(state.tasks, taskId, updates),
    })),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: removeTaskFromTree(state.tasks, taskId),
    })),

  clearCompletedTasks: () =>
    set((state) => ({
      tasks: state.tasks.filter(t => t.status !== 'done'),
    })),

  // Actions - Scheduled Tasks
  addScheduledTask: (task) => {
    const id = task.id || generateId()
    set((state) => ({
      scheduledTasks: [...state.scheduledTasks, {
        ...task,
        id,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }],
    }))
    return id
  },
  updateScheduledTask: (taskId, updates) =>
    set((state) => ({
      scheduledTasks: state.scheduledTasks.map(t =>
        t.id === taskId ? { ...t, ...updates, updatedAt: Date.now() } : t
      ),
    })),
  removeScheduledTask: (taskId) =>
    set((state) => ({
      scheduledTasks: state.scheduledTasks.filter(t => t.id !== taskId),
    })),
  toggleScheduledTask: (taskId) =>
    set((state) => ({
      scheduledTasks: state.scheduledTasks.map(t =>
        t.id === taskId ? { ...t, enabled: !t.enabled, updatedAt: Date.now() } : t
      ),
    })),
  toggleScheduledTasksPanel: () =>
    set((s) => ({ showScheduledTasksPanel: !s.showScheduledTasksPanel })),

  // Actions - MCP Servers
  addMcpServer: (name, config) =>
    set((state) => ({
      mcpServers: { ...state.mcpServers, [name]: config },
    })),
  removeMcpServer: (name) =>
    set((state) => {
      const { [name]: _, ...rest } = state.mcpServers
      return { mcpServers: rest }
    }),
  updateMcpServer: (name, config) =>
    set((state) => ({
      mcpServers: { ...state.mcpServers, [name]: config },
    })),
  toggleMcpServer: (name) =>
    set((state) => ({
      mcpServers: {
        ...state.mcpServers,
        [name]: {
          ...state.mcpServers[name],
          enabled: !state.mcpServers[name]?.enabled,
        },
      },
    })),

  // Actions - Webhooks/Artifacts — removed (unused features)

  // Actions - Custom Shortcuts
  addCustomShortcut: (id, shortcut) =>
    set((state) => ({
      customShortcuts: { ...state.customShortcuts, [id]: shortcut },
    })),
  removeCustomShortcut: (id) =>
    set((state) => {
      const { [id]: _, ...rest } = state.customShortcuts
      return { customShortcuts: rest }
    }),
  updateCustomShortcut: (id, shortcut) =>
    set((state) => {
      const customizedIds = new Set(state.customizedShortcutIds)
      customizedIds.add(id)
      return {
        customShortcuts: { ...state.customShortcuts, [id]: shortcut },
        customizedShortcutIds: customizedIds,
      }
    }),

  // Actions - Webhooks/Artifacts — removed (unused features)

  // API Config — in slices/api-config-slice.ts

  // Actions - Sub-agents
  spawnSubAgent: (name, description, parentId) => {
    const id = generateId()
    const agent: SubAgent = {
      id,
      name,
      description,
      status: 'running',
      parentId: parentId || null,
      chatMessageId: null,
      createdAt: Date.now(),
    }
    set((s) => ({ subAgents: [...s.subAgents, agent] }))
    return id
  },

  completeSubAgent: (agentId, result, filesModified) =>
    set((s) => ({
      subAgents: s.subAgents.map(a =>
        a.id === agentId
          ? { ...a, status: 'completed' as const, completedAt: Date.now(), result, filesModified }
          : a
      ),
    })),

  failSubAgent: (agentId, error) =>
    set((s) => ({
      subAgents: s.subAgents.map(a =>
        a.id === agentId
          ? { ...a, status: 'failed' as const, completedAt: Date.now(), result: error }
          : a
      ),
    })),

  cancelSubAgent: (agentId) =>
    set((s) => ({
      subAgents: s.subAgents.map(a =>
        a.id === agentId ? { ...a, status: 'cancelled' as const, completedAt: Date.now() } : a
      ),
    })),

  clearCompletedSubAgents: () =>
    set((s) => ({
      subAgents: s.subAgents.filter(a => a.status === 'running'),
    })),

  addSubAgentToolCall: (agentId, toolCall) =>
    set((s) => ({
      subAgents: s.subAgents.map(a =>
        a.id === agentId
          ? { ...a, toolCalls: [...(a.toolCalls || []), { ...toolCall, timestamp: Date.now() }] }
          : a
      ),
    })),

  // Actions - Persistence
  persistToStorage: async () => {
    try {
      const { persistence } = await import('@/lib/persist')
      const state = get()
      const sessionId = 'current-session'
      await Promise.all([
        persistence.saveMemories(state.memories),
        persistence.saveTasks(state.tasks),
        persistence.saveCheckpoints(state.checkpoints),
        persistence.saveNotes(state.notes),
        persistence.saveChatMessages(
          state.chatMessages.map(m => ({
            id: m.id,
            sessionId,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            isStreaming: m.isStreaming ?? false,
          })),
          sessionId
        ),
        persistence.saveSetting('goal', state.goal),
        persistence.saveSetting('apiConfig', state.apiConfig),
        persistence.saveSetting('apiHistory', state.apiHistory),
        persistence.saveSetting('apiProfiles', state.apiProfiles),
        persistence.saveSetting('activeProfileId', state.activeProfileId),
        persistence.saveSetting('providers', state.providers),
        persistence.saveSetting('activeModel', state.activeModel),
        persistence.saveSetting('activeProviderId', state.activeProviderId),
        // Persist the per-provider fetched model lists alongside other config so
        // they never get lost between a fetch and the next full persistToStorage.
        persistence.saveSetting('providerModels', state.providerModels),
        persistence.saveSetting('fontFamily', state.fontFamily),
        persistence.saveSetting('fontSize', state.fontSize),
        persistence.saveSetting('interfaceFont', state.interfaceFont),
        persistence.saveSetting('transcriptFontSize', state.transcriptFontSize),
        persistence.saveSetting('sessionUsageStats', state.sessionUsageStats),
        persistence.saveScheduledTasks(state.scheduledTasks),
        persistence.saveSetting('mcpServers', state.mcpServers),
        // Also sync MCP config to Hermes config.yaml for persistence
        isElectron() && window.electron?.hermes?.setYamlKey?.('mcpServers', Object.fromEntries(
          Object.entries(state.mcpServers).filter(([_, cfg]: any) => cfg.enabled !== false).map(([name, cfg]: any) => [name, {
            type: cfg.type,
            command: cfg.command,
            url: cfg.url,
            environment: cfg.environment,
            cwd: cfg.cwd,
            timeout: cfg.timeout,
            headers: cfg.headers,
          }])
        )),
        persistence.saveSetting('customizedShortcutIds', Array.from(state.customizedShortcutIds)),
        persistence.saveSetting('agentMaxIterations', state.agentMaxIterations),
        persistence.saveSetting('autoCompactContext', state.autoCompactContext),
        persistence.saveSetting('smartTruncation', state.smartTruncation),
        persistence.saveSetting('autoSaveSession', state.autoSaveSession),
        persistence.saveSetting('temperature', state.temperature),
        persistence.saveSetting('maxOutputTokens', state.maxOutputTokens),
        persistence.saveSetting('customInstructions', state.customInstructions),
        persistence.saveSetting('streamingEnabled', state.streamingEnabled),
        persistence.saveSetting('compressionEnabled', state.compressionEnabled),
        persistence.saveSetting('toolGuardrailsEnabled', state.toolGuardrailsEnabled),
        persistence.saveSetting('personality', state.personality),
        persistence.saveSetting('outputStyle', state.outputStyle),
        persistence.saveSetting('desktopNotifications', state.desktopNotifications),
        persistence.saveSetting('soundEnabled', state.soundEnabled),
        persistence.saveSetting('restoreLastSession', state.restoreLastSession),
        persistence.saveSetting('defaultWorkDir', state.defaultWorkDir),
        persistence.saveSetting('language', state.language),
        persistence.saveSetting('confirmDangerousActions', state.confirmDangerousActions),
        persistence.saveSetting('autoApproveRead', state.autoApproveRead),
        persistence.saveSetting('editorTheme', state.editorTheme),
        persistence.saveSetting('gitAutoCommit', state.gitAutoCommit),
        persistence.saveSetting('gitAutoPush', state.gitAutoPush),
        persistence.saveSetting('gitPushConfirm', state.gitPushConfirm),
        persistence.saveSetting('gitAutoBranch', state.gitAutoBranch),
        persistence.saveSetting('gitRemoteUrl', state.gitRemoteUrl),
        persistence.saveSetting('gitCommitTemplate', state.gitCommitTemplate),
        persistence.saveSetting('gitBranchPrefix', state.gitBranchPrefix),
        persistence.saveSetting('sessionHistory', state.sessionHistory),
        persistence.saveSetting('sessionHistoryIndex', state.sessionHistoryIndex),
        persistence.saveSetting('selectedWorkDir', state.selectedWorkDir),
      ])
    } catch (e) {
      logError('Failed to persist:', e)
      get().showToast({ type: 'error', title: '设置保存失败', description: '配置未能写入本地存储，请重试' })
    }
  },

  restoreFromStorage: async () => {
    try {
      const { persistence } = await import('@/lib/persist')
      const sessionId = 'current-session'

      // MCP config is now managed by Hermes
      let fileMcpConfig: Record<string, any> = {}

      // Try loading the latest saved session first (full state)
      const sessions = await persistence.loadSessions()
      const archivedSessions = sessions.filter(s => s.isArchived)
      const latestSession = sessions.filter(s => !s.isArchived).length > 0
        ? sessions.filter(s => !s.isArchived).sort((a, b) => b.savedAt - a.savedAt)[0]
        : null

      // Load individual pieces for settings and non-session state
      const [memories, tasks, checkpoints, notes, chatMessages, goal, apiConfig, apiHistory, apiProfiles, fontFamily, fontSize, interfaceFont, transcriptFontSize, sessionUsageStats, scheduledTasks, mcpServers, customShortcuts, customizedIdsArr, agentMaxIterations, autoCompactContext, smartTruncation, autoSaveSession, temperature, maxOutputTokens, customInstructions, availableModels, providerModels, streamingEnabled, compressionEnabled, toolGuardrailsEnabled, personality, outputStyle, desktopNotifications, soundEnabled, restoreLastSession, defaultWorkDir, language, confirmDangerousActions, autoApproveRead, editorTheme, gitAutoCommit, gitAutoPush, gitPushConfirm, gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix, providers, activeModel, activeProviderId, savedSessionHistory, savedSessionHistoryIndex, savedSelectedWorkDir] = await Promise.all([
        persistence.loadMemories(),
        persistence.loadTasks(),
        persistence.loadCheckpoints(),
        persistence.loadNotes(),
        persistence.loadChatMessagesBySession(sessionId),
        persistence.loadSetting<string | null>('goal'),
        persistence.loadSetting<ApiConfig>('apiConfig'),
        persistence.loadSetting<ApiConfig[]>('apiHistory'),
        persistence.loadSetting<ApiProfile[]>('apiProfiles'),
        persistence.loadSetting<string>('fontFamily'),
        persistence.loadSetting<number>('fontSize'),
        persistence.loadSetting<string>('interfaceFont'),
        persistence.loadSetting<number>('transcriptFontSize'),
        persistence.loadSetting<{
          requestCount: number
          totalTokens: number
          inputTokens: number
          outputTokens: number
          thoughtTokens: number
          cachedReadTokens: number
          cachedWriteTokens: number
          totalCost: number
        }>('sessionUsageStats'),
        persistence.loadSetting<any[]>('scheduledTasks'),
        persistence.loadSetting<Record<string, McpServerConfig>>('mcpServers'),
        persistence.loadSetting<Record<string, { keys: string[], action: string, description: string }>>('customShortcuts'),
        persistence.loadSetting<string[]>('customizedShortcutIds'),
        persistence.loadSetting<number>('agentMaxIterations'),
        persistence.loadSetting<boolean>('autoCompactContext'),
        persistence.loadSetting<boolean>('smartTruncation'),
        persistence.loadSetting<boolean>('autoSaveSession'),
        persistence.loadSetting<number>('temperature'),
        persistence.loadSetting<number>('maxOutputTokens'),
        persistence.loadSetting<string>('customInstructions'),
        persistence.loadSetting<string[]>('availableModels'),
        persistence.loadSetting<Record<string, string[]>>('providerModels'),
        persistence.loadSetting<boolean>('streamingEnabled'),
        persistence.loadSetting<boolean>('compressionEnabled'),
        persistence.loadSetting<boolean>('toolGuardrailsEnabled'),
        persistence.loadSetting<string>('personality'),
        persistence.loadSetting<string>('outputStyle'),
        persistence.loadSetting<boolean>('desktopNotifications'),
        persistence.loadSetting<boolean>('soundEnabled'),
        persistence.loadSetting<boolean>('restoreLastSession'),
        persistence.loadSetting<string>('defaultWorkDir'),
        persistence.loadSetting<string>('language'),
        persistence.loadSetting<boolean>('confirmDangerousActions'),
        persistence.loadSetting<boolean>('autoApproveRead'),
        persistence.loadSetting<string>('editorTheme'),
        persistence.loadSetting<boolean>('gitAutoCommit'),
        persistence.loadSetting<boolean>('gitAutoPush'),
        persistence.loadSetting<boolean>('gitPushConfirm'),
        persistence.loadSetting<boolean>('gitAutoBranch'),
        persistence.loadSetting<string>('gitRemoteUrl'),
        persistence.loadSetting<string>('gitCommitTemplate'),
        persistence.loadSetting<string>('gitBranchPrefix'),
        persistence.loadSetting<ProviderConfig[]>('providers'),
        persistence.loadSetting<string | null>('activeModel'),
        persistence.loadSetting<string | null>('activeProviderId'),
        persistence.loadSetting<string[]>('sessionHistory'),
        persistence.loadSetting<number>('sessionHistoryIndex'),
        persistence.loadSetting<string | null>('selectedWorkDir'),
      ])

      // Do NOT restore the latest session's chatMessages on startup.
      // Always start with an empty welcome screen so the user doesn't see
      // stale/failed messages (e.g. 401 errors) from a previous run.
      // Historical sessions remain available in the sidebar and can be
      // opened manually.
      const defaults = { provider: 'agnes-ai' as const, apiKey: '', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash' }
      // Restore which named profile was active before the restart, so the selection
      // survives a cold start (the profile list itself is persisted to IndexedDB).
      const loadedActiveProfileId = await persistence.loadSetting<string | null>('activeProfileId')

      // ── Build multi-provider config for the flattened model selector ──
      // Always rebuild `builtProviders` from the authoritative declared sources
      // (apiProfiles / apiConfig). We do NOT trust the persisted `providers`
      // field as a source of truth — it is a *runtime output* mirror that was
      // historically polluted by merged fetched-model lists and would re-seed
      // the pollution on every restart. The legacy apiProfiles / apiConfig
      // backfill keeps older installs working without data loss.
      //
      // SELF-HEAL for already-polluted installs: earlier builds unioned every
      // endpoint's fetched models into a single profile's `models` (via
      // handleSaveApi), so existing profiles in IndexedDB may carry models that
      // don't belong to their endpoint — which is what makes the input-bar
      // dropdown show "一堆放一起". When we have the clean per-endpoint fetched
      // list for a profile (providerModels[pid]), we treat it as authoritative
      // and REPLACE the profile's models with it (plus the profile's own
      // configured model). This scrubs cross-endpoint pollution on next restart
      // without needing the user to clear data. When no fetched list exists for a
      // profile, we leave its declared models untouched (can't verify), but the
      // fixed write path (handleSaveApi) will no longer re-pollute it.
      const cleanProfileModels = (p: ApiProfile): string[] => {
        const own = p.config?.model ? [p.config.model] : []
        const fetched = providerModels?.[p.id]
        if (fetched && fetched.length > 0) {
          // Authoritative: this endpoint's own fetched list wins.
          return Array.from(new Set([...own, ...fetched].filter(Boolean)))
        }
        // No fetched list available → we CANNOT verify that p.models is clean.
        // Historical builds unioned other endpoints' models into this array
        // (the "一堆放一起" bug), so trusting it would re-introduce pollution.
        // Trust ONLY the explicitly-configured model. The user can click
        // "获取模型列表" in settings, which populates providerModels[pid] and
        // then this branch switches to the clean fetched list.
        return Array.from(new Set(own.filter(Boolean)))
      }
      const builtProviders: ProviderConfig[] =
        (apiProfiles && apiProfiles.length > 0
              ? apiProfiles.map((p, i) => ({
                  id: p.id || `p-${i}`,
                  name: p.name,
                  baseUrl: p.config?.baseUrl || '',
                  apiKey: p.config?.apiKey || '',
                  models: cleanProfileModels(p),
                  isDefault: p.id === loadedActiveProfileId,
                }))
              : (apiConfig && apiConfig.baseUrl && apiConfig.model
                  ? [{
                      id: 'p-default',
                      name: apiConfig.provider || 'default',
                      baseUrl: apiConfig.baseUrl,
                      apiKey: apiConfig.apiKey,
                      models: [apiConfig.model],
                      isDefault: true,
                    }]
                  : []))
      // Merge the persisted per-provider fetched model lists (providerModels)
      // into each provider's candidate `models` pool. This keeps a single source
      // of truth so a model selected from "获取模型列表" survives a cold restart:
      // without it, `activeModel` would be rejected by the check below (not in
      // `providers[].models`) and silently fall back to the default model.
      const mergedProviders: ProviderConfig[] = builtProviders.map((p) => {
        const fetched = providerModels?.[p.id]
        if (fetched && fetched.length > 0) {
          const models = Array.from(new Set([...p.models, ...fetched]))
          return { ...p, models }
        }
        return p
      })
      const builtActiveModel: string | null =
        activeModel && (
          mergedProviders.some((p) => p.models.includes(activeModel)) ||
          Object.values(providerModels || {}).some((list) => (list || []).includes(activeModel))
        )
          ? activeModel
          : (mergedProviders.length > 0
              ? (mergedProviders.find((p) => p.isDefault)?.models[0] || mergedProviders[0].models[0] || null)
              : null)
      // Resolve the active provider: prefer a saved id that still exists, then
      // the owner of the active model, then the default/first provider.
      const builtActiveProviderId: string | null = (() => {
        if (activeProviderId && mergedProviders.some((p) => p.id === activeProviderId)) {
          return activeProviderId
        }
        if (builtActiveModel) {
          const owner = mergedProviders.find((p) => p.models.includes(builtActiveModel))
          if (owner) return owner.id
          // Fallback: locate the owner via providerModels when the model isn't
          // present in the merged declared+fetched pool (e.g. providerModels
          // loaded but not yet merged), so the active provider scope stays
          // correct instead of drifting to the default/first provider.
          for (const p of mergedProviders) {
            if ((providerModels?.[p.id] || []).includes(builtActiveModel)) return p.id
          }
        }
        return mergedProviders.find((p) => p.isDefault)?.id || mergedProviders[0]?.id || null
      })()

      // Prune sessionHistory: remove IDs that no longer exist in IndexedDB
      const validSessionIds = new Set(sessions.map(s => s.id))
      const prunedHistory = Array.isArray(savedSessionHistory)
        ? savedSessionHistory.filter(id => validSessionIds.has(id))
        : []
      const prunedIndex = savedSessionHistoryIndex != null && savedSessionHistoryIndex < prunedHistory.length
        ? savedSessionHistoryIndex
        : prunedHistory.length - 1

      set({
        // memories are global and owned by the Hermes backend (memories/MEMORY.md);
        // do NOT overwrite them from a per-session snapshot.
        tasks: tasks as TaskNode[],
        checkpoints: checkpoints as SessionCheckpoint[],
        notes: notes || '',
        goal: goal,
        currentSessionId: null,
        sessionHistory: prunedHistory,
        sessionHistoryIndex: prunedIndex,
        selectedWorkDir: savedSelectedWorkDir || latestSession?.workDir || get().selectedWorkDir,
        apiConfig: (() => {
          const resolve = (cfg: any) => {
            // Validation gate: reject stale/bad profiles so a poisoned IndexedDB
            // entry can never re-enter the store and get pushed to Hermes.
            if (!cfg || !cfg.baseUrl) {
              return { ...defaults }
            }
            return { ...defaults, ...cfg }
          }
          // Prefer the active provider built from providers/activeModel — this is
          // what the model selector treats as current, so apiConfig must agree.
          const activeProv = builtActiveProviderId
            ? mergedProviders.find((p) => p.id === builtActiveProviderId)
            : undefined
          if (activeProv && activeProv.baseUrl) {
            return resolve({
              provider: activeProv.name,
              baseUrl: activeProv.baseUrl,
              apiKey: activeProv.apiKey,
              model: builtActiveModel || activeProv.models[0] || activeProv.defaultModel || '',
            })
          }
          if (loadedActiveProfileId) {
            const prof = (apiProfiles || []).find((p) => p.id === loadedActiveProfileId)
            if (prof && prof.config) {
              return resolve(prof.config)
            }
          }
          const p = apiConfig
          if (!p || !p.baseUrl) {
            return { ...defaults }
          }
          return resolve(p)
        })(),
        apiHistory: apiHistory || [],
        apiProfiles: (() => {
          const loaded = apiProfiles || []
          if (loaded.length > 0) {
            // Backfill + SELF-HEAL models[] for existing profiles. We reuse
            // cleanProfileModels() so a profile's models are scrubbed of
            // cross-endpoint pollution (using providerModels[pid] when present)
            // and rewritten to IndexedDB below via persistToStorage on the next
            // save — permanently removing "一堆放一起" without user action.
            return loaded.map(p => ({
              ...p,
              models: cleanProfileModels(p),
            }))
          }
          if (apiHistory && apiHistory.length > 0) {
            return apiHistory.map((h, i) => ({ id: generateId(), name: `配置 ${i + 1}`, config: { ...defaults, ...h }, models: h.model ? [h.model] : [] }))
          }
          return []
        })(),
        // Multi-provider config backing the flattened model selector.
        // Write `mergedProviders` (declared + per-provider fetched) so that each
        // provider's `models` array survives a restart even if `providerModels`
        // fails to load. Without this, `cleanProfileModels` falls back to
        // [config.model] (1 item) when no fetched list exists, and the model
        // dropdown shows only one model after every restart.
        // The merge is strictly per-provider (providerModels[p.id] → provider p),
        // so there is NO cross-endpoint pollution.
        providers: mergedProviders,
        activeModel: builtActiveModel,
        activeProviderId: builtActiveProviderId,
        activeProfileId: (() => {
          const id = loadedActiveProfileId
          if (!id) return null
          const prof = (apiProfiles || []).find((p) => p.id === id)
          if (!prof) return null
          return id
        })(),
        chatMessages: [],
        files: get().files,
        openTabs: get().openTabs,
        fontFamily: fontFamily || (typeof localStorage !== 'undefined' ? localStorage.getItem('helix-font-family') : null) || get().fontFamily,
        fontSize: fontSize || (typeof localStorage !== 'undefined' ? Number(localStorage.getItem('helix-font-size')) || get().fontSize : get().fontSize),
        interfaceFont: interfaceFont || (typeof localStorage !== 'undefined' ? localStorage.getItem('helix-interface-font') : null) || get().interfaceFont,
        transcriptFontSize: transcriptFontSize || (typeof localStorage !== 'undefined' ? Number(localStorage.getItem('helix-transcript-size')) || get().transcriptFontSize : get().transcriptFontSize),
        sessionUsageStats: sessionUsageStats && sessionUsageStats.requestCount >= 0 ? sessionUsageStats : get().sessionUsageStats,
        scheduledTasks: (scheduledTasks as ScheduledTask[]) || [],
        mcpServers: {
          ...fileMcpConfig,
          ...(mcpServers || {}),
        },
        customShortcuts: (() => {
          const customizedIds = new Set(customizedIdsArr || [])
          const defaults = { ...DEFAULT_SHORTCUTS }
          if (customShortcuts && Object.keys(customShortcuts).length > 0) {
            // Only apply shortcuts the user actually customized;
            // new defaults always take effect for the rest.
            for (const id of Object.keys(customShortcuts)) {
              if (customizedIds.has(id)) {
                defaults[id] = customShortcuts[id]
              }
            }
          }
          return defaults
        })(),
        customizedShortcutIds: new Set(customizedIdsArr || []),
        agentMaxIterations: agentMaxIterations ?? get().agentMaxIterations,
        autoCompactContext: autoCompactContext ?? get().autoCompactContext,
        smartTruncation: smartTruncation ?? get().smartTruncation,
        autoSaveSession: autoSaveSession ?? get().autoSaveSession,
        temperature: temperature ?? get().temperature,
        maxOutputTokens: maxOutputTokens ?? get().maxOutputTokens,
        customInstructions: customInstructions ?? get().customInstructions,
        streamingEnabled: streamingEnabled ?? get().streamingEnabled,
        compressionEnabled: compressionEnabled ?? get().compressionEnabled,
        toolGuardrailsEnabled: toolGuardrailsEnabled ?? get().toolGuardrailsEnabled,
        personality: personality ?? get().personality,
        outputStyle: (outputStyle as 'default' | 'concise' | 'detailed' | 'technical') ?? get().outputStyle,
        desktopNotifications: desktopNotifications ?? get().desktopNotifications,
        soundEnabled: soundEnabled ?? get().soundEnabled,
        restoreLastSession: restoreLastSession ?? get().restoreLastSession,
        defaultWorkDir: defaultWorkDir || get().defaultWorkDir,
        language: (language as 'zh' | 'en') ?? get().language,
        confirmDangerousActions: confirmDangerousActions ?? get().confirmDangerousActions,
        autoApproveRead: autoApproveRead ?? get().autoApproveRead,
        availableModels: availableModels || [],
        providerModels: providerModels || {},
        editorTheme: (editorTheme as 'vs-dark' | 'light' | null | undefined) ?? get().editorTheme,
        gitAutoCommit: gitAutoCommit ?? get().gitAutoCommit,
        gitAutoPush: gitAutoPush ?? get().gitAutoPush,
        gitPushConfirm: gitPushConfirm ?? get().gitPushConfirm,
        gitAutoBranch: gitAutoBranch ?? get().gitAutoBranch,
        gitRemoteUrl: gitRemoteUrl || get().gitRemoteUrl,
        gitCommitTemplate: gitCommitTemplate || get().gitCommitTemplate,
        gitBranchPrefix: gitBranchPrefix || get().gitBranchPrefix,
      })

      // Permanently scrub the pollution from IndexedDB: write back the cleaned
      // apiProfiles and the unpolluted providers list. Without this, the on-disk
      // copies keep the old jumbled `models` and only the in-memory state would be
      // clean until the next write. Doing it here makes the "一堆放一起" fix stick
      // after a single restart, with no manual data clearing required.
      try {
        const healed = get()
        await persistence.saveSetting('apiProfiles', healed.apiProfiles)
        await persistence.saveSetting('providers', healed.providers)
      } catch (persistErr) {
        logError('Failed to persist healed model lists:', persistErr)
      }

      // Auto-detect AGENTS.md / CLAUDE.md from project root as fallback
      // Custom instructions are now managed by Hermes
      // No local API call needed

      // Set default workDir from the main process (not renderer process.cwd(),
      // which can resolve to a bare drive root like D:\).
      const currentDir = get().selectedWorkDir
      const isDriveRoot = typeof currentDir === 'string' && /^[a-zA-Z]:[\\/]?$/.test(currentDir)
      if (!currentDir || currentDir === '/' || currentDir === '\\' || isDriveRoot) {
        const fallbackDir = typeof process !== 'undefined' ? process.cwd() : ''
        const info = isElectron() ? await electronApp.getInfo() : { workDir: fallbackDir }
        set({ selectedWorkDir: info.workDir || fallbackDir })
      }

      // Re-apply font CSS variables after restore so the DOM matches the
      // persisted values (not the static defaults that ship with the bundle).
      const s = useHelixStore.getState()
      document.documentElement.style.setProperty('--helix-font-family', s.fontFamily)
      document.body.style.fontFamily = s.fontFamily
      document.documentElement.style.setProperty('--helix-font-size', `${s.fontSize}px`)
      document.documentElement.style.setProperty('--helix-interface-font', s.interfaceFont)
      document.documentElement.style.setProperty('--helix-transcript-size', `${s.transcriptFontSize}px`)
    } catch (e) {
      logError('Failed to restore:', e)
      get().showToast({ type: 'error', title: '数据恢复失败', description: '本地存储读取异常，部分设置可能未加载' })
    }
  },

  saveCheckpointChat: async () => {
    try {
      const { persistence } = await import('@/lib/persist')
      const state = get()
      const sessionId = 'checkpoint-' + Date.now()
      const messages = state.chatMessages
      if (messages.length === 0) return
      await persistence.saveChatMessages(
        messages.map(m => ({
          id: m.id,
          sessionId,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          isStreaming: false,
        })),
        sessionId
      )
    } catch (e) {
      logError('Failed to save checkpoint:', e)
    }
  },

  // Helpers
  getAllFiles: () => {
    const result: FileNode[] = []
    const collect = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.type === 'file') result.push(n)
        if (n.children) collect(n.children)
      }
    }
    collect(get().files)
    return result
  },

  getFilePath: (fileId) => {
    const findPath = (nodes: FileNode[], path: string[]): string | null => {
      for (const n of nodes) {
        const currentPath = [...path, n.name]
        if (n.id === fileId) return currentPath.join('/')
        if (n.children) {
          const found = findPath(n.children, currentPath)
          if (found) return found
        }
      }
      return null
    }
    return findPath(get().files, []) || ''
  },

  findFileByPath: (path) => {
    const segments = path.split('/')
    const fileName = segments.pop()
    let nodes = get().files
    for (const seg of segments) {
      const folder = nodes.find(n => n.type === 'folder' && n.name === seg)
      if (!folder?.children) return null
      nodes = folder.children
    }
    return nodes.find(n => n.name === fileName) || null
  },

  getMemoryContext: () => {
    const state = get()
    if (state.memories.length === 0 && !state.notes) return ''
    let ctx = '\n\n--- 项目记忆 ---\n'
    if (state.memories.length > 0) {
      ctx += '项目知识：\n'
      state.memories.forEach(m => {
        ctx += `  [${m.category}] ${m.content}\n`
      })
    }
    if (state.notes) {
      ctx += `\n会话笔记：\n${state.notes}\n`
    }
    return ctx
  },

  getTaskContext: () => {
    const state = get()
    if (state.tasks.length === 0 && state.subAgents.length === 0) return ''
    let ctx = '\n--- 当前任务 ---\n'
    const renderTasks = (tasks: TaskNode[], prefix = '') => {
      for (const t of tasks) {
        const statusIcon = t.status === 'done' ? '' : t.status === 'in_progress' ? '' : t.status === 'blocked' ? '' : ''
        ctx += `${prefix}${statusIcon} ${t.label}\n`
        if (t.children) renderTasks(t.children, prefix + '  ')
      }
    }
    renderTasks(state.tasks)
    if (state.goal) {
      ctx += `\n目标: ${state.goal}\n`
    }
    // Sub-agent context
    if (state.subAgents.length > 0) {
      ctx += '\n--- 子 Agent 状态 ---\n'
      for (const a of state.subAgents) {
        const statusIcon = a.status === 'running' ? '' : a.status === 'completed' ? '' : a.status === 'failed' ? '' : ''
        ctx += `${statusIcon} ${a.name}: ${a.description}\n`
        if (a.result && a.status === 'completed') {
          ctx += `   结果: ${a.result.slice(0, 200)}\n`
        }
      }
    }
    return ctx
  },
}))
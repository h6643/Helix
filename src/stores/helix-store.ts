import { create } from 'zustand'
import { defaultFiles } from '@/lib/seed-data'
import type { McpServerConfig } from '@/lib/helix/mcp'

export type { McpServerConfig }

export interface FileNode {
  id: string
  name: string
  type: 'file' | 'folder'
  children?: FileNode[]
  content?: string
  language?: string
}

export interface ImageAttachment {
  id: string
  dataUrl: string      // "data:image/png;base64,..."
  mediaType: string     // "image/png", "image/jpeg", "image/webp"
  width?: number
  height?: number
  name?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  images?: ImageAttachment[]
  timestamp: number
  isStreaming?: boolean
}

export interface EditorTab {
  id: string
  fileId: string
  name: string
  language: string
  isDirty: boolean
}

export interface CursorPosition {
  line: number
  column: number
}

export interface ToastMessage {
  id: string
  type: 'success' | 'error' | 'info' | 'warning'
  title: string
  description?: string
  duration?: number
}

export interface PendingChange {
  id: string
  fileId: string
  fileName: string
  filePath: string
  oldContent: string
  newContent: string
  language: string
}

export type ApiProvider = string
export type AgentEngine = 'helix'

export interface ApiConfig {
  provider: ApiProvider
  apiKey: string
  baseUrl: string
  model: string
  engine?: AgentEngine
}

export const PROVIDER_PRESETS: Record<string, { name: string; baseUrl: string; models: string[] }> = {}

export interface Skill {
  id: string
  name: string
  description: string
  prompt: string
  icon?: string
  isBuiltin?: boolean
  createdAt: number
}

export type MemoryCategory = 'user' | 'feedback' | 'project' | 'reference' | 'architecture' | 'rule' | 'decision' | 'pattern' | 'gotcha'

export interface MemoryEntry {
  id: string
  content: string
  category: MemoryCategory
  createdAt: number
}

export interface TaskNode {
  id: string
  label: string
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  children?: TaskNode[]
  parentId: string | null
  depth: number
}

export interface SessionCheckpoint {
  id: string
  label: string
  timestamp: number
  taskIds: string[]
 memorySnapshot: string
}

export interface ScheduledTask {
  id: string
  label: string
  prompt: string
  scheduleText: string       // e.g. "every day at 9am" or "cron: 0 9 * * *"
  cronExpression?: string    // parsed cron expression
  enabled: boolean
  lastRunAt: number | null
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Artifact {
  id: string
  title: string
  content: string
  type: 'html' | 'markdown' | 'mermaid'
  createdAt: number
  updatedAt: number
}

export interface ToolCallEntry {
  toolName: string
  params: string
  status: 'running' | 'success' | 'error'
  timestamp: number
}

export interface SubAgent {
  id: string
  name: string
  description: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  parentId: string | null
  chatMessageId: string | null
  createdAt: number
  completedAt?: number
  result?: string
  filesModified?: string[]
  toolCalls?: ToolCallEntry[]
}

interface HelixState {
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

  // API Configuration
  apiConfig: ApiConfig
  apiHistory: ApiConfig[]
  showSettings: boolean
  availableModels: string[]
  setAvailableModels: (models: string[]) => void

  // Chat
  chatMessages: ChatMessage[]
  isChatLoading: boolean

  // Skills
  skills: Skill[]
  showSkillPanel: boolean

  // Terminal
  terminalOutput: string[]
  isTerminalOpen: boolean
  terminalHistory: string[]
  terminalHistoryIndex: number

  // Goal
  goal: string | null

  // Memory
  memories: MemoryEntry[]
  notes: string
  checkpoints: SessionCheckpoint[]

  // Tasks
  tasks: TaskNode[]

  // Scheduled Tasks
  scheduledTasks: ScheduledTask[]
  showScheduledTasksPanel: boolean

  // MCP Servers
  mcpServers: Record<string, McpServerConfig>

  // Custom Shortcuts
  customShortcuts: Record<string, { keys: string[], action: string, description: string }>

  // Artifacts
  artifacts: Artifact[]
  showArtifactsPanel: boolean

  // Customize
  showCustomizePanel: boolean

  // Agent Execution
  agentExecutionSteps: Array<{ type: string; toolName?: string; path?: string; content?: string; toolParams?: Record<string, unknown>; timestamp: number }>
  accessedDirectories: string[]
  selectedFiles: string[]
  selectedWorkDir: string | null
  setSelectedWorkDir: (dir: string | null) => void
  sessionSaveVersion: number
  currentSessionId: string | null
  setCurrentSessionId: (id: string | null) => void
  addExecutionStep: (step: { type: string; toolName?: string; path?: string; content?: string; toolParams?: Record<string, unknown> }) => void
  addAccessedDirectory: (dir: string) => void
  addSelectedFile: (filePath: string) => void
  removeSelectedFile: (filePath: string) => void
  clearSelectedFiles: () => void
  clearExecutionFlow: () => void
  modelUsage: Record<string, { prompt: number; completion: number; total: number; cost: number }>
  addModelUsage: (model: string, usage: { prompt: number; completion: number; total: number; cost: number }) => void
  currentSessionTokens: { prompt: number; completion: number; total: number }
  addCurrentSessionTokens: (usage: { prompt: number; completion: number; total: number }) => void
  resetCurrentSessionTokens: () => void
  notifySessionSaved: () => void

  // UI
  showCommandPalette: boolean
  editorTheme: 'vs-dark' | 'light'
  fontFamily: string
  fontSize: number
  interfaceFont: string
  transcriptFontSize: number
  toasts: ToastMessage[]
  pendingChanges: PendingChange[]
  showDiffPreview: boolean
  showTaskPanel: boolean
  showMemoryPanel: boolean
  showSubAgentPanel: boolean
  showSessionManager: boolean

  // Agent Settings
  agentMaxIterations: number
  autoCompactContext: boolean
  smartTruncation: boolean
  autoSaveSession: boolean
  temperature: number
  maxOutputTokens: number
  customInstructions: string

  // Actions - Agent Settings
  setAgentMaxIterations: (n: number) => void
  setAutoCompactContext: (v: boolean) => void
  setSmartTruncation: (v: boolean) => void
  setAutoSaveSession: (v: boolean) => void
  setTemperature: (v: number) => void
  setMaxOutputTokens: (v: number) => void
  setCustomInstructions: (v: string) => void

  // Actions - Files
  setFiles: (files: FileNode[]) => void
  syncFilesFromDisk: () => Promise<void>
  selectFile: (fileId: string) => void
  toggleFolder: (folderId: string) => void
  createFile: (parentId: string | null, name: string, type: 'file' | 'folder') => void
  deleteFile: (fileId: string) => void
  updateFileContent: (fileId: string, content: string) => void
  getFileById: (fileId: string) => FileNode | null
  renameFile: (fileId: string, newName: string) => void

  // Actions - Tabs
  openFile: (fileId: string) => void
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void

  // Actions - Skills
  addSkill: (skill: Omit<Skill, 'id' | 'createdAt'>) => string
  updateSkill: (skillId: string, updates: Partial<Skill>) => void
  removeSkill: (skillId: string) => void
  toggleSkillPanel: () => void

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

  // Actions - Terminal
  addTerminalOutput: (output: string) => void
  clearTerminal: () => void
  toggleTerminal: () => void
  pushTerminalHistory: (cmd: string) => void
  navigateTerminalHistory: (direction: 'up' | 'down') => string

  // Actions - UI
  toggleCommandPalette: () => void
  setCommandPaletteOpen: (open: boolean) => void
  setEditorTheme: (theme: 'vs-dark' | 'light') => void
  setFontFamily: (font: string) => void
  setFontSize: (size: number) => void
  setInterfaceFont: (font: string) => void
  setTranscriptFontSize: (size: number) => void
  showToast: (toast: Omit<ToastMessage, 'id'>) => void
  dismissToast: (id: string) => void

  // Actions - File modifications
  applyFileChange: (fileId: string, newContent: string) => void
  createOrUpdateFile: (filePath: string, content: string) => void
  addPendingChange: (change: Omit<PendingChange, 'id'>) => string
  applyPendingChange: (changeId: string) => void
  rejectPendingChange: (changeId: string) => void
  applyAllPendingChanges: () => void
  rejectAllPendingChanges: () => void
  setShowDiffPreview: (show: boolean) => void

  // Actions - Goal
  setGoal: (goal: string | null) => void

  // Actions - Memory
  addMemory: (entry: Omit<MemoryEntry, 'id' | 'createdAt'>) => void
  removeMemory: (id: string) => void
  updateNotes: (notes: string) => void
  saveCheckpoint: (label?: string) => void

  // Actions - Tasks
  addTask: (label: string, parentId?: string) => string
  updateTask: (taskId: string, updates: Partial<Pick<TaskNode, 'label' | 'status'>>) => void
  removeTask: (taskId: string) => void
  clearCompletedTasks: () => void

  // Actions - Scheduled Tasks
  addScheduledTask: (task: Omit<ScheduledTask, 'id' | 'createdAt' | 'updatedAt'>) => string
  updateScheduledTask: (taskId: string, updates: Partial<Omit<ScheduledTask, 'id' | 'createdAt'>>) => void
  removeScheduledTask: (taskId: string) => void
  toggleScheduledTask: (taskId: string) => void
  toggleScheduledTasksPanel: () => void

  // Actions - MCP Servers
  addMcpServer: (name: string, config: McpServerConfig) => void
  removeMcpServer: (name: string) => void
  updateMcpServer: (name: string, config: McpServerConfig) => void
  toggleMcpServer: (name: string) => void

  // Actions - Custom Shortcuts
  addCustomShortcut: (id: string, shortcut: { keys: string[], action: string, description: string }) => void
  removeCustomShortcut: (id: string) => void
  updateCustomShortcut: (id: string, shortcut: { keys: string[], action: string, description: string }) => void

  // Actions - Artifacts
  addArtifact: (a: Omit<Artifact, 'id' | 'createdAt' | 'updatedAt'>) => string
  removeArtifact: (id: string) => void
  toggleArtifactsPanel: () => void
  toggleCustomizePanel: () => void

  // Actions - Panels
  toggleTaskPanel: () => void
  toggleMemoryPanel: () => void
  toggleSubAgentPanel: () => void
  toggleSessionManager: () => void
  toggleSettings: () => void

  // Actions - API Config
  setApiConfig: (config: Partial<ApiConfig>) => void
  getApiConfig: () => ApiConfig
  addApiHistory: (config: ApiConfig) => void
  removeApiHistory: (index: number) => void
  selectApiHistory: (index: number) => void

  // Actions - Sub-agents
  spawnSubAgent: (name: string, description: string, parentId?: string) => string
  completeSubAgent: (agentId: string, result?: string, filesModified?: string[]) => void
  failSubAgent: (agentId: string, error?: string) => void
  cancelSubAgent: (agentId: string) => void
  clearCompletedSubAgents: () => void
  addSubAgentToolCall: (agentId: string, toolCall: { toolName: string; params: string; status: 'running' | 'success' | 'error' }) => void

  // Git
  gitAutoCommit: boolean
  gitAutoPush: boolean
  gitPushConfirm: boolean
  gitAutoBranch: boolean
  gitRemoteUrl: string
  gitCommitTemplate: string
  gitBranchPrefix: string
  setGitAutoCommit: (v: boolean) => void
  setGitAutoPush: (v: boolean) => void
  setGitPushConfirm: (v: boolean) => void
  setGitAutoBranch: (v: boolean) => void
  setGitRemoteUrl: (v: string) => void
  setGitCommitTemplate: (v: string) => void
  setGitBranchPrefix: (v: string) => void

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

function generateId(): string {
  return Math.random().toString(36).substr(2, 9)
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
function scheduleSessionPersist() {
  if (sessionPersistTimer) clearTimeout(sessionPersistTimer)
  sessionPersistTimer = setTimeout(async () => {
    sessionPersistTimer = null
    try {
      const { persistence } = await import('@/lib/persist')
      const state = useHelixStore.getState()
      if (state.chatMessages.length === 0) return
      const sessionId = state.currentSessionId || 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      const firstUser = state.chatMessages.find(m => m.role === 'user')
      const label = firstUser ? firstUser.content.slice(0, 50) : new Date().toLocaleString('zh-CN')
      await persistence.saveSession({
        id: sessionId,
        label,
        workDir: state.selectedWorkDir,
        goal: state.goal,
        memories: state.memories,
        tasks: state.tasks,
        notes: state.notes,
        checkpoints: state.checkpoints,
        chatMessages: state.chatMessages.map(m => ({
          id: m.id, sessionId, role: m.role,
          content: m.content, images: m.images, timestamp: m.timestamp, isStreaming: m.isStreaming ?? false,
        })),
        files: collectFiles(state.files),
        openTabs: state.openTabs.map(tab => ({
          id: tab.id, fileId: tab.fileId, name: tab.name, language: tab.language, isDirty: tab.isDirty,
        })),
      })
      if (!state.currentSessionId) {
        useHelixStore.setState({ currentSessionId: sessionId })
      }
    } catch (e) {
      console.error('Failed to persist session:', e)
    }
  }, 1000)
}

export const DEFAULT_SHORTCUTS: Record<string, { keys: string[]; action: string; description: string }> = {
  'archive-chat': { keys: ['Ctrl', 'Shift', 'A'], action: 'archive-chat', description: '归档聊天' },
  'new-chat': { keys: ['Ctrl', 'N'], action: 'new-chat', description: '新对话' },
  'side-chat': { keys: ['Ctrl', 'Alt', 'S'], action: 'side-chat', description: '打开侧边聊天' },
  'quick-chat': { keys: ['Ctrl', 'Alt', 'N'], action: 'quick-chat', description: '新建快速对话' },
  'toggle-pin': { keys: ['Ctrl', 'Alt', 'P'], action: 'toggle-pin', description: '切换置顶状态' },
  'search-chat': { keys: ['Ctrl', 'F'], action: 'search-chat', description: '查找' },
  'focus-address': { keys: ['Ctrl', 'L'], action: 'focus-address', description: '聚焦浏览器地址栏' },
  'go-back': { keys: ['Ctrl', '['], action: 'go-back', description: '返回' },
  'go-forward': { keys: ['Ctrl', ']'], action: 'go-forward', description: '前进' },
  'next-recent-chat': { keys: ['Ctrl', 'Tab'], action: 'next-recent-chat', description: '下一个最近查看的聊天' },
  'prev-recent-chat': { keys: ['Ctrl', 'Shift', 'Tab'], action: 'prev-recent-chat', description: '上一个最近查看的聊天' },
  'next-tab': { keys: ['Ctrl', 'Shift', ']'], action: 'next-tab', description: '下一个标签页' },
  'prev-tab-1': { keys: ['Ctrl', 'Shift', '['], action: 'prev-tab', description: '上一个标签页' },
  'next-tab-pg': { keys: ['Ctrl', 'PageDown'], action: 'next-tab', description: '下一个标签页' },
  'prev-tab-pg': { keys: ['Ctrl', 'PageUp'], action: 'prev-tab', description: '上一个标签页' },
  'next-chat': { keys: ['Ctrl', 'Shift', ']'], action: 'next-chat', description: '下一个聊天' },
  'prev-chat': { keys: ['Ctrl', 'Shift', '['], action: 'prev-chat', description: '上一个聊天' },
  'new-browser-tab': { keys: ['Ctrl', 'T'], action: 'new-browser-tab', description: '打开浏览器标签页' },
  'open-review': { keys: ['Ctrl', 'Shift', 'G'], action: 'open-review', description: '打开审查选项卡' },
  'toggle-bottom-panel': { keys: ['Ctrl', 'J'], action: 'toggle-bottom-panel', description: '切换底部面板' },
  'toggle-browser-panel': { keys: ['Ctrl', 'Shift', 'B'], action: 'toggle-browser-panel', description: '显示/隐藏浏览器面板' },
  'toggle-sidebar': { keys: ['Ctrl', 'B'], action: 'toggle-sidebar', description: '切换边栏' },
  'toggle-side-panel': { keys: ['Ctrl', 'Alt', 'B'], action: 'toggle-side-panel', description: '切换侧边面板' },
  'toggle-terminal': { keys: ['Ctrl', '`'], action: 'toggle-terminal', description: '打开终端' },
  'env-action-1': { keys: ['Shift', 'Win', 'D'], action: 'env-action-1', description: '环境操作 1' },
  'open-folder': { keys: ['Ctrl', 'O'], action: 'open-folder', description: '打开文件夹' },
  'force-reload': { keys: ['Ctrl', 'Shift', 'R'], action: 'force-reload', description: '强制重新加载技能' },
  'browser-back': { keys: ['Alt', 'ArrowLeft'], action: 'browser-back', description: '浏览器返回' },
  'browser-forward': { keys: ['Alt', 'ArrowRight'], action: 'browser-forward', description: '浏览器前进' },
  'new-window': { keys: ['Ctrl', 'Shift', 'N'], action: 'new-window', description: '新建窗口' },
  'command-palette': { keys: ['Ctrl', 'K'], action: 'command-palette', description: '打开命令面板' },
  'command-palette-2': { keys: ['Ctrl', 'Shift', 'P'], action: 'command-palette', description: '打开命令面板' },
  'reload-page': { keys: ['Ctrl', 'R'], action: 'reload-page', description: '重新加载页面' },
  'rename-chat': { keys: ['Ctrl', 'Alt', 'R'], action: 'rename-chat', description: '重命名聊天' },
  'search-chats': { keys: ['Ctrl', 'G'], action: 'search-chats', description: '搜索聊天' },
  'search-files': { keys: ['Ctrl', 'P'], action: 'search-files', description: '搜索文件' },
  'show-shortcuts': { keys: ['Ctrl', 'Shift', '/'], action: 'show-shortcuts', description: '显示键盘快捷键' },
  'settings': { keys: ['Ctrl', ','], action: 'settings', description: '设置' },
  'approve-request': { keys: ['Enter'], action: 'approve-request', description: '批准请求' },
  'decline-request': { keys: ['Escape'], action: 'decline-request', description: '拒绝请求' },
  'close-tab': { keys: ['Ctrl', 'W'], action: 'close-tab', description: '关闭标签页' },
  'close-tab-2': { keys: ['Ctrl', 'F4'], action: 'close-tab', description: '关闭标签页' },
  'close-window': { keys: ['Ctrl', 'W'], action: 'close-window', description: '关闭窗口' },
  'close-window-2': { keys: ['Ctrl', 'F4'], action: 'close-window', description: '关闭窗口' },
  'model-picker': { keys: ['Ctrl', 'Shift', 'M'], action: 'model-picker', description: '打开模型选择器' },
  'start-dictation': { keys: ['Ctrl', 'Shift', 'D'], action: 'start-dictation', description: '开始听写' },
  'toggle-voice': { keys: ['Ctrl', 'Shift', 'V'], action: 'toggle-voice', description: '切换语音模式' },
  'copy-path': { keys: ['Ctrl', 'Alt', 'Shift', 'C'], action: 'copy-path', description: '复制路径' },
  'copy-deeplink': { keys: ['Ctrl', 'Alt', 'L'], action: 'copy-deeplink', description: '复制深度链接' },
  'copy-session-id': { keys: ['Ctrl', 'Alt', 'C'], action: 'copy-session-id', description: '复制会话 ID' },
  'copy-workdir': { keys: ['Ctrl', 'Shift', 'C'], action: 'copy-workdir', description: '复制工作目录' },
  'trace-recording': { keys: ['Ctrl', 'Shift', 'S'], action: 'trace-recording', description: '开始录制追踪' },
  'chat-1': { keys: ['Ctrl', '1'], action: 'chat-1', description: '转到聊天 1' },
  'chat-2': { keys: ['Ctrl', '2'], action: 'chat-2', description: '转到聊天 2' },
  'chat-3': { keys: ['Ctrl', '3'], action: 'chat-3', description: '转到聊天 3' },
  'chat-4': { keys: ['Ctrl', '4'], action: 'chat-4', description: '转到聊天 4' },
  'chat-5': { keys: ['Ctrl', '5'], action: 'chat-5', description: '转到聊天 5' },
  'chat-6': { keys: ['Ctrl', '6'], action: 'chat-6', description: '转到聊天 6' },
  'chat-7': { keys: ['Ctrl', '7'], action: 'chat-7', description: '转到聊天 7' },
  'chat-8': { keys: ['Ctrl', '8'], action: 'chat-8', description: '转到聊天 8' },
  'chat-9': { keys: ['Ctrl', '9'], action: 'chat-9', description: '转到聊天 9' },
  'toggle-file-tree': { keys: ['Ctrl', 'Shift', 'E'], action: 'toggle-file-tree', description: '切换文件树' },
}

export const useHelixStore = create<HelixState>((set, get) => ({
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

  // Skills
  skills: [],
  showSkillPanel: false,

  // Terminal
  terminalOutput: [
    'Helix v1.0.0 ready — type help for commands',
    '',
  ],
  isTerminalOpen: true,
  terminalHistory: [],
  terminalHistoryIndex: 0,

  // UI
  showCommandPalette: false,
  editorTheme: 'vs-dark' as const,
  fontFamily: "'Geist Mono', 'Fira Code', 'Consolas', monospace" as const,
  fontSize: 14 as const,
  interfaceFont: 'var(--font-geist-sans)' as const,
  transcriptFontSize: 14,
  toasts: [],
  pendingChanges: [],
  showDiffPreview: false,
  showTaskPanel: false,
  showMemoryPanel: false,

  // Agent Execution
  agentExecutionSteps: [],
  accessedDirectories: [],
  selectedFiles: [],
  selectedWorkDir: null,
  sessionSaveVersion: 0,
  currentSessionId: null,
  showSubAgentPanel: false,
  modelUsage: {},
  currentSessionTokens: { prompt: 0, completion: 0, total: 0 },
  showSessionManager: false,

  // Agent Settings
  agentMaxIterations: 50,
  autoCompactContext: true,
  smartTruncation: true,
  autoSaveSession: false,
  temperature: 0.7,
  maxOutputTokens: 4096,
  customInstructions: '',

  // Sub-agents
  subAgents: [],

  // API Configuration
  apiConfig: {
    provider: 'openai',
    apiKey: '',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  apiHistory: [],
  showSettings: false,
  availableModels: [],

  // Git
  gitAutoCommit: false,
  gitAutoPush: false,
  gitPushConfirm: true,
  gitAutoBranch: false,
  gitRemoteUrl: '',
  gitCommitTemplate: 'chore: auto-commit changes',
  gitBranchPrefix: 'feature/',
  setGitAutoCommit: (v) => set({ gitAutoCommit: v }),
  setGitAutoPush: (v) => set({ gitAutoPush: v }),
  setGitPushConfirm: (v) => set({ gitPushConfirm: v }),
  setGitAutoBranch: (v) => set({ gitAutoBranch: v }),
  setGitRemoteUrl: (v) => set({ gitRemoteUrl: v }),
  setGitCommitTemplate: (v) => set({ gitCommitTemplate: v }),
  setGitBranchPrefix: (v) => set({ gitBranchPrefix: v }),

  // Goal
  goal: null,

  // Memory
  memories: [],
  notes: '',
  checkpoints: [],

  // Tasks
  tasks: [],

  // Scheduled Tasks
  scheduledTasks: [],
  showScheduledTasksPanel: false,

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

  // Artifacts
  artifacts: [],
  showArtifactsPanel: false,

  // Customize
  showCustomizePanel: false,

  // Actions - Files
  setFiles: (files) => set({ files }),
  syncFilesFromDisk: async () => {
    try {
      const workDir = (globalThis as any).__helixWorkDir || process.cwd()
      const response = await fetch('/api/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workDir }),
      })
      if (!response.ok) return
      const data = await response.json()
      if (!data.structure) return

      // Parse the text structure into FileNode tree
      const lines: string[] = data.structure.split('\n')
      const root: FileNode[] = []
      const stack: { indent: number; node: FileNode }[] = []

      for (const line of lines) {
        if (!line.trim()) continue
        const indent = line.search(/\S/)
        const name = line.trim().replace(/\/$/, '')
        const isDir = line.trim().endsWith('/')
        const node: FileNode = {
          id: `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name,
          type: isDir ? 'folder' : 'file',
          content: '',
          children: isDir ? [] : undefined,
        }

        while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
          stack.pop()
        }

        if (stack.length === 0) {
          root.push(node)
        } else {
          const parent = stack[stack.length - 1].node
          if (!parent.children) parent.children = []
          parent.children.push(node)
        }

        if (isDir) {
          stack.push({ indent, node })
        }
      }

      set({ files: root })
    } catch (err) {
      console.error('[Sync] Failed to sync files from disk:', err)
    }
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

  renameFile: (fileId, newName) =>
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
    })),

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

  // Actions - Chat
  addChatMessage: (message) => {
    const id = generateId()
    set((state) => ({
      chatMessages: [...state.chatMessages, { ...message, id, timestamp: Date.now() }],
    }))
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
      selectedWorkDir: null,
      currentSessionTokens: { prompt: 0, completion: 0, total: 0 },
    })
    if (prevId) {
      import('@/lib/persist').then(({ persistence }) => {
        persistence.deleteChatMessagesBySession(prevId)
        persistence.deleteChatMessagesBySession('current-session')
      })
    }
  },
  clearChatAndPersist: async () => {
    get().clearChat()
  },

  setChatLoading: (loading) => set({ isChatLoading: loading }),

  // Actions - Terminal
  addTerminalOutput: (output) =>
    set((state) => ({ terminalOutput: [...state.terminalOutput, output] })),
  clearTerminal: () => set({ terminalOutput: [] }),
  toggleTerminal: () => set((state) => ({ isTerminalOpen: !state.isTerminalOpen })),
  pushTerminalHistory: (cmd) =>
    set((state) => ({
      terminalHistory: [...state.terminalHistory, cmd],
      terminalHistoryIndex: state.terminalHistory.length + 1,
    })),
  navigateTerminalHistory: (direction) => {
    const state = get()
    const history = state.terminalHistory
    let idx = state.terminalHistoryIndex
    if (direction === 'up' && idx > 0) idx--
    else if (direction === 'down' && idx < history.length) idx++
    set({ terminalHistoryIndex: idx })
    return history[idx] || ''
  },

  // Actions - Editor
  setCursorPosition: (pos) => set({ cursorPosition: pos }),
  markTabSaved: (tabId) =>
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.id === tabId ? { ...t, isDirty: false } : t
      ),
    })),

  // Actions - UI
  toggleCommandPalette: () =>
    set((state) => ({ showCommandPalette: !state.showCommandPalette })),
  setCommandPaletteOpen: (open) => set({ showCommandPalette: open }),
  setEditorTheme: (theme) => set({ editorTheme: theme }),
  setFontFamily: (fontFamily) => {
    set({ fontFamily })
    document.documentElement.style.setProperty('--helix-font-family', fontFamily)
    document.body.style.fontFamily = fontFamily
    localStorage.setItem('helix-font-family', fontFamily)
  },
  setFontSize: (fontSize) => {
    set({ fontSize })
    document.documentElement.style.setProperty('--helix-font-size', `${fontSize}px`)
    localStorage.setItem('helix-font-size', String(fontSize))
  },
  setInterfaceFont: (font) => {
    set({ interfaceFont: font })
    document.documentElement.style.setProperty('--helix-interface-font', font)
    document.body.style.fontFamily = font
    localStorage.setItem('helix-interface-font', font)
  },
  setTranscriptFontSize: (size) => {
    set({ transcriptFontSize: size })
    document.documentElement.style.setProperty('--helix-transcript-size', `${size}px`)
    localStorage.setItem('helix-transcript-size', String(size))
  },

  showToast: (toast) => {
    const id = generateId()
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) }))
    }, toast.duration || 3000)
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) })),

  // Actions - Agent Settings
  setAgentMaxIterations: (n) => set({ agentMaxIterations: n }),
  setAutoCompactContext: (v) => set({ autoCompactContext: v }),
  setSmartTruncation: (v) => set({ smartTruncation: v }),
  setAutoSaveSession: (v) => set({ autoSaveSession: v }),
  setTemperature: (v) => set({ temperature: v }),
  setMaxOutputTokens: (v) => set({ maxOutputTokens: v }),
  setCustomInstructions: (v) => set({ customInstructions: v }),

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
  setSelectedWorkDir: (dir: string | null) =>
    set({ selectedWorkDir: dir }),
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
  addCurrentSessionTokens: (usage) =>
    set((state) => ({
      currentSessionTokens: {
        prompt: state.currentSessionTokens.prompt + usage.prompt,
        completion: state.currentSessionTokens.completion + usage.completion,
        total: state.currentSessionTokens.total + usage.total,
      }
    })),
  resetCurrentSessionTokens: () =>
    set({ currentSessionTokens: { prompt: 0, completion: 0, total: 0 } }),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
  notifySessionSaved: () =>
    set((state) => ({ sessionSaveVersion: state.sessionSaveVersion + 1 })),

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

  setShowDiffPreview: (show) => set({ showDiffPreview: show }),

  // Actions - Goal
  setGoal: (goal) => set({ goal }),

  // Actions - Memory
  addMemory: (entry) =>
    set((state) => ({
      memories: [...state.memories, { ...entry, id: generateId(), createdAt: Date.now() }],
    })),
  removeMemory: (id) =>
    set((state) => ({ memories: state.memories.filter(m => m.id !== id) })),
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
    const id = generateId()
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
    set((state) => ({
      customShortcuts: { ...state.customShortcuts, [id]: shortcut },
    })),

  // Actions - Artifacts
  addArtifact: (a) => {
    const id = generateId()
    set((state) => ({
      artifacts: [...state.artifacts, { ...a, id, createdAt: Date.now(), updatedAt: Date.now() }],
    }))
    return id
  },
  removeArtifact: (id) =>
    set((state) => ({
      artifacts: state.artifacts.filter(a => a.id !== id),
    })),
  toggleArtifactsPanel: () =>
    set((s) => ({ showArtifactsPanel: !s.showArtifactsPanel })),
  toggleCustomizePanel: () =>
    set((s) => ({ showCustomizePanel: !s.showCustomizePanel })),

  // Actions - Panels
  toggleTaskPanel: () => set((s) => ({ showTaskPanel: !s.showTaskPanel })),
  toggleMemoryPanel: () => set((s) => ({ showMemoryPanel: !s.showMemoryPanel })),
  toggleSubAgentPanel: () => set((s) => ({ showSubAgentPanel: !s.showSubAgentPanel })),
  toggleSessionManager: () => set((s) => ({ showSessionManager: !s.showSessionManager })),
  toggleSettings: () => set((s) => ({ showSettings: !s.showSettings })),

  // Actions - API Config
  setApiConfig: (config) =>
    set((state) => ({
      apiConfig: { ...state.apiConfig, ...config },
    })),
  getApiConfig: () => get().apiConfig,
  setAvailableModels: (models) => {
    set({ availableModels: models })
    // Persist to storage so models survive restart
    import('@/lib/persist').then(({ persistence }) => {
      persistence.saveSetting('availableModels', models)
    })
  },

  addApiHistory: (config) =>
    set((state) => {
      // Deduplicate by baseUrl+apiKey+model
      const exists = state.apiHistory.some(
        h => h.baseUrl === config.baseUrl && h.apiKey === config.apiKey && h.model === config.model
      )
      if (exists) return state
      // Keep max 20 entries, newest first
      const newHistory = [config, ...state.apiHistory].slice(0, 20)
      return { apiHistory: newHistory }
    }),

  removeApiHistory: (index) =>
    set((state) => ({
      apiHistory: state.apiHistory.filter((_, i) => i !== index),
    })),

  selectApiHistory: (index) =>
    set((state) => {
      const config = state.apiHistory[index]
      if (!config) return state
      return { apiConfig: { ...config } }
    }),

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
        persistence.saveSetting('fontFamily', state.fontFamily),
        persistence.saveSetting('fontSize', state.fontSize),
        persistence.saveSetting('interfaceFont', state.interfaceFont),
        persistence.saveSetting('transcriptFontSize', state.transcriptFontSize),
        persistence.saveScheduledTasks(state.scheduledTasks),
        persistence.saveSetting('mcpServers', state.mcpServers),
        // Also save MCP config to helix.json on disk
        fetch('/api/mcp/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mcpServers: state.mcpServers }),
        }).catch(() => {/* non-critical */}),
        persistence.saveSetting('customShortcuts', state.customShortcuts),
        persistence.saveSetting('agentMaxIterations', state.agentMaxIterations),
        persistence.saveSetting('autoCompactContext', state.autoCompactContext),
        persistence.saveSetting('smartTruncation', state.smartTruncation),
        persistence.saveSetting('autoSaveSession', state.autoSaveSession),
        persistence.saveSetting('temperature', state.temperature),
        persistence.saveSetting('maxOutputTokens', state.maxOutputTokens),
        persistence.saveSetting('customInstructions', state.customInstructions),
        persistence.saveSetting('editorTheme', state.editorTheme),
        persistence.saveSetting('gitAutoCommit', state.gitAutoCommit),
        persistence.saveSetting('gitAutoPush', state.gitAutoPush),
        persistence.saveSetting('gitPushConfirm', state.gitPushConfirm),
        persistence.saveSetting('gitAutoBranch', state.gitAutoBranch),
        persistence.saveSetting('gitRemoteUrl', state.gitRemoteUrl),
        persistence.saveSetting('gitCommitTemplate', state.gitCommitTemplate),
        persistence.saveSetting('gitBranchPrefix', state.gitBranchPrefix),
      ])
    } catch (e) {
      console.error('Failed to persist:', e)
    }
  },

  restoreFromStorage: async () => {
    try {
      const { persistence } = await import('@/lib/persist')
      const sessionId = 'current-session'

      // Load MCP config from helix.json
      let fileMcpConfig: Record<string, any> = {}
      try {
        const configRes = await fetch('/api/config/mcp')
        const configData = await configRes.json()
        fileMcpConfig = configData.mcpServers || {}
      } catch {}

      // Try loading the latest saved session first (full state)
      const sessions = await persistence.loadSessions()
      const archivedSessions = sessions.filter(s => s.isArchived)
      const latestSession = sessions.filter(s => !s.isArchived).length > 0
        ? sessions.filter(s => !s.isArchived).sort((a, b) => b.savedAt - a.savedAt)[0]
        : null

      // Load individual pieces for settings and non-session state
      const [memories, tasks, checkpoints, notes, chatMessages, goal, apiConfig, apiHistory, fontFamily, fontSize, interfaceFont, transcriptFontSize, scheduledTasks, mcpServers, customShortcuts, agentMaxIterations, autoCompactContext, smartTruncation, autoSaveSession, temperature, maxOutputTokens, customInstructions, availableModels, editorTheme, gitAutoCommit, gitAutoPush, gitPushConfirm, gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix] = await Promise.all([
        persistence.loadMemories(),
        persistence.loadTasks(),
        persistence.loadCheckpoints(),
        persistence.loadNotes(),
        persistence.loadChatMessagesBySession(sessionId),
        persistence.loadSetting<string | null>('goal'),
        persistence.loadSetting<ApiConfig>('apiConfig'),
        persistence.loadSetting<ApiConfig[]>('apiHistory'),
        persistence.loadSetting<string>('fontFamily'),
        persistence.loadSetting<number>('fontSize'),
        persistence.loadSetting<string>('interfaceFont'),
        persistence.loadSetting<number>('transcriptFontSize'),
        persistence.loadSetting<any[]>('scheduledTasks'),
        persistence.loadSetting<Record<string, McpServerConfig>>('mcpServers'),
        persistence.loadSetting<Record<string, { keys: string[], action: string, description: string }>>('customShortcuts'),
        persistence.loadSetting<number>('agentMaxIterations'),
        persistence.loadSetting<boolean>('autoCompactContext'),
        persistence.loadSetting<boolean>('smartTruncation'),
        persistence.loadSetting<boolean>('autoSaveSession'),
        persistence.loadSetting<number>('temperature'),
        persistence.loadSetting<number>('maxOutputTokens'),
        persistence.loadSetting<string>('customInstructions'),
        persistence.loadSetting<string[]>('availableModels'),
        persistence.loadSetting<string>('editorTheme'),
        persistence.loadSetting<boolean>('gitAutoCommit'),
        persistence.loadSetting<boolean>('gitAutoPush'),
        persistence.loadSetting<boolean>('gitPushConfirm'),
        persistence.loadSetting<boolean>('gitAutoBranch'),
        persistence.loadSetting<string>('gitRemoteUrl'),
        persistence.loadSetting<string>('gitCommitTemplate'),
        persistence.loadSetting<string>('gitBranchPrefix'),
      ])

      // Use latest session data if available, otherwise fall back to chatMessages table
      const sessionMessages = latestSession?.chatMessages || []
      const messages = sessionMessages.length > 0
        ? sessionMessages
        : chatMessages

      const defaults = { provider: 'openai' as const, apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
      set({
        memories: latestSession?.memories
          ? (latestSession.memories as MemoryEntry[])
          : (memories as MemoryEntry[]),
        tasks: latestSession?.tasks
          ? (latestSession.tasks as TaskNode[])
          : (tasks as TaskNode[]),
        checkpoints: latestSession?.checkpoints
          ? (latestSession.checkpoints as SessionCheckpoint[])
          : (checkpoints as SessionCheckpoint[]),
        notes: latestSession?.notes || notes || '',
        goal: latestSession?.goal ?? goal,
        currentSessionId: latestSession?.id || null,
        selectedWorkDir: latestSession?.workDir || get().selectedWorkDir,
        apiConfig: apiConfig ? { ...defaults, ...apiConfig } : get().apiConfig,
        apiHistory: apiHistory || [],
        chatMessages: messages.length > 0
          ? messages.map(m => ({
              id: m.id,
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content,
              images: m.images,
              timestamp: m.timestamp,
              isStreaming: false,
            }))
          : get().chatMessages,
        files: latestSession?.files
          ? (latestSession.files as FileNode[])
          : get().files,
        openTabs: latestSession?.openTabs
          ? (latestSession.openTabs as any)
          : get().openTabs,
        fontFamily: fontFamily || (typeof localStorage !== 'undefined' ? localStorage.getItem('helix-font-family') : null) || get().fontFamily,
        fontSize: fontSize || (typeof localStorage !== 'undefined' ? Number(localStorage.getItem('helix-font-size')) || get().fontSize : get().fontSize),
        interfaceFont: interfaceFont || (typeof localStorage !== 'undefined' ? localStorage.getItem('helix-interface-font') : null) || get().interfaceFont,
        transcriptFontSize: transcriptFontSize || (typeof localStorage !== 'undefined' ? Number(localStorage.getItem('helix-transcript-size')) || get().transcriptFontSize : get().transcriptFontSize),
        scheduledTasks: scheduledTasks as ScheduledTask[],
        mcpServers: {
          ...fileMcpConfig,
          ...(mcpServers || {}),
        },
        customShortcuts: customShortcuts && Object.keys(customShortcuts).length > 0 ? customShortcuts : { ...DEFAULT_SHORTCUTS },
        agentMaxIterations: agentMaxIterations ?? get().agentMaxIterations,
        autoCompactContext: autoCompactContext ?? get().autoCompactContext,
        smartTruncation: smartTruncation ?? get().smartTruncation,
        autoSaveSession: autoSaveSession ?? get().autoSaveSession,
        temperature: temperature ?? get().temperature,
        maxOutputTokens: maxOutputTokens ?? get().maxOutputTokens,
        customInstructions: customInstructions ?? get().customInstructions,
        availableModels: availableModels || [],
        editorTheme: (editorTheme as 'vs-dark' | 'light') ?? get().editorTheme,
        gitAutoCommit: gitAutoCommit ?? get().gitAutoCommit,
        gitAutoPush: gitAutoPush ?? get().gitAutoPush,
        gitPushConfirm: gitPushConfirm ?? get().gitPushConfirm,
        gitAutoBranch: gitAutoBranch ?? get().gitAutoBranch,
        gitRemoteUrl: gitRemoteUrl || get().gitRemoteUrl,
        gitCommitTemplate: gitCommitTemplate || get().gitCommitTemplate,
        gitBranchPrefix: gitBranchPrefix || get().gitBranchPrefix,
      })

      // Auto-detect AGENTS.md / CLAUDE.md from project root as fallback
      if (!customInstructions) {
        try {
          const res = await fetch('/api/instructions')
          const data = await res.json()
          if (data.content) {
            get().setCustomInstructions(data.content)
          }
        } catch {
          // Silently ignore — no instructions file found or API unavailable
        }
      }

      // Set default workDir from server if none restored
      if (!get().selectedWorkDir) {
        try {
          const res = await fetch('/api/init')
          const data = await res.json()
          if (data.workDir) {
            get().setSelectedWorkDir(data.workDir)
          }
        } catch {
          // Silently ignore
        }
      }
    } catch (e) {
      console.error('Failed to restore:', e)
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
      console.error('Failed to save checkpoint:', e)
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
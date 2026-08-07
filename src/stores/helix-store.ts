import { create } from 'zustand'
import type { StateCreator } from 'zustand'
import { cleanUrl } from '@/lib/url-utils'
import { applyHelixPalette } from '@/lib/themes'
import { isModelProviderMismatch } from '@/lib/provider-match'
import { isElectron, getElectronAPI, electronFS, electronApp } from '@/lib/electron-bridge'
import { generateId, truncateString } from '@/lib/format'
import { debug, warn, error as logError } from '@/lib/logger'
import { defaultFiles } from '@/lib/seed-data'
import type { McpServerConfig } from '@/stores/hermes-store'
import { useHermesStore } from '@/stores/hermes-store'
export type { McpServerConfig } from '@/stores/hermes-store'
import type {
  FileNode, ImageAttachment, FileAttachment, ExecutionStep,
  StreamingResponseBlock, StreamingDraft, ConnectionNotice,
  ChatMessage, EditorTab, CursorPosition, ToastMessage, PendingChange,
  ApiProvider, AgentEngine, ApiConfig, ApiProfile, Skill,
  MemoryCategory, MemoryEntry, TaskNode,
  SessionCheckpoint, ScheduledTask,
  ToolCallEntry, SubAgent, ProviderConfig,
} from './helix-types'
import { DEFAULT_SHORTCUTS } from './helix-types'

/** A bookmark node (mirrors the subset of Chrome's Bookmarks JSON we care about). */
export interface BrowserBookmark {
  name: string
  type: 'url' | 'folder'
  url?: string
  children?: BrowserBookmark[]
}

/** A server / virtual machine the user can connect to from the breadcrumb. */
export interface ExternalService {
  id: string
  name: string
  host: string
  port: number
  username?: string
  /** 'password' | 'key' — how the secret authenticates. */
  authType?: 'password' | 'key'
  /** Secret (password or private key). Stored encrypted when safeStorage is available. */
  secret?: string
  secretEncrypted?: boolean
  connected: boolean
  createdAt: number
}

/** Per-model usage within a single day. */
export interface DailyModelUsage {
  totalTokens: number
  totalCost: number
  requestCount: number
}

/** Per-day token/cost usage, keyed by local date string `YYYY-MM-DD`. */
export interface DailyUsageEntry {
  totalTokens: number
  totalCost: number
  requestCount: number
  models: Record<string, DailyModelUsage>
}

export function dayKeyOf(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
import { createAgentSettingsSlice, type AgentSettingsSlice } from './slices/agent-settings-slice'
import { createApiConfigSlice, type ApiConfigSlice } from './slices/api-config-slice'
import { createEditorSlice, type EditorSlice } from './slices/editor-slice'
import { createGitSlice, type GitSlice } from './slices/git-slice'
import { createPanelSlice, type PanelSlice } from './slices/panel-slice'
import { createSkillSlice, type SkillSlice } from './slices/skill-slice'
import { createTerminalSlice, type TerminalSlice } from './slices/terminal-slice'
import { createToastSlice, type ToastSlice } from './slices/toast-slice'

export type {
  FileNode, ImageAttachment, FileAttachment, ExecutionStep,
  StreamingResponseBlock, PendingChange,
  ApiConfig, ApiProfile,
  TaskNode,
  ScheduledTask,
  ProviderConfig,
}
export { DEFAULT_SHORTCUTS }

interface HelixState extends GitSlice, ToastSlice, TerminalSlice, EditorSlice, AgentSettingsSlice, PanelSlice, ApiConfigSlice, SkillSlice {
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
  showActivityFeed: boolean
  toggleActivityFeed: () => void
  showArtifactsBrowser: boolean
  toggleArtifactsBrowser: () => void

  // Preview Rail
  showPreviewRail: boolean
  previewRailUrl: string | null
  setPreviewRailUrl: (url: string | null) => void
  togglePreviewRail: () => void

  // Browser bookmarks (imported from Chrome etc.)
  browserBookmarks: BrowserBookmark[]
  setBrowserBookmarks: (items: BrowserBookmark[]) => void

  // Browser settings
  browserHomeUrl: string
  setBrowserHomeUrl: (url: string) => void

  // Unified right sidebar (hosts the browser + code editor as switchable tabs)
  rightSidebarTab: 'browser' | 'code' | 'files' | 'email' | 'diff' | null
  setRightSidebarTab: (tab: 'browser' | 'code' | 'files' | 'email' | 'diff' | null) => void
  showLearningView: boolean
  toggleLearningView: () => void
  voiceAutoSpeak: boolean
  setVoiceAutoSpeak: (v: boolean) => void

  // Email integration state (secrets live in the Electron main process; only
  // non-sensitive flags/identifiers are mirrored here for UI rendering).
  emailConfigured: boolean
  emailAccount: string
  emailNotifyEnabled: boolean
  setEmailConfigured: (configured: boolean, account?: string) => void
  setEmailNotifyEnabled: (v: boolean) => void

  // MCP Servers
  mcpServers: Record<string, McpServerConfig>

  // External services (servers / virtual machines) connected from the breadcrumb.
  externalServices: ExternalService[]

  // SSH live-session state: whether a real ssh2 session is currently established,
  // and which external service it belongs to.
  sshConnected: boolean
  sshServiceId: string | null
  setSshConnected: (connected: boolean, serviceId?: string | null) => void

  // Custom Shortcuts
  customShortcuts: Record<string, { keys: string[], action: string, description: string }>
  customizedShortcutIds: Set<string>

  // Customize
  // showCustomizePanel — see slices/panel-slice.ts

  // Agent Execution
  isAgentRunning: boolean
  hasOnboarded: boolean
  setHasOnboarded: (v: boolean) => void
  gatewayStatus: 'connecting' | 'ready' | 'disconnected'
  setGatewayStatus: (v: 'connecting' | 'ready' | 'disconnected') => void
  setIsAgentRunning: (v: boolean) => void
  streamingDrafts: Record<string, StreamingDraft>
  injectInputSignal: { text: string; nonce: number } | null
  injectInput: (text: string) => void
  requestSendSignal: number
  requestSend: () => void
  injectAndSend: (text: string) => void
  tabInputs: Record<string, string>
  tabAttachments: Record<string, { images: ImageAttachment[]; files: FileAttachment[] }>
  pendingUpdate: string | null
  setPendingUpdate: (version: string | null) => void
  setTabInput: (sessionId: string, text: string) => void
  clearTabInput: (sessionId: string) => void
  setTabAttachments: (sessionId: string, images: ImageAttachment[], files: FileAttachment[]) => void
  clearTabAttachments: (sessionId: string) => void
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
  contextUsage: Record<string, { size: number; used: number }>
  setContextUsage: (sessionId: string, size: number, used: number) => void
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
  dailyUsage: Record<string, DailyUsageEntry>
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
  /** Persist a specific session's messages (works for background sessions). */
  persistSessionNow: (sessionId: string) => Promise<void>

  // UI
  editorTheme: 'vs-dark' | 'light'
  fontFamily: string
  fontSize: number
  interfaceFont: string
  transcriptFontSize: number
  // Theme style: 'default' (built-in cream) or a Catppuccin flavor id.
  themeStyle: string
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
  deleteMessage: (messageId: string) => void
  clearChat: () => void
  clearChatInPlace: () => Promise<void>
  clearChatAndPersist: () => Promise<void>
  setChatLoading: (loading: boolean) => void
  forkConversation: (messageId: string) => Promise<string | null>

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
  setThemeStyle: (styleId: string) => void
  // Toast actions — see slices/toast-slice.ts

  // Actions - File modifications
  applyFileChange: (fileId: string, newContent: string) => void
  createOrUpdateFile: (filePath: string, content: string) => void
  addPendingChange: (change: Omit<PendingChange, 'id' | 'workDir'> & { workDir?: string }) => string
  applyPendingChange: (changeId: string) => void
  rejectPendingChange: (changeId: string) => void
  applyAllPendingChanges: () => void
  rejectAllPendingChanges: () => void

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
  restoreCheckpoint: (id: string) => void
  removeCheckpoint: (id: string) => void

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

  // Actions - External Services (server / VM)
  addExternalService: (svc: Omit<ExternalService, 'id' | 'createdAt' | 'connected'>) => Promise<void>
  updateExternalService: (id: string, patch: Partial<ExternalService>) => Promise<void>
  removeExternalService: (id: string) => void
  setExternalServiceConnected: (id: string, connected: boolean) => void

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
    // Capture the CURRENT store state synchronously at entry — O(1), just grabs
    // the object reference. Zustand's set() swaps in a new state object rather
    // than mutating in place, so this snapshot keeps referencing the pre-clear
    // conversation even if the caller (e.g. handleNewTask) clearChat()s right
    // after firing this flush. The expensive per-message mapping / file-tree
    // walk below runs AFTER the await, so this never blocks the click handler.
    const snapshot = useHelixStore.getState()
    const sessionId = snapshot.currentSessionId
    const firstUser = snapshot.chatMessages.find(m => m.role === 'user')
    // Don't persist empty sessions (no user/assistant messages).
    // This prevents auto-creating ghost sessions with timestamp labels when the
    // system clock resumes after sleep/freeze — the debounce timer fires, finds
    // stale messages (e.g. system-role from scheduled tasks), and would otherwise
    // generate a new session ID and write it to disk + setCurrentSessionId.
    const hasRealContent = snapshot.chatMessages.some(m => m.role === 'user' || m.role === 'assistant')
    if (!firstUser && !hasRealContent) return
    // Never auto-create a session when there's no active session context.
    // persistCurrentSessionNow's job is to save the CURRENT session, not invent new ones.
    if (!sessionId) return
    const label = firstUser ? firstUser.content.slice(0, 50) : new Date().toLocaleString('zh-CN')

    // If a stream is mid-flight for this session, also persist its buffered
    // partial text so quitting / reloading mid-generation doesn't silently
    // drop the in-progress assistant reply. This is injected AT PERSIST TIME
    // only — the live chatMessages array is NOT mutated, so the running stream
    // and its eventual `done` handler are unaffected. Once the run completes,
    // clearStreamingDraft() drops the draft and the partial stops being
    // injected (the real message, added by done, takes its place).
    // The expensive per-message work below reads from the synchronous `snapshot`
    // captured at entry. Even though the store may have been cleared/switched
    // during the await, the snapshot still references the session that was
    // current when this flush fired — so a fire-and-forget flush from
    // handleNewTask saves the abandoned session correctly.
    const { persistence } = await import('@/lib/persist')

    // Concurrency guard: only persist messages that belong to THIS session
    // (or legacy untagged ones). The in-memory array may also hold messages of
    // OTHER sessions still running in the background — stamping those with the
    // current sessionId would corrupt both conversations.
    const msgsToSave = snapshot.chatMessages
      .filter(m => !m.sessionId || m.sessionId === sessionId)
      .map(m => ({
        id: m.id, sessionId, role: m.role,
        content: m.content, images: m.images, timestamp: m.timestamp, isStreaming: m.isStreaming ?? false,
        reasoning: m.reasoning,
        steps: m.steps,
      }))
    const draft = snapshot.streamingDrafts[sessionId]
    const draftPartialId = 'draft-partial-' + sessionId
    // 会话若曾被持久化并重新加载，chatMessages 里可能已有一条 draft-partial。
    // 再追加同 id 的消息会把相同 id 写进文件 → 重新加载后渲染重复 key。先去掉旧值。
    const existingPartial = msgsToSave.findIndex(m => m.id === draftPartialId)
    if (existingPartial !== -1) msgsToSave.splice(existingPartial, 1)
    if (draft?.isAgentRunning && draft.textBuffer && draft.textBuffer.trim()) {
      msgsToSave.push({
        id: draftPartialId,
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
      workDir: snapshot.activeSessionWorkDir ?? snapshot.selectedWorkDir,
      goal: snapshot.goal,
      memories: snapshot.memories,
      tasks: snapshot.tasks,
      notes: snapshot.notes,
      checkpoints: snapshot.checkpoints,
      chatMessages: msgsToSave,
      files: collectFiles(snapshot.files),
      openTabs: snapshot.openTabs.map(tab => ({
        id: tab.id, fileId: tab.fileId, name: tab.name, language: tab.language, isDirty: tab.isDirty,
      })),
    })
    // Pin the session id so subsequent saves land on the same session, and
    // refresh the sidebar list so the conversation shows up immediately. Only
    // pin back when the conversation wasn't explicitly cleared/switched during
    // the save — otherwise a fire-and-forget flush from "new conversation"
    // would resurrect the just-abandoned session in the UI.
    const live = useHelixStore.getState()
    if (!live.currentSessionId && live.chatMessages.length > 0) {
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

// Persist a SPECIFIC session's messages, even when it is not the currently
// viewed one. Needed for concurrent multi-session runs: a background run that
// finishes must save its committed reply into ITS OWN session record —
// persistCurrentSessionNow only covers the foreground session.
async function persistSessionById(sessionId: string): Promise<void> {
  try {
    const state = useHelixStore.getState()
    if (!sessionId) return
    if (state.currentSessionId === sessionId) return persistCurrentSessionNow()
    const msgs = state.chatMessages.filter(m => m.sessionId === sessionId)
    if (msgs.length === 0) return
    const { persistence } = await import('@/lib/persist')
    const all = await persistence.loadSessions()
    const existing = all.find(s => s.id === sessionId)
    // Merge by message id: keep everything already on disk, overlay in-memory.
    const byId = new Map<string, any>()
    for (const m of existing?.chatMessages || []) byId.set(m.id, m)
    for (const m of msgs) {
      byId.set(m.id, {
        id: m.id, sessionId, role: m.role,
        content: m.content, images: m.images, timestamp: m.timestamp, isStreaming: false,
        reasoning: m.reasoning,
        steps: m.steps,
      })
    }
    const merged = [...byId.values()].sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
    const firstUser = merged.find(m => m.role === 'user')
    await persistence.saveSession({
      id: sessionId,
      label: existing?.label || (firstUser ? String(firstUser.content).slice(0, 50) : new Date().toLocaleString('zh-CN')),
      workDir: existing?.workDir ?? state.activeSessionWorkDir ?? state.selectedWorkDir,
      goal: existing?.goal ?? null,
      memories: existing?.memories || [],
      tasks: existing?.tasks || [],
      notes: existing?.notes || '',
      checkpoints: existing?.checkpoints || [],
      chatMessages: merged,
      files: existing?.files || [],
      openTabs: existing?.openTabs || [],
    })
    useHelixStore.setState((st) => ({ sessionSaveVersion: st.sessionSaveVersion + 1 }))
  } catch (e) {
    logError('Failed to persist background session:', e)
  }
}

export const useHelixStore = create<HelixState>()((set, get, store) => ({
  ...createGitSlice(set, get, store),
  ...createToastSlice(set, get, store),
  ...createTerminalSlice(set, get, store),
  ...createEditorSlice(set, get, store),
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
  themeStyle: typeof window !== 'undefined'
    ? (window.localStorage.getItem('helix-theme-style') || 'default')
    : 'default',
  // Toast — in slices/toast-slice.ts
  pendingChanges: [],
  // Agent Settings — in slices/agent-settings-slice.ts

  // Agent Execution
  isAgentRunning: false,
  setIsAgentRunning: (v) => set({ isAgentRunning: v }),
  injectInputSignal: null,
  requestSendSignal: 0,
  injectInput: (text) => set({ injectInputSignal: { text, nonce: Date.now() } }),
  requestSend: () => set((s) => ({ requestSendSignal: s.requestSendSignal + 1 })),
  injectAndSend: (text: string) => set((s) => ({ injectInputSignal: { text, nonce: Date.now() }, requestSendSignal: s.requestSendSignal + 1 })),
  hasOnboarded: false,
  setHasOnboarded: (v) => {
    set({ hasOnboarded: v })
    // Persist so the onboarding screen doesn't reappear on every restart.
    // Without this, setHasOnboarded only mutates in-memory state, which resets
    // to the default `false` on the next app launch — "每次重启都弹引导".
    import('@/lib/persist').then(({ persistence }) => {
      persistence.saveSetting('hasOnboarded', v).catch(() => {})
    }).catch(() => {})
  },
  gatewayStatus: 'connecting',
  setGatewayStatus: (v) => set({ gatewayStatus: v }),
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
  tabAttachments: {} as Record<string, { images: ImageAttachment[]; files: FileAttachment[] }>,
  setTabAttachments: (sessionId, images, files) => set((state) => ({
    tabAttachments: { ...state.tabAttachments, [sessionId]: { images, files } },
  })),
  clearTabAttachments: (sessionId) => set((state) => {
    const { [sessionId]: _, ...rest } = state.tabAttachments
    return { tabAttachments: rest }
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
  contextUsage: {},
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
  dailyUsage: {},
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
  showActivityFeed: false,

  showRuntimePanel: false,
  showArtifactsBrowser: false,
  showPreviewRail: false,
  previewRailUrl: null as string | null,
  browserHomeUrl: '',
  browserBookmarks: [],
  rightSidebarTab: null,
  showLearningView: false,
  voiceAutoSpeak: false,

  emailConfigured: false,
  emailAccount: '',
  emailNotifyEnabled: false,

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

  // External services (servers / VMs)
  externalServices: [],

  // SSH live-session state (real ssh2 session, distinct from gateway mode)
  sshConnected: false,
  sshServiceId: null,

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
  toggleActivityFeed: () => set((s) => ({ showActivityFeed: !s.showActivityFeed })),
  toggleArtifactsBrowser: () => set((s) => ({ showArtifactsBrowser: !s.showArtifactsBrowser })),
  togglePreviewRail: () => set((s) => {
    const next = s.rightSidebarTab === 'browser' ? null : 'browser'
    return next === 'browser'
      ? { rightSidebarTab: 'browser', showPreviewRail: true, editorOpen: false }
      : { rightSidebarTab: null, showPreviewRail: false, editorOpen: false }
  }),
  setPreviewRailUrl: (url: string | null) => set((s) => ({
    previewRailUrl: url === null ? null : cleanUrl(url),
    ...(url !== null ? { showPreviewRail: true, rightSidebarTab: 'browser', editorOpen: false } : {}),
  })),
  setBrowserHomeUrl: (url: string) => {
    const trimmed = url.trim()
    set(() => ({ browserHomeUrl: trimmed }))
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('browserHomeUrl', trimmed)).catch(() => {})
  },
  setBrowserBookmarks: (items: BrowserBookmark[]) => {
    set(() => ({ browserBookmarks: items }))
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('browserBookmarks', items)).catch(() => {})
  },
  setRightSidebarTab: (tab) => set(() => {
    if (tab === 'browser') return { rightSidebarTab: 'browser', showPreviewRail: true, editorOpen: false }
    if (tab === 'code') return { rightSidebarTab: 'code', showPreviewRail: false, editorOpen: true }
    if (tab === 'files') return { rightSidebarTab: 'files', showPreviewRail: false, editorOpen: false }
    if (tab === 'email') return { rightSidebarTab: 'email', showPreviewRail: false, editorOpen: false }
    if (tab === 'diff') return { rightSidebarTab: 'diff', showPreviewRail: false, editorOpen: false }
    return { rightSidebarTab: null, showPreviewRail: false, editorOpen: false }
  }),
  toggleLearningView: () => set((s) => ({ showLearningView: !s.showLearningView })),
  setVoiceAutoSpeak: (v: boolean) => set((s) => ({ voiceAutoSpeak: v })),
  setEmailConfigured: (configured: boolean, account?: string) =>
    set((s) => ({ emailConfigured: configured, emailAccount: account !== undefined ? account : s.emailAccount })),
  setEmailNotifyEnabled: (v: boolean) => set((s) => ({ emailNotifyEnabled: v })),

  toggleRuntimePanel: () => set((s) => ({ showRuntimePanel: !s.showRuntimePanel })),

  // Actions - Chat
  addChatMessage: (message) => {
    const id = generateId()
    set((state) => {
      // Truncate any single message's text/content to 128 KB — larger payloads
      // (e.g. a tool_result carrying a full file) can blow the heap in long
      // conversations. Keep a head + tail window so the message is still useful.
      const msg: Record<string, any> = { ...message }
      const truncKeys = ['content', 'text', 'reasoning', 'html']
      for (const k of truncKeys) {
        const v = msg[k]
        if (typeof v === 'string') msg[k] = truncateString(v, 128_000)
      }
      const newState: Record<string, any> = {
        chatMessages: [...state.chatMessages, { ...msg, id, sessionId: msg.sessionId || state.currentSessionId || undefined, timestamp: Date.now() }],
      }
      // Keep the in-memory message list bounded (persistence handles the rest)
      // so the render heap doesn't grow unboundedly with long conversations.
      const MAX_CHAT_MESSAGES = 300
      if (newState.chatMessages.length > MAX_CHAT_MESSAGES) {
        newState.chatMessages = newState.chatMessages.slice(-MAX_CHAT_MESSAGES)
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

  deleteMessage: (messageId) =>
    set((state) => ({
      chatMessages: state.chatMessages.filter((m) => m.id !== messageId),
    })),

  clearChat: () => {
    if (sessionPersistTimer) clearTimeout(sessionPersistTimer)
    const prevId = get().currentSessionId
    set({
      chatMessages: [],
      currentSessionId: null,
      activeSessionWorkDir: null,
      selectedWorkDir: null,
      contextUsage: {},
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
  clearChatInPlace: async () => {
    // Like clearChat, but KEEPS currentSessionId so the UI stays on the same
    // conversation instead of jumping to a blank new session. Used by the
    // /clear /reset /compact slash commands. The backend session is still
    // reset so the model forgets history; the caller is responsible for
    // deleting the sessionMap entry so the next prompt opens a fresh session.
    if (sessionPersistTimer) clearTimeout(sessionPersistTimer)
    const sessionId = get().currentSessionId
    const snapshot = get()
    set({
      chatMessages: [],
      contextUsage: {},
    })
    import('@/stores/hermes-store').then(({ useHermesStore }) => {
      useHermesStore.getState().setHermesSessionId(null)
    })
    // Persist empty state to IndexedDB so cleared messages don't reappear
    // on next session load.
    if (sessionId) {
      try {
        const { persistence } = await import('@/lib/persist')
        await persistence.saveSession({
          id: sessionId,
          label: '新对话',
          chatMessages: [],
          goal: snapshot.goal,
          memories: snapshot.memories,
          tasks: snapshot.tasks,
          notes: snapshot.notes,
          checkpoints: snapshot.checkpoints,
          files: snapshot.files as any,
          openTabs: snapshot.openTabs as any,
          workDir: snapshot.activeSessionWorkDir,
        })
        useHelixStore.setState((st) => ({ sessionSaveVersion: st.sessionSaveVersion + 1 }))
      } catch (e) {
        logError('Failed to persist cleared session:', e)
      }
    }
  },
  clearChatAndPersist: async () => {
    get().clearChat()
  },

  setChatLoading: (loading) => set({ isChatLoading: loading }),

  forkConversation: async (messageId) => {
    const state = get()
    if (!state.currentSessionId) {
      state.showToast({ type: 'error', title: '无法分叉', description: '当前没有活跃的会话' })
      return null
    }

    // Find the fork point: copy all messages up to and including this one
    const msgs = state.chatMessages.filter(m => !m.sessionId || m.sessionId === state.currentSessionId)
    const forkIdx = msgs.findIndex(m => m.id === messageId)
    if (forkIdx < 0) {
      state.showToast({ type: 'error', title: '分叉失败', description: '找不到目标消息' })
      return null
    }

    // Copy messages up to fork point
    const forkedMsgs = msgs.slice(0, forkIdx + 1)

    // Generate new session ID
    const newSessionId = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)

    // Determine branch name: count existing forks from this parent
    const { persistence } = await import('@/lib/persist')
    const allSessions = await persistence.loadSessions()
    const siblingForks = allSessions.filter(s => s.parentSessionId === state.currentSessionId)
    const branchLabel = `分支 ${String.fromCharCode(65 + siblingForks.length)}` // A, B, C...

    // Persist the new session as a fork
    await persistence.saveSession({
      id: newSessionId,
      label: branchLabel,
      workDir: state.activeSessionWorkDir ?? state.selectedWorkDir,
      goal: state.goal,
      memories: state.memories,
      tasks: state.tasks,
      notes: state.notes,
      checkpoints: state.checkpoints,
      chatMessages: forkedMsgs.map(m => ({
        id: m.id,
        sessionId: newSessionId,
        role: m.role,
        content: m.content,
        images: m.images,
        timestamp: m.timestamp,
        isStreaming: false,
        reasoning: m.reasoning,
        steps: m.steps,
      })),
      files: collectFiles(state.files),
      openTabs: state.openTabs.map(tab => ({
        id: tab.id, fileId: tab.fileId, name: tab.name, language: tab.language, isDirty: tab.isDirty,
      })),
      parentSessionId: state.currentSessionId,
      forkedFromMessageId: messageId,
      branchName: branchLabel,
    })

    // Reset Hermes session for the new branch
    useHermesStore.getState().setHermesSessionId(null)

    // Switch to the new session
    state.setCurrentSessionId(newSessionId)
    // Increment session save version so sidebar refreshes
    useHelixStore.setState((st) => ({ sessionSaveVersion: st.sessionSaveVersion + 1 }))
    state.showToast({ type: 'success', title: `已创建 ${branchLabel}`, description: `从第 ${forkIdx + 1} 条消息处分叉` })

    return newSessionId
  },

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
    // Code-editor-only font: applied to CodeMirror via CSS var, NOT to body,
    // so it never leaks into the chat/settings UI (per the font-scope split).
    document.documentElement.style.setProperty('--helix-font-family', fontFamily)
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
    // UI font: applied to the app chrome (chat + settings) via the `--helix-interface-font`
    // CSS var on <body>. We deliberately do NOT write body.style.fontFamily directly so
    // the code-editor font (a separate var) stays isolated from the UI font.
    document.documentElement.style.setProperty('--helix-interface-font', font)
    localStorage.setItem('helix-interface-font', font)
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('interfaceFont', font))
  },
  setTranscriptFontSize: (size) => {
    set({ transcriptFontSize: size })
    document.documentElement.style.setProperty('--helix-transcript-size', `${size}px`)
    localStorage.setItem('helix-transcript-size', String(size))
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('transcriptFontSize', size))
  },
  setThemeStyle: (styleId) => {
    set({ themeStyle: styleId })
    if (typeof localStorage !== 'undefined') localStorage.setItem('helix-theme-style', styleId)
    // Apply immediately (not only via the layout effect) so selecting a flavor
    // re-skins the UI even if the React effect doesn't re-run for some reason.
    applyHelixPalette(styleId)
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('themeStyle', styleId)).catch(() => {})
  },

  // Toast — in slices/toast-slice.ts

  // Agent Settings — in slices/agent-settings-slice.ts

  // Actions - Agent Execution
  addExecutionStep: (step) => {
    // Never store full file content in memory — tool_params from a write_file
    // can be multi-MB and multiply with every call across a long conversation,
    // blowing the V8 heap to 3+ GB. Truncate each string param and keep only a
    // bounded number of execution steps (the execution panel renders a summary
    // view, not the full content, and full steps persist to disk separately).
    const s = { ...step }
    if (s.toolParams) {
      const p: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(s.toolParams)) {
        p[k] = typeof v === 'string' ? truncateString(v, 32_000) : v
      }
      s.toolParams = p
    }
    set((state) => ({
      agentExecutionSteps: [...state.agentExecutionSteps, { ...s, timestamp: Date.now() }].slice(-200),
    }))
  },
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
      const fallbackDir = typeof process !== 'undefined' && typeof (process as any).cwd === 'function' ? (process as any).cwd() : ''
      const info = isElectron() ? await electronApp.getInfo() : { workDir: fallbackDir }
      set({ selectedWorkDir: info.workDir || fallbackDir, workDirEpoch: get().workDirEpoch + 1 })
      return
    }
    const api = getElectronAPI()
    // 对话正在运行时，点另一个项目只是“浏览”，绝不能打断它：
    // 不卸载当前对话、不 bump workDirEpoch（那会把全局 hermesSessionId 置空），
    // 也不触发 agent-flow-panel 的 [selectedWorkDir] effect（那会从 sessionMapRef
    // 里删掉正在跑的会话 → 下次 session/prompt 拿到死会话 → "session not found" → 模型停止）。
    // 只切 selectedWorkDir + 文件树；新对话的第一条消息会用新 cwd 新建后端会话。
    const running = get().isAgentRunning || Object.keys(get().streamingDrafts || {}).length > 0
    if (running && api) {
      try {
        const res = await api.app.setWorkDir(relativePath)
        const absDir = res?.workDir || relativePath
        set({ selectedWorkDir: absDir })
        // 显式传目录扫描（与非运行分支一致），失败要看得见而不是静默吞掉。
        try {
          try { await (getElectronAPI() as any)?.fs?.allowRoot?.(absDir) } catch { /* best-effort */ }
          const tree = await electronFS.scanTree(absDir)
          set({ files: tree as FileNode[] })
        } catch (scanErr) {
          logError('[setWorkDir] scanTree failed:', scanErr)
        }
      } catch (err) {
        logError('[setWorkDir]', err)
        get().showToast({ title: '切换工作目录失败', type: 'error' })
      }
      return
    }
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
        try { await (getElectronAPI() as any)?.fs?.allowRoot?.(absDir) } catch { /* best-effort */ }
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
  setContextUsage: (sessionId, size, used) => {
    set((s) => ({ contextUsage: { ...s.contextUsage, [sessionId]: { size, used } } }))
    // Persist immediately so a cold restart restores the latest usage snapshot
    // instead of resetting to zero (the backend never reports a session's
    // accumulated token count on launch, and the in-memory field is only
    // refreshed by runtime events).
    import('@/lib/persist').then(({ persistence }) => {
      persistence.saveSetting('contextUsage', get().contextUsage).catch(() => {})
    })
  },
  addSessionUsageStats: (model, usage) =>
    set((state) => {
      const input = usage.inputTokens || 0
      const output = usage.outputTokens || 0
      const thought = usage.thoughtTokens || 0
      const cachedRead = usage.cachedReadTokens || 0
      const cachedWrite = usage.cachedWriteTokens || 0
      const total = usage.totalTokens || input + output + thought
      const rates: Record<string, { input: number; output: number }> = {
        'claude-sonnet-4': { input: 3.0, output: 15.0 },
        'claude-sonnet-4-20250514': { input: 3.0, output: 15.0 },
        'gpt-4o': { input: 2.5, output: 10.0 },
        'gpt-4o-mini': { input: 0.15, output: 0.6 },
        'deepseek-chat': { input: 0.14, output: 0.28 },
        'deepseek-reasoner': { input: 0.55, output: 2.19 },
        'custom:step-router-v1': { input: 0.5, output: 2.0 },
      }
      const rate = rates[model] || { input: 1.0, output: 5.0 }
      const cost = (input * rate.input + output * rate.output) / 1_000_000
      // Accumulate into the current local day (used by the daily-usage treemap).
      const dayKey = dayKeyOf(new Date())
      const prevDay = state.dailyUsage[dayKey] || { totalTokens: 0, totalCost: 0, requestCount: 0, models: {} }
      const prevModels = prevDay.models || {}
      const prevModel = prevModels[model] || { totalTokens: 0, totalCost: 0, requestCount: 0 }
      // Prune entries older than 90 days so the record stays bounded.
      const cutoff = Date.now() - 90 * 86400000
      const prunedDaily: Record<string, DailyUsageEntry> = {}
      for (const [k, v] of Object.entries(state.dailyUsage)) {
        const t = new Date(`${k}T00:00:00`).getTime()
        if (!Number.isNaN(t) && t >= cutoff) prunedDaily[k] = v
      }
      prunedDaily[dayKey] = {
        totalTokens: prevDay.totalTokens + total,
        totalCost: prevDay.totalCost + cost,
        requestCount: prevDay.requestCount + 1,
        models: {
          ...prevModels,
          [model]: {
            totalTokens: prevModel.totalTokens + total,
            totalCost: prevModel.totalCost + cost,
            requestCount: prevModel.requestCount + 1,
          },
        },
      }
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
        dailyUsage: prunedDaily,
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

      const seen = new Set<string>()
      const msgs = session.chatMessages
        .filter(msg => {
          // 防御性去重：session 保存时 "draft-partial" 可能被写两次
          // (streaming 中 flushSessionPersist 一次 + turn 结束再持久化一次)，
          // 导致恢复后 chatMessages 含同 id 消息 → React 渲染 duplicate key。
          if (seen.has(msg.id)) return false
          seen.add(msg.id)
          // 恢复时丢弃 draft-partial 消息（只在运行意外中断时才有用，
          // 恢复后它只是"中断的残本"，不再是当前运行的草稿）。
          if (typeof msg.id === 'string' && msg.id.startsWith('draft-partial-')) return false
          return true
        })
        .map(msg => ({
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

  persistSessionNow: (sessionId: string) => {
    return persistSessionById(sessionId)
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
        const folder = state.files.find(f => f.type === 'folder' && f.name === folderName)
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
        const folder = parent?.children?.find(f => f.type === 'folder' && f.name === folderName)
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
    set((state) => {
      // Each diff belongs to the project it was captured in. Without this scope,
      // the aggregated diff panel would mix changes across all projects.
      const workDir = change.workDir ?? state.selectedWorkDir ?? state.activeSessionWorkDir ?? ''
      const entry = { ...change, id, workDir }
      // Upsert by fileId (+ workDir so identical relative paths in different
      // projects don't collide) so repeated edits to the same file keep a
      // single entry showing the latest diff.
      const exists = state.pendingChanges.findIndex(c => c.fileId === change.fileId && (c.workDir ?? '') === workDir)
      const pendingChanges = exists >= 0
        ? state.pendingChanges.map((c, i) => (i === exists ? entry : c))
        : [...state.pendingChanges, entry]
      return { pendingChanges }
    })
    return id
  },

  applyPendingChange: (changeId) =>
    set((state) => {
      const change = state.pendingChanges.find(c => c.id === changeId)
      if (!change) return state
      if (change.unifiedDiff) {
        // Backend-sourced diff: the file is already written on disk. Applying
        // means acknowledging the change, not rewriting partial content.
        return { pendingChanges: state.pendingChanges.filter(c => c.id !== changeId) }
      }
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
        if (change.unifiedDiff) continue // backend already wrote it; ack only
        files = updateFileInTree(files, change.fileId, (n) => ({ ...n, content: change.newContent }))
        openTabs = openTabs.map((t) =>
          t.fileId === change.fileId ? { ...t, isDirty: false } : t
        )
      }
      return { files, openTabs, pendingChanges: [] }
    }),

  rejectAllPendingChanges: () => set({ pendingChanges: [] }),

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
          tasks: JSON.parse(JSON.stringify(state.tasks)) as TaskNode[],
        },
      ],
    })),
  restoreCheckpoint: (id) => {
    const state = get()
    const cp = state.checkpoints.find(c => c.id === id)
    if (!cp) return
    const hashText = (s: string) => {
      let h = 5381
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
      return (h >>> 0).toString(36)
    }
    const memories: MemoryEntry[] = cp.memorySnapshot
      .split('\n')
      .map((content) => content.trim())
      .filter(Boolean)
      .map((content) => ({
        id: 'cp_' + hashText(content),
        content,
        category: 'project' as MemoryCategory,
        createdAt: Date.now(),
        source: 'manual' as const,
      }))
    set({
      tasks: cp.tasks ? JSON.parse(JSON.stringify(cp.tasks)) as TaskNode[] : [],
      memories,
    })
  },
  removeCheckpoint: (id) => set((state) => ({ checkpoints: state.checkpoints.filter(c => c.id !== id) })),

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
    import('@/lib/persist').then(({ persistence }) => persistence.saveScheduledTasks(get().scheduledTasks))
    return id
  },
  updateScheduledTask: (taskId, updates) => {
    set((state) => ({
      scheduledTasks: state.scheduledTasks.map(t =>
        t.id === taskId ? { ...t, ...updates, updatedAt: Date.now() } : t
      ),
    }))
    import('@/lib/persist').then(({ persistence }) => persistence.saveScheduledTasks(get().scheduledTasks))
  },
  removeScheduledTask: (taskId) => {
    set((state) => ({
      scheduledTasks: state.scheduledTasks.filter(t => t.id !== taskId),
    }))
    import('@/lib/persist').then(({ persistence }) => persistence.saveScheduledTasks(get().scheduledTasks))
  },
  toggleScheduledTask: (taskId) => {
    set((state) => ({
      scheduledTasks: state.scheduledTasks.map(t =>
        t.id === taskId ? { ...t, enabled: !t.enabled, updatedAt: Date.now() } : t
      ),
    }))
    import('@/lib/persist').then(({ persistence }) => persistence.saveScheduledTasks(get().scheduledTasks))
  },
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

  // Actions - External Services (server / VM)
  addExternalService: async (svc) => {
    // Encrypt the secret at rest when safeStorage is available (Electron only).
    let secret = svc.secret
    let secretEncrypted = false
    if (secret && typeof window !== 'undefined' && window.electron?.secure) {
      try {
        const available = await window.electron.secure.available()
        if (available) {
          secret = (await window.electron.secure.encrypt(secret)) ?? undefined
          secretEncrypted = true
        }
      } catch { /* fall back to plaintext */ }
    }
    const entry: ExternalService = {
      ...svc,
      secret,
      secretEncrypted,
      id: `ext_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      connected: false,
      createdAt: Date.now(),
    }
    set((state) => ({ externalServices: [...state.externalServices, entry] }))
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('externalServices', get().externalServices))
  },
  updateExternalService: async (id, patch) => {
    let secret = patch.secret
    let secretEncrypted = patch.secretEncrypted
    if (secret !== undefined && typeof window !== 'undefined' && window.electron?.secure) {
      try {
        const available = await window.electron.secure.available()
        if (available) {
          secret = (await window.electron.secure.encrypt(secret)) ?? undefined
          secretEncrypted = true
        }
      } catch { /* fall back to plaintext */ }
    }
    set((state) => ({
      externalServices: state.externalServices.map((s) =>
        s.id === id
          ? { ...s, ...patch, ...(secret !== undefined ? { secret, secretEncrypted } : {}) }
          : s
      ),
    }))
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('externalServices', get().externalServices))
  },
  removeExternalService: (id) => {
    set((state) => ({ externalServices: state.externalServices.filter((s) => s.id !== id) }))
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('externalServices', get().externalServices))
  },
  setExternalServiceConnected: (id, connected) => {
    set((state) => ({
      externalServices: state.externalServices.map((s) =>
        s.id === id ? { ...s, connected } : s
      ),
    }))
    import('@/lib/persist').then(({ persistence }) => persistence.saveSetting('externalServices', get().externalServices))
  },
  setSshConnected: (connected, serviceId = null) => {
    set({ sshConnected: connected, sshServiceId: serviceId })
  },

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
        persistence.saveSetting('themeStyle', state.themeStyle),
        persistence.saveSetting('sessionUsageStats', state.sessionUsageStats),
        persistence.saveSetting('contextUsage', state.contextUsage),
        persistence.saveSetting('dailyUsage', state.dailyUsage),
        persistence.saveScheduledTasks(state.scheduledTasks),
        persistence.saveSetting('mcpServers', state.mcpServers),
        persistence.saveSetting('externalServices', state.externalServices),
        persistence.saveSetting('customizedShortcutIds', Array.from(state.customizedShortcutIds)),
        persistence.saveSetting('agentMaxIterations', state.agentMaxIterations),
        persistence.saveSetting('autoCompactContext', state.autoCompactContext),
        persistence.saveSetting('autoSaveSession', state.autoSaveSession),
        persistence.saveSetting('reasoningEffort', state.reasoningEffort),
        persistence.saveSetting('personality', state.personality),
        persistence.saveSetting('fastMode', state.fastMode),
        persistence.saveSetting('desktopNotifications', state.desktopNotifications),
        persistence.saveSetting('soundEnabled', state.soundEnabled),
        persistence.saveSetting('voiceAutoSpeak', state.voiceAutoSpeak),
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
      const fileMcpConfig: Record<string, any> = {}

      // Try loading the latest saved session first (full state)
      const sessions = await persistence.loadSessions()
      const archivedSessions = sessions.filter(s => s.isArchived)
      const latestSession = sessions.filter(s => !s.isArchived).length > 0
        ? sessions.filter(s => !s.isArchived).sort((a, b) => b.savedAt - a.savedAt)[0]
        : null

      // Load individual pieces for settings and non-session state
      const [memories, tasks, checkpoints, notes, chatMessages, goal, apiConfig, apiHistory, apiProfiles, fontFamily, fontSize, interfaceFont, transcriptFontSize, themeStyle, sessionUsageStats, dailyUsage, scheduledTasks, mcpServers, customShortcuts, customizedIdsArr, agentMaxIterations, autoCompactContext, autoSaveSession, availableModels, providerModels, reasoningEffort, personality, fastMode, desktopNotifications, soundEnabled, editorTheme, gitAutoCommit, gitAutoPush, gitPushConfirm, gitAutoBranch, gitRemoteUrl, gitCommitTemplate, gitBranchPrefix, voiceAutoSpeak, providers, activeModel, activeProviderId, savedSessionHistory, savedSessionHistoryIndex, savedSelectedWorkDir, loadedHasOnboarded, contextUsage, externalServices] = await Promise.all([
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
        persistence.loadSetting<string>('themeStyle'),
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
        persistence.loadSetting<Record<string, DailyUsageEntry>>('dailyUsage'),
        persistence.loadSetting<any[]>('scheduledTasks'),
        persistence.loadSetting<Record<string, McpServerConfig>>('mcpServers'),
        persistence.loadSetting<Record<string, { keys: string[], action: string, description: string }>>('customShortcuts'),
        persistence.loadSetting<string[]>('customizedShortcutIds'),
        persistence.loadSetting<number>('agentMaxIterations'),
        persistence.loadSetting<boolean>('autoCompactContext'),
        persistence.loadSetting<boolean>('autoSaveSession'),
        persistence.loadSetting<string[]>('availableModels'),
        persistence.loadSetting<Record<string, string[]>>('providerModels'),
        persistence.loadSetting<string>('reasoningEffort'),
        persistence.loadSetting<string>('personality'),
        persistence.loadSetting<boolean>('fastMode'),
        persistence.loadSetting<boolean>('desktopNotifications'),
        persistence.loadSetting<boolean>('soundEnabled'),
        persistence.loadSetting<string>('editorTheme'),
        persistence.loadSetting<boolean>('gitAutoCommit'),
        persistence.loadSetting<boolean>('gitAutoPush'),
        persistence.loadSetting<boolean>('gitPushConfirm'),
        persistence.loadSetting<boolean>('gitAutoBranch'),
        persistence.loadSetting<string>('gitRemoteUrl'),
        persistence.loadSetting<string>('gitCommitTemplate'),
        persistence.loadSetting<string>('gitBranchPrefix'),
        persistence.loadSetting<boolean>('voiceAutoSpeak'),
        persistence.loadSetting<ProviderConfig[]>('providers'),
        persistence.loadSetting<string | null>('activeModel'),
        persistence.loadSetting<string | null>('activeProviderId'),
        persistence.loadSetting<string[]>('sessionHistory'),
        persistence.loadSetting<number>('sessionHistoryIndex'),
        persistence.loadSetting<string | null>('selectedWorkDir'),
        persistence.loadSetting<boolean>('hasOnboarded'),
        persistence.loadSetting<{ size: number; used: number } | null>('contextUsage'),
        persistence.loadSetting<ExternalService[]>('externalServices'),
      ])

      // Do NOT restore the latest session's chatMessages on startup.
      // Always start with an empty welcome screen so the user doesn't see
      // stale/failed messages (e.g. 401 errors) from a previous run.
      // Historical sessions remain available in the sidebar and can be
      // opened manually.
      const defaults = { provider: 'custom' as const, apiKey: '', baseUrl: 'https://api.ant-ling.com/v1', model: 'Ling-2.6-1T' }
      // Restore which named profile was active before the restart, so the selection
      // survives a cold start (the profile list itself is persisted to IndexedDB).
      const loadedActiveProfileId = await persistence.loadSetting<string | null>('activeProfileId')
      const savedBookmarks = await persistence.loadSetting<BrowserBookmark[]>('browserBookmarks')

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
      // Heuristic guard against cross-endpoint pollution in persisted history:
      // a model name that obviously cannot belong to the configured endpoint
      // (e.g. "Ling-*" on a deepseek base URL, or "deepseek-*" on an ant-ling
      // base URL) is treated as poisoned and dropped from the provider's model
      // pool, so it can never be silently selected as the active model.
      // Helpers for scrubbing cross-endpoint model pollution. The narrow
      // Ling↔DeepSeek check used to let model/endpoint mismatches from other
      // suppliers (e.g. `k3`/Kimi saved under a DeepSeek base URL) slip through.
      // We now delegate to the shared classifier, which recognizes all major
      // families and only flags when BOTH sides are clearly owned by DIFFERENT
      // suppliers (custom endpoints / custom model names are never flagged).
      const isModelEndpointMismatch = (model: string, baseUrl?: string): boolean =>
        isModelProviderMismatch(model, baseUrl)
      const deriveProviderName = (baseUrl?: string, fallback?: string): string => {
        if (!baseUrl) return fallback || '配置'
        try {
          const host = new URL(baseUrl).hostname.toLowerCase()
          if (/ant-ling|agnes|ant-/.test(host)) return 'Ling'
          if (host.includes('deepseek')) return 'DeepSeek'
          if (host.includes('openai')) return 'OpenAI'
          if (host.includes('anthropic')) return 'Anthropic'
          if (host.includes('google')) return 'Gemini'
          return host.replace(/^www\./, '') || fallback || '配置'
        } catch {
          return fallback || '配置'
        }
      }
      // Build id -> baseUrl authority from declared apiProfiles so we can scrub
      // each provider's *fetched* model list (providerModels[pid]) of models that
      // don't belong to that endpoint. This is what removes the kimi models a past
      // bug wrote into the deepseek profile's fetched list — `cleanProfileModels`
      // alone couldn't fix it because `mergedProviders` later re-merged the
      // un-filtered providerModels back in.
      const profileBaseByPid: Record<string, string> = {}
      for (const p of (apiProfiles || [])) {
        if (p.id && p.config?.baseUrl) profileBaseByPid[p.id] = p.config.baseUrl
      }
      const cleanedProviderModels: Record<string, string[]> = {}
      for (const [pid, models] of Object.entries(providerModels || {})) {
        const baseUrl = profileBaseByPid[pid]
        if (baseUrl) {
          const scrubbed = (models || []).filter((m) => !isModelEndpointMismatch(m, baseUrl))
          if (scrubbed.length) cleanedProviderModels[pid] = scrubbed
        } else if (models && models.length) {
          // Unknown owner (custom runtime provider) — keep as-is; don't risk
          // dropping a legit fetched list we can't attribute.
          cleanedProviderModels[pid] = models
        }
      }
      const cleanProfileModels = (p: ApiProfile): string[] => {
        const own = (p.config?.model ? [p.config.model] : []).filter(
          (m) => !isModelEndpointMismatch(m, p.config?.baseUrl),
        )
        const fetched = (cleanedProviderModels[p.id] || []).filter(
          (m) => !isModelEndpointMismatch(m, p.config?.baseUrl),
        )
        if (fetched.length > 0) {
          // Authoritative: this endpoint's own fetched list wins (after scrubbing).
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
              ? apiProfiles.map((p, i) => {
                  // Scrub cross-endpoint pollution; if that leaves a profile with
                  // NO models, re-seed it from its own history endpoint so a
                  // deepseek profile that had its models polluted by another
                  // supplier's list still surfaces the correct model
                  // (e.g. deepseek-v4-pro) instead of going empty.
                  let models = cleanProfileModels(p)
                  if (models.length === 0 && p.config?.baseUrl) {
                    const histModels = Array.from(
                      new Set(
                        (apiHistory || [])
                          .filter((h) => h.baseUrl === p.config!.baseUrl && h.model)
                          .map((h) => h.model as string)
                          .filter((m) => !isModelEndpointMismatch(m, p.config!.baseUrl)),
                      ),
                    )
                    if (histModels.length) models = histModels
                  }
                  return {
                    id: p.id || `p-${i}`,
                    name: p.name,
                    baseUrl: p.config?.baseUrl || '',
                    apiKey: p.config?.apiKey || '',
                    models,
                    isDefault: p.id === loadedActiveProfileId,
                  }
                })
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
      // ── Include history-only endpoints as providers ──
      // An endpoint the user has only ever used via "添加模型" (landing in
      // apiHistory) but never saved as an apiProfile has NO provider entry. On
      // restoreFromStorage the persisted activeModel then can't be validated by
      // any provider and silently falls back to the default provider's first
      // model (e.g. Ling) — so clicking a deepseek/kimi history item appears to
      // "switch to Ling" after a refresh. Synthesize a provider for every
      // history endpoint not already covered by a named profile, so the active
      // model stays pinned to the endpoint it belongs to.
      const historyProviders: ProviderConfig[] = []
      {
        const seenBase = new Set(builtProviders.map((p) => p.baseUrl))
        const hist = (apiHistory || []) as Array<{ baseUrl?: string; apiKey?: string; model?: string; provider?: string }>
        // Single O(n) pass: group history entries by endpoint instead of the old
        // O(n²) approach that re-filtered the whole list per unique baseUrl.
        const byBase = new Map<string, { apiKey: string; provider?: string; models: Set<string> }>()
        for (const h of hist) {
          if (!h.baseUrl || !h.model) continue
          if (seenBase.has(h.baseUrl)) continue
          let entry = byBase.get(h.baseUrl)
          if (!entry) {
            entry = { apiKey: h.apiKey || '', provider: h.provider, models: new Set<string>() }
            byBase.set(h.baseUrl, entry)
            seenBase.add(h.baseUrl)
          }
          entry.models.add(h.model)
        }
        for (const [baseUrl, entry] of byBase) {
          historyProviders.push({
            id: `hist-${historyProviders.length}`,
            name: deriveProviderName(baseUrl, entry.provider) || entry.provider || '配置',
            baseUrl,
            apiKey: entry.apiKey,
            models: Array.from(entry.models),
            isDefault: false,
          })
        }
      }
      const allBuiltProviders = [...builtProviders, ...historyProviders]
      // Heal persisted provider baseUrl pollution: if a provider's models all
      // clearly belong to a different endpoint than its baseUrl (e.g. Ling/Ring
      // models but a deepseek URL), its baseUrl was overwritten by an old bug.
      // Clear it so activeProvider matching falls back to model-based lookup
      // instead of anchoring to the wrong provider and showing the wrong list.
      const healedProviders = allBuiltProviders.map((p) => {
        if (!p.baseUrl || p.models.length === 0) return p
        const validModels = p.models.filter((m) => !isModelEndpointMismatch(m, p.baseUrl))
        if (validModels.length === 0) {
          warn('[restoreFromStorage] provider baseUrl polluted:', p.name, p.baseUrl, 'models:', p.models, '-> clearing baseUrl')
          return { ...p, baseUrl: '', apiKey: '' }
        }
        return p
      })
      // Merge the persisted per-provider fetched model lists (providerModels)
      // into each provider's candidate `models` pool. This keeps a single source
      // of truth so a model selected from "获取模型列表" survives a cold restart:
      // without it, `activeModel` would be rejected by the check below (not in
      // `providers[].models`) and silently fall back to the default model.
      const mergedProviders: ProviderConfig[] = healedProviders.map((p) => {
        const fetched = cleanedProviderModels[p.id]
        if (fetched && fetched.length > 0) {
          const models = Array.from(new Set([...p.models, ...fetched]))
          return { ...p, models }
        }
        return p
      })
      // Canonical restore logic: the active model is whatever IndexedDB persisted
      // as `activeModel`. If that model is not declared by any provider, fall
      // back to the default provider's first model.
      // Honor the persisted active model even when it is only present in a
      // fetched list (providerModels) and not in the declared `models[]` yet —
      // e.g. a model picked from "获取模型列表". The previous logic dropped it
      // back to the default provider's `models[0]` (deepseek-v4-pro) whenever
      // the fetched list hadn't hydrated at restore time, which reverted every
      // launch to pro. The mismatch guard below (isModelEndpointMismatch) still
      // catches genuinely bad model/endpoint pairings, so keeping the user's
      // explicit choice here is safe.
      const builtActiveModel: string | null =
        activeModel || (mergedProviders.length > 0
          ? (mergedProviders.find((p) => p.isDefault && (p.models?.length || 0) > 0)?.models[0] ||
             mergedProviders.find((p) => (p.models?.length || 0) > 0)?.models[0] ||
             null)
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
        hasOnboarded: loadedHasOnboarded === true,
        apiConfig: (() => {
          const resolve = (cfg: any) => {
            // Validation gate: reject stale/bad profiles so a poisoned IndexedDB
            // entry can never re-enter the store and get pushed to Hermes.
            if (!cfg || !cfg.baseUrl) {
              return { ...defaults }
            }
            const merged = { ...defaults, ...cfg }
            // Heal model/baseUrl mismatch: a persisted entry can pair a Ling
            // model with a deepseek baseUrl (old pollution / provider-switch
            // fallout). The gateway would then 400 "model not supported" and
            // output nothing. Keep the user's model name but force the
            // known-good ant-ling endpoint + key — same policy as
            // main.js hermes:setModel (isBadConfig fallback).
            if (isModelEndpointMismatch(merged.model, merged.baseUrl)) {
              warn('[restoreFromStorage] apiConfig model/baseUrl mismatch → snap to ant-ling:', merged.model, merged.baseUrl)
              return { ...merged, provider: 'ant-ling', baseUrl: defaults.baseUrl, apiKey: defaults.apiKey }
            }
            return merged
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
        apiHistory: (() => {
          const raw = apiHistory || []
          // Drop poisoned history entries where the model name clearly belongs to
          // a DIFFERENT supplier than the endpoint it was saved against (e.g.
          // `k3`/Kimi under a DeepSeek base URL). We no longer "heal" these by
          // rewriting the model — rewriting kept a misleading entry under the
          // wrong supplier; the user wants them removed outright. Entries whose
          // model or URL cannot be confidently attributed (custom endpoints /
          // custom model names) are left untouched to avoid deleting legit configs.
          const kept = raw.filter(
            (h) => !h.model || !h.baseUrl || !isModelEndpointMismatch(h.model, h.baseUrl),
          )
          // Deduplicate by baseUrl + apiKey: one CONFIG is one history entry
          // (the list groups by baseUrl and entries within a group differ by
          // apiKey). Model changes on the same connection update that entry in
          // place, so persisted duplicates from older builds — several entries
          // with the same endpoint+key but different models — collapse here.
          // The list is ordered most-recent-first, so the first occurrence kept
          // is the newest model for that config.
          const seen = new Set<string>()
          const normKey = (k?: string) => (k ?? '').trim()
          return kept.filter((h) => {
            if (!h.model || !h.baseUrl) return false
            const key = `${h.baseUrl}|${normKey(h.apiKey)}`
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
        })(),
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
            // Group history entries by baseUrl so each endpoint becomes its own
            // provider. This prevents a single "配置 · xxx" profile from owning
            // models that clearly belong to different endpoints (e.g. Ling and
            // DeepSeek models mixed together after repeated saves).
            const groups = new Map<string, typeof apiHistory>()
            for (const h of apiHistory) {
              const key = h.baseUrl || `unknown-${groups.size}`
              if (!groups.has(key)) groups.set(key, [])
              groups.get(key)!.push(h)
            }
            return Array.from(groups.entries()).map(([baseUrl, entries], i) => {
              const primary = entries[0]
              const models = Array.from(new Set(entries.map((h) => h.model).filter(Boolean)))
              return {
                id: generateId(),
                name: deriveProviderName(baseUrl, `配置 ${i + 1}`),
                config: { ...defaults, ...primary },
                models,
              }
            })
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
        themeStyle: themeStyle || (typeof localStorage !== 'undefined' ? localStorage.getItem('helix-theme-style') : null) || get().themeStyle,
        sessionUsageStats: (sessionUsageStats && typeof sessionUsageStats === 'object' && typeof (sessionUsageStats as { requestCount?: unknown }).requestCount === 'number')
          // Restore the persisted cumulative token stats verbatim. Previously a
          // "one-time migration" gated this on dailyUsage having a `models`
          // subfield; that wrongly discarded valid historical stats whenever
          // dailyUsage was empty or predated per-model tracking, so the panel
          // showed "尚未获取到用量数据" after every cold restart. Cumulative
          // usage is inherently persistent, so we keep it whenever it was saved.
          ? sessionUsageStats
          : { requestCount: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0, totalCost: 0 },
        // Rehydrate the last persisted context-window usage snapshot so the
        // indicator no longer resets to zero on every cold start. The backend
        // does not report a session's accumulated token count on launch and the
        // in-memory field is only refreshed by runtime events, so we persist it
        // (see setContextUsage / persistToStorage) and restore it here. A fresh
        // `message.complete` from the backend overwrites it with the live value.
        contextUsage: (contextUsage && typeof contextUsage === 'object' && !Array.isArray(contextUsage))
          ? contextUsage as unknown as Record<string, { size: number; used: number }>
          : {},
        dailyUsage: (dailyUsage && typeof dailyUsage === 'object' && Object.keys(dailyUsage).length > 0)
          // Restore the persisted daily breakdown verbatim. The old `hasDailyModels`
          // gate dropped every day entry that lacked the newer `models` subfield,
          // which silently emptied the chart on restart for pre-per-model data.
          ? dailyUsage
          : {},
        scheduledTasks: (scheduledTasks as ScheduledTask[]) || [],
        mcpServers: {
          ...fileMcpConfig,
          ...(mcpServers || {}),
        },
        externalServices: (externalServices || []).filter(
          (s) => s && typeof s.id === 'string' && typeof s.host === 'string'
        ),
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
        autoSaveSession: autoSaveSession ?? get().autoSaveSession,
        reasoningEffort: (reasoningEffort as any) || get().reasoningEffort,
        personality: personality || get().personality,
        fastMode: fastMode ?? get().fastMode,
        desktopNotifications: desktopNotifications ?? get().desktopNotifications,
        soundEnabled: soundEnabled ?? get().soundEnabled,
        availableModels: availableModels || [],
        providerModels: cleanedProviderModels,
        editorTheme: (editorTheme as 'vs-dark' | 'light' | null | undefined) ?? get().editorTheme,
        gitAutoCommit: gitAutoCommit ?? get().gitAutoCommit,
        gitAutoPush: gitAutoPush ?? get().gitAutoPush,
        gitPushConfirm: gitPushConfirm ?? get().gitPushConfirm,
        gitAutoBranch: gitAutoBranch ?? get().gitAutoBranch,
        gitRemoteUrl: gitRemoteUrl || get().gitRemoteUrl,
        gitCommitTemplate: gitCommitTemplate || get().gitCommitTemplate,
        gitBranchPrefix: gitBranchPrefix || get().gitBranchPrefix,
        voiceAutoSpeak: voiceAutoSpeak ?? get().voiceAutoSpeak,
        browserHomeUrl: '',
        browserBookmarks: savedBookmarks ?? get().browserBookmarks,
      })

      // Permanently scrub the pollution from IndexedDB: write back the cleaned
      // apiProfiles and the unpolluted providers list. Without this, the on-disk
      // copies keep the old jumbled `models` and only the in-memory state would be
      // clean until the next write. Doing it here makes the "一堆放一起" fix stick
      // after a single restart, with no manual data clearing required.
      try {
        const healed = get()
        // Skip the redundant IndexedDB writes when nothing actually changed.
        // After the first "heal" restart the on-disk data is already clean, so
        // re-writing identical blobs on every subsequent startup is pure I/O.
        const prevModels = providerModels || {}
        const changed =
          JSON.stringify(healed.apiProfiles) !== JSON.stringify(apiProfiles || []) ||
          JSON.stringify(healed.providers) !== JSON.stringify(providers || []) ||
          JSON.stringify(cleanedProviderModels) !== JSON.stringify(prevModels)
        if (changed) {
          await persistence.saveSetting('apiProfiles', healed.apiProfiles)
          await persistence.saveSetting('providers', healed.providers)
          await persistence.saveSetting('providerModels', cleanedProviderModels)
        }
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
        const fallbackDir = typeof process !== 'undefined' && typeof (process as any).cwd === 'function' ? (process as any).cwd() : ''
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
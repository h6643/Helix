import { create } from 'zustand'

export interface FileNode {
  id: string
  name: string
  type: 'file' | 'folder'
  children?: FileNode[]
  content?: string
  language?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
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

export type ApiProvider = 'openai' | 'deepseek' | 'mimo' | 'custom'

export interface ApiConfig {
  provider: ApiProvider
  apiKey: string
  baseUrl: string
  model: string
}

export const PROVIDER_PRESETS: Record<Exclude<ApiProvider, 'custom'>, { name: string; baseUrl: string; models: string[] }> = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-coder', 'deepseek-reasoner'],
  },
  mimo: {
    name: 'MiMo',
    baseUrl: 'https://api.mimo.ai/v1',
    models: ['mimo-auto', 'mimo-v2-pro'],
  },
}

export interface Skill {
  id: string
  name: string
  description: string
  prompt: string
  icon?: string
  isBuiltin?: boolean
  createdAt: number
}

export interface MemoryEntry {
  id: string
  content: string
  category: 'architecture' | 'rule' | 'decision' | 'pattern' | 'gotcha'
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

  // Agent Execution
  agentExecutionSteps: Array<{ type: string; toolName?: string; path?: string; timestamp: number }>
  accessedDirectories: string[]
  sessionSaveVersion: number
  addExecutionStep: (step: { type: string; toolName?: string; path?: string }) => void
  addAccessedDirectory: (dir: string) => void
  clearExecutionFlow: () => void
  notifySessionSaved: () => void

  // UI
  showCommandPalette: boolean
  editorTheme: 'vs-dark' | 'light'
  toasts: ToastMessage[]
  pendingChanges: PendingChange[]
  showDiffPreview: boolean
  showTaskPanel: boolean
  showMemoryPanel: boolean
  showSubAgentPanel: boolean
  showSessionManager: boolean

  // Actions - Files
  setFiles: (files: FileNode[]) => void
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

const defaultFiles: FileNode[] = [
  {
    id: 'root-src',
    name: 'src',
    type: 'folder',
    children: [
      {
        id: 'file-app',
        name: 'App.tsx',
        type: 'file',
        language: 'typescript',
        content: `import React from 'react';\nimport { Counter } from './components/Counter';\n\nexport default function App() {\n  return (\n    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">\n      <header className="bg-white dark:bg-gray-800 shadow-sm">\n        <div className="max-w-7xl mx-auto px-4 py-4">\n          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">\n            My App\n          </h1>\n        </div>\n      </header>\n      <main className="max-w-7xl mx-auto px-4 py-8">\n        <Counter />\n      </main>\n    </div>\n  );\n}`,
      },
      {
        id: 'folder-components',
        name: 'components',
        type: 'folder',
        children: [
          {
            id: 'file-counter',
            name: 'Counter.tsx',
            type: 'file',
            language: 'typescript',
            content: `import React, { useState } from 'react';\n\ninterface CounterProps {\n  initialValue?: number;\n}\n\nexport function Counter({ initialValue = 0 }: CounterProps) {\n  const [count, setCount] = useState(initialValue);\n\n  return (\n    <div className="flex flex-col items-center gap-4">\n      <span className="text-5xl font-bold text-gray-800 dark:text-gray-200">\n        {count}\n      </span>\n      <div className="flex gap-3">\n        <button\n          onClick={() => setCount(c => c - 1)}\n          className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition"\n        >\n          -1\n        </button>\n        <button\n          onClick={() => setCount(0)}\n          className="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition"\n        >\n          Reset\n        </button>\n        <button\n          onClick={() => setCount(c => c + 1)}\n          className="px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 transition"\n        >\n          +1\n        </button>\n      </div>\n    </div>\n  );\n}`,
          },
        ],
      },
      {
        id: 'file-styles',
        name: 'index.css',
        type: 'file',
        language: 'css',
        content: `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {\n  --primary: #3b82f6;\n  --primary-dark: #2563eb;\n}\n\nbody {\n  font-family: 'Inter', sans-serif;\n}`,
      },
    ],
  },
  {
    id: 'file-package',
    name: 'package.json',
    type: 'file',
    language: 'json',
    content: `{\n  "name": "my-project",\n  "version": "1.0.0",\n  "private": true,\n  "scripts": {\n    "dev": "next dev",\n    "build": "next build",\n    "start": "next start"\n  },\n  "dependencies": {\n    "react": "^19.0.0",\n    "react-dom": "^19.0.0",\n    "next": "^16.0.0"\n  }\n}`,
  },
  {
    id: 'file-readme',
    name: 'README.md',
    type: 'file',
    language: 'markdown',
    content: `# My Project\n\nA modern web application built with React and Next.js.\n\n## Getting Started\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n\nOpen [http://localhost:3000](http://localhost:3000) to view it in the browser.`,
  },
  {
    id: 'file-gitignore',
    name: '.gitignore',
    type: 'file',
    language: 'plaintext',
    content: `node_modules\n.next\n.env.local\n*.log`,
  },
]

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
  chatMessages: [
    {
      id: 'welcome-msg',
      role: 'assistant',
      content: '你好！有什么我可以帮你的吗？',
      timestamp: Date.now(),
    },
  ],
  isChatLoading: false,

  // Skills
  skills: [
    { id: 'explain', name: '解释代码', description: '解释选中的代码', prompt: '请解释以下代码的功能和逻辑：\n\n{code}', icon: '📖', isBuiltin: true, createdAt: Date.now() },
    { id: 'refactor', name: '重构代码', description: '优化代码结构', prompt: '请重构以下代码，使其更清晰、更高效：\n\n{code}', icon: '🔄', isBuiltin: true, createdAt: Date.now() },
    { id: 'test', name: '生成测试', description: '为代码生成单元测试', prompt: '请为以下代码生成完整的单元测试：\n\n{code}', icon: '🧪', isBuiltin: true, createdAt: Date.now() },
    { id: 'doc', name: '生成文档', description: '为代码生成文档注释', prompt: '请为以下代码生成详细的文档注释：\n\n{code}', icon: '📝', isBuiltin: true, createdAt: Date.now() },
    { id: 'fix', name: '修复错误', description: '分析并修复代码错误', prompt: '请分析以下代码并修复其中的错误：\n\n{code}\n\n错误信息：{error}', icon: '🔧', isBuiltin: true, createdAt: Date.now() },
  ],
  showSkillPanel: false,

  // Terminal
  terminalOutput: [
    '\x1b[32m$ Helix v1.0.0\x1b[0m',
    'AI 编程助手已就绪。在下方输入你的需求，或直接编辑代码。',
    '',
  ],
  isTerminalOpen: true,
  terminalHistory: [],
  terminalHistoryIndex: 0,

  // UI
  showCommandPalette: false,
  editorTheme: 'vs-dark' as const,
  toasts: [],
  pendingChanges: [],
  showDiffPreview: false,
  showTaskPanel: false,
  showMemoryPanel: false,

  // Agent Execution
  agentExecutionSteps: [],
  accessedDirectories: [],
  sessionSaveVersion: 0,
  showSubAgentPanel: false,
  showSessionManager: false,

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

  // Goal
  goal: null,

  // Memory
  memories: [],
  notes: '',
  checkpoints: [],

  // Tasks
  tasks: [],

  // Actions - Files
  setFiles: (files) => set({ files }),
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
    return id
  },

  updateChatMessage: (messageId, content) =>
    set((state) => ({
      chatMessages: state.chatMessages.map((m) =>
        m.id === messageId ? { ...m, content } : m
      ),
    })),

  setChatMessageStreaming: (messageId, isStreaming) =>
    set((state) => ({
      chatMessages: state.chatMessages.map((m) =>
        m.id === messageId ? { ...m, isStreaming } : m
      ),
    })),

  clearChat: () =>
    set({
      chatMessages: [
        {
          id: 'welcome-msg',
          role: 'assistant',
          content: '你好！有什么我可以帮你的吗？',
          timestamp: Date.now(),
        },
      ],
    }),
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

  showToast: (toast) => {
    const id = generateId()
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }))
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) }))
    }, toast.duration || 3000)
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter(t => t.id !== id) })),

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
  clearExecutionFlow: () =>
    set({ agentExecutionSteps: [], accessedDirectories: [] }),
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
  setAvailableModels: (models) => set({ availableModels: models }),

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
      ])
    } catch (e) {
      console.error('Failed to persist:', e)
    }
  },

  restoreFromStorage: async () => {
    try {
      const { persistence } = await import('@/lib/persist')
      const sessionId = 'current-session'
      const [memories, tasks, checkpoints, notes, chatMessages, goal, apiConfig, apiHistory] = await Promise.all([
        persistence.loadMemories(),
        persistence.loadTasks(),
        persistence.loadCheckpoints(),
        persistence.loadNotes(),
        persistence.loadChatMessagesBySession(sessionId),
        persistence.loadSetting<string | null>('goal'),
        persistence.loadSetting<ApiConfig>('apiConfig'),
        persistence.loadSetting<ApiConfig[]>('apiHistory'),
      ])
      // Filter out the welcome message from persisted history
      const filteredMessages = chatMessages.filter(m =>
        !(m.role === 'assistant' && m.content === '你好！有什么我可以帮你的吗？')
      )
      set({
        memories: memories as MemoryEntry[],
        tasks: tasks as TaskNode[],
        checkpoints: checkpoints as SessionCheckpoint[],
        notes: notes || '',
        goal,
        apiConfig: apiConfig || get().apiConfig,
        apiHistory: apiHistory || [],
        chatMessages: filteredMessages.length > 0
          ? filteredMessages.map(m => ({
              id: m.id,
              role: m.role as 'user' | 'assistant' | 'system',
              content: m.content,
              timestamp: m.timestamp,
              isStreaming: false,
            }))
          : get().chatMessages,
      })
    } catch (e) {
      console.error('Failed to restore:', e)
    }
  },

  saveCheckpointChat: async () => {
    try {
      const { persistence } = await import('@/lib/persist')
      const state = get()
      const sessionId = 'checkpoint-' + Date.now()
      const messages = state.chatMessages.filter(m =>
        !(m.role === 'assistant' && m.content === '你好！有什么我可以帮你的吗？')
      )
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
        const statusIcon = t.status === 'done' ? '✅' : t.status === 'in_progress' ? '🔄' : t.status === 'blocked' ? '⚠️' : '⬜'
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
        const statusIcon = a.status === 'running' ? '🔄' : a.status === 'completed' ? '✅' : a.status === 'failed' ? '❌' : '⏹️'
        ctx += `${statusIcon} ${a.name}: ${a.description}\n`
        if (a.result && a.status === 'completed') {
          ctx += `   结果: ${a.result.slice(0, 200)}\n`
        }
      }
    }
    return ctx
  },
}))
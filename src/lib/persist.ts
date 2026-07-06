/**
 * IndexedDB persistence layer for Helix
 * Stores: memories, tasks, notes, checkpoints, chat history, file snapshots
 */
import { encryptApiKey, decryptApiKey } from './crypto'

const DB_NAME = 'helix-db'
const DB_VERSION = 4

interface PersistedMemory {
  id: string
  content: string
  category: string
  createdAt: number
}

interface PersistedTask {
  id: string
  label: string
  status: string
  children?: PersistedTask[]
  parentId: string | null
  depth: number
}

interface PersistedCheckpoint {
  id: string
  label: string
  timestamp: number
  taskIds: string[]
  memorySnapshot: string
}

export interface PersistedChatMessage {
  id: string
  sessionId?: string
  role: string
  content: string
  images?: Array<{
    id: string
    dataUrl: string
    mediaType: string
    width?: number
    height?: number
    name?: string
  }>
  timestamp: number
  isStreaming: boolean
}

interface PersistedNote {
  content: string
}

interface PersistedFileSnapshot {
  id: string
  name: string
  type: string
  content?: string
  language?: string
  children?: PersistedFileSnapshot[]
}

export interface PersistedProject {
  id: string
  name: string
  folder: string
  createdAt: number
  updatedAt: number
  chatMessages: PersistedChatMessage[]
  files: PersistedFileSnapshot[]
}

export interface PersistedOpenTab {
  id: string
  fileId?: string
  name: string
  language?: string
  isDirty?: boolean
}

export type PersistedEditorTab = PersistedOpenTab

export interface PersistedScheduledTask {
  id: string
  label: string
  prompt: string
  scheduleText: string
  cronExpression?: string
  enabled: boolean
  lastRunAt: number | null
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}

export interface PersistedSession {
  id: string
  label: string
  savedAt: number
  isArchived?: boolean
  workDir: string | null
  goal: string | null
  memories: PersistedMemory[]
  tasks: PersistedTask[]
  notes: string
  checkpoints: PersistedCheckpoint[]
  chatMessages: PersistedChatMessage[]
  files: PersistedFileSnapshot[]
  openTabs: PersistedOpenTab[]
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('memories')) {
        db.createObjectStore('memories', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('tasks')) {
        db.createObjectStore('tasks', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('checkpoints')) {
        db.createObjectStore('checkpoints', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('chatMessages')) {
        const store = db.createObjectStore('chatMessages', { keyPath: 'id' })
        store.createIndex('sessionId', 'sessionId', { unique: false })
      }
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' })
      }
      // Migration: add sessionId index if store exists but index doesn't
      if (db.objectStoreNames.contains('chatMessages')) {
        let hasIndex = false
        try {
          const store = db.transaction('chatMessages', 'readwrite').objectStore('chatMessages')
          store.index('sessionId')
          hasIndex = true
        } catch (_) {
          // index doesn't exist yet
        }
        if (!hasIndex) {
          const store = db.transaction('chatMessages', 'readwrite').objectStore('chatMessages')
          store.createIndex('sessionId', 'sessionId', { unique: false })
        }
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function tx<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const store = transaction.objectStore(storeName)
    const request = fn(store)
    request.onsuccess = () => {
      transaction.oncomplete = () => resolve(request.result)
      transaction.onerror = () => reject(transaction.error)
    }
    request.onerror = () => reject(request.error)
  })
}

function txAll<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => void
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    const store = transaction.objectStore(storeName)
    const request = store.getAll()
    fn(store)
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error)
  })
}

// ============ Public API ============

export const persistence = {
  // --- Memories ---
  async saveMemories(memories: PersistedMemory[]): Promise<void> {
    const db = await openDB()
    const transaction = db.transaction('memories', 'readwrite')
    const store = transaction.objectStore('memories')
    store.clear()
    for (const m of memories) store.put(m)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  },

  async loadMemories(): Promise<PersistedMemory[]> {
    const db = await openDB()
    return txAll<PersistedMemory>(db, 'memories', 'readonly', () => {})
  },

  // --- Tasks ---
  async saveTasks(tasks: PersistedTask[]): Promise<void> {
    const db = await openDB()
    const transaction = db.transaction('tasks', 'readwrite')
    const store = transaction.objectStore('tasks')
    store.clear()
    // Flatten task tree for storage
    const flatten = (nodes: PersistedTask[]): PersistedTask[] => {
      const result: PersistedTask[] = []
      for (const t of nodes) {
        result.push({ ...t, children: undefined })
        if (t.children) result.push(...flatten(t.children))
      }
      return result
    }
    const flat = flatten(tasks)
    for (const t of flat) store.put(t)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  },

  async loadTasks(): Promise<PersistedTask[]> {
    const db = await openDB()
    const flat = await txAll<PersistedTask>(db, 'tasks', 'readonly', () => {})
    // Rebuild tree
    const map = new Map<string, PersistedTask>()
    const roots: PersistedTask[] = []
    for (const t of flat) {
      map.set(t.id, { ...t, children: [] })
    }
    for (const t of flat) {
      const node = map.get(t.id)!
      if (t.parentId && map.has(t.parentId)) {
        map.get(t.parentId)!.children!.push(node)
      } else {
        roots.push(node)
      }
    }
    return roots
  },

  // --- Checkpoints ---
  async saveCheckpoints(checkpoints: PersistedCheckpoint[]): Promise<void> {
    const db = await openDB()
    const transaction = db.transaction('checkpoints', 'readwrite')
    const store = transaction.objectStore('checkpoints')
    store.clear()
    for (const cp of checkpoints) store.put(cp)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  },

  async loadCheckpoints(): Promise<PersistedCheckpoint[]> {
    const db = await openDB()
    return txAll<PersistedCheckpoint>(db, 'checkpoints', 'readonly', () => {})
  },

  // --- Chat Messages ---
  async saveChatMessages(messages: PersistedChatMessage[], sessionId?: string): Promise<void> {
    const db = await openDB()
    const transaction = db.transaction('chatMessages', 'readwrite')
    const store = transaction.objectStore('chatMessages')
    store.clear()
    // Assign sessionId to all messages if provided
    const enriched = messages.map(m => ({ ...m, sessionId: sessionId || m.sessionId || 'default' }))
    // Save last 200 messages max to avoid bloating
    const recent = enriched.slice(-200)
    for (const m of recent) store.put(m)
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
  },

  // Delete all chat messages for a specific session
  async deleteChatMessagesBySession(sessionId: string): Promise<void> {
    const db = await openDB()
    const transaction = db.transaction('chatMessages', 'readwrite')
    const store = transaction.objectStore('chatMessages')
    let request: IDBRequest<PersistedChatMessage[]>

    try {
      const index = store.index('sessionId')
      request = index.getAll(sessionId)
    } catch {
      request = store.getAll()
    }

    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        const all = request.result as PersistedChatMessage[]
        const messages = all.filter(m => m.sessionId === sessionId)
        for (const m of messages) store.delete(m.id)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
      }
      request.onerror = () => reject(request.error)
    })
  },

  // Load chat messages for a specific session
  async loadChatMessagesBySession(sessionId: string): Promise<PersistedChatMessage[]> {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('chatMessages', 'readonly')
      const store = transaction.objectStore('chatMessages')
      let request: IDBRequest<PersistedChatMessage[]>

      try {
        const index = store.index('sessionId')
        request = index.getAll(sessionId)
      } catch {
        // Index doesn't exist yet (migration pending) — fall back to getAll + filter
        request = store.getAll()
      }

      request.onsuccess = () => {
        const all = request.result as PersistedChatMessage[]
        const filtered = all
          .filter(m => m.sessionId === sessionId)
          .sort((a, b) => a.timestamp - b.timestamp)
        resolve(filtered)
      }
      request.onerror = () => reject(request.error)
    })
  },

  async loadChatMessages(): Promise<PersistedChatMessage[]> {
    const db = await openDB()
    return txAll<PersistedChatMessage>(db, 'chatMessages', 'readonly', () => {})
  },

  // --- Settings ---
  async saveSetting(key: string, value: unknown): Promise<void> {
    let toStore = value
    if (key === 'apiConfig' && value && typeof value === 'object' && 'apiKey' in (value as Record<string, unknown>)) {
      const config = { ...(value as Record<string, unknown>) }
      if (typeof config.apiKey === 'string' && config.apiKey) {
        config.apiKey = await encryptApiKey(config.apiKey)
      }
      toStore = config
    }
    if (key === 'apiHistory' && Array.isArray(value)) {
      toStore = await Promise.all((value as Array<Record<string, unknown>>).map(async (h) => {
        if (typeof h.apiKey === 'string' && h.apiKey) {
          return { ...h, apiKey: await encryptApiKey(h.apiKey) }
        }
        return h
      }))
    }
    const db = await openDB()
    await tx(db, 'settings', 'readwrite', (store) => store.put({ key, value: toStore }))
  },

  async loadSetting<T = unknown>(key: string): Promise<T | null> {
    const db = await openDB()
    const result = await tx<{ key: string; value: T } | undefined>(db, 'settings', 'readonly', (store) => store.get(key))
    let value: T | null = result?.value ?? null
    if (key === 'apiConfig' && value && typeof value === 'object' && 'apiKey' in (value as Record<string, unknown>)) {
      const config = { ...(value as Record<string, unknown>) }
      if (typeof config.apiKey === 'string' && config.apiKey) {
        config.apiKey = await decryptApiKey(config.apiKey)
      }
      value = config as T
    }
    if (key === 'apiHistory' && Array.isArray(value)) {
      value = await Promise.all((value as Array<Record<string, unknown>>).map(async (h) => {
        if (typeof h.apiKey === 'string' && h.apiKey) {
          return { ...h, apiKey: await decryptApiKey(h.apiKey) }
        }
        return h
      })) as T
    }
    return value
  },

  // --- Full Session Save/Restore ---
  async saveSession(data: {
    goal: string | null
    memories: PersistedMemory[]
    tasks: PersistedTask[]
    notes: string
    checkpoints: PersistedCheckpoint[]
    chatMessages: PersistedChatMessage[]
    files: PersistedFileSnapshot[]
    openTabs: PersistedOpenTab[]
    id?: string
    savedAt?: number
    label?: string
    workDir?: string | null
    isArchived?: boolean
  }): Promise<string> {
    const db = await openDB()
    const now = Date.now()
    const id = data.id || 'session-' + now
    const { label: dataLabel, ...rest } = data
    const session: PersistedSession = {
      id,
      label: dataLabel || new Date().toLocaleString('zh-CN'),
      savedAt: data.savedAt || now,
      workDir: data.workDir ?? null,
      ...rest,
      chatMessages: rest.chatMessages.map(m => ({ ...m, sessionId: m.sessionId || 'session-default' })),
    }
    await tx(db, 'sessions', 'readwrite', (store) => store.put(session))
    return id
  },

  async loadSessions(): Promise<PersistedSession[]> {
    const db = await openDB()
    return txAll<PersistedSession>(db, 'sessions', 'readonly', () => {})
  },

  async deleteSession(id: string): Promise<void> {
    const db = await openDB()
    await tx(db, 'sessions', 'readwrite', (store) => store.delete(id))
  },

  async updateSessionLabel(id: string, label: string): Promise<void> {
    const db = await openDB()
    const session = await tx<PersistedSession | undefined>(db, 'sessions', 'readonly', (store) => store.get(id))
    if (session) {
      session.label = label
      session.savedAt = Date.now()
      await tx(db, 'sessions', 'readwrite', (store) => store.put(session))
    }
  },

  // --- Projects ---
  async saveProject(data: {
    name: string
    folder: string
    chatMessages: PersistedChatMessage[]
    files: PersistedFileSnapshot[]
    id?: string
  }): Promise<string> {
    const db = await openDB()
    const id = data.id || 'project-' + Date.now()
    const now = Date.now()
    const project: PersistedProject = {
      id,
      name: data.name,
      folder: data.folder,
      createdAt: now,
      updatedAt: now,
      chatMessages: data.chatMessages.map(m => ({ ...m, sessionId: m.sessionId || 'project-default' })),
      files: data.files,
    }
    await tx(db, 'projects', 'readwrite', (store) => store.put(project))
    return id
  },

  async loadProjects(): Promise<PersistedProject[]> {
    const db = await openDB()
    return txAll<PersistedProject>(db, 'projects', 'readonly', () => {})
  },

  async getProjectFolders(): Promise<string[]> {
    const projects = await this.loadProjects()
    const folders = new Set<string>()
    for (const p of projects) {
      if (p.folder) folders.add(p.folder)
    }
    return Array.from(folders).sort()
  },

  async deleteProject(id: string): Promise<void> {
    const db = await openDB()
    await tx(db, 'projects', 'readwrite', (store) => store.delete(id))
  },

  // --- Notes ---
  async saveNotes(content: string): Promise<void> {
    await this.saveSetting('notes', content)
  },

  async loadNotes(): Promise<string> {
    return (await this.loadSetting<string>('notes')) ?? ''
  },

  // --- Scheduled Tasks ---
  async saveScheduledTasks(tasks: PersistedScheduledTask[]): Promise<void> {
    await this.saveSetting('scheduledTasks', tasks)
  },

  async loadScheduledTasks(): Promise<PersistedScheduledTask[]> {
    return (await this.loadSetting<PersistedScheduledTask[]>('scheduledTasks')) ?? []
  },

  // --- Editor Theme ---
  async saveEditorTheme(theme: string): Promise<void> {
    await this.saveSetting('editorTheme', theme)
  },

  async loadEditorTheme(): Promise<string | null> {
    return this.loadSetting<string>('editorTheme')
  },

  // --- Session Export/Import ---
  async exportSessionAsJson(session: PersistedSession): Promise<string> {
    const exportData = {
      version: '1.0',
      exportedAt: Date.now(),
      type: 'helix-session',
      session: {
        label: session.label,
        savedAt: session.savedAt,
        workDir: session.workDir,
        goal: session.goal,
        chatMessages: session.chatMessages.map(m => ({
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        })),
        files: session.files,
        openTabs: session.openTabs,
        tasks: session.tasks,
        memories: session.memories,
        notes: session.notes,
      },
    }
    return JSON.stringify(exportData, null, 2)
  },

  async exportSessionAsMarkdown(session: PersistedSession): Promise<string> {
    const lines: string[] = []
    lines.push(`# ${session.label}`)
    lines.push(`> 导出时间: ${new Date(session.savedAt).toLocaleString('zh-CN')}`)
    if (session.goal) lines.push(`> 目标: ${session.goal}`)
    if (session.workDir) lines.push(`> 工作目录: ${session.workDir}`)
    lines.push('')

    const fileList = session.files || []
    if (fileList.length > 0) {
      lines.push('## 文件结构')
      for (const f of fileList) {
        lines.push(`- ${f.name}${f.type === 'folder' ? '/' : ''}`)
      }
      lines.push('')
    }

    const messages = session.chatMessages || []
    if (messages.length > 0) {
      lines.push('## 对话记录')
      lines.push('')
      for (const msg of messages) {
        const role = msg.role === 'user' ? '🧑 用户' : '🤖 AI'
        lines.push(`### ${role} (${new Date(msg.timestamp).toLocaleString('zh-CN')})`)
        lines.push('')
        lines.push(msg.content)
        lines.push('')
        lines.push('---')
        lines.push('')
      }
    }

    return lines.join('\n')
  },

  async importSessionFromJson(json: string): Promise<PersistedSession | null> {
    try {
      const data = JSON.parse(json)
      if (data.type !== 'helix-session' && !data.session) return null
      const s = data.session || data
      const now = Date.now()
      const session: PersistedSession = {
        id: `imported-${now}`,
        label: s.label || `导入会话 ${new Date(now).toLocaleString('zh-CN')}`,
        savedAt: s.savedAt || now,
        workDir: s.workDir || null,
        goal: s.goal || null,
        chatMessages: (s.chatMessages || []).map((m: any) => ({
          id: `msg-${now}-${Math.random().toString(36).slice(2, 8)}`,
          role: m.role,
          content: m.content || '',
          timestamp: m.timestamp || now,
          isStreaming: false,
        })),
        files: s.files || [],
        openTabs: s.openTabs || [],
        tasks: s.tasks || [],
        memories: s.memories || [],
        notes: s.notes || '',
        checkpoints: [],
      }
      await this.saveSession(session)
      return session
    } catch {
      return null
    }
  },
}
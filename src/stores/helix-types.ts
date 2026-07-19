/**
 * Type declarations + shared constants for the Helix store.
 *
 * Extracted from helix-store.ts so the store file is purely "state shape +
 * actions" instead of mixing ~250 lines of interfaces with its implementation.
 * Everything here is re-exported from helix-store.ts for backward-compatible
 * imports (`import { type ChatMessage } from '@/stores/helix-store'`).
 */

import type { McpServerConfig } from '@/stores/hermes-store'
export type { McpServerConfig } from '@/stores/hermes-store'

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

// A file dropped/picked into the conversation (images, text, or binary).
export interface FileAttachment {
  id: string
  name: string
  size: number
  mime: string
  kind: 'image' | 'text' | 'file'
  dataUrl?: string     // image preview (data: URL), only for kind === 'image'
  base64?: string      // raw base64 payload (without data: prefix), for sending to Hermes
  path?: string        // Electron: absolute file path for binary files
}

export interface ExecutionStep {
  id: string
  type: 'task' | 'thinking' | 'reasoning' | 'tool_call' | 'tool_result' | 'text' | 'error' | 'done' | 'plan' | 'usage' | 'compact' | 'file_change'
  content: string
  toolName?: string
  toolKind?: string
  toolParams?: Record<string, unknown>
  fileChanges?: Array<{ path: string; type: 'add' | 'modify' | 'delete'; diff: string }>
  timestamp: number
  expanded?: boolean
  planText?: string
  taskLabel?: string
  taskId?: string
  finishReason?: string
  status?: 'running' | 'completed' | 'failed' | 'waiting'
  startedAt?: number
  finishedAt?: number
  logs?: string[]
  agentName?: string
  subSteps?: ExecutionStep[]
  delegationId?: string
}

// Streaming response blocks for the currently-running assistant reply.
export type StreamingResponseBlock =
  | { type: 'text'; content: string }
  | { type: 'thinking'; content: string }
  | { type: 'tool_group'; steps: ExecutionStep[] }

// Per-session streaming draft: survives conversation switches.
export interface StreamingDraft {
  responseBlocks: StreamingResponseBlock[]
  streamThinking: string
  steps: ExecutionStep[]
  isAgentRunning: boolean
  textBuffer?: string
  thoughtBuffer?: string
  hermesSessionId?: string | null
}

// Transient notice about the Hermes gateway connection (e.g. upstream dropped the
// stream and is retrying). Shown in the execution status box; not persisted.
export interface ConnectionNotice {
  phase: 'error' | 'retrying' | 'recovered'
  attempt?: number
  total?: number
  message: string
  ts: number
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  sessionId?: string
  images?: ImageAttachment[]
  files?: FileAttachment[]
  timestamp: number
  isStreaming?: boolean
  thinkingTime?: number
  tokenCount?: number
  thoughtTokens?: number
  reasoning?: string
  steps?: ExecutionStep[]
  blocks?: Array<{ type: 'text'; content: string } | { type: 'thinking'; content: string } | { type: 'tool_group'; steps: ExecutionStep[] }>
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
  position?: 'bottom-right' | 'top-right'
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

export interface ApiProfile {
  id: string
  name: string
  config: ApiConfig
  /** All models available under this provider. The first entry is the default. */
  models?: string[]
}

/**
 * Multi-provider config used by the flattened model selector.
 * Mirrors the hermes-ui ProviderConfig shape so the selector can read from
 * either the main store or the standalone hermes-ui store.
 */
export interface ProviderConfig {
  id: string
  /** Display name, e.g. "Ling" */
  name: string
  /** Base URL, e.g. "https://api.ant-ling.com/v1" */
  baseUrl: string
  apiKey: string
  /** Models offered by this provider, e.g. ["Ling-2.6-1T", "Ling-2.6-Pro"] */
  models: string[]
  /** Default model for this provider (falls back to models[0]). */
  defaultModel?: string
  /** Marks the provider used when nothing is selected. */
  isDefault?: boolean
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
  /** Origin of a MEMORY.md entry: 'manual' (added via Helix UI) vs 'auto'
   * (appended by Hermes self-evolution). Undefined for user-profile entries. */
  source?: 'manual' | 'auto'
}

export interface AvailableCommand {
  name: string
  description?: string
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

// Used as the `customShortcuts` value shape across the app.
export interface CustomShortcutEntry {
  keys: string[]
  action: string
  description: string
}

export const DEFAULT_SHORTCUTS: Record<string, CustomShortcutEntry> = {
  'archive-chat': { keys: ['Ctrl', 'Shift', 'A'], action: 'archive-chat', description: '归档聊天' },
  'new-chat': { keys: ['Ctrl', 'N'], action: 'new-chat', description: '新对话' },
  'quick-chat': { keys: ['Ctrl', 'Alt', 'N'], action: 'quick-chat', description: '新建快速对话' },
  'search-chat': { keys: ['Ctrl', 'F'], action: 'search-chat', description: '查找' },
  'go-back': { keys: ['Ctrl', '['], action: 'go-back', description: '返回' },
  'go-forward': { keys: ['Ctrl', ']'], action: 'go-forward', description: '前进' },
  'next-recent-chat': { keys: ['Ctrl', 'Tab'], action: 'next-recent-chat', description: '下一个最近查看的聊天' },
  'prev-recent-chat': { keys: ['Ctrl', 'Shift', 'Tab'], action: 'prev-recent-chat', description: '上一个最近查看的聊天' },
  'prev-chat': { keys: ['Ctrl', 'Shift', '['], action: 'prev-chat', description: '上一个聊天' },
  'open-review': { keys: ['Ctrl', 'Shift', 'G'], action: 'open-review', description: '打开审查选项卡' },
  'toggle-sidebar': { keys: ['Ctrl', 'B'], action: 'toggle-sidebar', description: '切换边栏' },
  'toggle-sidebar-full': { keys: ['Ctrl', 'L'], action: 'toggle-sidebar-full', description: '完全显示/隐藏边栏' },
  'toggle-terminal': { keys: ['Ctrl', 'J'], action: 'toggle-terminal', description: '打开终端' },
  'force-reload': { keys: ['Ctrl', 'Shift', 'R'], action: 'force-reload', description: '刷新界面' },

  'new-window': { keys: ['Ctrl', 'Shift', 'N'], action: 'new-window', description: '新建窗口' },
  'rename-chat': { keys: ['Ctrl', 'Alt', 'R'], action: 'rename-chat', description: '重命名聊天' },
  'search-chats': { keys: ['Ctrl', 'G'], action: 'search-chats', description: '搜索聊天' },
  'show-shortcuts': { keys: ['Ctrl', 'Shift', '/'], action: 'show-shortcuts', description: '显示键盘快捷键' },
  'settings': { keys: ['Ctrl', ','], action: 'settings', description: '设置' },
  'approve-request': { keys: ['Enter'], action: 'approve-request', description: '批准请求' },
  'decline-request': { keys: ['Escape'], action: 'decline-request', description: '拒绝请求' },
  'model-picker': { keys: ['Ctrl', 'Shift', 'M'], action: 'model-picker', description: '打开模型选择器' },
  'toggle-file-tree': { keys: ['Ctrl', 'Shift', 'E'], action: 'toggle-file-tree', description: '切换文件树' },
}

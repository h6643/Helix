/**
 * Type declarations + shared constants for the Helix store.
 *
 * Extracted from helix-store.ts so the store file is purely "state shape +
 * actions" instead of mixing ~250 lines of interfaces with its implementation.
 * Everything here is re-exported from helix-store.ts for backward-compatible
 * imports (`import { type ChatMessage } from '@/stores/helix-store'`).
 */

export interface FileNode {
  id: string;
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
  content?: string;
  language?: string;
}

export interface ImageAttachment {
  id: string;
  dataUrl: string; // "data:image/png;base64,..."
  mediaType: string; // "image/png", "image/jpeg", "image/webp"
  width?: number;
  height?: number;
  name?: string;
}

// A file dropped/picked into the conversation (images, text, or binary).
export interface FileAttachment {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: "image" | "text" | "file";
  dataUrl?: string; // image preview (data: URL), only for kind === 'image'
  base64?: string; // raw base64 payload (without data: prefix), for sending to Helix
  path?: string; // Electron: absolute file path for binary files
}

// A web link picked from the in-app browser ("选取网页元素加入聊天") and shown
// as a compact card in the composer instead of a long raw URL in the input.
export interface LinkAttachment {
  id: string;
  url: string;
  title?: string; // optional display label (e.g. the picked element's text)
}

export interface ExecutionStep {
  id: string;
  type:
    | "task"
    | "thinking"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "text"
    | "error"
    | "done"
    | "plan"
    | "usage"
    | "compact"
    | "file_change";
  content: string;
  toolName?: string;
  toolKind?: string;
  // pi 后端事件 id（toolcall_start 的 id）：toolcall_end / tool_execution_start
  // 的迟到参数补写靠它匹配回这一步。
  toolCallId?: string;
  toolParams?: Record<string, unknown>;
  fileChanges?: Array<{
    path: string;
    type: "add" | "modify" | "delete";
    diff: string;
  }>;
  timestamp: number;
  expanded?: boolean;
  planText?: string;
  taskLabel?: string;
  taskId?: string;
  finishReason?: string;
  status?: "running" | "completed" | "failed" | "waiting";
  startedAt?: number;
  finishedAt?: number;
  duration_s?: number;
  logs?: string[];
  agentName?: string;
  subSteps?: ExecutionStep[];
  delegationId?: string;
  inlineDiff?: string;
  summary?: string;
  output?: string;
}

// Streaming response blocks for the currently-running assistant reply.
export type StreamingResponseBlock =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_group"; steps: ExecutionStep[] }
  | { type: "file_change"; changes: PendingChange[] };

// Per-session streaming draft: survives conversation switches.
export interface StreamingDraft {
  responseBlocks: StreamingResponseBlock[];
  streamThinking: string;
  steps: ExecutionStep[];
  isAgentRunning: boolean;
  textBuffer?: string;
  thoughtBuffer?: string;
  helixSessionId?: string | null;
  // When this run started (ms epoch). Per-session so each conversation's live
  // timer keeps its own elapsed time instead of sharing one global timestamp.
  startedAt?: number;
  // Backend-reported total token count after usage:prompt-complete.
  totalTokens?: number;
}

// Transient notice about the Helix gateway connection (e.g. upstream dropped the
// stream and is retrying). Shown in the execution status box; not persisted.
export interface ConnectionNotice {
  phase: "error" | "retrying" | "recovered";
  attempt?: number;
  total?: number;
  message: string;
  ts: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /** Durable backend message row id (state.db messages.id), surfaced by the
   *  gateway's message.complete frame. Used to sync local withdraw/delete with
   *  the backend session history via the message.delete RPC. Absent on messages
   *  produced before this field existed or for local-only messages. */
  rowId?: number;
  sessionId?: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  timestamp: number;
  isStreaming?: boolean;
  duration?: number;
  thinkingTime?: number;
  tokenCount?: number;
  thoughtTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoning?: string;
  steps?: ExecutionStep[];
  fileChanges?: PendingChange[];
  blocks?: Array<
    | { type: "text"; content: string }
    | { type: "thinking"; content: string }
    | { type: "tool_group"; steps: ExecutionStep[] }
    | { type: "file_change"; changes: PendingChange[] }
  >;
}

export interface EditorTab {
  id: string;
  fileId: string;
  name: string;
  language: string;
  isDirty: boolean;
}

export interface CursorPosition {
  line: number;
  column: number;
}

export interface ToastMessage {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title: string;
  description?: string;
  duration?: number;
  onClick?: () => void;
}

export interface PendingChange {
  id: string;
  fileId: string;
  fileName: string;
  filePath: string;
  /** 捕获该更改时所属的项目工作目录（绝对路径）。diff 面板按当前项目过滤；
   *  对话内联 file_change 块（非聚合列表）可以没有该字段。 */
  workDir?: string;
  oldContent: string;
  newContent: string;
  language: string;
  /** Backend-rendered unified diff (from Helix tool.complete inline_diff),
   *  ANSI-stripped. When present, DiffPreview renders it directly instead of
   *  recomputing a diff from old/new content. */
  unifiedDiff?: string;
  /**
   * 不能用这份 diff 反推撤销（网关标的）。两种来源：
   *  1. pi 的 `write` 工具结果不带 diff，网关若拿不到覆盖前的旧内容，只能按
   *     "原文件为空"假想一个 patch —— 覆盖已有文件时它是假的；
   *  2. diff 过长被网关截断（`diff 过长已截断`），残缺 hunks 反推不出原文。
   * 共同点：`reverseUnifiedDiff` 是按行号 splice 的，拿这些 diff 撤销会**静默
   * 破坏文件** → 卡片必须拒绝撤销并说明原因。edit 工具自带真 diff，不受影响。
   */
  undoUnsafe?: boolean;
}

type ApiProvider = string;
type AgentEngine = "helix";

// Helix native reasoning scale (none/minimal/low/medium/high/xhigh/max/ultra).
export type ReasoningEffortLevel =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type ApprovalMode = "default" | "accept_edits" | "dont_ask" | "plan";

// Tool approval choices written back to the backend approval state machine.
export type ApprovalLevel = "once" | "session" | "always" | "deny";

/**
 * /btw 旁路问答的会话记录，按**主线会话 id** 索引。
 *
 * 旁路会话（btw- 前缀）不进左侧对话列表、不落盘；它的整段对话（多轮追问）
 * 由右侧边栏「旁路问答」面板渲染：消息读 chatMessages 里 sessionId ===
 * bylineSessionId 的条目，运行中的流式草稿读 streamingDrafts[bylineSessionId]。
 * 答案文本额外留一份在 answer 里（finalize 时写入），作为面板的兜底。
 */
export interface BylineReply {
  /** 旁路会话的前端 cid（bylineSessionId）。 */
  sessionId: string;
  /** 第一条问题（不含 /btw 前缀）——面板页签/标题用它做标签。 */
  question: string;
  /** 最近一次模型回复（多轮追问时是最新一轮的）；运行中可能为空。 */
  answer: string;
  status: "running" | "done" | "error";
  /** 最近一次回复完成时刻（运行中为发问时刻）。 */
  ts: number;
}

export interface McpServerConfig {
  name?: string;
  type: "local" | "remote";
  command?: string[];
  url?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  cwd?: string;
  timeout?: number;
  headers?: Record<string, string>;
  envPassthrough?: boolean;
}

export interface ApiConfig {
  provider: ApiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  contextWindow?: number;
  /** Wire protocol of the endpoint: openai-completions / openai-responses /
   *  anthropic-messages / google-generative-ai (pi's models.json `api` field). */
  apiFormat?: string;
  engine?: AgentEngine;
}

export interface ApiProfile {
  id: string;
  name: string;
  config: ApiConfig;
  /** All models available under this provider. The first entry is the default. */
  models?: string[];
}

/**
 * Multi-provider config used by the flattened model selector.
 * Mirrors the helix-ui ProviderConfig shape so the selector can read from
 * either the main store or the standalone helix-ui store.
 */
export interface ProviderConfig {
  id: string;
  // Display name
  name: string;
  // Base URL,
  baseUrl: string;
  apiKey: string;
  /** Models offered by this provider, */
  models: string[];
  /** Default model for this provider (falls back to models[0]). */
  defaultModel?: string;
  /** Marks the provider used when nothing is selected. */
  isDefault?: boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  icon?: string;
  isBuiltin?: boolean;
  createdAt: number;
}

export type MemoryCategory =
  | "user"
  | "feedback"
  | "project"
  | "reference"
  | "architecture"
  | "rule"
  | "decision"
  | "pattern"
  | "gotcha";

export interface MemoryEntry {
  id: string;
  content: string;
  category: MemoryCategory;
  createdAt: number;
  /** Origin of a MEMORY.md entry: 'manual' (added via Helix UI) vs 'auto'
   * (appended by Helix self-evolution). Undefined for user-profile entries. */
  source?: "manual" | "auto";
}

export interface AvailableCommand {
  name: string;
  description?: string;
}

export interface TaskNode {
  id: string;
  label: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  children?: TaskNode[];
  parentId: string | null;
  depth: number;
}

export interface SessionCheckpoint {
  id: string;
  label: string;
  timestamp: number;
  taskIds: string[];
  memorySnapshot: string;
  /** Full task-tree snapshot so restoreCheckpoint can rebuild tasks faithfully.
   *  Absent on checkpoints saved by older builds — those fall back to taskIds. */
  tasks?: TaskNode[];
}

export interface ScheduledTask {
  id: string;
  label: string;
  prompt: string;
  scheduleText: string; // e.g. "every day at 9am" or "cron: 0 9 * * *"
  cronExpression?: string; // parsed cron expression
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ToolCallEntry {
  toolName: string;
  params: string;
  status: "running" | "success" | "error";
  timestamp: number;
}

/**
 * A single task item in Helix's in-session todo list (emitted via
 * `session/update` with a todo/plan-style `sessionUpdate` name, or via the
 * `todo_write` tool result). `status` mirrors Helix's own states.
 */
export interface HelixTodo {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  activeForm?: string;
}

/**
 * 一条结构化计划步骤（来自 plan.md 的列表项，解析见 src/lib/plan-parse.ts）。
 * 比 HelixTodo 语义更窄：只有三态、无 id/activeForm——它描述的是“计划里写
 * 了什么步骤 + 当前做到哪一步”，供工作面板「执行计划」区块渲染。
 */
export interface PlanStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface SubAgent {
  id: string;
  name: string;
  description: string;
  status: "running" | "completed" | "failed" | "cancelled";
  parentId: string | null;
  chatMessageId: string | null;
  createdAt: number;
  /** 归属的前端会话 id（spawn 时快照）：工作面板/子 Agent 面板按当前会话过滤，
   *  防止并行会话的子代理互相串台。 */
  sessionId?: string;
  /** pi-subagents 扩展自己的子代理 id（后台启动确认 details.agentId 带回）。
   *  .output 转录文件以它命名 —— 侧边栏时间线靠它定位，重启后依然有效。 */
  agentId?: string;
  completedAt?: number;
  result?: string;
  filesModified?: string[];
  toolCalls?: ToolCallEntry[];
  /** 完整 prompt 文本（比 description 更详细）。由后端 subagent.start 事件的 text 字段写入。 */
  text?: string;
}

// Used as the `customShortcuts` value shape across the app.
export interface CustomShortcutEntry {
  keys: string[];
  action: string;
  description: string;
}

export const DEFAULT_SHORTCUTS: Record<string, CustomShortcutEntry> = {
  "archive-chat": {
    keys: ["Ctrl", "Shift", "A"],
    action: "archive-chat",
    description: "归档聊天",
  },
  "new-chat": {
    keys: ["Ctrl", "N"],
    action: "new-chat",
    description: "新对话",
  },
  "quick-chat": {
    keys: ["Ctrl", "Alt", "N"],
    action: "quick-chat",
    description: "新建快速对话",
  },
  "search-chat": {
    keys: ["Ctrl", "F"],
    action: "search-chat",
    description: "搜索对话内容",
  },
  "go-back": { keys: ["Ctrl", "["], action: "go-back", description: "返回" },
  "go-forward": {
    keys: ["Ctrl", "]"],
    action: "go-forward",
    description: "前进",
  },
  "next-recent-chat": {
    keys: ["Ctrl", "Tab"],
    action: "next-recent-chat",
    description: "下一个最近查看的聊天",
  },
  "prev-recent-chat": {
    keys: ["Ctrl", "Shift", "Tab"],
    action: "prev-recent-chat",
    description: "上一个最近查看的聊天",
  },
  "prev-chat": {
    keys: ["Ctrl", "Shift", "["],
    action: "prev-chat",
    description: "上一个聊天",
  },
  "open-review": {
    keys: ["Ctrl", "Shift", "G"],
    action: "open-review",
    description: "打开审查选项卡",
  },
  "toggle-sidebar": {
    keys: ["Ctrl", "B"],
    action: "toggle-sidebar",
    description: "切换边栏",
  },
  "toggle-sidebar-full": {
    keys: ["Ctrl", "L"],
    action: "toggle-sidebar-full",
    description: "完全显示/隐藏边栏",
  },
  "toggle-terminal": {
    keys: ["Ctrl", "J"],
    action: "toggle-terminal",
    description: "打开终端",
  },
  "force-reload": {
    keys: ["Ctrl", "Shift", "R"],
    action: "force-reload",
    description: "刷新界面",
  },

  "new-window": {
    keys: ["Ctrl", "Shift", "N"],
    action: "new-window",
    description: "新建窗口",
  },
  "rename-chat": {
    keys: ["Ctrl", "Alt", "R"],
    action: "rename-chat",
    description: "重命名聊天",
  },
  "search-chats": {
    keys: ["Ctrl", "G"],
    action: "search-chats",
    description: "搜索聊天",
  },
  "show-shortcuts": {
    keys: ["Ctrl", "Shift", "/"],
    action: "show-shortcuts",
    description: "显示键盘快捷键",
  },
  settings: { keys: ["Ctrl", ","], action: "settings", description: "设置" },
  "approve-request": {
    keys: ["Enter"],
    action: "approve-request",
    description: "批准请求",
  },
  "decline-request": {
    keys: ["Escape"],
    action: "decline-request",
    description: "拒绝请求",
  },
  "model-picker": {
    keys: ["Ctrl", "Shift", "M"],
    action: "model-picker",
    description: "打开模型选择器",
  },
  "toggle-file-tree": {
    keys: ["Ctrl", "Shift", "E"],
    action: "toggle-file-tree",
    description: "切换文件树",
  },
};

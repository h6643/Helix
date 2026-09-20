import { create } from "zustand";

// 未选择项目目录时的默认工作目录：~/.pi/agent/sessions（pi agent 的会话目录）。
// 由后端 Tauri 命令 get_sessions_dir 返回（~/.pi/agent/sessions）。
async function getDefaultSessionsDir(): Promise<string> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const r: { sessionsDir?: string } = await invoke("get_sessions_dir");
    return r?.sessionsDir ?? "";
  } catch {
    return "";
  }
}
import type {
  FileNode,
  ImageAttachment,
  FileAttachment,
  LinkAttachment,
  ExecutionStep,
  StreamingResponseBlock,
  StreamingDraft,
  ConnectionNotice,
  ChatMessage,
  EditorTab,
  CursorPosition,
  PendingChange,
  ApiConfig,
  ApiProfile,
  MemoryCategory,
  MemoryEntry,
  TaskNode,
  SessionCheckpoint,
  ScheduledTask,
  SubAgent,
  ProviderConfig,
  McpServerConfig,
  ApprovalMode,
  BylineReply,
  HelixTodo,
  PlanStep,
} from "./helix-types";
import { DEFAULT_SHORTCUTS } from "./helix-types";
import { helixApi } from "@/lib/electron-bridge";
import { normalizeAcpContent } from "@/lib/text-utils";

/** A server / virtual machine the user can connect to from the breadcrumb. */
export interface ExternalService {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string;
  /** 'password' | 'key' — how the secret authenticates. */
  authType?: "password" | "key";
  /** Secret (password or private key). Stored encrypted when safeStorage is available. */
  secret?: string;
  secretEncrypted?: boolean;
  connected: boolean;
  createdAt: number;
}

/** Per-model usage within a single day. */
interface DailyModelUsage {
  totalTokens: number;
  requestCount: number;
}

/** Per-day token/cost usage, keyed by local date string `YYYY-MM-DD`. */
export interface DailyUsageEntry {
  totalTokens: number;
  requestCount: number;
  models: Record<string, DailyModelUsage>;
}

function dayKeyOf(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
import {
  createAgentSettingsSlice,
  type AgentSettingsSlice,
} from "./slices/agent-settings-slice";
import {
  createApiConfigSlice,
  type ApiConfigSlice,
} from "./slices/api-config-slice";
import {
  createCompactNoticeSlice,
  type CompactNoticeSlice,
} from "./slices/compact-notice-slice";
import {
  createCompressionRecordsSlice,
  type CompressionRecordsSlice,
} from "./slices/compression-records-slice";
import { createEditorSlice, type EditorSlice } from "./slices/editor-slice";
import { createGitSlice, type GitSlice } from "./slices/git-slice";
import { createPanelSlice, type PanelSlice } from "./slices/panel-slice";
import { createSkillSlice, type SkillSlice } from "./slices/skill-slice";
import {
  createTerminalSlice,
  type TerminalSlice,
} from "./slices/terminal-slice";
import { createToastSlice, type ToastSlice } from "./slices/toast-slice";
import {
  isElectron,
  getElectronAPI,
  electronFS,
  electronApp,
} from "@/lib/electron-bridge";
import { generateId, truncateString } from "@/lib/format";
import { debug, warn, error as logError } from "@/lib/logger";
import type { PersistedChatMessage } from "@/lib/persist";
import { defaultFiles } from "@/lib/seed-data";
import { applyHelixPalette } from "@/lib/themes";
import { cleanUrl } from "@/lib/url-utils";
import { useGatewayStore } from "@/stores/gateway-store";

export type {
  FileNode,
  ImageAttachment,
  FileAttachment,
  LinkAttachment,
  ExecutionStep,
  ChatMessage,
  StreamingResponseBlock,
  ApiConfig,
  ApiProfile,
  TaskNode,
  ScheduledTask,
  ProviderConfig,
  HelixTodo,
  PlanStep,
};
export { DEFAULT_SHORTCUTS };

interface HelixState
  extends
    GitSlice,
    ToastSlice,
    CompactNoticeSlice,
    CompressionRecordsSlice,
    TerminalSlice,
    EditorSlice,
    AgentSettingsSlice,
    PanelSlice,
    ApiConfigSlice,
    SkillSlice {
  // File system
  files: FileNode[];
  selectedFileId: string | null;
  expandedFolders: Set<string>;

  // Sub-agents
  subAgents: SubAgent[];

  // Editor
  openTabs: EditorTab[];
  activeTabId: string | null;
  cursorPosition: CursorPosition;

  // API Configuration — see slices/api-config-slice.ts

  // Chat
  chatMessages: ChatMessage[];
  isChatLoading: boolean;

  // Skills
  // Skills — see slices/skill-slice.ts

  // Terminal — see slices/terminal-slice.ts

  // Goal
  goal: string | null;

  // Memory
  memories: MemoryEntry[];
  userMemories: MemoryEntry[];
  notes: string;
  checkpoints: SessionCheckpoint[];

  // Tasks
  tasks: TaskNode[];

  // Scheduled Tasks
  scheduledTasks: ScheduledTask[];
  showScheduledTasksPanel: boolean;

  showRuntimePanel: boolean;
  showActivityFeed: boolean;
  toggleActivityFeed: () => void;
  showArtifactsBrowser: boolean;
  toggleArtifactsBrowser: () => void;

  // Preview Rail
  showPreviewRail: boolean;
  previewRailUrl: string | null;
  // Monotonic counter bumped on every setPreviewRailUrl call. The right sidebar
  // keys its link-navigation effect off this, so RE-clicking the same link (whose
  // `previewRailUrl` value is unchanged) still navigates instead of leaving a
  // freshly-created blank browser page.
  previewRailNavSeq: number;
  // 最近一次 setPreviewRailUrl 是否为「安静」触发（agent / 后台 browser 工具）。
  // 供 right-sidebar 的 navSeq effect 判断：quiet 且当前**没有任何**浏览器页时
  // 不新建页签——否则用户正看着「更改」/「代码」，tab 条上会莫名多出一个网页
  // 标签（agent 后台 navigate → 静默建页 → 下次打开侧边栏才看见）。此时只记
  // URL，等用户在 toast 上点「查看」（forceOpen → quiet=false）再真正建页。
  lastPreviewRailQuiet: boolean;
  // `forceOpen`（默认 true）控制是否**抢焦点**：拉出侧边栏 + 切到浏览器页签 +
  // 关编辑器。用户自己点链接 → true；pi agent 的 browser 工具 navigate → false，
  // 只记 URL，不把你从 diff / code 上拽走。
  // `quiet`（默认 false）标记 agent / 后台触发，见 lastPreviewRailQuiet。
  setPreviewRailUrl: (
    url: string | null,
    forceOpen?: boolean,
    quiet?: boolean,
  ) => void;
  togglePreviewRail: () => void;

  // Monotonic counter bumped on every "新建浏览器页" request (the "更多操作 /
  // ＋ → 浏览器" menu). The right sidebar keys its add-page effect off this so
  // every click opens a NEW browser tab instead of reusing the existing one.
  browserAddSeq: number;
  requestAddBrowserPage: () => void;

  // Browser settings
  browserHomeUrl: string;
  setBrowserHomeUrl: (url: string) => void;

  // Unified right sidebar (hosts the browser + code editor as switchable tabs)
  rightSidebarTab: "browser" | "code" | "diff" | "agent" | "byline" | null;
  setRightSidebarTab: (
    tab: "browser" | "code" | "diff" | "agent" | "byline" | null,
  ) => void;
  // 右侧栏的「子 Agent 工作内容」视图：点击工作面板里的某个 agent 时写入，
  // RightSidebar 据此渲染该 agent 的任务 / live 日志。null = 未选中。
  activeAgentView: { id: string; name: string } | null;
  openAgentView: (agent: { id: string; name: string }) => void;
  // Left sidebar: which project's file tree is expanded (null = none). Triggered
  // by the per-project "目录" button; opening a file from it opens the right
  // sidebar code editor.
  directoryProjectDir: string | null;
  toggleDirectoryProject: (dir: string) => void;
  // Code "fullscreen": the right sidebar expands to fill the MAIN area (the
  // conversation card is hidden) while the LEFT sidebar (projects / directory
  // tree) stays visible. Driven by the maximize button in the right sidebar.
  codeFullscreen: boolean;
  toggleCodeFullscreen: () => void;
  approvalMode: ApprovalMode;
  approvalModeBySession: Record<string, ApprovalMode>;
  setApprovalMode: (v: ApprovalMode) => void;
  // 仅写单条会话的覆盖值（不动全局默认）：旁路面板的审批模式下拉用，
  // 只影响那条旁路会话；主线 setApprovalMode 保持「全局 + 当前对话」语义。
  setApprovalModeForSession: (sessionId: string, mode: ApprovalMode) => void;
  // 按会话的模型覆盖：cid → { provider, model }（pi 侧身份）。旁路面板的
  // 模型下拉写这里；handleRun 每轮经 set_model 透传到该会话的 pi 实例，
  // 不写全局 config.yaml（全局默认仍由设置页/主线模型切换管理）。
  modelBySession: Record<string, { provider: string; model: string }>;
  setModelForSession: (
    sessionId: string,
    model: { provider: string; model: string },
  ) => void;
  // 旁路问答（/btw）：主线会话 id → 它当前开放着的一条旁路会话（右侧边栏
  // 「旁路问答」面板据此渲染整段对话流，可在面板输入框里多轮追问）。
  bylineReplies: Record<string, BylineReply>;
  setBylineReply: (mainSessionId: string, reply: BylineReply) => void;
  // 旁路追问信号：右侧「旁路问答」面板输入框提交时递增。AgentFlowPanel 监听
  // 本信号，把 bylineAskQuestion 丢进当前主线的旁路会话（无开放会话则新建）。
  bylineAskSignal: number;
  bylineAskQuestion: string;
  /** 追问目标主线会话（面板提交瞬间的 currentSessionId；可能已切走，用记录值）。 */
  bylineAskMainCid: string | null;
  bylineAsk: (question: string, mainCid?: string | null) => void;
  /** 让右侧「旁路问答」面板聚焦输入框（裸 /btw 打开面板后用）。 */
  bylineFocusSignal: number;
  focusBylineInput: () => void;
  // 旁路停止信号：面板的停止按钮递增。AgentFlowPanel 监听后对当前主线名下
  // 开放的旁路会话调用 handleStop——Enter 只发送，停止只能走这个显式按钮。
  bylineStopSignal: number;
  stopByline: () => void;
  // 每个会话是否有待用户确认（审批/反问/定时任务），侧边栏据此显示标记
  sessionPendingApproval: Record<string, boolean>;
  setSessionPendingApproval: (patch: Record<string, boolean>) => void;
  startupGreeting: string;
  setStartupGreeting: (v: string) => void;

  // MCP Servers
  mcpServers: Record<string, McpServerConfig>;

  // External services (servers / virtual machines) connected from the breadcrumb.
  externalServices: ExternalService[];

  // SSH live-session state: whether a real ssh2 session is currently established,
  // and which external service it belongs to.
  sshConnected: boolean;
  sshServiceId: string | null;
  setSshConnected: (connected: boolean, serviceId?: string | null) => void;

  // Custom Shortcuts
  customShortcuts: Record<
    string,
    { keys: string[]; action: string; description: string }
  >;
  customizedShortcutIds: Set<string>;

  // Customize
  // showCustomizePanel — see slices/panel-slice.ts

  // Agent Execution
  isAgentRunning: boolean;
  hasOnboarded: boolean;
  setHasOnboarded: (v: boolean) => void;
  gatewayStatus: "connecting" | "ready" | "disconnected";
  setGatewayStatus: (v: "connecting" | "ready" | "disconnected") => void;
  setIsAgentRunning: (v: boolean) => void;
  streamingDrafts: Record<string, StreamingDraft>;
  injectInputSignal: { text: string; nonce: number; append?: boolean } | null;
  injectInput: (text: string) => void;
  /** 追加注入：把 text 追加到当前输入框内容之后（用于连续选取网页元素累积） */
  injectInputAppend: (text: string) => void;
  requestSendSignal: number;
  requestSend: () => void;
  injectAndSend: (text: string) => void;
  tabInputs: Record<string, string>;
  tabAttachments: Record<
    string,
    {
      images: ImageAttachment[];
      files: FileAttachment[];
      links: LinkAttachment[];
    }
  >;
  pendingUpdate: string | null;
  setPendingUpdate: (version: string | null) => void;
  setTabInput: (sessionId: string, text: string) => void;
  clearTabInput: (sessionId: string) => void;
  setTabAttachments: (
    sessionId: string,
    images: ImageAttachment[],
    files: FileAttachment[],
    links?: LinkAttachment[],
  ) => void;
  addLinkAttachment: (link: LinkAttachment) => void;
  removeLinkAttachment: (id: string) => void;
  clearTabAttachments: (sessionId: string) => void;
  setStreamingDraft: (
    sessionId: string,
    draft: Partial<StreamingDraft>,
  ) => void;
  clearStreamingDraft: (sessionId: string) => void;
  connectionNotice: ConnectionNotice | null;
  setConnectionNotice: (notice: ConnectionNotice | null) => void;
  agentExecutionSteps: Array<{
    type: string;
    toolName?: string;
    path?: string;
    content?: string;
    toolParams?: Record<string, unknown>;
    timestamp: number;
  }>;
  accessedDirectories: string[];
  selectedFiles: string[];
  selectedWorkDir: string | null;
  setSelectedWorkDir: (dir: string | null) => void;
  workDirEpoch: number;
  setWorkDir: (relativePath: string) => Promise<void>;
  sessionSaveVersion: number;
  currentSessionId: string | null;
  /** 重启后没有可恢复的会话时为 true：界面停在「无会话」占位，不显示可输入的
   *  空草稿——首次发消息不会再悄悄建后端会话文件；必须显式点「新对话」或选会话。 */
  noActiveConversation: boolean;
  setNoActiveConversation: (v: boolean) => void;
  activeSessionWorkDir: string | null;
  setCurrentSessionId: (id: string | null) => void;
  /**
   * 已标记失效的会话。只有 Resume 返回 SESSION_NOT_FOUND 才能写入这里
   * （判定统一走 session-resume 的 isSessionGone）——restore 失败/内部错误
   * 是可重试故障，写进这里等于把一次抖动永久化成失效会话。
   */
  brokenSessionIds: string[];
  /** 每个失效会话的原因（错误文本），供 UI 与下次发消息时的短路提示用。 */
  brokenSessionReasons: Record<string, string>;
  markSessionBroken: (cid: string, reason?: string) => void;
  clearSessionBroken: (cid: string) => void;
  sessionHistory: string[];
  sessionHistoryIndex: number;
  /** direction 步进 sessionHistory；给 targetId 时直接跳到该会话在栈中的
   *  位置（导航栈含设置页条目，与 sessionHistory 步进方向可能不同步，
   *  前进/后退必须以目标会话为准而不是方向）。 */
  navigateSession: (
    direction: "back" | "forward",
    targetId?: string,
  ) => Promise<void>;
  addExecutionStep: (step: {
    type: string;
    toolName?: string;
    toolKind?: string;
    path?: string;
    content?: string;
    toolParams?: Record<string, unknown>;
  }) => void;
  addAccessedDirectory: (dir: string) => void;
  addSelectedFile: (filePath: string) => void;
  removeSelectedFile: (filePath: string) => void;
  clearSelectedFiles: () => void;
  clearExecutionFlow: () => void;
  modelUsage: Record<
    string,
    { prompt: number; completion: number; total: number; cost: number }
  >;
  addModelUsage: (
    model: string,
    usage: { prompt: number; completion: number; total: number; cost: number },
  ) => void;
  contextUsage: Record<
    string,
    {
      size: number;
      used: number;
      categories?: Array<{
        id: string;
        label: string;
        tokens: number;
        color: string;
        /** 后端在会话文件未落盘时给的"整块占用"兜底项（不可按内容拆分） */
        aggregate?: boolean;
      }>;
      toolsets?: Array<{
        toolset: string;
        tool_count: number;
        schema_tokens: number;
      }>;
    }
  >;
  setContextUsage: (
    sessionId: string,
    size: number,
    used: number,
    categories?: Array<{
      id: string;
      label: string;
      tokens: number;
      color: string;
      aggregate?: boolean;
    }>,
    toolsets?: Array<{
      toolset: string;
      tool_count: number;
      schema_tokens: number;
    }>,
    /** 权威快照：完整后端查询 / 压缩完成回报，直接覆盖 size/used，允许 used 下降。
     *  默认的 max 合并只适用于工具循环内流式的 provider totalTokens——它在
     *  cache miss / in-turn compaction 时不单调，覆盖会把环来回跳。压缩是一个
     *  已知的确定性下降事件，不能被 max 拦住，否则环永远停在压缩前的高位。 */
    authoritative?: boolean,
  ) => void;
  // Estimated tokens for in-flight requests (shows ~Xk while waiting for API response)
  estimatedTokens: Record<string, number>;
  setEstimatedTokens: (sessionId: string, tokens: number) => void;
  clearEstimatedTokens: (sessionId: string) => void;
  sessionUsageStats: {
    requestCount: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    thoughtTokens: number;
    cachedReadTokens: number;
    cachedWriteTokens: number;
  };
  dailyUsage: Record<string, DailyUsageEntry>;
  addSessionUsageStats: (
    model: string,
    usage: {
      totalTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      thoughtTokens?: number;
      cachedReadTokens?: number;
      cachedWriteTokens?: number;
    },
  ) => void;
  notifySessionSaved: () => void;
  flushSessionPersist: () => void;
  /** Persist a specific session's messages (works for background sessions). */
  persistSessionNow: (sessionId: string) => Promise<void>;

  // UI
  editorTheme: "vs-dark" | "light";
  fontFamily: string;
  fontSize: number;
  interfaceFont: string;
  transcriptFontSize: number;
  // Theme style: 'default' (built-in cream) or a Catppuccin flavor id.
  themeStyle: string;
  // Boot overlay background image (Base64 encoded or null for default)
  bootBackgroundImage: string | null;
  // Whether the custom background image also shows on the main workspace
  // (vs. the boot screen only). Defaults true so the image persists across
  // the whole app surface, not just the splash.
  showGlobalBackground: boolean;
  setGlobalBackgroundEnabled: (enabled: boolean) => void;
  // Toast — see slices/toast-slice.ts
  pendingChanges: PendingChange[];
  // Panel toggles — see slices/panel-slice.ts

  // Agent Settings — see slices/agent-settings-slice.ts

  // Actions - Agent Settings
  // (declared in slices/agent-settings-slice.ts)

  // Actions - Files
  setFiles: (files: FileNode[]) => void;
  syncFilesFromDisk: () => Promise<void>;
  selectFile: (fileId: string) => void;
  toggleFolder: (folderId: string) => void;
  createFile: (
    parentId: string | null,
    name: string,
    type: "file" | "folder",
  ) => void;
  deleteFile: (fileId: string) => void;
  updateFileContent: (fileId: string, content: string) => void;
  getFileById: (fileId: string) => FileNode | null;
  renameFile: (fileId: string, newName: string) => Promise<boolean>;

  // Actions - Tabs
  openFile: (fileId: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;

  // Actions - Skills — see slices/skill-slice.ts

  // Actions - Chat
  addChatMessage: (message: Omit<ChatMessage, "id" | "timestamp">) => string;
  updateChatMessage: (messageId: string, content: string) => void;
  setChatMessageStreaming: (messageId: string, isStreaming: boolean) => void;
  setChatMessageRowId: (messageId: string, rowId: number) => void;
  deleteMessage: (messageId: string) => void;
  clearChat: () => void;
  clearChatInPlace: () => Promise<void>;
  clearChatAndPersist: () => Promise<void>;
  setChatLoading: (loading: boolean) => void;
  /**
   * 从某条消息处分叉出新会话（新会话带该消息及之前的全部历史）。
   * `labelPrefix` 覆盖默认的"分支"前缀（例如 /btw 用"旁路"）。
   */
  /** 从某条消息分叉：复制到该条为止的会话消息到**新对话**（纯本地，不涉及
   *  后端 session fork / 分支链）。labelPrefix 用于旁路（/btw）等场景。 */
  forkConversation: (
    messageId: string,
    opts?: { labelPrefix?: string },
  ) => Promise<string | null>;

  // Actions - Editor
  setCursorPosition: (pos: CursorPosition) => void;
  markTabSaved: (tabId: string) => void;

  // Terminal actions — see slices/terminal-slice.ts

  // Actions - UI
  // Panel toggles — see slices/panel-slice.ts
  setEditorTheme: (theme: "vs-dark" | "light") => void;
  setFontFamily: (font: string) => void;
  setFontSize: (size: number) => void;
  setInterfaceFont: (font: string) => void;
  setTranscriptFontSize: (size: number) => void;
  setThemeStyle: (styleId: string) => void;
  setBootBackgroundImage: (image: string | null) => void;
  // Toast actions — see slices/toast-slice.ts

  // Actions - File modifications
  applyFileChange: (fileId: string, newContent: string) => void;
  createOrUpdateFile: (filePath: string, content: string) => void;
  addPendingChange: (
    change: Omit<PendingChange, "id" | "workDir"> & { workDir?: string },
  ) => string;
  applyPendingChange: (changeId: string) => void;
  rejectPendingChange: (changeId: string) => void;
  applyAllPendingChanges: () => void;
  rejectAllPendingChanges: () => void;
  /** Acknowledge (not re-apply) all pending changes of the given work dir —
   * used after a git commit so committed files leave the "更改" list. */
  ackPendingChangesForWorkDir: (workDir: string | null | undefined) => void;

  // Actions - Goal
  setGoal: (goal: string | null) => void;

  // Actions - Memory
  addMemory: (entry: Omit<MemoryEntry, "id" | "createdAt">) => Promise<void>;
  removeMemory: (id: string) => Promise<void>;
  loadMemories: () => Promise<void>;
  // User profile (Helix USER.md) — separate from the agent's MEMORY.md.
  addUserMemory: (
    entry: Omit<MemoryEntry, "id" | "createdAt">,
  ) => Promise<void>;
  removeUserMemory: (id: string) => Promise<void>;
  loadUserMemories: () => Promise<void>;
  updateNotes: (notes: string) => void;
  saveCheckpoint: (label?: string) => void;
  restoreCheckpoint: (id: string) => void;
  removeCheckpoint: (id: string) => void;

  // Actions - Tasks
  addTask: (label: string, parentId?: string) => string;
  updateTask: (
    taskId: string,
    updates: Partial<Pick<TaskNode, "label" | "status">>,
  ) => void;
  removeTask: (taskId: string) => void;
  clearCompletedTasks: () => void;

  // Actions - Scheduled Tasks
  addScheduledTask: (
    task: Omit<ScheduledTask, "id" | "createdAt" | "updatedAt"> & {
      id?: string;
    },
  ) => string;
  updateScheduledTask: (
    taskId: string,
    updates: Partial<Omit<ScheduledTask, "id" | "createdAt">>,
  ) => void;
  removeScheduledTask: (taskId: string) => void;
  toggleScheduledTask: (taskId: string) => void;
  toggleScheduledTasksPanel: () => void;

  toggleRuntimePanel: () => void;

  // Actions - MCP Servers
  addMcpServer: (name: string, config: McpServerConfig) => void;
  removeMcpServer: (name: string) => void;
  updateMcpServer: (name: string, config: McpServerConfig) => void;
  toggleMcpServer: (name: string) => void;

  // Actions - External Services (server / VM)
  addExternalService: (
    svc: Omit<ExternalService, "id" | "createdAt" | "connected">,
  ) => Promise<void>;
  updateExternalService: (
    id: string,
    patch: Partial<ExternalService>,
  ) => Promise<void>;
  removeExternalService: (id: string) => void;
  setExternalServiceConnected: (id: string, connected: boolean) => void;

  // Actions - Artifacts
  // (removed — unused)

  // Actions - Custom Shortcuts
  addCustomShortcut: (
    id: string,
    shortcut: { keys: string[]; action: string; description: string },
  ) => void;
  removeCustomShortcut: (id: string) => void;
  updateCustomShortcut: (
    id: string,
    shortcut: { keys: string[]; action: string; description: string },
  ) => void;

  // Actions - Panels
  // Panel toggles — see slices/panel-slice.ts

  // API Config — see slices/api-config-slice.ts

  // Actions - Sub-agents
  spawnSubAgent: (
    name: string,
    description: string,
    parentId?: string,
    agentId?: string,
    sessionId?: string,
    text?: string,
  ) => string;
  completeSubAgent: (
    agentId: string,
    result?: string,
    filesModified?: string[],
  ) => void;
  failSubAgent: (agentId: string, error?: string) => void;
  cancelSubAgent: (agentId: string) => void;
  clearCompletedSubAgents: () => void;
  addSubAgentToolCall: (
    agentId: string,
    toolCall: {
      toolName: string;
      params: string;
      status: "running" | "success" | "error";
    },
  ) => void;
  updateSubAgentToolCallStatus: (
    agentId: string,
    toolName: string,
    status: "success" | "error",
  ) => void;
  /** 把扩展的子代理 id（.output 转录文件名）绑到卡片上 —— 后台启动确认
   *  （subagent.tool background 事件）带回，供侧边栏时间线定位转录。 */
  setSubAgentAgentId: (agentId: string, extAgentId: string) => void;
  /** 磁盘重建的终态卡片在同一 id 的 subagent.start 到达时翻回 running
   *  （后端确认该孩子真在跑——重启后同工具调用 id 复用）。 */
  reviveSubAgentForRun: (agentId: string, description?: string) => void;
  /** 重启后从磁盘 delegation manifest 重建子 Agent 卡片（按 id 去重，磁盘
   *  running 的孩子已随进程死亡 → 标记中断）。事件驱动的实时卡片优先。 */
  rehydrateSubAgentsFromDisk: (
    sessionId: string | null,
    diskAgents: Array<{
      id: string;
      agentId?: string;
      goal?: string;
      prompt?: string;
      status?: string;
      summary?: string;
    }>,
  ) => void;

  // Git — see slices/git-slice.ts

  // Actions - Persistence
  persistToStorage: () => Promise<void>;
  restoreFromStorage: () => Promise<void>;
  saveCheckpointChat: () => Promise<void>;

  // Helpers
  getAllFiles: () => FileNode[];
  getFilePath: (fileId: string) => string;
  findFileByPath: (path: string) => FileNode | null;
  getMemoryContext: () => string;
  getTaskContext: () => string;
}

function getLanguageFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const langMap: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    cpp: "cpp",
    c: "c",
    cs: "csharp",
    php: "php",
    swift: "swift",
    kt: "kotlin",
    html: "html",
    css: "css",
    scss: "scss",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    sql: "sql",
    sh: "shell",
    dockerfile: "dockerfile",
    xml: "xml",
    svg: "xml",
  };
  if (name.toLowerCase() === "dockerfile") return "dockerfile";
  if (name.toLowerCase() === "makefile") return "makefile";
  return langMap[ext] || "plaintext";
}

function findFileById(nodes: FileNode[], id: string): FileNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findFileById(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

function updateFileInTree(
  nodes: FileNode[],
  fileId: string,
  updater: (node: FileNode) => FileNode,
): FileNode[] {
  return nodes.map((node) => {
    if (node.id === fileId) return updater(node);
    if (node.children) {
      return {
        ...node,
        children: updateFileInTree(node.children, fileId, updater),
      };
    }
    return node;
  });
}

function removeFileFromTree(nodes: FileNode[], fileId: string): FileNode[] {
  return nodes
    .filter((node) => node.id !== fileId)
    .map((node) => {
      if (node.children) {
        return { ...node, children: removeFileFromTree(node.children, fileId) };
      }
      return node;
    });
}

function addFileToTree(
  nodes: FileNode[],
  parentId: string,
  newFile: FileNode,
): FileNode[] {
  return nodes.map((node) => {
    if (node.id === parentId && node.type === "folder") {
      return { ...node, children: [...(node.children || []), newFile] };
    }
    if (node.children) {
      return {
        ...node,
        children: addFileToTree(node.children, parentId, newFile),
      };
    }
    return node;
  });
}

function updateTaskInTree(
  tasks: TaskNode[],
  taskId: string,
  updates: Partial<Pick<TaskNode, "label" | "status">>,
): TaskNode[] {
  return tasks.map((t) => {
    if (t.id === taskId) return { ...t, ...updates };
    if (t.children)
      return { ...t, children: updateTaskInTree(t.children, taskId, updates) };
    return t;
  });
}

function removeTaskFromTree(tasks: TaskNode[], taskId: string): TaskNode[] {
  return tasks
    .filter((t) => t.id !== taskId)
    .map((t) =>
      t.children
        ? { ...t, children: removeTaskFromTree(t.children, taskId) }
        : t,
    );
}

// Debounced chat persistence: saves to IndexedDB after messages change
let sessionPersistTimer: ReturnType<typeof setTimeout> | null = null;

// Resolve a session's workDir at persist time.
//   - Session already on disk: keep its existing workDir, INCLUDING a null one
//     (a project-less conversation must stay project-less). Falling back to
//     selectedWorkDir here would wrongly re-home it: "新对话选了目录但没发消息"
//     leaves selectedWorkDir = that dir, so clicking a project-less conversation
//     next would silently attach it to the picked directory.
//   - Brand-new session (no disk record): home it to the current project.
function resolveSessionWorkDir(
  existing: { workDir?: string | null } | undefined,
  activeSessionWorkDir: string | null,
  selectedWorkDir: string | null,
): string | null {
  if (existing) return existing.workDir ?? null;
  return activeSessionWorkDir ?? selectedWorkDir;
}
function collectFiles(nodes: FileNode[]) {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    content: n.content,
    language: n.language,
    children: n.children ? collectFiles(n.children) : undefined,
  }));
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
    const snapshot = useHelixStore.getState();
    const sessionId = snapshot.currentSessionId;
    const firstUser = snapshot.chatMessages.find((m) => m.role === "user");
    // 标签只取**本会话**的首条 user 消息：chatMessages 是跨会话全局数组，不过滤
    // sessionId 会把别的会话（含仍在后台跑的主线）的首条消息当成本会话的 label——
    // 旁路会话/并发后台会话都会在侧边栏挂上别人的名字（看起来像重复项）。
    const ownFirstUser = snapshot.chatMessages.find(
      (m) => m.role === "user" && (!m.sessionId || m.sessionId === sessionId),
    );
    // Don't persist empty sessions (no user/assistant messages).
    // This prevents auto-creating ghost sessions with timestamp labels when the
    // system clock resumes after sleep/freeze — the debounce timer fires, finds
    // stale messages (e.g. system-role from scheduled tasks), and would otherwise
    // generate a new session ID and write it to disk + setCurrentSessionId.
    const hasRealContent = snapshot.chatMessages.some(
      (m) => m.role === "user" || m.role === "assistant",
    );
    if (!firstUser && !hasRealContent) return;
    // Never auto-create a session when there's no active session context.
    // persistCurrentSessionNow's job is to save the CURRENT session, not invent new ones.
    if (!sessionId) return;
    // 旁路提问（/btw）跑在一次性的后台会话上，它不是要留在左侧边栏的对话：
    // 会话本身不落盘——否则每次 /btw 都会在对话列表里多出一条，正是不要的效果。
    if (sessionId.startsWith("btw-")) return;

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
    const { persistence } = await import("@/lib/persist");

    // Preserve the session's EXISTING workDir when it's already on disk.
    // Double-clicking a sidebar session fires handleLoadSession twice: the
    // second flush can capture a snapshot whose activeSessionWorkDir was
    // already switched to the TARGET session's project, and saving with
    // `activeSessionWorkDir ?? selectedWorkDir` would then RE-STAMP the
    // current session into the wrong project ("对话跑到第一个项目里去").
    // existing?.workDir wins, matching persistSessionById's merge semantics.
    const existing = (await persistence.loadSessions()).find(
      (s) => s.id === sessionId,
    );

    // Label: preserve whatever is already stored — including a user rename
    // (updateSessionLabel). Re-deriving from the first user message on every
    // auto-save would silently clobber a rename the moment the next flush
    // fires (the "对话名称自动改变" bug). Only re-derive when the stored
    // label is still the "新对话" placeholder (empty session before its first
    // message) or absent.
    const savedLabel = existing?.label?.trim() || "";
    const label =
      savedLabel && savedLabel !== "新对话"
        ? savedLabel
        : ownFirstUser
          ? ownFirstUser.content.slice(0, 50)
          : new Date().toLocaleString("zh-CN");

    // Concurrency guard: only persist messages that belong to THIS session
    // (or legacy untagged ones). The in-memory array may also hold messages of
    // OTHER sessions still running in the background — stamping those with the
    // current sessionId would corrupt both conversations.
    const msgsToSave = snapshot.chatMessages
      .filter((m) => !m.sessionId || m.sessionId === sessionId)
      .map((m) => ({
        id: m.id,
        sessionId,
        role: m.role,
        content: m.content,
        images: m.images,
        timestamp: m.timestamp,
        isStreaming: m.isStreaming ?? false,
        reasoning: m.reasoning,
        duration: m.duration,
        thinkingTime: m.thinkingTime,
        totalTokens: m.totalTokens,
        thoughtTokens: m.thoughtTokens,
        outputTokens: m.outputTokens,
        steps: m.steps,
        fileChanges: m.fileChanges,
        blocks: m.blocks,
      }));
    const draft = snapshot.streamingDrafts[sessionId];
    const draftPartialId = "draft-partial-" + sessionId;
    // 会话若曾被持久化并重新加载，chatMessages 里可能已有一条 draft-partial。
    // 再追加同 id 的消息会把相同 id 写进文件 → 重新加载后渲染重复 key。先去掉旧值。
    const existingPartial = msgsToSave.findIndex(
      (m) => m.id === draftPartialId,
    );
    if (existingPartial !== -1) msgsToSave.splice(existingPartial, 1);
    if (draft?.isAgentRunning && draft.textBuffer && draft.textBuffer.trim()) {
      // 并发多会话下，运行中切换会话并不会中断后台 run——该占位只是持久化
      // 快照（崩溃/退出时部分回复不静默丢失），文案须如实说明"仍在生成"，
      // 而非旧串行假设下的"生成中断"。加载端（sidebar / navigateSession）
      // 统一丢弃 draft-partial，避免与最终提交的完整回复重复显示。
      msgsToSave.push({
        id: draftPartialId,
        sessionId,
        role: "assistant",
        content:
          draft.textBuffer + "\n\n*（回复生成中，以下为切换时暂存的部分内容）*",
        images: undefined,
        reasoning: draft.thoughtBuffer || undefined,
        duration: undefined,
        thinkingTime: undefined,
        totalTokens: draft.totalTokens,
        thoughtTokens: undefined,
        outputTokens: undefined,
        timestamp: Date.now(),
        isStreaming: false,
        steps: undefined,
        fileChanges: undefined,
        blocks: undefined,
      });
    }

    await persistence.saveSession({
      id: sessionId,
      label,
      workDir: resolveSessionWorkDir(
        existing,
        snapshot.activeSessionWorkDir,
        snapshot.selectedWorkDir,
      ),
      goal: snapshot.goal,
      memories: snapshot.memories,
      tasks: snapshot.tasks,
      notes: snapshot.notes,
      checkpoints: snapshot.checkpoints,
      chatMessages: msgsToSave,
      files: collectFiles(snapshot.files),
      openTabs: snapshot.openTabs.map((tab) => ({
        id: tab.id,
        fileId: tab.fileId,
        name: tab.name,
        language: tab.language,
        isDirty: tab.isDirty,
      })),
    });
    // Pin the session id so subsequent saves land on the same session, and
    // refresh the sidebar list so the conversation shows up immediately. Only
    // pin back when the conversation wasn't explicitly cleared/switched during
    // the save — otherwise a fire-and-forget flush from "new conversation"
    // would resurrect the just-abandoned session in the UI.
    const live = useHelixStore.getState();
    if (!live.currentSessionId && live.chatMessages.length > 0) {
      useHelixStore.getState().setCurrentSessionId(sessionId);
    }
    useHelixStore.setState((st) => ({
      sessionSaveVersion: st.sessionSaveVersion + 1,
    }));
  } catch (e) {
    logError("Failed to persist session:", e);
    // Avoid toast-spam: only surface once per failure burst via getState.
    useHelixStore.getState().showToast({
      type: "error",
      title: "会话保存失败",
      description: "当前对话未能写入本地，切换或关闭可能丢失",
    });
  }
}

function scheduleSessionPersist() {
  if (sessionPersistTimer) clearTimeout(sessionPersistTimer);
  sessionPersistTimer = setTimeout(() => {
    sessionPersistTimer = null;
    void persistCurrentSessionNow();
  }, 200);
}

// Synchronously flush any pending session save (used before switching conversations
// so unsaved messages in the current chat are not lost when state is swapped).
function flushSessionPersist(): Promise<void> {
  if (sessionPersistTimer) {
    clearTimeout(sessionPersistTimer);
    sessionPersistTimer = null;
  }
  return persistCurrentSessionNow();
}

// Persist a SPECIFIC session's messages, even when it is not the currently
// viewed one. Needed for concurrent multi-session runs: a background run that
// finishes must save its committed reply into ITS OWN session record —
// persistCurrentSessionNow only covers the foreground session.
async function persistSessionById(sessionId: string): Promise<void> {
  try {
    const state = useHelixStore.getState();
    if (!sessionId) return;
    // 旁路提问的一次性会话不落盘，侧边栏不出现。
    if (sessionId.startsWith("btw-")) return;
    if (state.currentSessionId === sessionId) return persistCurrentSessionNow();
    const msgs = state.chatMessages.filter((m) => m.sessionId === sessionId);
    if (msgs.length === 0) return;
    const { persistence } = await import("@/lib/persist");
    const all = await persistence.loadSessions();
    const existing = all.find((s) => s.id === sessionId);
    // Merge by message id: keep everything already on disk, overlay in-memory.
    const byId = new Map<string, PersistedChatMessage>();
    for (const m of existing?.chatMessages || []) byId.set(m.id, m);
    for (const m of msgs) {
      byId.set(m.id, {
        id: m.id,
        sessionId,
        role: m.role,
        content: m.content,
        images: m.images,
        timestamp: m.timestamp,
        isStreaming: false,
        reasoning: m.reasoning,
        duration: m.duration,
        thinkingTime: m.thinkingTime,
        totalTokens: m.totalTokens,
        thoughtTokens: m.thoughtTokens,
        outputTokens: m.outputTokens,
        steps: m.steps,
        fileChanges: m.fileChanges,
        blocks: m.blocks,
      });
    }
    const merged = [...byId.values()].sort(
      (a, b) => (a.timestamp || 0) - (b.timestamp || 0),
    );
    const firstUser = merged.find((m) => m.role === "user");
    await persistence.saveSession({
      id: sessionId,
      label: (() => {
        const stored = existing?.label?.trim() || "";
        // 与 persistCurrentSessionNow 同一规则：保留已存 label（含用户改名），
        // 仅在还是「新对话」占位名时重新派生。
        return stored && stored !== "新对话"
          ? stored
          : firstUser
            ? String(firstUser.content).slice(0, 50)
            : new Date().toLocaleString("zh-CN");
      })(),
      workDir: resolveSessionWorkDir(
        existing,
        state.activeSessionWorkDir,
        state.selectedWorkDir,
      ),
      goal: existing?.goal ?? null,
      memories: existing?.memories || [],
      tasks: existing?.tasks || [],
      notes: existing?.notes || "",
      checkpoints: existing?.checkpoints || [],
      chatMessages: merged,
      files: existing?.files || [],
      openTabs: existing?.openTabs || [],
    });
    useHelixStore.setState((st) => ({
      sessionSaveVersion: st.sessionSaveVersion + 1,
    }));
  } catch (e) {
    logError("Failed to persist background session:", e);
  }
}

export const useHelixStore = create<HelixState>()((set, get, store) => ({
  ...createGitSlice(set, get, store),
  ...createToastSlice(set, get, store),
  ...createCompactNoticeSlice(set, get, store),
  ...createCompressionRecordsSlice(set, get, store),
  ...createTerminalSlice(set, get, store),
  ...createEditorSlice(set, get, store),
  ...createAgentSettingsSlice(set, get, store),
  ...createPanelSlice(set, get, store),
  ...createApiConfigSlice(set, get, store),
  ...createSkillSlice(set, get, store),
  // File system
  files: defaultFiles,
  selectedFileId: "file-app",
  expandedFolders: new Set(["root-src", "folder-components"]),

  // Editor
  openTabs: [
    {
      id: "tab-app",
      fileId: "file-app",
      name: "App.tsx",
      language: "typescript",
      isDirty: false,
    },
  ],
  activeTabId: "tab-app",
  cursorPosition: { line: 1, column: 1 },

  // Chat
  chatMessages: [],
  isChatLoading: false,

  // Skills — in slices/skill-slice.ts

  // Terminal — in slices/terminal-slice.ts

  // UI
  // Panel state — in slices/panel-slice.ts
  editorTheme: "light" as const,
  fontFamily: "'Geist Mono', 'Fira Code', 'Consolas', monospace" as const,
  fontSize: 14 as const,
  interfaceFont: "var(--font-geist-sans)" as const,
  transcriptFontSize: 16,
  themeStyle:
    typeof window !== "undefined"
      ? window.localStorage.getItem("helix-theme-style") || "default"
      : "default",
  bootBackgroundImage: null,
  showGlobalBackground:
    typeof window !== "undefined"
      ? (localStorage.getItem("helix-global-bg") ?? "true") !== "false"
      : true,
  // Toast — in slices/toast-slice.ts
  pendingChanges: [],
  // Agent Settings — in slices/agent-settings-slice.ts

  // Agent Execution
  isAgentRunning: false,
  setIsAgentRunning: (v) => set({ isAgentRunning: v }),
  injectInputSignal: null,
  requestSendSignal: 0,
  injectInput: (text) =>
    set({ injectInputSignal: { text, nonce: Date.now() } }),
  injectInputAppend: (text) =>
    set({ injectInputSignal: { text, nonce: Date.now(), append: true } }),
  requestSend: () =>
    set((s) => ({ requestSendSignal: s.requestSendSignal + 1 })),
  injectAndSend: (text: string) =>
    set((s) => ({
      injectInputSignal: { text, nonce: Date.now() },
      requestSendSignal: s.requestSendSignal + 1,
    })),
  hasOnboarded: false,
  setHasOnboarded: (v) => {
    set({ hasOnboarded: v });
    // Persist so the onboarding screen doesn't reappear on every restart.
    // Without this, setHasOnboarded only mutates in-memory state, which resets
    // to the default `false` on the next app launch — "每次重启都弹引导".
    import("@/lib/persist")
      .then(({ persistence }) => {
        persistence.saveSetting("hasOnboarded", v).catch(() => {});
      })
      .catch(() => {});
  },
  gatewayStatus: "connecting",
  setGatewayStatus: (v) => set({ gatewayStatus: v }),
  streamingDrafts: {},
  tabInputs: {} as Record<string, string>,
  pendingUpdate: null as string | null,
  setTabInput: (sessionId: string, text: string) =>
    set((state) => ({
      tabInputs: { ...state.tabInputs, [sessionId]: text },
    })),
  clearTabInput: (sessionId: string) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.tabInputs;
      return { tabInputs: rest };
    }),
  tabAttachments: {} as Record<
    string,
    {
      images: ImageAttachment[];
      files: FileAttachment[];
      links: LinkAttachment[];
    }
  >,
  setTabAttachments: (sessionId, images, files, links) =>
    set((state) => ({
      tabAttachments: {
        ...state.tabAttachments,
        [sessionId]: { images, files, links: links ?? [] },
      },
    })),
  addLinkAttachment: (link) =>
    set((state) => {
      const key = state.currentSessionId ?? "__draft__";
      const cur = state.tabAttachments[key]?.links ?? [];
      // De-dupe by url so re-picking the same link doesn't pile up cards.
      if (cur.some((l) => l.url === link.url)) return {};
      return {
        tabAttachments: {
          ...state.tabAttachments,
          [key]: {
            images: state.tabAttachments[key]?.images ?? [],
            files: state.tabAttachments[key]?.files ?? [],
            links: [...cur, link],
          },
        },
      };
    }),
  removeLinkAttachment: (id) =>
    set((state) => {
      const key = state.currentSessionId ?? "__draft__";
      const cur = state.tabAttachments[key]?.links ?? [];
      return {
        tabAttachments: {
          ...state.tabAttachments,
          [key]: {
            images: state.tabAttachments[key]?.images ?? [],
            files: state.tabAttachments[key]?.files ?? [],
            links: cur.filter((l) => l.id !== id),
          },
        },
      };
    }),
  clearTabAttachments: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.tabAttachments;
      return { tabAttachments: rest };
    }),
  setPendingUpdate: (version) => set({ pendingUpdate: version }),
  connectionNotice: null,
  setConnectionNotice: (notice) => set({ connectionNotice: notice }),
  setStreamingDraft: (sessionId, draft) =>
    set((state) => {
      const existing = state.streamingDrafts[sessionId] || {
        responseBlocks: [],
        streamThinking: "",
        steps: [],
        isAgentRunning: false,
      };
      return {
        streamingDrafts: {
          ...state.streamingDrafts,
          [sessionId]: { ...existing, ...draft },
        },
      };
    }),
  clearStreamingDraft: (sessionId) =>
    set((state) => {
      const { [sessionId]: _, ...rest } = state.streamingDrafts;
      return { streamingDrafts: rest };
    }),
  agentExecutionSteps: [],
  accessedDirectories: [],
  selectedFiles: [],
  selectedWorkDir: null,
  workDirEpoch: 0,
  sessionSaveVersion: 0,
  currentSessionId: null,
  noActiveConversation: true,
  brokenSessionIds: [],
  brokenSessionReasons: {},
  activeSessionWorkDir: null,
  sessionHistory: [],
  sessionHistoryIndex: -1,
  // Panel state — in slices/panel-slice.ts
  modelUsage: {},
  contextUsage: {},
  estimatedTokens: {},
  sessionUsageStats: {
    requestCount: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtTokens: 0,
    cachedReadTokens: 0,
    cachedWriteTokens: 0,
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
  notes: "",
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
  previewRailNavSeq: 0,
  lastPreviewRailQuiet: false,
  browserAddSeq: 0,
  browserHomeUrl: "",
  rightSidebarTab: null,
  activeAgentView: null,
  directoryProjectDir: null,
  codeFullscreen: false,
  approvalMode: "accept_edits" as const,
  approvalModeBySession: {},
  modelBySession: {},
  bylineReplies: {},
  bylineAskSignal: 0,
  bylineAskQuestion: "",
  bylineAskMainCid: null,
  bylineAsk: (question, mainCid) => {
    set((s) => ({
      bylineAskSignal: s.bylineAskSignal + 1,
      bylineAskQuestion: question,
      bylineAskMainCid: mainCid ?? s.currentSessionId ?? null,
    }));
  },
  bylineFocusSignal: 0,
  focusBylineInput: () =>
    set((s) => ({ bylineFocusSignal: s.bylineFocusSignal + 1 })),
  bylineStopSignal: 0,
  stopByline: () => set((s) => ({ bylineStopSignal: s.bylineStopSignal + 1 })),
  startupGreeting: "有什么可以帮你的？",

  // MCP Servers
  mcpServers: {},

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
    // Files are now managed by Helix, not local API
    set({ files: [] });
  },
  selectFile: (fileId) => set({ selectedFileId: fileId }),
  toggleFolder: (folderId) =>
    set((state) => {
      const next = new Set(state.expandedFolders);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return { expandedFolders: next };
    }),

  createFile: (parentId, name, type) => {
    const id = generateId();
    const newFile: FileNode = {
      id,
      name,
      type,
      ...(type === "file"
        ? { content: "", language: getLanguageFromName(name) }
        : { children: [] }),
    };

    if (parentId) {
      set((state) => ({
        files: addFileToTree(state.files, parentId, newFile),
      }));
    } else {
      set((state) => ({ files: [...state.files, newFile] }));
    }

    if (type === "file") {
      get().openFile(id);
    } else {
      set((state) => {
        const next = new Set(state.expandedFolders);
        next.add(id);
        return { expandedFolders: next };
      });
    }
  },

  deleteFile: (fileId) => {
    const file = get().getFileById(fileId);
    set((state) => {
      const newFiles = removeFileFromTree(state.files, fileId);
      const newTabs = state.openTabs.filter((t) => t.fileId !== fileId);
      const newActiveTabId =
        state.activeTabId &&
        state.openTabs.find((t) => t.id === state.activeTabId)?.fileId ===
          fileId
          ? newTabs[newTabs.length - 1]?.id || null
          : state.activeTabId;
      return {
        files: newFiles,
        openTabs: newTabs,
        activeTabId: newActiveTabId,
      };
    });
    if (file?.type === "folder") {
      // Remove all tabs for files in this folder
      const allFolderFileIds: string[] = [];
      const collectIds = (nodes: FileNode[]) => {
        for (const n of nodes) {
          if (n.type === "file") allFolderFileIds.push(n.id);
          if (n.children) collectIds(n.children);
        }
      };
      if (file.children) collectIds(file.children);
    }
  },

  updateFileContent: (fileId, content) =>
    set((state) => ({
      files: updateFileInTree(state.files, fileId, (n) => ({ ...n, content })),
      openTabs: state.openTabs.map((t) =>
        t.fileId === fileId ? { ...t, isDirty: true } : t,
      ),
    })),

  getFileById: (fileId) => findFileById(get().files, fileId),

  renameFile: async (fileId, newName) => {
    const state = get();
    const file = findFileById(state.files, fileId);
    if (!file) return false;
    const relativePath = state.getFilePath(fileId);
    if (relativePath && state.selectedWorkDir && isElectron()) {
      const newRelativePath = relativePath.replace(/[^/]+$/, newName);
      try {
        await electronFS.rename(relativePath, newRelativePath);
      } catch (err) {
        logError("renameFile fs error:", err);
        return false;
      }
    }
    set((state) => ({
      files: updateFileInTree(state.files, fileId, (n) => ({
        ...n,
        name: newName,
        language: n.type === "file" ? getLanguageFromName(newName) : n.language,
      })),
      openTabs: state.openTabs.map((t) =>
        t.fileId === fileId
          ? { ...t, name: newName, language: getLanguageFromName(newName) }
          : t,
      ),
    }));
    return true;
  },

  // Actions - Tabs
  openFile: (fileId) => {
    const state = get();
    const file = findFileById(state.files, fileId);
    if (!file || file.type !== "file") return;

    const existingTab = state.openTabs.find((t) => t.fileId === fileId);
    if (existingTab) {
      set({ activeTabId: existingTab.id, selectedFileId: fileId });
      return;
    }

    const newTab: EditorTab = {
      id: `tab-${fileId}`,
      fileId,
      name: file.name,
      language: file.language || getLanguageFromName(file.name),
      isDirty: false,
    };
    set((s) => ({
      openTabs: [...s.openTabs, newTab],
      activeTabId: newTab.id,
      selectedFileId: fileId,
    }));
  },

  closeTab: (tabId) =>
    set((state) => {
      const idx = state.openTabs.findIndex((t) => t.id === tabId);
      const newTabs = state.openTabs.filter((t) => t.id !== tabId);
      let newActiveTabId = state.activeTabId;
      if (state.activeTabId === tabId) {
        if (newTabs.length > 0) {
          newActiveTabId =
            newTabs[Math.min(idx, newTabs.length - 1)]?.id || null;
        } else {
          newActiveTabId = null;
        }
      }
      return { openTabs: newTabs, activeTabId: newActiveTabId };
    }),

  setActiveTab: (tabId) =>
    set((state) => ({
      activeTabId: tabId,
      selectedFileId:
        state.openTabs.find((t) => t.id === tabId)?.fileId || null,
    })),

  // Actions - Skills
  addSkill: (skill) => {
    const id = generateId();
    set((state) => ({
      skills: [...state.skills, { ...skill, id, createdAt: Date.now() }],
    }));
    return id;
  },

  updateSkill: (skillId, updates) =>
    set((state) => ({
      skills: state.skills.map((s) =>
        s.id === skillId ? { ...s, ...updates } : s,
      ),
    })),

  removeSkill: (skillId) =>
    set((state) => ({
      skills: state.skills.filter((s) => s.id !== skillId || s.isBuiltin),
    })),

  toggleSkillPanel: () => set((s) => ({ showSkillPanel: !s.showSkillPanel })),
  toggleActivityFeed: () =>
    set((s) => ({ showActivityFeed: !s.showActivityFeed })),
  toggleArtifactsBrowser: () =>
    set((s) => ({ showArtifactsBrowser: !s.showArtifactsBrowser })),
  togglePreviewRail: () =>
    set((s) => {
      const next = s.rightSidebarTab === "browser" ? null : "browser";
      return next === "browser"
        ? {
            rightSidebarTab: "browser",
            showPreviewRail: true,
            editorOpen: false,
          }
        : { rightSidebarTab: null, showPreviewRail: false, editorOpen: false };
    }),
  setPreviewRailUrl: (url: string | null, forceOpen = true, quiet = false) =>
    set((s) => ({
      previewRailUrl: url === null ? null : cleanUrl(url),
      previewRailNavSeq: s.previewRailNavSeq + 1,
      lastPreviewRailQuiet: quiet,
      ...(url !== null && forceOpen
        ? {
            showPreviewRail: true,
            rightSidebarTab: "browser",
            editorOpen: false,
          }
        : {}),
    })),
  requestAddBrowserPage: () =>
    set((s) => ({
      // 打开侧边栏 + 递增信号；right-sidebar 监听 browserAddSeq 新建页面。
      rightSidebarTab: "browser",
      showPreviewRail: true,
      editorOpen: false,
      browserAddSeq: s.browserAddSeq + 1,
    })),
  setBrowserHomeUrl: (url: string) => {
    const trimmed = url.trim();
    set(() => ({ browserHomeUrl: trimmed }));
    import("@/lib/persist")
      .then(({ persistence }) =>
        persistence.saveSetting("browserHomeUrl", trimmed),
      )
      .catch(() => {});
  },
  setRightSidebarTab: (tab) =>
    set(() => {
      if (tab === "browser")
        return {
          rightSidebarTab: "browser",
          showPreviewRail: true,
          editorOpen: false,
        };
      if (tab === "code")
        return {
          rightSidebarTab: "code",
          showPreviewRail: false,
          editorOpen: true,
        };
      if (tab === "diff")
        return {
          rightSidebarTab: "diff",
          showPreviewRail: false,
          editorOpen: false,
        };
      if (tab === "agent")
        return {
          rightSidebarTab: "agent",
          showPreviewRail: false,
          editorOpen: false,
        };
      if (tab === "byline")
        return {
          rightSidebarTab: "byline",
          showPreviewRail: false,
          editorOpen: false,
        };
      return {
        rightSidebarTab: null,
        showPreviewRail: false,
        editorOpen: false,
      };
    }),
  openAgentView: (agent) =>
    set(() => ({
      activeAgentView: agent,
      rightSidebarTab: "agent",
      showPreviewRail: false,
      editorOpen: false,
    })),
  toggleDirectoryProject: (dir) =>
    set((s) => ({
      directoryProjectDir: s.directoryProjectDir === dir ? null : dir,
    })),
  toggleCodeFullscreen: () =>
    set((s) => ({ codeFullscreen: !s.codeFullscreen })),
  setApprovalMode: (v: ApprovalMode) => {
    set((s) => {
      // 新对话尚未分配 id 时先存到草稿键，避免选择后重启丢失。
      const sid = s.currentSessionId || "__draft__";
      const bySession = { ...s.approvalModeBySession, [sid]: v };
      return { approvalMode: v, approvalModeBySession: bySession };
    });
    import("@/lib/persist").then(({ persistence }) => {
      const st = get();
      persistence.saveSetting("approvalMode", st.approvalMode).catch(() => {});
      persistence
        .saveSetting("approvalModeBySession", st.approvalModeBySession)
        .catch(() => {});
    });
  },
  // 旁路面板的审批模式下拉：只写该旁路会话的覆盖值，不碰全局。旁路 cid
  // （btw- 前缀）不参与 setCurrentSessionId 的恢复逻辑，所以直接落 map。
  setApprovalModeForSession: (sessionId, mode) => {
    set((s) => ({
      approvalModeBySession: { ...s.approvalModeBySession, [sessionId]: mode },
    }));
    import("@/lib/persist").then(({ persistence }) => {
      persistence
        .saveSetting("approvalModeBySession", get().approvalModeBySession)
        .catch(() => {});
    });
  },
  // 按会话的模型选择：输入框模型下拉与旁路面板都写它。handleRun 每轮把
  // modelBySession[会话cid] 经 set_model 透传到该会话的 pi 实例（网关按
  // session_id 路由），不改全局 config.yaml——所以每个对话可以各选各的模型，
  // 新对话继续走全局默认。
  setModelForSession: (sessionId, model) => {
    set((s) => ({
      modelBySession: { ...s.modelBySession, [sessionId]: model },
    }));
    import("@/lib/persist").then(({ persistence }) => {
      persistence
        .saveSetting("modelBySession", get().modelBySession)
        .catch(() => {});
    });
  },
  // 旁路答案立即落盘：右侧「旁路问答」面板读它，重启后必须还在。与
  // setContextUsage 同样走即时 saveSetting（不等 persistToStorage 的整批写）。
  setBylineReply: (mainSessionId, reply) => {
    set((s) => ({
      bylineReplies: { ...s.bylineReplies, [mainSessionId]: reply },
    }));
  },
  sessionPendingApproval: {},
  setSessionPendingApproval: (patch: Record<string, boolean>) =>
    set((s) => {
      const next: Record<string, boolean> = { ...s.sessionPendingApproval };
      for (const k of Object.keys(patch)) next[k] = patch[k];
      // 相等则跳过 set，避免无谓的全局订阅者重渲染（防止 Maximum update depth）
      if (Object.keys(next).length === Object.keys(s.sessionPendingApproval).length &&
        Object.keys(next).every((k) => next[k] === s.sessionPendingApproval[k])) {
        return {};
      }
      return { sessionPendingApproval: next };
    }),
  setStartupGreeting: (v: string) => set((s) => ({ startupGreeting: v })),

  toggleRuntimePanel: () =>
    set((s) => ({ showRuntimePanel: !s.showRuntimePanel })),

  // Actions - Chat
  addChatMessage: (message) => {
    const id = generateId();
    set((state) => {
      // Truncate any single message's text/content to 128 KB — larger payloads
      // (e.g. a tool_result carrying a full file) can blow the heap in long
      // conversations. Keep a head + tail window so the message is still useful.
      const msg: Record<string, any> = { ...message };
      const truncKeys = ["content", "text", "reasoning", "html"];
      for (const k of truncKeys) {
        const v = msg[k];
        if (typeof v === "string") msg[k] = truncateString(v, 128_000);
      }
      const newState: Record<string, any> = {
        chatMessages: [
          ...state.chatMessages,
          {
            ...msg,
            id,
            sessionId: msg.sessionId || state.currentSessionId || undefined,
            timestamp: Date.now(),
          },
        ],
      };
      // Keep the in-memory message list bounded (persistence handles the rest)
      // so the render heap doesn't grow unboundedly with long conversations.
      const MAX_CHAT_MESSAGES = 300;
      if (newState.chatMessages.length > MAX_CHAT_MESSAGES) {
        newState.chatMessages = newState.chatMessages.slice(-MAX_CHAT_MESSAGES);
      }
      return newState;
    });
    scheduleSessionPersist();
    return id;
  },

  updateChatMessage: (messageId, content) => {
    set((state) => ({
      chatMessages: state.chatMessages.map((m) =>
        m.id === messageId ? { ...m, content } : m,
      ),
    }));
    scheduleSessionPersist();
  },

  setChatMessageStreaming: (messageId, isStreaming) =>
    set((state) => ({
      chatMessages: state.chatMessages.map((m) =>
        m.id === messageId ? { ...m, isStreaming } : m,
      ),
    })),

  setChatMessageRowId: (messageId, rowId) =>
    set((state) => ({
      chatMessages: state.chatMessages.map((m) =>
        m.id === messageId ? { ...m, rowId } : m,
      ),
    })),

  deleteMessage: (messageId) =>
    set((state) => ({
      chatMessages: state.chatMessages.filter((m) => m.id !== messageId),
    })),

  clearChat: () => {
    if (sessionPersistTimer) clearTimeout(sessionPersistTimer);
    const prevId = get().currentSessionId;
    set({
      chatMessages: [],
      currentSessionId: null,
      activeSessionWorkDir: null,
      selectedWorkDir: null,
      // Do NOT wipe contextUsage here. 新建对话/新标签页只是离开视图，旧对话
      // 仍留在侧边栏，它的环读数必须保留。之前把整个 per-conversation 映射清成
      // {}，下一次 persistToStorage 又把空映射落盘 → 重启后所有对话的用量全空
      // （"每次重启后上下文清空"根因）。环在 currentSessionId=null 时自然显示空态。
    });
    // Reset the Helix backend session so a fresh ACP session is created on the
    // next prompt. Without this the UI clears but Helix keeps the full
    // conversation history, so the model still answers with prior context.
    import("@/stores/gateway-store").then(({ useGatewayStore }) => {
      useGatewayStore.getState().setHelixSessionId(null);
    });
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
    if (sessionPersistTimer) clearTimeout(sessionPersistTimer);
    const sessionId = get().currentSessionId;
    const snapshot = get();
    set({
      chatMessages: [],
      // /clear /reset 只是让当前对话"忘掉"历史：只删本对话的用量快照，保留
      // 其他对话的（之前整表清空 + persistToStorage 落盘会连带抹掉所有对话
      // 的环读数）。压缩轮换出的新 sid 也不在这里 —— compress 后 setContextUsage
      // 会按新会话重新落值。
      contextUsage: sessionId
        ? Object.fromEntries(
            Object.entries(snapshot.contextUsage).filter(
              ([k]) => k !== sessionId,
            ),
          )
        : snapshot.contextUsage,
    });
    import("@/stores/gateway-store").then(({ useGatewayStore }) => {
      useGatewayStore.getState().setHelixSessionId(null);
    });
    // Persist empty state to IndexedDB so cleared messages don't reappear
    // on next session load.
    if (sessionId) {
      try {
        const { persistence } = await import("@/lib/persist");
        await persistence.saveSession({
          id: sessionId,
          label: "新对话",
          chatMessages: [],
          goal: snapshot.goal,
          memories: snapshot.memories,
          tasks: snapshot.tasks,
          notes: snapshot.notes,
          checkpoints: snapshot.checkpoints,
          files: snapshot.files as any,
          openTabs: snapshot.openTabs as any,
          workDir: snapshot.activeSessionWorkDir,
        });
        useHelixStore.setState((st) => ({
          sessionSaveVersion: st.sessionSaveVersion + 1,
        }));
      } catch (e) {
        logError("Failed to persist cleared session:", e);
      }
    }
  },
  clearChatAndPersist: async () => {
    get().clearChat();
  },

  setChatLoading: (loading) => set({ isChatLoading: loading }),

  forkConversation: async (messageId, opts) => {
    const state = get();
    if (!state.currentSessionId) {
      state.showToast({
        type: "error",
        title: "无法分叉",
        description: "当前没有活跃的会话",
      });
      return null;
    }

    // Find the fork point: copy all messages up to and including this one.
    // 过滤规则必须与渲染层（agent-flow-panel 的 sessionMessages）一致：无 sessionId
    // 的消息只属于「新对话」那一屏，旧写法 `!m.sessionId || …` 会把它算进当前会话，
    // 分叉点因而可能落在一条用户根本没在本会话里看到的消息上。
    const forkCid = state.currentSessionId;
    const msgs = forkCid
      ? state.chatMessages.filter((m) => m.sessionId === forkCid)
      : state.chatMessages.filter((m) => !m.sessionId);
    const forkIdx = msgs.findIndex((m) => m.id === messageId);
    if (forkIdx < 0) {
      state.showToast({
        type: "error",
        title: "分叉失败",
        description: "找不到目标消息",
      });
      return null;
    }

    // Copy messages up to fork point
    const forkedMsgs = msgs.slice(0, forkIdx + 1);

    // Generate new session ID
    const newSessionId =
      "session-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);

    // 纯本地分叉（不依赖后端 session/fork RPC——该 RPC 已从网关移除）：
    // 复制到分叉点为止的消息到新对话，后续 run 正常创建自己的后端会话。

    // Determine branch name: count existing forks from this parent
    const { persistence } = await import("@/lib/persist");
    const allSessions = await persistence.loadSessions();
    const siblingForks = allSessions.filter(
      (s) => s.parentSessionId === state.currentSessionId,
    );
    // 旁路对话（/btw）会传 labelPrefix="旁路"，让侧边栏里一眼能分清它是旁路而不是
    // 正式的分支线。字母后缀 A/B/C… 仍按同一父会话下的既有分叉数量递增。
    const labelPrefix = opts?.labelPrefix ?? "分支";
    const branchLabel = `${labelPrefix} ${String.fromCharCode(65 + siblingForks.length)}`; // A, B, C...

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
      chatMessages: forkedMsgs.map((m) => ({
        id: m.id,
        sessionId: newSessionId,
        role: m.role,
        content: m.content,
        images: m.images,
        timestamp: m.timestamp,
        isStreaming: false,
        reasoning: m.reasoning,
        duration: m.duration,
        thinkingTime: m.thinkingTime,
        totalTokens: m.totalTokens,
        thoughtTokens: m.thoughtTokens,
        outputTokens: m.outputTokens,
        steps: m.steps,
        fileChanges: m.fileChanges,
        blocks: m.blocks,
      })),
      files: collectFiles(state.files),
      openTabs: state.openTabs.map((tab) => ({
        id: tab.id,
        fileId: tab.fileId,
        name: tab.name,
        language: tab.language,
        isDirty: tab.isDirty,
      })),
      parentSessionId: state.currentSessionId,
      forkedFromMessageId: messageId,
      branchName: branchLabel,
    });

    // Reset Helix session for the new branch
    useGatewayStore.getState().setHelixSessionId(null);

    // Switch to the new session
    state.setCurrentSessionId(newSessionId);

    // 把分叉消息装进内存，让 (a) 当前视图立即显示分叉会话的内容、
    // (b) handleRun 的 seedHistory 过滤（m.sessionId === activeSessionId）
    // 找得到它们。
    // 旧实现从 allSessions 里 find 新会话——但 allSessions 是 saveSession
    // **之前**的快照，find 永远 undefined，整块从不执行：分叉后视图空白、
    // 直接提问时后端 seed 也是空的（分叉上下文全丢）。这里直接用算好的
    // forkedMsgs 重映射进内存，不再绕盘。
    set({
      chatMessages: [
        ...get().chatMessages,
        ...forkedMsgs.map((m) => ({ ...m, sessionId: newSessionId }) as ChatMessage),
      ],
    });

    state.showToast({
      type: "success",
      title: `已创建 ${branchLabel}`,
      description: `从第 ${forkIdx + 1} 条消息处分叉`,
    });

    // Increment session save version so sidebar refreshes
    useHelixStore.setState((st) => ({
      sessionSaveVersion: st.sessionSaveVersion + 1,
    }));

    return newSessionId;
  },

  // Terminal — in slices/terminal-slice.ts

  // Actions - Editor
  setCursorPosition: (pos) => set({ cursorPosition: pos }),
  markTabSaved: (tabId) =>
    set((state) => ({
      openTabs: state.openTabs.map((t) =>
        t.id === tabId ? { ...t, isDirty: false } : t,
      ),
    })),

  // Actions - UI
  // Panel toggles — in slices/panel-slice.ts
  setEditorTheme: (theme) => set({ editorTheme: theme }),
  setFontFamily: (fontFamily) => {
    set({ fontFamily });
    // Code-editor-only font: applied to CodeMirror via CSS var, NOT to body,
    // so it never leaks into the chat/settings UI (per the font-scope split).
    document.documentElement.style.setProperty(
      "--helix-font-family",
      fontFamily,
    );
    localStorage.setItem("helix-font-family", fontFamily);
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveSetting("fontFamily", fontFamily),
    );
  },
  setFontSize: (fontSize) => {
    set({ fontSize });
    document.documentElement.style.setProperty(
      "--helix-font-size",
      `${fontSize}px`,
    );
    localStorage.setItem("helix-font-size", String(fontSize));
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveSetting("fontSize", fontSize),
    );
  },
  setInterfaceFont: (font) => {
    set({ interfaceFont: font });
    // UI font: applied to the app chrome (chat + settings) via the `--helix-interface-font`
    // CSS var on <body>. We deliberately do NOT write body.style.fontFamily directly so
    // the code-editor font (a separate var) stays isolated from the UI font.
    document.documentElement.style.setProperty("--helix-interface-font", font);
    localStorage.setItem("helix-interface-font", font);
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveSetting("interfaceFont", font),
    );
  },
  setTranscriptFontSize: (size) => {
    set({ transcriptFontSize: size });
    document.documentElement.style.setProperty(
      "--helix-transcript-size",
      `${size}px`,
    );
    localStorage.setItem("helix-transcript-size", String(size));
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveSetting("transcriptFontSize", size),
    );
  },
  setThemeStyle: (styleId) => {
    set({ themeStyle: styleId });
    if (typeof localStorage !== "undefined")
      localStorage.setItem("helix-theme-style", styleId);
    // Apply immediately (not only via the layout effect) so selecting a flavor
    // re-skins the UI even if the React effect doesn't re-run for some reason.
    applyHelixPalette(styleId);
    import("@/lib/persist")
      .then(({ persistence }) => persistence.saveSetting("themeStyle", styleId))
      .catch(() => {});
  },
  setBootBackgroundImage: (image) => {
    set({ bootBackgroundImage: image });
    import("@/lib/persist")
      .then(({ persistence }) =>
        persistence.saveSetting("bootBackgroundImage", image),
      )
      .catch(() => {});
  },
  setGlobalBackgroundEnabled: (enabled) => {
    set({ showGlobalBackground: enabled });
    import("@/lib/persist")
      .then(({ persistence }) =>
        persistence.saveSetting("showGlobalBackground", enabled),
      )
      .catch(() => {});
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
    const s = { ...step };
    if (s.toolParams) {
      const p: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(s.toolParams)) {
        p[k] = typeof v === "string" ? truncateString(v, 32_000) : v;
      }
      s.toolParams = p;
    }
    set((state) => ({
      agentExecutionSteps: [
        ...state.agentExecutionSteps,
        { ...s, timestamp: Date.now() },
      ].slice(-200),
    }));
  },
  addAccessedDirectory: (dir) =>
    set((state) => {
      if (state.accessedDirectories.includes(dir)) return state;
      return { accessedDirectories: [...state.accessedDirectories, dir] };
    }),
  addSelectedFile: (filePath) =>
    set((state) => {
      if (state.selectedFiles.includes(filePath)) return state;
      return { selectedFiles: [...state.selectedFiles, filePath] };
    }),
  removeSelectedFile: (filePath) =>
    set((state) => ({
      selectedFiles: state.selectedFiles.filter((p) => p !== filePath),
    })),
  clearSelectedFiles: () => set({ selectedFiles: [] }),
  setSelectedWorkDir: (dir: string | null) => {
    const isDriveRoot =
      typeof dir === "string" && /^[a-zA-Z]:[\\/]?$/.test(dir);
    if (dir === "/" || dir === "\\" || isDriveRoot || !dir) {
      // Let the main process decide the real project directory; the renderer's
      // process.cwd() is unreliable (often resolves to a drive root like D:\).
      set({ selectedWorkDir: "" });
    } else {
      set({ selectedWorkDir: dir });
    }
  },

  setWorkDir: async (relativePath: string) => {
    const isDriveRoot =
      typeof relativePath === "string" &&
      /^[a-zA-Z]:[\\/]?$/.test(relativePath);
    if (
      !relativePath ||
      relativePath === "/" ||
      relativePath === "\\" ||
      isDriveRoot
    ) {
      get().showToast({
        title: "无效的工作目录，已回退到项目目录",
        type: "warning",
      });
      const fallbackDir = await getDefaultSessionsDir();
      const info = isElectron()
        ? await electronApp.getInfo()
        : { workDir: fallbackDir };
      set({
        selectedWorkDir: info.workDir || fallbackDir,
        workDirEpoch: get().workDirEpoch + 1,
      });
      return;
    }
    const api = getElectronAPI();
    // 对话正在运行时，点另一个项目只是“浏览”，绝不能打断它：
    // 不卸载当前对话、不 bump workDirEpoch（那会把全局 helixSessionId 置空），
    // 也不触发 agent-flow-panel 的 [selectedWorkDir] effect（那会从 sessionMapRef
    // 里删掉正在跑的会话 → 下次 session/prompt 拿到死会话 → "session not found" → 模型停止）。
    // 只切 selectedWorkDir + 文件树；新对话的第一条消息会用新 cwd 新建后端会话。
    const running =
      get().isAgentRunning ||
      Object.keys(get().streamingDrafts || {}).length > 0;
    if (running && api) {
      try {
        // 轻量对齐（不杀 Pi 实例、不重启网关）——与注释中“不打断运行中对话”的
        // 意图一致。重型的 setWorkDir 会 kill+restart 全部后端实例，绝不能用于此。
        const res = await api.app.syncWorkDir(relativePath);
        const absDir = res?.workDir || relativePath;
        set({ selectedWorkDir: absDir });
        // 显式传目录扫描（与非运行分支一致），失败要看得见而不是静默吞掉。
        try {
          try {
            await (getElectronAPI() as any)?.fs?.allowRoot?.(absDir);
          } catch {
            /* best-effort */
          }
          const tree = await electronFS.scanTree(absDir);
          set({ files: tree as FileNode[] });
        } catch (scanErr) {
          logError("[setWorkDir] scanTree failed:", scanErr);
        }
      } catch (err) {
        logError("[setWorkDir]", err);
        get().showToast({ title: "切换工作目录失败", type: "error" });
      }
      return;
    }
    if (!api) {
      // Don't auto-save the current session when switching projects.
      // Just clear the current session so new messages go to the new project.
      get().setCurrentSessionId(null);
      get().setNoActiveConversation(false);
      set({
        selectedWorkDir: relativePath,
        workDirEpoch: get().workDirEpoch + 1,
      });
      return;
    }
    try {
      const res = await api.app.setWorkDir(relativePath);
      const absDir = res?.workDir || relativePath;
      // Don't auto-save the current session when switching projects.
      // Just clear the current session so new messages go to the new project.
      get().setCurrentSessionId(null);
      get().setNoActiveConversation(false);
      // 先更新工作目录与 epoch，保证即使扫描失败，目录标签也是正确的。
      set({ selectedWorkDir: absDir, workDirEpoch: get().workDirEpoch + 1 });
      // 文件树扫描降级为尽力而为：scanTree 不可用时不影响工作目录切换。
      try {
        try {
          await (getElectronAPI() as any)?.fs?.allowRoot?.(absDir);
        } catch {
          /* best-effort */
        }
        const tree = await electronFS.scanTree(absDir);
        set({ files: tree as FileNode[] });
      } catch (scanErr) {
        logError("[setWorkDir] scanTree failed:", scanErr);
      }
    } catch (err) {
      logError("[setWorkDir]", err);
      get().showToast({ title: "切换工作目录失败", type: "error" });
    }
  },
  clearExecutionFlow: () =>
    set({ agentExecutionSteps: [], accessedDirectories: [] }),
  addModelUsage: (model, usage) =>
    set((state) => {
      const existing = state.modelUsage[model] || {
        prompt: 0,
        completion: 0,
        total: 0,
        cost: 0,
      };
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
      };
    }),
  setContextUsage: (
    sessionId,
    size,
    used,
    categories,
    toolsets,
    authoritative = false,
  ) => {
    set((s) => {
      const prev = s.contextUsage[sessionId];
      // 权威快照直接覆盖（size 也覆盖，窗口本身变了就得跟）；流式数据只做
      // 单调抬升，避免 cache miss / in-turn compaction 把环来回跳。
      const nextSize = authoritative ? size : Math.max(prev?.size || 0, size);
      const nextUsed = authoritative ? used : Math.max(prev?.used || 0, used);
      const next: {
        size: number;
        used: number;
        categories?: Array<{
          id: string;
          label: string;
          tokens: number;
          color: string;
          aggregate?: boolean;
        }>;
        toolsets?: Array<{
          toolset: string;
          tool_count: number;
          schema_tokens: number;
        }>;
      } = { size: nextSize, used: nextUsed };
      // Only a non-empty categories/toolsets array overrides the snapshot — an
      // empty array is a "backend couldn't produce a breakdown" marker, and
      // treating `[]` as authoritative (truthy) permanently destroyed real
      // persisted categories (「重启后所有分类都没了」根因).
      if (categories && categories.length > 0) next.categories = categories;
      else if (prev?.categories) next.categories = prev.categories;
      if (toolsets && toolsets.length > 0) next.toolsets = toolsets;
      else if (prev?.toolsets) next.toolsets = prev.toolsets;
      return { contextUsage: { ...s.contextUsage, [sessionId]: next } };
    });
    // Persist immediately so a cold restart restores the latest usage snapshot
    // instead of resetting to zero (the backend never reports a session's
    // accumulated token count on launch, and the in-memory field is only
    // refreshed by runtime events).
    import("@/lib/persist").then(({ persistence }) => {
      persistence
        .saveSetting("contextUsage", get().contextUsage)
        .catch(() => {});
    });
  },
  // Set estimated tokens for a session (shown while request is in-flight)
  setEstimatedTokens: (sessionId, tokens) =>
    set({ estimatedTokens: { ...get().estimatedTokens, [sessionId]: tokens } }),
  // Clear estimated tokens after real usage arrives
  clearEstimatedTokens: (sessionId) =>
    set((s) => {
      const { [sessionId]: _, ...rest } = s.estimatedTokens;
      return { estimatedTokens: rest };
    }),
  addSessionUsageStats: (model, usage) => {
    (set((state) => {
      const input = usage.inputTokens || 0;
      const output = usage.outputTokens || 0;
      const thought = usage.thoughtTokens || 0;
      const cachedRead = usage.cachedReadTokens || 0;
      const cachedWrite = usage.cachedWriteTokens || 0;
      // Backend CanonicalUsage.total_tokens = input + cache_read + cache_write
      // + output (reasoning is tracked separately and excluded). Mirror that
      // basis so the accumulated "total" agrees with the backend's total_tokens.
      const total =
        usage.totalTokens || input + cachedRead + cachedWrite + output;
      // 4-tier pricing aligned with backend usage_pricing.py. Reasoning tokens
      // are billed as output by every thinking-capable provider, so they enter
      // the output bucket; cache reads/writes use their discounted tiers.
    
      // Accumulate into the current local day (used by the daily-usage treemap).
      const dayKey = dayKeyOf(new Date());
      const prevDay = state.dailyUsage[dayKey] || {
        totalTokens: 0,
        requestCount: 0,
        models: {},
      };
      const prevModels = prevDay.models || {};
      const prevModel = prevModels[model] || {
        totalTokens: 0,
        requestCount: 0,
      };
      // Prune entries older than 90 days so the record stays bounded.
      const cutoff = Date.now() - 90 * 86400000;
      const prunedDaily: Record<string, DailyUsageEntry> = {};
      for (const [k, v] of Object.entries(state.dailyUsage)) {
        const t = new Date(`${k}T00:00:00`).getTime();
        if (!Number.isNaN(t) && t >= cutoff) prunedDaily[k] = v;
      }
      prunedDaily[dayKey] = {
        totalTokens: prevDay.totalTokens + total,
        requestCount: prevDay.requestCount + 1,
        models: {
          ...prevModels,
          [model]: {
            totalTokens: prevModel.totalTokens + total,
            requestCount: prevModel.requestCount + 1,
          },
        },
      };
      return {
        sessionUsageStats: {
          requestCount: state.sessionUsageStats.requestCount + 1,
          totalTokens: state.sessionUsageStats.totalTokens + total,
          inputTokens: state.sessionUsageStats.inputTokens + input,
          outputTokens: state.sessionUsageStats.outputTokens + output,
          thoughtTokens: state.sessionUsageStats.thoughtTokens + thought,
          cachedReadTokens:
            state.sessionUsageStats.cachedReadTokens + cachedRead,
          cachedWriteTokens:
            state.sessionUsageStats.cachedWriteTokens + cachedWrite,
        },
        dailyUsage: prunedDaily,
      };
    }),
      // Persist immediately: the settings usage panel (TokenUsagePanel) reads
      // these two keys, and persistToStorage only fires on config changes /
      // new-session creation — usage accumulated during normal conversation
      // runs was never flushed to IndexedDB, so the panel showed stale values
      // after a restart ("模型用量不会更新").
      import("@/lib/persist").then(({ persistence }) => {
        const s = get();
        Promise.all([
          persistence.saveSetting("sessionUsageStats", s.sessionUsageStats),
          persistence.saveSetting("dailyUsage", s.dailyUsage),
        ]).catch(() => {});
      }));
  },
  setNoActiveConversation: (v) => set({ noActiveConversation: v }),
  markSessionBroken: (cid, _reason) =>
    set((s) => ({
      brokenSessionIds: s.brokenSessionIds.includes(cid)
        ? s.brokenSessionIds
        : [...s.brokenSessionIds, cid],
    })),
  clearSessionBroken: (cid) =>
    set((s) => {
      if (!s.brokenSessionIds.includes(cid)) return {};
      const { [cid]: _reason, ...restReasons } = s.brokenSessionReasons;
      return {
        brokenSessionIds: s.brokenSessionIds.filter((x) => x !== cid),
        brokenSessionReasons: restReasons,
      };
    }),
  setCurrentSessionId: (id) =>
    set((state) => {
      if (!id)
        return {
          currentSessionId: id,
          activeSessionWorkDir: null,
          helixTodos: [],
        };
      // Skip if clicking the same session that's already loaded
      if (id === state.currentSessionId) return {};
      // 任务清单跟随会话：恢复目标会话缓存的 todo 列表（无则清空）
      const helixTodos = state.helixTodosBySession?.[id] ?? [];
      // 访问权限跟随会话：每个对话记住自己的审批模式。
      const draftMode = state.approvalModeBySession?.["__draft__"];
      const approvalMode =
        state.approvalModeBySession?.[id] ?? draftMode ?? state.approvalMode;
      const approvalModeBySession = { ...state.approvalModeBySession };
      if (draftMode && !approvalModeBySession[id])
        approvalModeBySession[id] = draftMode;
      delete approvalModeBySession["__draft__"];
      const history = [...state.sessionHistory];
      const idx = state.sessionHistoryIndex;
      // Check if the target ID already exists at the current position (deduplicate)
      if (history[idx] === id) {
        get().pushNavigation({ type: "chat", sessionId: id });
        return {
          currentSessionId: id,
          helixTodos,
          approvalMode,
          approvalModeBySession,
        };
      }
      // Remove any forward history when navigating to a new session
      const newHistory = [...history.slice(0, idx + 1), id];
      // 同步推送导航栈：所有会话切换路径都过 setCurrentSessionId，在这里
      // 推 chat 条目保证 navigationHistory 与 sessionHistory 永不错位。
      get().pushNavigation({ type: "chat", sessionId: id });
      return {
        currentSessionId: id,
        sessionHistory: newHistory,
        sessionHistoryIndex: newHistory.length - 1,
        helixTodos,
        approvalMode,
        approvalModeBySession,
      };
    }),
  navigateSession: async (direction, targetId) => {
    const state = get();
    let { sessionHistory, sessionHistoryIndex } = state;
    if (sessionHistory.length === 0) return;
    let historyChanged = false;
    let newIndex = sessionHistoryIndex;
    if (targetId) {
      const found = sessionHistory.indexOf(targetId);
      if (found < 0) {
        // 分支切换：目标可能从没进过历史（面板分支 chip 直跳兄弟/父会话）
        // ——追加到历史末尾再跳。不能直接 return，否则分支导航是死功能。
        sessionHistory = [...sessionHistory, targetId];
        historyChanged = true;
        newIndex = sessionHistory.length - 1;
      } else {
        newIndex = found;
      }
    } else if (direction === "back" && newIndex > 0) {
      newIndex--;
    } else if (
      direction === "forward" &&
      newIndex < sessionHistory.length - 1
    ) {
      newIndex++;
    } else {
      return;
    }
    const target = sessionHistory[newIndex];
    if (!target) return;

    // Flush current session first so we don't lose unsaved messages
    if (state.currentSessionId) {
      await state.flushSessionPersist();
    }

    try {
      const { persistence } = await import("@/lib/persist");
      const all = await persistence.loadSessions();
      const session = all.find((s) => s.id === target);
      if (!session) {
        // Session may have been deleted — just update the index
        set({ currentSessionId: target, sessionHistoryIndex: newIndex });
        return;
      }

      const seen = new Set<string>();
      const msgs = session.chatMessages
        .filter((msg) => {
          // 防御性去重：session 保存时 "draft-partial" 可能被写两次
          // (streaming 中 flushSessionPersist 一次 + turn 结束再持久化一次)，
          // 导致恢复后 chatMessages 含同 id 消息 → React 渲染 duplicate key。
          if (seen.has(msg.id)) return false;
          seen.add(msg.id);
          // 恢复时丢弃 draft-partial 占位消息（同 sidebar/session-manager）。
          // 并发下切换会话不中断后台 run，占位仅是持久化快照，加载端统一
          // 丢弃，避免与最终提交的完整回复重复显示。只在应用真正崩溃退出
          // 时才作为部分回复的兜底保留在磁盘上。
          if (typeof msg.id === "string" && msg.id.startsWith("draft-partial-"))
            return false;
          return true;
        })
        .map((msg) => ({
          id: msg.id,
          role: msg.role as "user" | "assistant" | "system",
          content: msg.content,
          images: msg.images,
          timestamp: msg.timestamp,
          reasoning: msg.reasoning,
          duration: msg.duration,
          thinkingTime: msg.thinkingTime,
          totalTokens: msg.totalTokens,
          thoughtTokens: msg.thoughtTokens,
          outputTokens: msg.outputTokens,
          steps: msg.steps,
          fileChanges: msg.fileChanges,
          blocks: msg.blocks,
        }));

      // 内存合并而非整体覆盖：后台 run 完成时 done 提交 + persistSessionNow
      // 是 fire-and-forget（动态 import + 全量读盘 + 落盘，数百 ms），若此刻
      // 用磁盘快照整体替换 chatMessages，回复可能内存（被覆盖）、draft（已清）、
      // 磁盘（还没写完）三处同时缺席——切回来输出就"消失"了。以磁盘快照为基底，
      // 该会话仍在内存里的消息按 id 覆盖回来（内存是 done 刚提交的新鲜副本，
      // 磁盘可能落后），其他会话的消息原样保留。
      const live = get().chatMessages;
      const byId = new Map<string, ChatMessage>();
      for (const m of msgs) byId.set(m.id, { ...m, sessionId: target });
      for (const m of live) {
        if (!m.sessionId || m.sessionId !== target) continue;
        if (typeof m.id === "string" && m.id.startsWith("draft-partial-"))
          continue;
        byId.set(m.id, m);
      }
      const merged = [
        // 保留「其他会话」的消息 + 「无 sessionId 的草稿消息」（= 新对话那一屏的
        // 内容，见 addChatMessage 的 `|| undefined` 兜底）。
        //
        // ⚠️ 旧写法 `m.sessionId && m.sessionId !== target` 会把后者直接删掉。
        // 它们不属于任何会话、也不参与落盘（persistCurrentSessionNow 在
        // currentSessionId 为 null 时第 868 行就 return），所以在切会话时被丢掉
        // 就是**永久**消失——切回新对话也不会再有。注意 byId 的收集循环用的是
        // `if (!m.sessionId || m.sessionId !== target) continue`（continue 语义，
        // 只收 target 自己的消息），别和这里的 include 语义搞混。
        ...live.filter((m) => m.sessionId !== target),
        ...[...byId.values()],
      ];
      merged.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

      useHelixStore.getState().clearExecutionFlow();
      useGatewayStore.getState().setHelixSessionId(null);

      const panelState = get();
      if (panelState.showScheduledTasksPanel || panelState.showSkillPanel) {
        useHelixStore.setState({
          showScheduledTasksPanel: false,
          showSkillPanel: false,
        });
      }

      set({
        chatMessages: merged,
        activeSessionWorkDir: session.workDir ?? null,
        currentSessionId: target,
        sessionHistoryIndex: newIndex,
        // 分支切换追加进历史时同步进 store（普通路径引用相同，写回无副作用）
        ...(historyChanged ? { sessionHistory } : {}),
      });

      // Persist the updated history index
      const { persistence: persistMod } = await import("@/lib/persist");
      await Promise.all([
        persistMod.saveSetting("sessionHistoryIndex", newIndex),
        persistMod.saveSetting("sessionHistory", get().sessionHistory),
      ]);

      if (session.workDir) {
        await persistence.saveProjectFolder(session.workDir);
        // 分支选择器等 selectedWorkDir 驱动的 UI 跟随当前对话所属项目。
        // 只改 selectedWorkDir，不走 setWorkDir（避免切换项目副作用打断运行中对话）。
        set({ selectedWorkDir: session.workDir });
      }
    } catch (e) {
      logError("[navigateSession] failed:", e);
      get().showToast({ type: "error", title: "会话加载失败" });
    }
  },
  notifySessionSaved: () =>
    set((state) => ({ sessionSaveVersion: state.sessionSaveVersion + 1 })),

  flushSessionPersist: () => {
    return flushSessionPersist();
  },

  persistSessionNow: (sessionId: string) => {
    return persistSessionById(sessionId);
  },

  // Actions - File modifications
  applyFileChange: (fileId, newContent) =>
    set((state) => ({
      files: updateFileInTree(state.files, fileId, (n) => ({
        ...n,
        content: newContent,
      })),
      openTabs: state.openTabs.map((t) =>
        t.fileId === fileId ? { ...t, isDirty: false } : t,
      ),
    })),

  createOrUpdateFile: (filePath, content) => {
    const state = get();
    const existing = state.findFileByPath(filePath);
    if (existing) {
      get().applyFileChange(existing.id, content);
      get().openFile(existing.id);
      return;
    }
    // Create new file
    const segments = filePath.split("/");
    const fileName = segments.pop()!;
    let parentId: string | null = null;

    // Ensure parent folders exist
    for (const folderName of segments) {
      if (!parentId) {
        const folder = state.files.find(
          (f) => f.type === "folder" && f.name === folderName,
        );
        if (!folder) {
          const id = generateId();
          const newFolder: FileNode = {
            id,
            name: folderName,
            type: "folder",
            children: [],
          };
          set((s) => ({ files: [...s.files, newFolder] }));
          const expanded = new Set(get().expandedFolders);
          expanded.add(id);
          set({ expandedFolders: expanded });
          parentId = id;
        } else {
          parentId = folder.id;
          if (!state.expandedFolders.has(folder.id)) {
            get().toggleFolder(folder.id);
          }
        }
      } else {
        const parent = get().getFileById(parentId);
        const folder = parent?.children?.find(
          (f) => f.type === "folder" && f.name === folderName,
        );
        if (!folder) {
          const id = generateId();
          const newFolder: FileNode = {
            id,
            name: folderName,
            type: "folder",
            children: [],
          };
          set((s) => ({
            files: addFileToTree(s.files, parentId!, newFolder),
          }));
          const expanded = new Set(get().expandedFolders);
          expanded.add(id);
          set({ expandedFolders: expanded });
          parentId = id;
        } else {
          parentId = folder.id;
        }
      }
    }

    const fileId = generateId();
    const newFile: FileNode = {
      id: fileId,
      name: fileName,
      type: "file",
      content,
      language: getLanguageFromName(fileName),
    };
    if (parentId) {
      set((s) => ({ files: addFileToTree(s.files, parentId!, newFile) }));
    } else {
      set((s) => ({ files: [...s.files, newFile] }));
    }
    get().openFile(fileId);
  },

  addPendingChange: (change) => {
    const id = generateId();
    set((state) => {
      // Each diff belongs to the project it was captured in. Without this scope,
      // the aggregated diff panel would mix changes across all projects.
      const workDir =
        change.workDir ??
        state.selectedWorkDir ??
        state.activeSessionWorkDir ??
        "";
      const entry = { ...change, id, workDir };
      // Upsert by fileId (+ workDir so identical relative paths in different
      // projects don't collide) so repeated edits to the same file keep a
      // single entry showing the latest diff.
      const exists = state.pendingChanges.findIndex(
        (c) => c.fileId === change.fileId && (c.workDir ?? "") === workDir,
      );
      const pendingChanges =
        exists >= 0
          ? state.pendingChanges.map((c, i) => (i === exists ? entry : c))
          : [...state.pendingChanges, entry];
      return { pendingChanges };
    });
    return id;
  },

  applyPendingChange: (changeId) =>
    set((state) => {
      const change = state.pendingChanges.find((c) => c.id === changeId);
      if (!change) return state;
      if (change.unifiedDiff) {
        // Backend-sourced diff: the file is already written on disk. Applying
        // means acknowledging the change, not rewriting partial content.
        return {
          pendingChanges: state.pendingChanges.filter((c) => c.id !== changeId),
        };
      }
      return {
        files: updateFileInTree(state.files, change.fileId, (n) => ({
          ...n,
          content: change.newContent,
        })),
        pendingChanges: state.pendingChanges.filter((c) => c.id !== changeId),
        openTabs: state.openTabs.map((t) =>
          t.fileId === change.fileId ? { ...t, isDirty: false } : t,
        ),
      };
    }),

  rejectPendingChange: (changeId) =>
    set((state) => ({
      pendingChanges: state.pendingChanges.filter((c) => c.id !== changeId),
    })),

  applyAllPendingChanges: () =>
    set((state) => {
      let files = state.files;
      let openTabs = state.openTabs;
      for (const change of state.pendingChanges) {
        if (change.unifiedDiff) continue; // backend already wrote it; ack only
        files = updateFileInTree(files, change.fileId, (n) => ({
          ...n,
          content: change.newContent,
        }));
        openTabs = openTabs.map((t) =>
          t.fileId === change.fileId ? { ...t, isDirty: false } : t,
        );
      }
      return { files, openTabs, pendingChanges: [] };
    }),

  rejectAllPendingChanges: () => set({ pendingChanges: [] }),

  ackPendingChangesForWorkDir: (workDir) =>
    set((state) => ({
      pendingChanges: state.pendingChanges.filter(
        (c) => (c.workDir ?? "") !== (workDir ?? ""),
      ),
    })),

  // Actions - Goal
  setGoal: (goal) => set({ goal }),

  // Actions - Memory
  // Helix's manual memories are synchronized with Helix's backend memory_manager
  // (memories/MEMORY.md). Helix is the single source of truth; the local `memories`
  // array is an optimistic cache re-synced from the backend so the two systems
  // stop keeping separate copies.
  addMemory: async (entry) => {
    const content = entry.content.trim();
    if (!content) return;
    // optimistic local update (category kept for display only)
    set((state) => ({
      memories: [
        ...state.memories,
        { ...entry, id: generateId(), createdAt: Date.now(), source: "manual" },
      ],
    }));
    if (isElectron()) {
      try {
        await getElectronAPI()?.helix.addMemoryEntry("memory", content);
        await get().loadMemories();
      } catch (e) {
        logError("[helix] addMemory sync failed:", e);
      }
    } else {
      const { persistence } = await import("@/lib/persist");
      persistence.saveMemories(get().memories);
    }
  },
  removeMemory: async (id) => {
    const item = get().memories.find((m) => m.id === id);
    if (!item) return;
    set((state) => ({ memories: state.memories.filter((m) => m.id !== id) }));
    if (isElectron()) {
      try {
        await getElectronAPI()?.helix.removeMemoryEntry("memory", item.content);
      } catch (e) {
        logError("[helix] removeMemory sync failed:", e);
      }
    }
  },
  loadMemories: async () => {
    if (!isElectron()) {
      warn("[helix] loadMemories skipped: not running in Electron");
      return;
    }
    try {
      const api = getElectronAPI();
      if (!api) {
        warn(
          "[helix] loadMemories skipped: electron API not available (did you restart Electron?)",
        );
        return;
      }
      debug("[helix] loadMemories: calling listMemories...");
      let res = await api.helix.listMemories();
      debug("[helix] loadMemories: response", {
        memoryLen: res?.memory?.length,
        userLen: res?.user?.length,
        manualLen: res?.manual?.length,
      });
      if (!res) {
        warn("[helix] loadMemories: got null/undefined response from IPC");
        return;
      }
      // One-time migration: if Helix is empty but legacy local memories exist,
      // push them into Helix so nothing is lost on first sync.
      if ((res.memory?.length ?? 0) === 0) {
        const { persistence } = await import("@/lib/persist");
        const local = await persistence.loadMemories();
        if (local && local.length) {
          for (const m of local) {
            await api.helix.addMemoryEntry("memory", m.content);
          }
          res = await api.helix.listMemories();
        }
      }
      const hashText = (s: string) => {
        let h = 5381;
        for (let i = 0; i < s.length; i++)
          h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
      };
      const manualSet = new Set(res.manual || []);
      const list: MemoryEntry[] = (res.memory || []).map((text) => ({
        id: "hm_" + hashText(text),
        content: text,
        category: "user" as MemoryCategory,
        createdAt: 0,
        source: manualSet.has(text) ? "manual" : "auto",
      }));
      set({ memories: list });
    } catch (e) {
      logError("[helix] loadMemories failed:", e);
    }
  },
  // ── User profile (USER.md) ────────────────────────────────────────────────
  // Separate from MEMORY.md: profile facts about the user that Helix keeps in
  // USER.md. No origin tagging here — everything in USER.md is user-provided.
  addUserMemory: async (entry) => {
    const content = entry.content.trim();
    if (!content) return;
    set((state) => ({
      userMemories: [
        ...state.userMemories,
        { ...entry, id: generateId(), createdAt: Date.now() },
      ],
    }));
    if (isElectron()) {
      try {
        await getElectronAPI()?.helix.addMemoryEntry("user", content);
        await get().loadUserMemories();
      } catch (e) {
        logError("[helix] addUserMemory sync failed:", e);
      }
    }
  },
  removeUserMemory: async (id) => {
    const item = get().userMemories.find((m) => m.id === id);
    if (!item) return;
    set((state) => ({
      userMemories: state.userMemories.filter((m) => m.id !== id),
    }));
    if (isElectron()) {
      try {
        await getElectronAPI()?.helix.removeMemoryEntry("user", item.content);
      } catch (e) {
        logError("[helix] removeUserMemory sync failed:", e);
      }
    }
  },
  loadUserMemories: async () => {
    if (!isElectron()) {
      warn("[helix] loadUserMemories skipped: not running in Electron");
      return;
    }
    try {
      const api = getElectronAPI();
      if (!api) {
        warn("[helix] loadUserMemories skipped: electron API not available");
        return;
      }
      debug("[helix] loadUserMemories: calling listMemories...");
      const res = await api.helix.listMemories();
      debug("[helix] loadUserMemories: response", {
        userLen: res?.user?.length,
      });
      const hashText = (s: string) => {
        let h = 5381;
        for (let i = 0; i < s.length; i++)
          h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
      };
      const list: MemoryEntry[] = (res.user || []).map((text) => ({
        id: "up_" + hashText(text),
        content: text,
        category: "user" as MemoryCategory,
        createdAt: 0,
      }));
      set({ userMemories: list });
    } catch (e) {
      logError("[helix] loadUserMemories failed:", e);
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
          taskIds: state.tasks.map((t) => t.id),
          memorySnapshot: state.memories.map((m) => m.content).join("\n"),
          tasks: JSON.parse(JSON.stringify(state.tasks)) as TaskNode[],
        },
      ],
    })),
  restoreCheckpoint: (id) => {
    const state = get();
    const cp = state.checkpoints.find((c) => c.id === id);
    if (!cp) return;
    const hashText = (s: string) => {
      let h = 5381;
      for (let i = 0; i < s.length; i++)
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    };
    const memories: MemoryEntry[] = cp.memorySnapshot
      .split("\n")
      .map((content) => content.trim())
      .filter(Boolean)
      .map((content) => ({
        id: "cp_" + hashText(content),
        content,
        category: "project" as MemoryCategory,
        createdAt: Date.now(),
        source: "manual" as const,
      }));
    set({
      tasks: cp.tasks
        ? (JSON.parse(JSON.stringify(cp.tasks)) as TaskNode[])
        : [],
      memories,
    });
  },
  removeCheckpoint: (id) =>
    set((state) => ({
      checkpoints: state.checkpoints.filter((c) => c.id !== id),
    })),

  // Actions - Tasks
  addTask: (label, parentId) => {
    const id = generateId();
    const newTask: TaskNode = {
      id,
      label,
      status: "pending",
      parentId: parentId || null,
      depth: 0,
    };
    if (parentId) {
      set((state) => ({
        tasks: state.tasks.map((t) =>
          t.id === parentId
            ? {
                ...t,
                children: [
                  ...(t.children || []),
                  { ...newTask, depth: t.depth + 1 },
                ],
              }
            : t,
        ),
      }));
    } else {
      set((state) => ({ tasks: [...state.tasks, newTask] }));
    }
    return id;
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
      tasks: state.tasks.filter((t) => t.status !== "done"),
    })),

  // Actions - Scheduled Tasks
  addScheduledTask: (task) => {
    const id = task.id || generateId();
    set((state) => ({
      scheduledTasks: [
        ...state.scheduledTasks,
        {
          ...task,
          id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    }));
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveScheduledTasks(get().scheduledTasks),
    );
    return id;
  },
  updateScheduledTask: (taskId, updates) => {
    set((state) => ({
      scheduledTasks: state.scheduledTasks.map((t) =>
        t.id === taskId ? { ...t, ...updates, updatedAt: Date.now() } : t,
      ),
    }));
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveScheduledTasks(get().scheduledTasks),
    );
  },
  removeScheduledTask: (taskId) => {
    set((state) => ({
      scheduledTasks: state.scheduledTasks.filter((t) => t.id !== taskId),
    }));
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveScheduledTasks(get().scheduledTasks),
    );
  },
  toggleScheduledTask: (taskId) => {
    set((state) => ({
      scheduledTasks: state.scheduledTasks.map((t) =>
        t.id === taskId
          ? { ...t, enabled: !t.enabled, updatedAt: Date.now() }
          : t,
      ),
    }));
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveScheduledTasks(get().scheduledTasks),
    );
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
      const { [name]: _, ...rest } = state.mcpServers;
      return { mcpServers: rest };
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
    let secret = svc.secret;
    let secretEncrypted = false;
    if (secret && typeof window !== "undefined" && window.electron?.secure) {
      try {
        const available = await window.electron.secure.available();
        if (available) {
          secret = (await window.electron.secure.encrypt(secret)) ?? undefined;
          secretEncrypted = true;
        }
      } catch {
        /* fall back to plaintext */
      }
    }
    const entry: ExternalService = {
      ...svc,
      secret,
      secretEncrypted,
      id: `ext_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      connected: false,
      createdAt: Date.now(),
    };
    set((state) => ({ externalServices: [...state.externalServices, entry] }));
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveSetting("externalServices", get().externalServices),
    );
  },
  updateExternalService: async (id, patch) => {
    let secret = patch.secret;
    let secretEncrypted = patch.secretEncrypted;
    if (
      secret !== undefined &&
      typeof window !== "undefined" &&
      window.electron?.secure
    ) {
      try {
        const available = await window.electron.secure.available();
        if (available) {
          secret = (await window.electron.secure.encrypt(secret)) ?? undefined;
          secretEncrypted = true;
        }
      } catch {
        /* fall back to plaintext */
      }
    }
    set((state) => ({
      externalServices: state.externalServices.map((s) =>
        s.id === id
          ? {
              ...s,
              ...patch,
              ...(secret !== undefined ? { secret, secretEncrypted } : {}),
            }
          : s,
      ),
    }));
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveSetting("externalServices", get().externalServices),
    );
  },
  removeExternalService: (id) => {
    set((state) => ({
      externalServices: state.externalServices.filter((s) => s.id !== id),
    }));
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveSetting("externalServices", get().externalServices),
    );
  },
  setExternalServiceConnected: (id, connected) => {
    set((state) => ({
      externalServices: state.externalServices.map((s) =>
        s.id === id ? { ...s, connected } : s,
      ),
    }));
    import("@/lib/persist").then(({ persistence }) =>
      persistence.saveSetting("externalServices", get().externalServices),
    );
  },
  setSshConnected: (connected, serviceId = null) => {
    set({ sshConnected: connected, sshServiceId: serviceId });
  },

  // Actions - Webhooks/Artifacts — removed (unused features)

  // Actions - Custom Shortcuts
  addCustomShortcut: (id, shortcut) =>
    set((state) => ({
      customShortcuts: { ...state.customShortcuts, [id]: shortcut },
    })),
  removeCustomShortcut: (id) =>
    set((state) => {
      const { [id]: _, ...rest } = state.customShortcuts;
      return { customShortcuts: rest };
    }),
  updateCustomShortcut: (id, shortcut) =>
    set((state) => {
      const customizedIds = new Set(state.customizedShortcutIds);
      customizedIds.add(id);
      return {
        customShortcuts: { ...state.customShortcuts, [id]: shortcut },
        customizedShortcutIds: customizedIds,
      };
    }),

  // Actions - Webhooks/Artifacts — removed (unused features)

  // API Config — in slices/api-config-slice.ts

  // Actions - Sub-agents
  spawnSubAgent: (name, description, parentId, agentId, sessionId, text) => {
    // 外部传入 agentId（serve 后端 subagent_id）时沿用，保证后续 subagent.*
    // 事件（tool/complete）能按同一 id 命中；无则本地生成。
    const id = agentId || generateId();
    const agent: SubAgent = {
      id,
      name,
      description,
      status: "running",
      parentId: parentId || null,
      chatMessageId: null,
      createdAt: Date.now(),
      // 会话归属快照：spawn 后切换会话不会改变归属；缺省记为当前会话，
      // 供面板按 currentSessionId 过滤（见 helix-layout 工作面板）。
      sessionId: sessionId ?? get().currentSessionId ?? undefined,
      ...(text ? { text } : {}),
    };
    set((s) => ({ subAgents: [...s.subAgents, agent] }));
    return id;
  },

  completeSubAgent: (agentId, result, filesModified) =>
    set((s) => ({
      subAgents: s.subAgents.map((a) =>
        a.id === agentId
          ? {
              ...a,
              status: "completed" as const,
              completedAt: Date.now(),
              result,
              filesModified,
              // 未收尾的工具调用统一标记成功，避免残留"运行中"状态
              toolCalls: (a.toolCalls || []).map((tc) =>
                tc.status === "running"
                  ? { ...tc, status: "success" as const }
                  : tc,
              ),
            }
          : a,
      ),
    })),

  failSubAgent: (agentId, error) =>
    set((s) => ({
      subAgents: s.subAgents.map((a) =>
        a.id === agentId
          ? {
              ...a,
              status: "failed" as const,
              completedAt: Date.now(),
              result: error,
              toolCalls: (a.toolCalls || []).map((tc) =>
                tc.status === "running"
                  ? { ...tc, status: "error" as const }
                  : tc,
              ),
            }
          : a,
      ),
    })),

  cancelSubAgent: (agentId) =>
    set((s) => ({
      subAgents: s.subAgents.map((a) =>
        a.id === agentId
          ? { ...a, status: "cancelled" as const, completedAt: Date.now() }
          : a,
      ),
    })),

  clearCompletedSubAgents: () =>
    set((s) => ({
      subAgents: s.subAgents.filter((a) => a.status === "running"),
    })),

  addSubAgentToolCall: (agentId, toolCall) =>
    set((s) => ({
      subAgents: s.subAgents.map((a) =>
        a.id === agentId
          ? {
              ...a,
              toolCalls: [
                ...(a.toolCalls || []),
                { ...toolCall, timestamp: Date.now() },
              ],
            }
          : a,
      ),
    })),

  updateSubAgentToolCallStatus: (agentId, toolName, status) =>
    set((s) => ({
      subAgents: s.subAgents.map((a) =>
        a.id === agentId
          ? {
              ...a,
              toolCalls: (a.toolCalls || []).map((tc) =>
                tc.toolName === toolName && tc.status === "running"
                  ? { ...tc, status }
                  : tc,
              ),
            }
          : a,
      ),
    })),

  setSubAgentAgentId: (agentId, extAgentId) =>
    set((s) => ({
      subAgents: s.subAgents.map((a) =>
        a.id === agentId && !a.agentId ? { ...a, agentId: extAgentId } : a,
      ),
    })),

  reviveSubAgentForRun: (agentId, description) =>
    set((s) => ({
      subAgents: s.subAgents.map((a) =>
        a.id === agentId
          ? {
              ...a,
              status: "running" as const,
              completedAt: undefined,
              result: undefined,
              description: description || a.description,
            }
          : a,
      ),
    })),

  rehydrateSubAgentsFromDisk: (sessionId, diskAgents) => {
    if (diskAgents.length === 0) return;
    set((s) => {
      const known = new Set(s.subAgents.map((a) => a.id));
      const rebuilt = diskAgents
        .filter((d) => !known.has(d.id))
        .map((d) => {
          // Disk "running" means the manifest never saw a terminal record —
          // after a restart that child process is dead, not still working.
          const interrupted = !d.status || d.status === "running";
          return {
            id: d.id,
            name: d.goal || d.id,
            description: d.goal || d.id,
            status: (interrupted
              ? "cancelled"
              : d.status === "failed" || d.status === "error"
                ? "failed"
                : "completed") as SubAgent["status"],
            parentId: null,
            chatMessageId: null,
            createdAt: Date.now(),
            completedAt: interrupted ? Date.now() : undefined,
            result: d.summary || (interrupted ? "重启时中断" : undefined),
            // 必须 stamp 会话键：这些磁盘记录是经「当前会话的 backend sid」查出来的
            // （checkDelegations 用 resolveBackendSids(currentSessionId)），天然归属
            // 当前对话。不 stamp 的话卡片对每个会话都可见 → 工作面板会把所有会话的
            // 历史子 Agent 混在一起（全局共享），正是要修的 bug。stamp 后由
            // helix-layout 的 `a.sessionId === currentSessionId` 过滤，只在所属对话出现。
            sessionId: sessionId ?? undefined,
            agentId: d.agentId,
            ...(d.prompt ? { text: d.prompt } : {}),
          };
        });
      if (rebuilt.length === 0) return {};
      return { subAgents: [...s.subAgents, ...rebuilt] };
    });
  },

  // Actions - Persistence
  persistToStorage: async () => {
    try {
      const { persistence } = await import("@/lib/persist");
      const state = get();
      const sessionId = "current-session";
      await Promise.all([
        persistence.saveMemories(state.memories),
        persistence.saveTasks(state.tasks),
        persistence.saveCheckpoints(state.checkpoints),
        persistence.saveNotes(state.notes),
        persistence.saveChatMessages(
          state.chatMessages.map((m) => ({
            id: m.id,
            sessionId,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
            isStreaming: m.isStreaming ?? false,
            fileChanges: m.fileChanges,
          })),
          sessionId,
        ),
        persistence.saveSetting("goal", state.goal),
        persistence.saveSetting("apiConfig", state.apiConfig),
        persistence.saveSetting("apiHistory", state.apiHistory),
        persistence.saveSetting("apiProfiles", state.apiProfiles),
        persistence.saveSetting("activeProfileId", state.activeProfileId),
        persistence.saveSetting("providers", state.providers),
        persistence.saveSetting("activeModel", state.activeModel),
        persistence.saveSetting("activeProviderId", state.activeProviderId),
        // Persist the per-provider fetched model lists alongside other config so
        // they never get lost between a fetch and the next full persistToStorage.
        persistence.saveSetting("providerModels", state.providerModels),
        persistence.saveSetting("fontFamily", state.fontFamily),
        persistence.saveSetting("fontSize", state.fontSize),
        persistence.saveSetting("interfaceFont", state.interfaceFont),
        persistence.saveSetting("transcriptFontSize", state.transcriptFontSize),
        persistence.saveSetting("themeStyle", state.themeStyle),
        persistence.saveSetting("sessionUsageStats", state.sessionUsageStats),
        persistence.saveSetting("contextUsage", state.contextUsage),
        persistence.saveSetting("compressionRecords", state.compressionRecordsBySession),
        persistence.saveSetting("dailyUsage", state.dailyUsage),
        persistence.saveScheduledTasks(state.scheduledTasks),
        persistence.saveSetting("mcpServers", state.mcpServers),
        persistence.saveSetting("externalServices", state.externalServices),
        persistence.saveSetting(
          "customizedShortcutIds",
          Array.from(state.customizedShortcutIds),
        ),
        persistence.saveSetting("agentMaxIterations", state.agentMaxIterations),
        persistence.saveSetting("autoCompactContext", state.autoCompactContext),
        persistence.saveSetting("autoSaveSession", state.autoSaveSession),
        persistence.saveSetting("reasoningEffort", state.reasoningEffort),
        persistence.saveSetting("personality", state.personality),
        persistence.saveSetting("fastMode", state.fastMode),
        persistence.saveSetting("terminalShell", state.terminalShell),
        persistence.saveSetting("approvalMode", state.approvalMode),
        persistence.saveSetting(
          "approvalModeBySession",
          state.approvalModeBySession,
        ),
        persistence.saveSetting("modelBySession", state.modelBySession),
        persistence.saveSetting("startupGreeting", state.startupGreeting),
        persistence.saveSetting(
          "bootBackgroundImage",
          state.bootBackgroundImage,
        ),
        persistence.saveSetting("editorTheme", state.editorTheme),
        persistence.saveSetting("gitAutoCommit", state.gitAutoCommit),
        persistence.saveSetting("gitAutoPush", state.gitAutoPush),
        persistence.saveSetting("gitPushConfirm", state.gitPushConfirm),
        persistence.saveSetting("gitAutoBranch", state.gitAutoBranch),
        persistence.saveSetting("gitRemoteUrl", state.gitRemoteUrl),
        persistence.saveSetting("gitCommitTemplate", state.gitCommitTemplate),
        persistence.saveSetting("gitBranchPrefix", state.gitBranchPrefix),
        persistence.saveSetting("sessionHistory", state.sessionHistory),
        persistence.saveSetting(
          "sessionHistoryIndex",
          state.sessionHistoryIndex,
        ),
        persistence.saveSetting("selectedWorkDir", state.selectedWorkDir),
        persistence.saveSetting("hasOnboarded", state.hasOnboarded),
      ]);
    } catch (e) {
      logError("Failed to persist:", e);
      get().showToast({
        type: "error",
        title: "设置保存失败",
        description: "配置未能写入本地存储，请重试",
      });
    }
  },

  restoreFromStorage: async () => {
    try {
      const { persistence } = await import("@/lib/persist");
      const sessionId = "current-session";

      // MCP config is now managed by Helix
      const fileMcpConfig: Record<string, any> = {};

      // Helper: load a setting without throwing — a single corrupted key
      // must not fail the entire restore (common on Windows after crashes).
      const safeLoad = <T>(
        promise: Promise<T | null>,
        key: string,
      ): Promise<T | null> =>
        promise.catch((e) => {
          logError(`[restore] failed to load ${key}:`, e);
          return null;
        });

      // Early-load the boot background image so the splash screen paints WITH
      // it on the first frame instead of flashing the "no image" version first.
      // The image lives in the same settings batch below (a ~5MB base64 blob
      // mixed with ~30 other awaits); waiting for that whole batch makes the
      // splash show without the picture, then pop it in a beat later. Loading it
      // here as a standalone read lets it settle within a few ms of first paint.
      // The later batch still loads it too, and the final `set` uses
      // `?? get().bootBackgroundImage`, so this early set is strictly additive.
      safeLoad(
        persistence.loadSetting<string | null>("bootBackgroundImage"),
        "bootBackgroundImage-early",
      ).then((img) => {
        if (img) set({ bootBackgroundImage: img });
      });

      // Try loading the latest saved session first (full state)
      const sessions =
        (await safeLoad(persistence.loadSessions(), "sessions")) || [];
      const archivedSessions = sessions.filter((s) => s.isArchived);
      const latestSession =
        sessions.filter((s) => !s.isArchived).length > 0
          ? sessions
              .filter((s) => !s.isArchived)
              .sort((a, b) => b.savedAt - a.savedAt)[0]
          : null;

      // Load individual pieces for settings and non-session state
      const [
        memories,
        tasks,
        checkpoints,
        notes,
        chatMessages,
        goal,
        apiConfig,
        apiHistory,
        apiProfiles,
        fontFamily,
        fontSize,
        interfaceFont,
        transcriptFontSize,
        themeStyle,
        sessionUsageStats,
        dailyUsage,
        scheduledTasks,
        mcpServers,
        customShortcuts,
        customizedIdsArr,
        agentMaxIterations,
        autoCompactContext,
        autoSaveSession,
        availableModels,
        providerModels,
        reasoningEffort,
        personality,
        fastMode,
        terminalShell,
        editorTheme,
        gitAutoCommit,
        gitAutoPush,
        gitPushConfirm,
        gitAutoBranch,
        gitRemoteUrl,
        gitCommitTemplate,
        gitBranchPrefix,
        approvalMode,
        approvalModeBySession,
        modelBySession,
        startupGreeting,
        bootBackgroundImage,
        providers,
        activeModel,
        activeProviderId,
        savedSessionHistory,
        savedSessionHistoryIndex,
        savedSelectedWorkDir,
        loadedHasOnboarded,
        contextUsage,
        externalServices,
        compressionRecordsBySession,
      ] = await Promise.all([
        safeLoad(persistence.loadMemories(), "memories"),
        safeLoad(persistence.loadTasks(), "tasks"),
        safeLoad(persistence.loadCheckpoints(), "checkpoints"),
        safeLoad(persistence.loadNotes(), "notes"),
        safeLoad(
          persistence.loadChatMessagesBySession(sessionId),
          "chatMessages",
        ),
        safeLoad(persistence.loadSetting<string | null>("goal"), "goal"),
        safeLoad(persistence.loadSetting<ApiConfig>("apiConfig"), "apiConfig"),
        safeLoad(
          persistence.loadSetting<ApiConfig[]>("apiHistory"),
          "apiHistory",
        ),
        safeLoad(
          persistence.loadSetting<ApiProfile[]>("apiProfiles"),
          "apiProfiles",
        ),
        safeLoad(persistence.loadSetting<string>("fontFamily"), "fontFamily"),
        safeLoad(persistence.loadSetting<number>("fontSize"), "fontSize"),
        safeLoad(
          persistence.loadSetting<string>("interfaceFont"),
          "interfaceFont",
        ),
        safeLoad(
          persistence.loadSetting<number>("transcriptFontSize"),
          "transcriptFontSize",
        ),
        safeLoad(persistence.loadSetting<string>("themeStyle"), "themeStyle"),
        safeLoad(
          persistence.loadSetting<{
            requestCount: number;
            totalTokens: number;
            inputTokens: number;
            outputTokens: number;
            thoughtTokens: number;
            cachedReadTokens: number;
            cachedWriteTokens: number;
          }>("sessionUsageStats"),
          "sessionUsageStats",
        ),
        safeLoad(
          persistence.loadSetting<Record<string, DailyUsageEntry>>(
            "dailyUsage",
          ),
          "dailyUsage",
        ),
        safeLoad(
          persistence.loadSetting<any[]>("scheduledTasks"),
          "scheduledTasks",
        ),
        safeLoad(
          persistence.loadSetting<Record<string, McpServerConfig>>(
            "mcpServers",
          ),
          "mcpServers",
        ),
        safeLoad(
          persistence.loadSetting<
            Record<
              string,
              { keys: string[]; action: string; description: string }
            >
          >("customShortcuts"),
          "customShortcuts",
        ),
        safeLoad(
          persistence.loadSetting<string[]>("customizedShortcutIds"),
          "customizedShortcutIds",
        ),
        safeLoad(
          persistence.loadSetting<number>("agentMaxIterations"),
          "agentMaxIterations",
        ),
        safeLoad(
          persistence.loadSetting<boolean>("autoCompactContext"),
          "autoCompactContext",
        ),
        safeLoad(
          persistence.loadSetting<boolean>("autoSaveSession"),
          "autoSaveSession",
        ),
        safeLoad(
          persistence.loadSetting<string[]>("availableModels"),
          "availableModels",
        ),
        safeLoad(
          persistence.loadSetting<Record<string, string[]>>("providerModels"),
          "providerModels",
        ),
        safeLoad(
          persistence.loadSetting<string>("reasoningEffort"),
          "reasoningEffort",
        ),
        safeLoad(persistence.loadSetting<string>("personality"), "personality"),
        safeLoad(persistence.loadSetting<boolean>("fastMode"), "fastMode"),
        safeLoad(
          persistence.loadSetting<"auto" | "cmd" | "pwsh" | "powershell">(
            "terminalShell",
          ),
          "terminalShell",
        ),
        safeLoad(persistence.loadSetting<string>("editorTheme"), "editorTheme"),
        safeLoad(
          persistence.loadSetting<boolean>("gitAutoCommit"),
          "gitAutoCommit",
        ),
        safeLoad(
          persistence.loadSetting<boolean>("gitAutoPush"),
          "gitAutoPush",
        ),
        safeLoad(
          persistence.loadSetting<boolean>("gitPushConfirm"),
          "gitPushConfirm",
        ),
        safeLoad(
          persistence.loadSetting<boolean>("gitAutoBranch"),
          "gitAutoBranch",
        ),
        safeLoad(
          persistence.loadSetting<string>("gitRemoteUrl"),
          "gitRemoteUrl",
        ),
        safeLoad(
          persistence.loadSetting<string>("gitCommitTemplate"),
          "gitCommitTemplate",
        ),
        safeLoad(
          persistence.loadSetting<string>("gitBranchPrefix"),
          "gitBranchPrefix",
        ),
        safeLoad(
          persistence.loadSetting<string>("approvalMode"),
          "approvalMode",
        ),
        safeLoad(
          persistence.loadSetting<Record<string, ApprovalMode>>(
            "approvalModeBySession",
          ),
          "approvalModeBySession",
        ),
        safeLoad(
          persistence.loadSetting<
            Record<string, { provider: string; model: string }>
          >("modelBySession"),
          "modelBySession",
        ),
        safeLoad(
          persistence.loadSetting<string>("startupGreeting"),
          "startupGreeting",
        ),
        safeLoad(
          persistence.loadSetting<string | null>("bootBackgroundImage"),
          "bootBackgroundImage",
        ),
        safeLoad(
          persistence.loadSetting<ProviderConfig[]>("providers"),
          "providers",
        ),
        safeLoad(
          persistence.loadSetting<string | null>("activeModel"),
          "activeModel",
        ),
        safeLoad(
          persistence.loadSetting<string | null>("activeProviderId"),
          "activeProviderId",
        ),
        safeLoad(
          persistence.loadSetting<string[]>("sessionHistory"),
          "sessionHistory",
        ),
        safeLoad(
          persistence.loadSetting<number>("sessionHistoryIndex"),
          "sessionHistoryIndex",
        ),
        safeLoad(
          persistence.loadSetting<string | null>("selectedWorkDir"),
          "selectedWorkDir",
        ),
        safeLoad(
          persistence.loadSetting<boolean>("hasOnboarded"),
          "hasOnboarded",
        ),
        safeLoad(
          persistence.loadSetting<{ size: number; used: number } | null>(
            "contextUsage",
          ),
          "contextUsage",
        ),
        safeLoad(
          persistence.loadSetting<ExternalService[]>("externalServices"),
          "externalServices",
        ),
        safeLoad(
          persistence.loadSetting<
            Record<
              string,
              import("./slices/compression-records-slice").PersistedCompressionRecord[]
            > | null
          >("compressionRecords"),
          "compressionRecords",
        ),
      ]);

      // 启动时恢复上次打开的会话及其历史，模型重新建会话时会用这些消息
      // 作为 seed history，避免每次重启都像新对话一样丢失上下文。
      const defaults = {
        provider: "custom" as const,
        apiKey: "",
        baseUrl: "",
        model: "",
      };
      let defaultSessionsDir: string | null = null;
      try {
        defaultSessionsDir = await getDefaultSessionsDir();
      } catch {
        // Electron bridge unavailable — leave default empty
      }
      // Restore which named profile was active before the restart, so the selection
      // survives a cold start (the profile list itself is persisted to IndexedDB).
      const loadedActiveProfileId =
        (await safeLoad(
          persistence.loadSetting<string | null>("activeProfileId"),
          "activeProfileId",
        )) ?? null;

      // ── Build multi-provider config for the flattened model selector ──
      // Always rebuild `builtProviders` from the authoritative declared sources
      // (apiProfiles / apiConfig). We do NOT trust the persisted `providers`
      // field as a source of truth — it is a *runtime output* mirror that was
      // historically polluted by merged fetched-model lists and would re-seed
      // the pollution on every restart. The legacy apiProfiles / apiConfig
      // backfill keeps older installs working without data loss.
      //
      // SELF-HEAL for already-polluted installs:
      // `apiProfiles[].models` is the AUTHORITATIVE declared list — the new
      // settings save path (handleSaveApi → updateApiProfileConfig) writes the
      // user's "已添加的模型" list here, so p.models is exactly what the user
      // wants to see in the level-2 cards. We do NOT consult the endpoint
      // catalog cache (providerModels[pid]) as an authoritative replacement:
      // that cache holds the endpoint's full /models directory, and treating
      // it as authoritative would re-inject hundreds of models the user never
      // added into the profile, which is exactly the "只保存了一个模型，二级
      // 卡片却把所有模型都显示" bug. `p.models` wins; if it's empty for a
      // legacy profile we fall back to `p.config.model` (and later to
      // apiHistory below).
      const cleanedProviderModels: Record<string, string[]> = {};
      for (const [pid, models] of Object.entries(providerModels || {})) {
        if (models && models.length) cleanedProviderModels[pid] = models;
      }
      const cleanProfileModels = (p: ApiProfile): string[] => {
        // Declared list is authoritative. Only fall back to the active config
        // model when nothing was declared (very old profile shapes).
        const declared = Array.isArray(p.models)
          ? p.models.filter((m): m is string => typeof m === "string" && !!m)
          : [];
        if (declared.length > 0) return declared;
        return p.config?.model ? [p.config.model] : [];
      };
      const builtProviders: ProviderConfig[] =
        apiProfiles && apiProfiles.length > 0
          ? apiProfiles.map((p, i) => {
              // Scrub cross-endpoint pollution; if that leaves a profile with
              // NO models, re-seed it from its own history endpoint so a
              // deepseek profile that had its models polluted by another
              // supplier's list still surfaces the correct model
              // (e.g. deepseek-v4-pro) instead of going empty.
              let models = cleanProfileModels(p);
              if (models.length === 0 && p.config?.baseUrl) {
                const histModels = Array.from(
                  new Set(
                    (apiHistory || [])
                      .filter((h) => h.baseUrl === p.config!.baseUrl && h.model)
                      .map((h) => h.model as string),
                  ),
                );
                if (histModels.length) models = histModels;
              }
              return {
                id: p.id || `p-${i}`,
                name: p.config?.provider || p.name,
                baseUrl: p.config?.baseUrl || "",
                apiKey: p.config?.apiKey || "",
                models,
                isDefault: p.id === loadedActiveProfileId,
              };
            })
          : apiConfig && apiConfig.baseUrl && apiConfig.model
            ? [
                {
                  id: "p-default",
                  name: apiConfig.provider || "default",
                  baseUrl: apiConfig.baseUrl,
                  apiKey: apiConfig.apiKey,
                  models: [apiConfig.model],
                  isDefault: true,
                },
              ]
            : [];
      // ── Include history-only endpoints as providers ──
      // An endpoint the user has only ever used via "添加模型" (landing in
      // apiHistory) but never saved as an apiProfile has NO provider entry. On
      // restoreFromStorage the persisted activeModel then can't be validated by
      // any provider and silently falls back to the default provider's first
      // model (e.g. Ling) — so clicking a deepseek/kimi history item appears to
      // "switch to Ling" after a refresh. Synthesize a provider for every
      // history endpoint not already covered by a named profile, so the active
      // model stays pinned to the endpoint it belongs to.
      const historyProviders: ProviderConfig[] = [];
      {
        const seenBase = new Set(builtProviders.map((p) => p.baseUrl));
        const hist = (apiHistory || []) as Array<{
          baseUrl?: string;
          apiKey?: string;
          model?: string;
          provider?: string;
        }>;
        // Single O(n) pass: group history entries by endpoint instead of the old
        // O(n²) approach that re-filtered the whole list per unique baseUrl.
        const byBase = new Map<
          string,
          { apiKey: string; provider?: string; models: Set<string> }
        >();
        for (const h of hist) {
          if (!h.baseUrl || !h.model) continue;
          if (seenBase.has(h.baseUrl)) continue;
          let entry = byBase.get(h.baseUrl);
          if (!entry) {
            entry = {
              apiKey: h.apiKey || "",
              provider: h.provider,
              models: new Set<string>(),
            };
            byBase.set(h.baseUrl, entry);
            seenBase.add(h.baseUrl);
          }
          entry.models.add(h.model);
        }
        for (const [baseUrl, entry] of byBase) {
          historyProviders.push({
            id: `hist-${historyProviders.length}`,
            name: entry.provider || "配置",
            baseUrl,
            apiKey: entry.apiKey,
            models: Array.from(entry.models),
            isDefault: false,
          });
        }
      }
      const allBuiltProviders = [...builtProviders, ...historyProviders];
      // `allBuiltProviders` IS the merged set. Do NOT union in the endpoint
      // catalog cache (providerModels[pid]) here either — doing so would
      // re-introduce the "所有模型都显示" bug at the restore layer even
      // after the UI-level fix. `p.models` (from apiProfiles or
      // apiHistory-derived historyProviders) is the only candidate list we
      // consult for the level-2 cards.
      const mergedProviders: ProviderConfig[] = allBuiltProviders;
      // Canonical restore logic: the active model is whatever IndexedDB persisted
      // as `activeModel`. If that model is not declared by any provider, fall
      // back to the default provider's first model.
      // Honor the persisted active model even when it is only present in a
      // fetched list (providerModels) and not in the declared `models[]` yet —
      // e.g. a model picked from "获取模型列表". The previous logic dropped it
      // back to the default provider's `models[0]` (deepseek-v4-pro) whenever
      // the fetched list hadn't hydrated at restore time, which reverted every
      // launch to pro. Keeping the user's explicit choice here is safe.
      const builtActiveModel: string | null =
        // 以用户最后选择的 activeModel 为准；profile 只在没有 activeModel 时兜底，
        // 避免“手动选了新模型，重启后又被 profile 里的旧模型覆盖”。
        (() => {
          if (activeModel) return activeModel;
          if (loadedActiveProfileId) {
            const prof = (apiProfiles || []).find(
              (p) => p.id === loadedActiveProfileId,
            );
            if (prof?.config?.model) return prof.config.model;
          }
          return mergedProviders.length > 0
            ? mergedProviders.find(
                (p) => p.isDefault && (p.models?.length || 0) > 0,
              )?.models[0] ||
                mergedProviders.find((p) => (p.models?.length || 0) > 0)
                  ?.models[0] ||
                null
            : null;
        })();
      // Resolve the active provider: prefer the owner of the active model, then
      // a saved id that still exists (only when it agrees with that owner or the
      // model has no clear owner), then the default/first provider.
      const builtActiveProviderId: string | null = (() => {
        // Re-anchor to the active model's OWNER first. A saved activeProviderId
        // can be stale — handleSaveApi/applyProfile used to sync activeModel
        // without re-anchoring it, leaving the id pointing at an older provider
        // (e.g. an older provider) while the active model belongs to another
        // endpoint (e.g. DeepSeek). The stale id then scoped providerModels writes and the chat
        // dropdown's open-refetch to the WRONG endpoint, collapsing the fetched
        // list to the single declared model. Trusting the saved id only when it
        // points at the same endpoint as the model owner keeps them in lockstep.
        if (builtActiveModel) {
          const owner = mergedProviders.find((p) =>
            p.models.includes(builtActiveModel),
          );
          if (owner) {
            if (!activeProviderId) return owner.id;
            const saved = mergedProviders.find(
              (p) => p.id === activeProviderId,
            );
            if (!saved || saved.baseUrl === owner.baseUrl) return owner.id;
            warn(
              "[restoreFromStorage] activeProviderId stale, re-anchoring to model owner:",
              activeProviderId,
              "→",
              owner.id,
            );
            return owner.id;
          }
          // Fallback: locate the owner via providerModels when the model isn't
          // present in the merged declared+fetched pool (e.g. providerModels
          // loaded but not yet merged), so the active provider scope stays
          // correct instead of drifting to the default/first provider.
          for (const p of mergedProviders) {
            if ((providerModels?.[p.id] || []).includes(builtActiveModel))
              return p.id;
          }
        }
        if (
          activeProviderId &&
          mergedProviders.some((p) => p.id === activeProviderId)
        ) {
          return activeProviderId;
        }
        return (
          mergedProviders.find((p) => p.isDefault)?.id ||
          mergedProviders[0]?.id ||
          null
        );
      })();

      // Prune sessionHistory: remove IDs that no longer exist in IndexedDB
      const validSessionIds = new Set(sessions.map((s) => s.id));
      const prunedHistory = Array.isArray(savedSessionHistory)
        ? savedSessionHistory.filter((id) => validSessionIds.has(id))
        : [];
      const prunedIndex =
        savedSessionHistoryIndex != null &&
        savedSessionHistoryIndex < prunedHistory.length
          ? savedSessionHistoryIndex
          : prunedHistory.length - 1;
      const restoredSessionId = latestSession?.id ?? null;
      const restoredHistory =
        latestSession && !prunedHistory.includes(latestSession.id)
          ? [latestSession.id, ...prunedHistory]
          : prunedHistory;
      const restoredIndex = latestSession
        ? prunedHistory.includes(latestSession.id)
          ? prunedIndex
          : 0
        : prunedIndex;

      // 恢复导航栈：优先用持久化的 navigationHistory/navigationIndex（含
      // 设置页条目）；旧版本/缺失时用 sessionHistory 重建 chat-only 栈。
      const [savedNavHistory, savedNavIndex] = await Promise.all([
        safeLoad(
          persistence.loadSetting<
            Array<
              | { type: "chat"; sessionId: string }
              | { type: "settings"; page: string }
            >
          >("navigationHistory"),
          "navigationHistory",
        ),
        safeLoad(
          persistence.loadSetting<number>("navigationIndex"),
          "navigationIndex",
        ),
      ]);
      const navHistory =
        Array.isArray(savedNavHistory) && savedNavHistory.length > 0
          ? savedNavHistory
          : restoredHistory.map((id) => ({
              type: "chat" as const,
              sessionId: id,
            }));
      const navIndex =
        typeof savedNavIndex === "number" &&
        savedNavIndex >= 0 &&
        Array.isArray(savedNavHistory) &&
        savedNavHistory.length > 0
          ? savedNavIndex
          : restoredIndex;
      get().restoreNavigation(navHistory, navIndex, validSessionIds);

      // Heal a historically polluted startupGreeting: a transient dev-state
      // restore once paired this destructure slot with the bootBackgroundImage
      // load, copying the ~1MB background-image data URL into the greeting
      // (persisted on the next save). The empty conversation state renders this
      // string verbatim, so the user saw a wall of base64 instead of the
      // greeting. A greeting is short user text — a data URL or anything over
      // 500 chars can only be pollution. Reset to the default AND write the
      // healed value back so the bad record doesn't come back on next start.
      const DEFAULT_STARTUP_GREETING = "有什么可以帮你的？";
      let healedStartupGreeting =
        startupGreeting || get().startupGreeting || DEFAULT_STARTUP_GREETING;
      if (
        healedStartupGreeting.startsWith("data:") ||
        healedStartupGreeting.length > 500
      ) {
        healedStartupGreeting = DEFAULT_STARTUP_GREETING;
        safeLoad(
          persistence.saveSetting("startupGreeting", healedStartupGreeting),
          "startupGreeting-heal",
        ).catch(() => {});
      }

      set({
        // memories are global and owned by the Helix backend (memories/MEMORY.md);
        // do NOT overwrite them from a per-session snapshot.
        tasks: tasks as TaskNode[],
        checkpoints: checkpoints as SessionCheckpoint[],
        notes: notes || "",
        goal: goal,
        // 恢复上次打开的会话和它的历史，避免重启后模型/界面都变成新对话。
        // 没有可恢复的会话时（restoredSessionId 为 null）置 noActiveConversation，
        // 界面停在「无会话」占位：用户必须显式点「新对话」或选会话才进入草稿，
        // 避免首条消息悄悄创建后端会话文件（"自己建文件"的根因）。
        currentSessionId: restoredSessionId,
        noActiveConversation: !restoredSessionId,
        activeSessionWorkDir: latestSession?.workDir ?? null,
        sessionHistory: restoredHistory,
        sessionHistoryIndex: restoredIndex,
        // 没选项目时默认使用 Helix sessions 目录；恢复会话时跟随会话自己的目录。
        selectedWorkDir: latestSession?.workDir ?? defaultSessionsDir,
        // Never downgrade a fresh true set while restore was still loading.
        // Startup renders from the default false before IndexedDB finishes;
        // clicking "skip/start" in that window must not be overwritten by the
        // stale restored false.
        hasOnboarded: get().hasOnboarded || loadedHasOnboarded === true,
        apiConfig: (() => {
          const resolve = (cfg: any) => {
            // Validation gate: reject stale/bad profiles so a poisoned IndexedDB
            // entry can never re-enter the store and get pushed to Helix.
            if (!cfg || !cfg.baseUrl) {
              return { ...defaults };
            }
            const merged = { ...defaults, ...cfg };
            return merged;
          };
          // Prefer the active provider built from providers/activeModel — this is
          // what the model selector treats as current, so apiConfig must agree.
          const activeProv = builtActiveProviderId
            ? mergedProviders.find((p) => p.id === builtActiveProviderId)
            : undefined;
          if (activeProv && activeProv.baseUrl) {
            return resolve({
              provider: activeProv.name,
              baseUrl: activeProv.baseUrl,
              apiKey: activeProv.apiKey,
              model:
                builtActiveModel ||
                activeProv.models[0] ||
                activeProv.defaultModel ||
                "",
            });
          }
          if (loadedActiveProfileId) {
            const prof = (apiProfiles || []).find(
              (p) => p.id === loadedActiveProfileId,
            );
            if (prof && prof.config) {
              return resolve(prof.config);
            }
          }
          const p = apiConfig;
          if (!p || !p.baseUrl) {
            return { ...defaults };
          }
          return resolve(p);
        })(),
        apiHistory: (() => {
          const raw = apiHistory || [];
          // Deduplicate by baseUrl + apiKey: one CONFIG is one history entry
          // (the list groups by baseUrl and entries within a group differ by
          // apiKey). Model changes on the same connection update that entry in
          // place, so persisted duplicates from older builds — several entries
          // with the same endpoint+key but different models — collapse here.
          // The list is ordered most-recent-first, so the first occurrence kept
          // is the newest model for that config.
          const seen = new Set<string>();
          const normKey = (k?: string) => (k ?? "").trim();
          return raw.filter((h) => {
            if (!h.model || !h.baseUrl) return false;
            const key = `${h.baseUrl}|${normKey(h.apiKey)}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        })(),
        apiProfiles: (() => {
          const loaded = apiProfiles || [];
          if (loaded.length > 0) {
            // Backfill + SELF-HEAL models[] for existing profiles. We reuse
            // cleanProfileModels() so a profile's models are scrubbed of
            // cross-endpoint pollution (using providerModels[pid] when present)
            // and rewritten to IndexedDB below via persistToStorage on the next
            // save — permanently removing "一堆放一起" without user action.
            return loaded.map((p) => ({
              ...p,
              models: cleanProfileModels(p),
            }));
          }
          if (apiHistory && apiHistory.length > 0) {
            // Group history entries by baseUrl so each endpoint becomes its own
            // provider. This prevents a single "配置 · xxx" profile from owning
            // models that clearly belong to different endpoints (e.g. Kimi and
            // DeepSeek models mixed together after repeated saves).
            const groups = new Map<string, typeof apiHistory>();
            for (const h of apiHistory) {
              const key = h.baseUrl || `unknown-${groups.size}`;
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key)!.push(h);
            }
            return Array.from(groups.values()).map((entries) => {
              const primary = entries[0];
              const models = Array.from(
                new Set(entries.map((h) => h.model).filter(Boolean)),
              );
              return {
                id: generateId(),
                name: "",
                config: { ...defaults, ...primary },
                models,
              };
            });
          }
          return [];
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
          const id = loadedActiveProfileId;
          if (!id) return null;
          const prof = (apiProfiles || []).find((p) => p.id === id);
          if (!prof) return null;
          return id;
        })(),
        chatMessages: (latestSession?.chatMessages ?? []).map((m) => ({
          ...m,
          role: m.role as "user" | "assistant" | "system",
          isStreaming: !!m.isStreaming,
        })),
        files: get().files,
        openTabs: get().openTabs,
        fontFamily:
          fontFamily ||
          (typeof localStorage !== "undefined"
            ? localStorage.getItem("helix-font-family")
            : null) ||
          get().fontFamily,
        fontSize:
          fontSize ||
          (typeof localStorage !== "undefined"
            ? Number(localStorage.getItem("helix-font-size")) || get().fontSize
            : get().fontSize),
        interfaceFont:
          interfaceFont ||
          (typeof localStorage !== "undefined"
            ? localStorage.getItem("helix-interface-font")
            : null) ||
          get().interfaceFont,
        transcriptFontSize:
          transcriptFontSize ||
          (typeof localStorage !== "undefined"
            ? Number(localStorage.getItem("helix-transcript-size")) ||
              get().transcriptFontSize
            : get().transcriptFontSize),
        themeStyle:
          themeStyle ||
          (typeof localStorage !== "undefined"
            ? localStorage.getItem("helix-theme-style")
            : null) ||
          get().themeStyle,
        sessionUsageStats:
          sessionUsageStats &&
          typeof sessionUsageStats === "object" &&
          typeof (sessionUsageStats as { requestCount?: unknown })
            .requestCount === "number"
            ? // Restore the persisted cumulative token stats verbatim. Previously a
              // "one-time migration" gated this on dailyUsage having a `models`
              // subfield; that wrongly discarded valid historical stats whenever
              // dailyUsage was empty or predated per-model tracking, so the panel
              // showed "尚未获取到用量数据" after every cold restart. Cumulative
              // usage is inherently persistent, so we keep it whenever it was saved.
              sessionUsageStats
            : {
                requestCount: 0,
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                thoughtTokens: 0,
                cachedReadTokens: 0,
                cachedWriteTokens: 0,
              },
        // Rehydrate the last persisted context-window usage snapshot so the
        // indicator no longer resets to zero on every cold start. The backend
        // does not report a session's accumulated token count on launch and the
        // in-memory field is only refreshed by runtime events, so we persist it
        // (see setContextUsage / persistToStorage) and restore it here. A fresh
        // `message.complete` from the backend overwrites it with the live value.
        contextUsage:
          contextUsage &&
          typeof contextUsage === "object" &&
          !Array.isArray(contextUsage)
            ? (contextUsage as unknown as Record<
                string,
                { size: number; used: number }
              >)
            : {},
        // 恢复每会话的压缩记录（compression-records-slice），重启后按会话回填
        // 压缩提示 divider。形状校验在 slice 的 loadCompressionNoticesFromPersistence
        // 里做，这里只做「对象且非数组」的最小守卫，避免坏数据把内存态清掉。
        compressionRecordsBySession:
          compressionRecordsBySession &&
          typeof compressionRecordsBySession === "object" &&
          !Array.isArray(compressionRecordsBySession)
            ? (compressionRecordsBySession as Record<
                string,
                import("./slices/compression-records-slice").PersistedCompressionRecord[]
              >)
            : {},
        dailyUsage:
          dailyUsage &&
          typeof dailyUsage === "object" &&
          Object.keys(dailyUsage).length > 0
            ? // Restore the persisted daily breakdown verbatim. The old `hasDailyModels`
              // gate dropped every day entry that lacked the newer `models` subfield,
              // which silently emptied the chart on restart for pre-per-model data.
              dailyUsage
            : {},
        scheduledTasks: (scheduledTasks as ScheduledTask[]) || [],
        mcpServers: {
          ...fileMcpConfig,
          ...(mcpServers || {}),
        },
        externalServices: (externalServices || []).filter(
          (s) => s && typeof s.id === "string" && typeof s.host === "string",
        ),
        customShortcuts: (() => {
          const customizedIds = new Set(customizedIdsArr || []);
          const defaults = { ...DEFAULT_SHORTCUTS };
          if (customShortcuts && Object.keys(customShortcuts).length > 0) {
            // Only apply shortcuts the user actually customized;
            // new defaults always take effect for the rest.
            for (const id of Object.keys(customShortcuts)) {
              if (customizedIds.has(id)) {
                defaults[id] = customShortcuts[id];
              }
            }
          }
          return defaults;
        })(),
        customizedShortcutIds: new Set(customizedIdsArr || []),
        agentMaxIterations: agentMaxIterations ?? get().agentMaxIterations,
        autoCompactContext: autoCompactContext ?? get().autoCompactContext,
        autoSaveSession: autoSaveSession ?? get().autoSaveSession,
        reasoningEffort: (reasoningEffort as any) || get().reasoningEffort,
        personality: personality || get().personality,
        fastMode: fastMode ?? get().fastMode,
        terminalShell:
          terminalShell === "cmd" ||
          terminalShell === "pwsh" ||
          terminalShell === "powershell"
            ? terminalShell
            : "auto",
        availableModels: availableModels || [],
        providerModels: cleanedProviderModels,
        editorTheme:
          (editorTheme as "vs-dark" | "light" | null | undefined) ??
          get().editorTheme,
        gitAutoCommit: gitAutoCommit ?? get().gitAutoCommit,
        gitAutoPush: gitAutoPush ?? get().gitAutoPush,
        gitPushConfirm: gitPushConfirm ?? get().gitPushConfirm,
        gitAutoBranch: gitAutoBranch ?? get().gitAutoBranch,
        gitRemoteUrl: gitRemoteUrl || get().gitRemoteUrl,
        gitCommitTemplate: gitCommitTemplate || get().gitCommitTemplate,
        gitBranchPrefix: gitBranchPrefix || get().gitBranchPrefix,
        approvalMode: (approvalMode as any) || get().approvalMode,
        approvalModeBySession:
          approvalModeBySession ?? get().approvalModeBySession,
        modelBySession: modelBySession ?? get().modelBySession,
        startupGreeting: healedStartupGreeting,
        bootBackgroundImage: bootBackgroundImage ?? get().bootBackgroundImage,
        browserHomeUrl: "",
      });

      // Permanently scrub the pollution from IndexedDB: write back the cleaned
      // apiProfiles and the unpolluted providers list. Without this, the on-disk
      // copies keep the old jumbled `models` and only the in-memory state would be
      // clean until the next write. Doing it here makes the "一堆放一起" fix stick
      // after a single restart, with no manual data clearing required.
      try {
        const healed = get();
        // Skip the redundant IndexedDB writes when nothing actually changed.
        // After the first "heal" restart the on-disk data is already clean, so
        // re-writing identical blobs on every subsequent startup is pure I/O.
        const prevModels = providerModels || {};
        // A stale persisted activeProviderId (pointing at a different endpoint
        // than the active model's owner) is healed by builtActiveProviderId
        // above; write the corrected value back so the next cold start doesn't
        // have to re-heal it and doesn't scope fetches to the wrong provider.
        const healedActiveProviderId = healed.activeProviderId;
        const providerIdChanged = healedActiveProviderId !== activeProviderId;
        const changed =
          JSON.stringify(healed.apiProfiles) !==
            JSON.stringify(apiProfiles || []) ||
          JSON.stringify(healed.providers) !==
            JSON.stringify(providers || []) ||
          JSON.stringify(cleanedProviderModels) !==
            JSON.stringify(prevModels) ||
          providerIdChanged;
        if (changed) {
          await persistence.saveSetting("apiProfiles", healed.apiProfiles);
          await persistence.saveSetting("providers", healed.providers);
          await persistence.saveSetting(
            "providerModels",
            cleanedProviderModels,
          );
          if (providerIdChanged && healedActiveProviderId !== null) {
            await persistence.saveSetting(
              "activeProviderId",
              healedActiveProviderId,
            );
          }
        }
      } catch (persistErr) {
        logError("Failed to persist healed model lists:", persistErr);
      }

      // Auto-detect AGENTS.md / CLAUDE.md from project root as fallback
      // Custom instructions are now managed by Helix
      // No local API call needed

      // Set default workDir from the main process (not renderer process.cwd(),
      // which can resolve to a bare drive root like D:\).
      const currentDir = get().selectedWorkDir;
      const isDriveRoot =
        typeof currentDir === "string" && /^[a-zA-Z]:[\\/]?$/.test(currentDir);
      if (
        !currentDir ||
        currentDir === "/" ||
        currentDir === "\\" ||
        isDriveRoot
      ) {
        const fallbackDir = await getDefaultSessionsDir();
        let info = { workDir: fallbackDir };
        if (isElectron()) {
          try {
            info = await electronApp.getInfo();
          } catch {
            /* fall through to fallbackDir */
          }
        }
        set({ selectedWorkDir: info.workDir || fallbackDir });
      }

      // Re-apply font CSS variables after restore so the DOM matches the
      // persisted values (not the static defaults that ship with the bundle).
      const s = useHelixStore.getState();
      document.documentElement.style.setProperty(
        "--helix-font-family",
        s.fontFamily,
      );
      document.body.style.fontFamily = s.fontFamily;
      document.documentElement.style.setProperty(
        "--helix-font-size",
        `${s.fontSize}px`,
      );
      document.documentElement.style.setProperty(
        "--helix-interface-font",
        s.interfaceFont,
      );
      document.documentElement.style.setProperty(
        "--helix-transcript-size",
        `${s.transcriptFontSize}px`,
      );
    } catch (e) {
      logError("Failed to restore:", e);
      get().showToast({
        type: "error",
        title: "数据恢复失败",
        description: "本地存储读取异常，部分设置可能未加载",
      });
    }
  },

  saveCheckpointChat: async () => {
    try {
      const { persistence } = await import("@/lib/persist");
      const state = get();
      const sessionId = "checkpoint-" + Date.now();
      const messages = state.chatMessages;
      if (messages.length === 0) return;
      await persistence.saveChatMessages(
        messages.map((m) => ({
          id: m.id,
          sessionId,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          isStreaming: false,
          duration: m.duration,
          thinkingTime: m.thinkingTime,
          totalTokens: m.totalTokens,
        })),
        sessionId,
      );
    } catch (e) {
      logError("Failed to save checkpoint:", e);
    }
  },

  // Helpers
  getAllFiles: () => {
    const result: FileNode[] = [];
    const collect = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.type === "file") result.push(n);
        if (n.children) collect(n.children);
      }
    };
    collect(get().files);
    return result;
  },

  getFilePath: (fileId) => {
    const findPath = (nodes: FileNode[], path: string[]): string | null => {
      for (const n of nodes) {
        const currentPath = [...path, n.name];
        if (n.id === fileId) return currentPath.join("/");
        if (n.children) {
          const found = findPath(n.children, currentPath);
          if (found) return found;
        }
      }
      return null;
    };
    return findPath(get().files, []) || "";
  },

  findFileByPath: (path) => {
    const segments = path.split("/");
    const fileName = segments.pop();
    let nodes = get().files;
    for (const seg of segments) {
      const folder = nodes.find((n) => n.type === "folder" && n.name === seg);
      if (!folder?.children) return null;
      nodes = folder.children;
    }
    return nodes.find((n) => n.name === fileName) || null;
  },

  getMemoryContext: () => {
    const state = get();
    if (state.memories.length === 0 && !state.notes) return "";
    let ctx = "\n\n--- 项目记忆 ---\n";
    if (state.memories.length > 0) {
      ctx += "项目知识：\n";
      state.memories.forEach((m) => {
        ctx += `  [${m.category}] ${m.content}\n`;
      });
    }
    if (state.notes) {
      ctx += `\n会话笔记：\n${state.notes}\n`;
    }
    return ctx;
  },

  getTaskContext: () => {
    const state = get();
    if (state.tasks.length === 0 && state.subAgents.length === 0) return "";
    let ctx = "\n--- 当前任务 ---\n";
    const renderTasks = (tasks: TaskNode[], prefix = "") => {
      for (const t of tasks) {
        const statusIcon =
          t.status === "done"
            ? ""
            : t.status === "in_progress"
              ? ""
              : t.status === "blocked"
                ? ""
                : "";
        ctx += `${prefix}${statusIcon} ${t.label}\n`;
        if (t.children) renderTasks(t.children, prefix + "  ");
      }
    };
    renderTasks(state.tasks);
    if (state.goal) {
      ctx += `\n目标: ${state.goal}\n`;
    }
    // Sub-agent context
    if (state.subAgents.length > 0) {
      ctx += "\n--- 子 Agent 状态 ---\n";
      for (const a of state.subAgents) {
        const statusIcon =
          a.status === "running"
            ? ""
            : a.status === "completed"
              ? ""
              : a.status === "failed"
                ? ""
                : "";
        ctx += `${statusIcon} ${a.name}: ${a.description}\n`;
        if (a.result && a.status === "completed") {
          ctx += `   结果: ${a.result.slice(0, 200)}\n`;
        }
      }
    }
    return ctx;
  },
}));

// TEMP DEBUG: expose store for runtime diagnosis (remove after debugging)
if (typeof window !== "undefined") {
  (window as any).__helixStore = useHelixStore;
}

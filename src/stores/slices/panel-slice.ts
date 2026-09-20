/**
 * Panel visibility toggles slice — all panel open/close state.
 * Zero business-logic cross-references; purely UI state.
 */
import type { StateCreator } from "zustand";
import type { AvailableCommand, HelixTodo, PlanStep } from "../helix-types";
import type { PlanReviewRequest } from "@/components/Helix/approval-dialog";

type NavEntry =
  | { type: "chat"; sessionId: string }
  | { type: "settings"; page: string };

const NAV_HISTORY_KEY = "navigationHistory";
const NAV_INDEX_KEY = "navigationIndex";

function persistNavState(history: NavEntry[], index: number) {
  import("@/lib/persist")
    .then(({ persistence }) => {
      Promise.all([
        persistence.saveSetting(NAV_HISTORY_KEY, history),
        persistence.saveSetting(NAV_INDEX_KEY, index),
      ]).catch(() => {});
    })
    .catch(() => {});
}

export interface PanelSlice {
  showCommandPalette: boolean;
  showTaskPanel: boolean;
  showSubAgentPanel: boolean;
  showSessionManager: boolean;
  showSettings: boolean;
  settingsPage: string | null;
  /** Unified navigation history — tracks both chat sessions and settings pages */
  navigationHistory: NavEntry[];
  navigationIndex: number;
  showCustomizePanel: boolean;
  showWorktreePanel: boolean;
  showPluginManager: boolean;
  availableCommands: AvailableCommand[];
  /**
   * Helix's in-session todo list, captured from `session/update` events that
   * carry a todo/plan payload. Empty by default so the header button stays
   * hidden until the backend actually streams a list.
   */
  helixTodos: HelixTodo[];
  /** 按会话缓存的 todo 列表（仅内存，不持久化）：切会话时按 currentSessionId
   *  恢复对应清单，避免 A 会话的任务清单串到 B 会话。 */
  helixTodosBySession: Record<string, HelixTodo[]>;
  /** 计划模式（plan mode）模型产出的待批准方案。由后端 plan_complete /
   *  run 结束等事件写入，全局共享，供右上角工作面板与底部 PlanReviewBar 共用。 */
  pendingPlanReview: PlanReviewRequest | null;
  /** 正在执行的计划步骤（plan.md 解析而来）：工作面板「执行计划」区块渲染它，
   *  非空 = 计划已进入实施阶段（待批准时显示的是 pendingPlanReview 纯文本）。 */
  activePlan: PlanStep[];
  setActivePlan: (steps: PlanStep[] | null) => void;
  setPendingPlanReview: (v: PlanReviewRequest | null) => void;
  toggleCommandPalette: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleTaskPanel: () => void;
  toggleSubAgentPanel: () => void;
  toggleSessionManager: () => void;
  toggleSettings: (page?: string) => void;
  setSettingsPage: (page: string | null) => void;
  pushNavigation: (entry: NavEntry) => void;
  navigateBack: () => NavEntry | null;
  navigateForward: () => NavEntry | null;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  /** 统一处理前进/后退后的落地行为（切会话 / 开设置页），供标题栏按钮、
   *  窗口菜单与快捷键共用——此前 6 处回调各自实现且行为不一致。 */
  navigateHistory: (direction: "back" | "forward") => void;
  /** 启动恢复时从持久化重建导航栈；持久化条目缺失/失效时用会话历史兜底。 */
  restoreNavigation: (
    history: NavEntry[],
    index: number,
    validSessionIds: Set<string>,
  ) => void;
  toggleCustomizePanel: () => void;
  toggleWorktreePanel: () => void;
  togglePluginManager: () => void;
  setAvailableCommands: (cmds: AvailableCommand[]) => void;
  /** Replace the Helix todo list (called whenever a fresh todo payload arrives).
   *  sessionId 标识该清单归属的 UI 会话：写入按会话缓存，且仅当它就是当前
   *  查看的会话时才更新展示列表（并行 run 不互相覆盖）。 */
  setHelixTodos: (todos: HelixTodo[], sessionId?: string) => void;
}

export const createPanelSlice: StateCreator<PanelSlice, [], [], PanelSlice> = (
  set,
  get,
) => ({
  showCommandPalette: false,
  showTaskPanel: false,
  showSubAgentPanel: false,
  showSessionManager: false,
  showSettings: false,
  settingsPage: null,
  navigationHistory: [],
  navigationIndex: -1,
  showCustomizePanel: false,
  showWorktreePanel: false,
  showPluginManager: false,
  availableCommands: [],
  helixTodos: [],
  helixTodosBySession: {},
  pendingPlanReview: null,
  activePlan: [],

  toggleCommandPalette: () =>
    set((state) => ({ showCommandPalette: !state.showCommandPalette })),
  setCommandPaletteOpen: (open) => set({ showCommandPalette: open }),
  toggleTaskPanel: () => set((s) => ({ showTaskPanel: !s.showTaskPanel })),
  toggleSubAgentPanel: () =>
    set((s) => ({ showSubAgentPanel: !s.showSubAgentPanel })),
  toggleSessionManager: () =>
    set((s) => ({ showSessionManager: !s.showSessionManager })),
  toggleSettings: (page?) =>
    set((s) => ({
      showSettings: page ? true : !s.showSettings,
      settingsPage: page ?? s.settingsPage,
    })),
  setSettingsPage: (page) => set({ settingsPage: page }),

  pushNavigation: (entry) =>
    set((s) => {
      const history = [...s.navigationHistory];
      const idx = s.navigationIndex;
      // 连续同条目去重：重复点击同一会话/设置页不应产生重复历史——
      // 否则点后退"看似没反应"。
      if (JSON.stringify(history[idx]) === JSON.stringify(entry)) return {};
      // Remove forward history and push new entry
      const newHistory = [...history.slice(0, idx + 1), entry];
      const newIndex = newHistory.length - 1;
      persistNavState(newHistory, newIndex);
      return {
        navigationHistory: newHistory,
        navigationIndex: newIndex,
      };
    }),

  navigateBack: () => {
    const { navigationHistory, navigationIndex } = get();
    if (navigationIndex <= 0) return null;
    const newIndex = navigationIndex - 1;
    const entry = navigationHistory[newIndex];
    set({ navigationIndex: newIndex });
    persistNavState(navigationHistory, newIndex);
    return entry;
  },

  navigateForward: () => {
    const { navigationHistory, navigationIndex } = get();
    if (navigationIndex >= navigationHistory.length - 1) return null;
    const newIndex = navigationIndex + 1;
    const entry = navigationHistory[newIndex];
    set({ navigationIndex: newIndex });
    persistNavState(navigationHistory, newIndex);
    return entry;
  },

  canGoBack: () => get().navigationIndex > 0,
  canGoForward: () => {
    const { navigationHistory, navigationIndex } = get();
    return navigationIndex < navigationHistory.length - 1;
  },

  navigateHistory: (direction) => {
    const s = get() as PanelSlice & {
      navigateSession: (
        direction: "back" | "forward",
        targetId?: string,
      ) => Promise<void>;
    };
    const entry = direction === "back" ? s.navigateBack() : s.navigateForward();
    if (!entry) return;
    if (entry.type === "chat") {
      if (s.showSettings) s.toggleSettings();
      // 导航栈与 sessionHistory 步进方向可能不同步（栈里夹着设置页条目），
      // 以条目里的目标会话为准，方向仅作回退语义。
      s.navigateSession(direction, entry.sessionId);
    } else {
      if (!s.showSettings) s.toggleSettings(entry.page);
      else s.setSettingsPage(entry.page);
    }
  },

  restoreNavigation: (history, index, validSessionIds) => {
    const valid = history.filter(
      (e) => e.type !== "chat" || validSessionIds.has(e.sessionId),
    );
    const clampedIndex = Math.min(
      Math.max(
        index >= 0 ? index : valid.length - 1,
        valid.length > 0 ? 0 : -1,
      ),
      valid.length - 1,
    );
    set({ navigationHistory: valid, navigationIndex: clampedIndex });
  },

  toggleCustomizePanel: () =>
    set((s) => ({ showCustomizePanel: !s.showCustomizePanel })),
  toggleWorktreePanel: () =>
    set((s) => ({ showWorktreePanel: !s.showWorktreePanel })),
  togglePluginManager: () =>
    set((s) => ({ showPluginManager: !s.showPluginManager })),
  setAvailableCommands: (cmds) => set({ availableCommands: cmds }),
  setHelixTodos: (todos, sessionId) =>
    set((s) => {
      const bySession = sessionId
        ? { ...s.helixTodosBySession, [sessionId]: todos }
        : s.helixTodosBySession;
      const cur = (s as unknown as { currentSessionId: string | null })
        .currentSessionId;
      const isVisible = sessionId === undefined || sessionId === cur;
      return {
        helixTodosBySession: bySession,
        ...(isVisible ? { helixTodos: todos } : {}),
      };
    }),
  setPendingPlanReview: (v) => set({ pendingPlanReview: v }),
  setActivePlan: (steps) => set({ activePlan: steps ?? [] }),
});

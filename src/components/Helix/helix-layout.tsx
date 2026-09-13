"use client";

import {
  Minus,
  Square,
  Copy,
  X,
  Folder,
  Terminal,
  PanelLeft,
  ArrowLeft,
  ArrowRight,
  GripVertical,
  ChevronDown,
  FileText,
  Keyboard,
  ListTodo,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  MoreHorizontal,
  Users,
  ChevronRight,
  FilePlus,
  GitCommit,
  Send,
  Pencil,
} from "lucide-react";
import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  lazy,
  Suspense,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentVersion } from "@/hooks/use-check-update";
import { createPortal } from "react-dom";
import { useProviderStore } from "@/stores/slices/provider-store";
import { useCheckUpdate } from "@/hooks/use-check-update";
import { useGitChangeStat } from "@/hooks/use-git-change-stat";
import {
  pushModelConfig,
  pushAgentConfigLive,
  pushConfigKeyValue,
} from "@/lib/config-sync";
import {
  isElectron,
  electronHelix,
  electronShell,
  electronGit,
} from "@/lib/electron-bridge";
import { startScheduledTaskRunner } from "@/lib/scheduled-task-runner";
import { isServeActive, getServeClient } from "@/lib/serve-gateway";
import { useHelixStore } from "@/stores/helix-store";
import { applyHelixPalette } from "@/lib/themes";
import { AgentFlowPanel } from "./agent-flow-panel";
import { GlobalTooltip } from "./global-tooltip";
import { CommandPalette } from "./command-palette";
import { Sidebar } from "./sidebar";
import { BranchPicker } from "./branch-picker";
import { KeyboardShortcuts } from "./keyboard-shortcuts";
import { ContextMenuProvider } from "./context-menu";
import { BackgroundTasksPanel, type BgTask } from "./background-tasks-panel";

import { ToastContainer } from "./toast-container";
import { useGatewayStore } from "@/stores/gateway-store";
import { DEFAULT_SHORTCUTS } from "@/stores/helix-types";

// Process-wide guard so the startup restore + Helix sync runs exactly once.
// A component-local useRef resets whenever this layout remounts (e.g. tab
// switches that unmount/remount the tree), which would re-trigger
// restoreFromStorage() and overwrite the user's live model/provider selection
// with the persisted snapshot — the "sometimes stops working after a few
// clicks" symptom.
let startupSyncDone = false;

function shortcutLabel(
  action: string,
  customShortcuts?: Record<string, { keys: string[] }>,
): string {
  const entry = customShortcuts?.[action] || DEFAULT_SHORTCUTS[action];
  if (!entry) return "";
  return entry.keys.join("+");
}

// Dynamic imports for heavy components (Next's next/dynamic ssr:false →
// React.lazy; a static Vite SPA is client-only anyway).
const SessionManager = lazy(() =>
  import("./session-manager").then((m) => ({ default: m.SessionManager })),
);
const ApiSettings = lazy(() =>
  import("./api-settings").then((m) => ({ default: m.ApiSettings })),
);
const SkillPanel = lazy(() =>
  import("./skill-panel").then((m) => ({ default: m.SkillPanel })),
);
const ScheduledTasksPanel = lazy(() =>
  import("./scheduled-tasks-panel").then((m) => ({
    default: m.ScheduledTasksPanel,
  })),
);
const CustomizePanel = lazy(() =>
  import("./customize-panel").then((m) => ({ default: m.CustomizePanel })),
);
const RuntimePanel = lazy(() =>
  import("./runtime-panel").then((m) => ({ default: m.RuntimePanel })),
);
const ActivityFeed = lazy(() =>
  import("./activity-feed").then((m) => ({ default: m.ActivityFeed })),
);
const Onboarding = lazy(() =>
  import("./onboarding").then((m) => ({ default: m.Onboarding })),
);
const BootOverlay = lazy(() =>
  import("./boot-overlay").then((m) => ({ default: m.BootOverlay })),
);
const ArtifactsBrowser = lazy(() =>
  import("./artifacts-browser").then((m) => ({ default: m.ArtifactsBrowser })),
);
const TerminalPanel = lazy(() =>
  import("./terminal-panel").then((m) => ({ default: m.TerminalPanel })),
);
const WorktreePanel = lazy(() =>
  import("./worktree-panel").then((m) => ({ default: m.WorktreePanel })),
);
const DelegationsPanel = lazy(() =>
  import("./delegations-panel").then((m) => ({ default: m.DelegationsPanel })),
);
const RightSidebar = lazy(() =>
  import("./right-sidebar").then((m) => ({ default: m.RightSidebar })),
);
import { MoreActionsMenu } from "./more-actions-menu";

// Local Suspense for the always-visible panel areas. Without a boundary the
// lazy panels' chunk load bubbles up to the root Suspense in main.tsx, which
// swaps the WHOLE app for "Loading Helix..." and unmounts every component.
// An in-panel spinner keeps the UI alive while the chunk + data load.
function PanelSuspense({ children }: { children: React.ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="h-full w-full flex items-center justify-center text-[length:var(--helix-transcript-size)] text-muted-foreground">
          正在加载…
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

// ── Resizable sidebar constants ──────────────────────────────────────────
const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 500;
const SIDEBAR_COLLAPSED = 48;
const SIDEBAR_DEFAULT = 280;
const STORAGE_KEY = "helix-sidebar-width";

// 网关探测心跳间隔：连接正常时也保持这个频率回查一次状态，
// 避免后端在无事件通知的情况下恢复/掉线后，UI 状态永久漂移。
const HEALTHY_HEARTBEAT_MS = 10_000;

// Right sidebar (code editor / browser)
const RIGHT_SIDEBAR_MIN = 280;
const RIGHT_SIDEBAR_MAX = 400;
const RIGHT_SIDEBAR_DEFAULT = 240;
// The chat/dialogue column must always keep a readable width. Cap the right
// sidebar so the dialogue area never shrinks into awkwardly short line wraps.
// (440 would over-constrain the drag range — 400 still keeps lines readable.)
const CHAT_MIN_WIDTH = 400;
const RIGHT_STORAGE_KEY = "helix-right-sidebar-width";

function rightSidebarCap(leftWidth: number): number {
  // Hard ceiling: regardless of how wide the window is, the right sidebar must
  // never exceed RIGHT_SIDEBAR_MAX. Only the *lower* bound is governed by the
  // window width (so the chat column keeps a minimum readable width).
  if (typeof window === "undefined") return RIGHT_SIDEBAR_MAX;
  const cap = window.innerWidth - leftWidth - CHAT_MIN_WIDTH;
  return Math.max(
    RIGHT_SIDEBAR_MIN,
    Math.min(RIGHT_SIDEBAR_MAX, Math.floor(cap)),
  );
}

// Mirror of rightSidebarCap for the LEFT (session) sidebar. The upper bound is
// window-relative so the chat column never drops below CHAT_MIN_WIDTH even when
// the window is narrow; the lower bound stays the fixed SIDEBAR_MIN.
function leftSidebarCap(rightWidth: number): number {
  if (typeof window === "undefined") return SIDEBAR_MAX;
  const cap = window.innerWidth - rightWidth - CHAT_MIN_WIDTH;
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Math.floor(cap)));
}

function loadSidebarWidth(): number {
  if (typeof localStorage === "undefined") return SIDEBAR_DEFAULT;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) {
      const n = parseInt(v, 10);
      // Migration: the old default was 300. Treat a stored width that equals the
      // old default as "unset" so the new smaller default (240) takes effect on
      // first launch — but any custom width the user dragged to is respected.
      if (n === 300) {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {}
        return SIDEBAR_DEFAULT;
      }
      if (n >= SIDEBAR_MIN && n <= leftSidebarCap(RIGHT_SIDEBAR_DEFAULT))
        return n;
    }
  } catch {}
  return SIDEBAR_DEFAULT;
}

function saveSidebarWidth(w: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(w));
  } catch {}
}

function loadRightSidebarWidth(): number {
  if (typeof localStorage === "undefined") return RIGHT_SIDEBAR_DEFAULT;
  const cap = rightSidebarCap(SIDEBAR_DEFAULT);
  try {
    const v = localStorage.getItem(RIGHT_STORAGE_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= RIGHT_SIDEBAR_MIN && n <= cap) return n;
    }
  } catch {}
  return Math.min(RIGHT_SIDEBAR_DEFAULT, cap);
}

function saveRightSidebarWidth(w: number) {
  try {
    localStorage.setItem(RIGHT_STORAGE_KEY, String(w));
  } catch {}
}

interface WindowMenuItem {
  label: string;
  shortcut?: string;
  action: () => void;
}

export function HelixLayout() {
  useCheckUpdate();
  const [showSidebar, setShowSidebar] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth);
  const [isDragging, setIsDragging] = useState(false);
  const [rightSidebarWidth, setRightSidebarWidth] = useState(
    loadRightSidebarWidth,
  );
  const [isRightDragging, setIsRightDragging] = useState(false);
  // Mirror sidebarWidth so the right-sidebar resize clamp can read it live
  // without re-subscribing the drag effect on every sidebar width change.
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  // Mirror rightSidebarWidth so the left-sidebar resize clamp can read it live
  // without re-subscribing the drag effect on every right-sidebar width change.
  const rightSidebarWidthRef = useRef(rightSidebarWidth);
  rightSidebarWidthRef.current = rightSidebarWidth;
  const [isMaximized, setIsMaximized] = useState(false);
  const dragStartX = useRef(0);
  const dragStartW = useRef(0);
  const rightDragStartX = useRef(0);
  const rightDragStartW = useRef(0);

  // Refs for keyboard shortcut handler (avoids stale closures)
  const showSidebarRef = useRef(showSidebar);
  const setSidebarCollapsedRef = useRef(setSidebarCollapsed);
  const setShowSidebarRef = useRef(setShowSidebar);

  useEffect(() => {
    showSidebarRef.current = showSidebar;
  }, [showSidebar]);

  useEffect(() => {
    setSidebarCollapsedRef.current = setSidebarCollapsed;
  }, [setSidebarCollapsed]);

  useEffect(() => {
    setShowSidebarRef.current = setShowSidebar;
  }, [setShowSidebar]);

  // ── Sidebar resize drag ──────────────────────────────────────────────
  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      dragStartX.current = e.clientX;
      dragStartW.current = sidebarWidth;
    },
    [sidebarWidth],
  );

  useEffect(() => {
    if (!isDragging) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    let raf: number;
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const delta = e.clientX - dragStartX.current;
        const cap = leftSidebarCap(rightSidebarWidthRef.current);
        const next = Math.max(
          SIDEBAR_MIN,
          Math.min(cap, dragStartW.current + delta),
        );
        setSidebarWidth(next);
      });
    };
    const onUp = () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setIsDragging(false);
      setSidebarWidth((w) => {
        saveSidebarWidth(w);
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isDragging]);

  // ── Right sidebar resize drag ────────────────────────────────────────
  const handleRightDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsRightDragging(true);
      rightDragStartX.current = e.clientX;
      rightDragStartW.current = rightSidebarWidth;
    },
    [rightSidebarWidth],
  );

  useEffect(() => {
    if (!isRightDragging) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    let raf: number;
    const onMove = (e: MouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const delta = rightDragStartX.current - e.clientX;
        const cap = rightSidebarCap(sidebarWidthRef.current);
        const next = Math.max(
          RIGHT_SIDEBAR_MIN,
          Math.min(cap, rightDragStartW.current + delta),
        );
        setRightSidebarWidth(next);
      });
    };
    const onUp = () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      setIsRightDragging(false);
      setRightSidebarWidth((w) => {
        saveRightSidebarWidth(w);
        return w;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isRightDragging]);

  // State selectors (only re-render when this specific slice changes)
  const uiFontSize = useHelixStore((s) => s.fontSize);
  const openTabs = useHelixStore((s) => s.openTabs);
  const showSessionManager = useHelixStore((s) => s.showSessionManager);
  const showSettings = useHelixStore((s) => s.showSettings);
  const showSkillPanel = useHelixStore((s) => s.showSkillPanel);
  const showScheduledTasksPanel = useHelixStore(
    (s) => s.showScheduledTasksPanel,
  );
  const showCustomizePanel = useHelixStore((s) => s.showCustomizePanel);
  const showRuntimePanel = useHelixStore((s) => s.showRuntimePanel);
  const showWorktreePanel = useHelixStore((s) => s.showWorktreePanel);
  const showSubAgentPanel = useHelixStore((s) => s.showSubAgentPanel);
  const showActivityFeed = useHelixStore((s) => s.showActivityFeed);
  const showArtifactsBrowser = useHelixStore((s) => s.showArtifactsBrowser);
  // 打开任一主区覆盖页（计划/技能/运行时/工作树）时，聊天区用
  // display:none 隐藏而不是卸载。run 由 AgentFlowPanel 驱动，卸载会冻结流式
  // 画面并让暂停按钮消失（看起来像"点击插件把运行终止了"）。保持挂载即可在
  // 切页面时让模型继续在后台运行，返回后还能接着看。
  // Only hide chat for overlay panels (delegations, runtime, worktree)
  const sidePanelOpen =
    showRuntimePanel || showWorktreePanel || showSubAgentPanel;
  const rightSidebarTab = useHelixStore((s) => s.rightSidebarTab);
  const codeFullscreen = useHelixStore((s) => s.codeFullscreen);
  const isTerminalOpen = useHelixStore((s) => s.isTerminalOpen);
  const selectedWorkDir = useHelixStore((s) => s.selectedWorkDir);
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedWorkDir) {
      setGitBranch(null);
      return;
    }
    let cancelled = false;
    invoke<{ ok: boolean; branch?: string }>("current_branch", {
      targetCwd: selectedWorkDir,
    })
      // ok:false（目录不是 git 仓库）时同样要清空，否则 gitBranch 残留上一个仓库
      // 的分支名 → 切到非 git 目录仍显示 "tauri"。
      .then((r) => {
        if (!cancelled) setGitBranch(r.ok ? r.branch || null : null);
      })
      .catch(() => {
        if (!cancelled) setGitBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkDir]);
  const editorTheme = useHelixStore((s) => s.editorTheme);
  const themeStyle = useHelixStore((s) => s.themeStyle);
  const setThemeStyle = useHelixStore((s) => s.setThemeStyle);
  const chatMessages = useHelixStore((s) => s.chatMessages);
  const currentSessionId = useHelixStore((s) => s.currentSessionId);
  // 新对话 / 计划 / 插件 视图下隐藏标题栏的「终端 / 更多操作」——这两项是
  // 对话区操作：空会话、或被任意全屏面板（计划/插件/运行时/工作树/子 Agent）
  // 盖住聊天区时都没有意义。同时让面板头部只留窗口控制按钮那一段，避免互相压。
  const hideConversationActions =
    !currentSessionId ||
    showScheduledTasksPanel ||
    showSkillPanel ||
    showRuntimePanel ||
    showWorktreePanel ||
    showSubAgentPanel;
  const activeSessionWorkDir = useHelixStore((s) => s.activeSessionWorkDir);
  // Which workDir the branch picker operates on. An active session uses its
  // own dir; a brand-new conversation has no session yet, so fall back to the
  // selected project dir — otherwise the branch picker stays hidden until the
  // first message is sent (gitBranch is already probed from selectedWorkDir).
  // Project-outside conversations (loaded, activeSessionWorkDir empty) stay
  // hidden, matching the project chip next to it.
  const branchPickerWorkDir =
    activeSessionWorkDir ??
    (currentSessionId === null ? selectedWorkDir : null);
  const navigationHistory = useHelixStore((s) => s.navigationHistory);
  const navigationIndex = useHelixStore((s) => s.navigationIndex);
  const customShortcuts = useHelixStore((s) => s.customShortcuts);
  const helixTodos = useHelixStore((s) => s.helixTodos);
  const pendingPlanReview = useHelixStore((s) => s.pendingPlanReview);
  // Stable action references — these never change so getState() is safe
  const storeActions = useMemo(() => useHelixStore.getState(), []);
  const [restoreReady, setRestoreReady] = useState(startupSyncDone);
  const [delegations, setDelegations] = useState<
    Array<{ id: string; tasks: Array<{ name: string; modified: number }> }>
  >([]);
  // 后台任务（pi-background-tasks 扩展注册表）：面板打开时 3s 轮询，平时
  // 10s 慢轮询维持按钮徽标。数据经 Rust tasks_list 读共享 tasks.json。
  const [bgTasks, setBgTasks] = useState<BgTask[]>([]);
  const [bgTasksOpen, setBgTasksOpen] = useState(false);
  const bgTasksRef = useRef<HTMLDivElement>(null);
  const helixSessionId = useGatewayStore((s) => s.helixSessionId);
  const loadBgTasks = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const api = (window as any).electron as any;
      const res = await api?.backgroundTasks?.list?.();
      if (res?.ok) setBgTasks(res.tasks || []);
    } catch {}
  }, []);
  useEffect(() => {
    if (!isElectron()) return;
    loadBgTasks();
    const interval = setInterval(loadBgTasks, bgTasksOpen ? 3000 : 10000);
    return () => clearInterval(interval);
  }, [bgTasksOpen, loadBgTasks]);
  const runningBgTasks = useMemo(
    () => bgTasks.filter((t) => t.status === "running"),
    [bgTasks],
  );
  // 右上角「更改」胶囊：当前工作区未提交改动的行数统计。
  // 数据 = git diff --numstat 各文件 +/- 求和（二进制文件输出 "-\t-" 会被跳过）。
  // 无会话/项目目录、非 git 仓库、或零改动时置空 → 胶囊不渲染。
  // agent 编辑文件很频繁，5s 轮询跟上；workDir 变化（切会话/项目）立即重算。
  // 「更改」胶囊重新统计的信号：提交成功后 +1 立即刷新，无需等 5s 轮询。
  const [gitRevision, setGitRevision] = useState(0);
  // 未提交改动（git diff --numstat）。这里只取总计，「更改」tab 用同一 hook
  // 拿文件明细。无改动 / 非 git 仓库 → null → 胶囊不渲染。
  const gitChangeStat = useGitChangeStat(branchPickerWorkDir, gitRevision);
  // 右上角「提交 / 提交并推送」的提交中状态。
  const [isCommitting, setIsCommitting] = useState(false);
  // 提交弹窗（点「提交并推送」时弹出，内含提交信息输入框 + 提交 / 提交并推送 两个动作）。
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  // 右上角统一工作面板（更改 / 任务清单 / 子 Agent 共用的下拉）。
  const [workPanelOpen, setWorkPanelOpen] = useState(false);
  const workPanelRef = useRef<HTMLDivElement>(null);
  // 点击面板外部时关闭统一工作面板。
  useEffect(() => {
    if (!workPanelOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        workPanelRef.current &&
        !workPanelRef.current.contains(e.target as Node)
      ) {
        setWorkPanelOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [workPanelOpen]);
  // 复用分支管理的 quick commit 逻辑：提交当前工作区改动，可选随后推送。
  const quickCommit = useCallback(
    async (pushAfter = false, message?: string) => {
      if (!isElectron() || !branchPickerWorkDir || isCommitting) return;
      setIsCommitting(true);
      try {
        const commitRes = await electronGit.commit(
          message && message.trim().length > 0
            ? message.trim()
            : `chore: auto-commit (${new Date().toLocaleString("zh-CN")})`,
        );
        if (!commitRes.ok) {
          storeActions.showToast({
            type: "error",
            title: "提交失败",
            description: commitRes.error,
          });
          return;
        }
        if (pushAfter) {
          const pushRes = await electronGit.push();
          if (!pushRes.ok) {
            storeActions.showToast({
              type: "error",
              title: "推送失败",
              description: pushRes.error,
            });
            return;
          }
        }
        storeActions.showToast({
          type: "success",
          title: pushAfter ? "提交并推送成功" : "提交成功",
        });
        // 改动已落库，立即刷新「更改」胶囊。
        setGitRevision((r) => r + 1);
        setCommitDialogOpen(false);
      } catch (e) {
        storeActions.showToast({
          type: "error",
          title: "操作失败",
          description: String(e),
        });
      } finally {
        setIsCommitting(false);
      }
    },
    [branchPickerWorkDir, isCommitting, storeActions],
  );
  // Load delegations data — scoped to the current session.
  useEffect(() => {
    if (!isElectron()) return;
    const loadDelegations = async () => {
      try {
        const api = (window as any).electron as any;
        const sid = useHelixStore.getState().currentSessionId || undefined;
        const res = await api?.delegations?.list?.(sid);
        if (res?.ok) {
          setDelegations(res.delegations || []);
        }
      } catch {}
    };
    loadDelegations();
    // Refresh every 10 seconds
    const interval = setInterval(loadDelegations, 10000);
    return () => clearInterval(interval);
  }, [currentSessionId]);

  // Apply the selected theme style (Catppuccin flavor or built-in cream) by
  // writing inline CSS variables onto <html>. Runs on mount and whenever the
  // style changes — including when the light/dark toggle switches to a paired
  // flavor.
  useEffect(() => {
    applyHelixPalette(themeStyle);
  }, [themeStyle]);

  // Editor theme follows the resolved light/dark state of <html>. Snapshot it
  // on mount, then watch the class attribute so a 深色 flavor → 内置 switch (or
  // any theme toggle) re-syncs the editor immediately.
  useEffect(() => {
    const syncEditorTheme = () =>
      storeActions.setEditorTheme(
        document.documentElement.classList.contains("dark")
          ? "vs-dark"
          : "light",
      );

    syncEditorTheme();
    const observer = new MutationObserver(syncEditorTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });

    return () => observer.disconnect();
  }, []);

  // Re-assert the frontend's restored model config into Helix on startup so
  // the backend always matches the user's choice. This runs once after the
  // store rehydrates from IndexedDB: it (a) writes the active profile to the
  // cold-start cache and (b) pushes it to the running gateway. No hardcoded
  // pin — the value is whatever the user last saved (or the sensible default).
  useEffect(() => {
    if (startupSyncDone) return;
    startupSyncDone = true;
    let cancelled = false;
    (async () => {
      await storeActions.restoreFromStorage();
      if (cancelled) return;
      const st = useHelixStore.getState();
      // Model setup counts as having completed first-run onboarding. Avoid a
      // first-use modal when the user already configured providers/models but
      // the old race never persisted hasOnboarded=true.
      if (!st.hasOnboarded) {
        const hasConfiguredModel =
          st.apiProfiles.length > 0 ||
          st.apiHistory.length > 0 ||
          st.providers.length > 0 ||
          !!(
            st.apiConfig?.baseUrl &&
            st.apiConfig?.model &&
            st.apiConfig?.apiKey
          );
        if (hasConfiguredModel) st.setHasOnboarded(true);
      }
      setRestoreReady(true);
      if (!isElectron()) return;
      const cfg = st.apiConfig;
      if (!cfg || !cfg.model) return;
      // 启动重申只推 model/provider/baseUrl——凭据以 pi 侧文件为准。带 key 会
      // 在每次重启时把缓存里的旧 key 重建进 models.json，覆盖用户在外部轮换
      // 过的 key（pushModelConfig 内部也会剥 key，这里显式不传）。
      pushModelConfig({
        model: cfg.model,
        provider:
          cfg.provider && cfg.provider !== "__custom__"
            ? cfg.provider
            : "custom",
        baseUrl: cfg.baseUrl,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [storeActions.restoreFromStorage]);

  // Sync agent settings to Helix via live config.set (no gateway restart).
  // personality + reasoningEffort + fastMode are pushed instantly.
  // Removed: temperature, maxOutputTokens, customInstructions, Chinese language injection.
  const agentSettingsSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  useEffect(() => {
    if (!isElectron()) return;
    const pushAgentConfig = () => {
      const s = useHelixStore.getState();
      pushAgentConfigLive({
        personality: s.personality || undefined,
        reasoningEffort: s.reasoningEffort,
        fastMode: s.fastMode,
      });
    };
    pushAgentConfig();
    const unsub = useHelixStore.subscribe((state, prevState) => {
      const changed =
        state.personality !== prevState.personality ||
        state.reasoningEffort !== prevState.reasoningEffort ||
        state.fastMode !== prevState.fastMode;
      if (!changed) return;
      if (agentSettingsSyncTimer.current)
        clearTimeout(agentSettingsSyncTimer.current);
      agentSettingsSyncTimer.current = setTimeout(pushAgentConfig, 150);
    });
    return () => {
      unsub();
      if (agentSettingsSyncTimer.current)
        clearTimeout(agentSettingsSyncTimer.current);
    };
  }, []);

  // ── Reasoning-effort: live push via config.set (no restart, no translation) ──
  // Uses Helix native effort scale (none/minimal/low/medium/high/xhigh/max/ultra)
  // directly — no toBackendReasoningEffort translation needed.
  const reasoningFastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!isElectron()) return;
    const unsub = useHelixStore.subscribe((state, prevState) => {
      if (state.reasoningEffort === prevState.reasoningEffort) return;
      if (reasoningFastTimer.current) clearTimeout(reasoningFastTimer.current);
      reasoningFastTimer.current = setTimeout(() => {
        const effort = useHelixStore.getState().reasoningEffort;
        pushConfigKeyValue("agent.reasoning_effort", effort);
        // Live-update thinking level. Pi has no persistent thinking-level
        // config key, so we broadcast to every live instance; new sessions
        // get it re-applied at spawn time in Rust (pi_gateway). serve mode
        // honors agent.reasoning_effort via config.set instead.
        if (isServeActive()) {
          const gw = useGatewayStore.getState();
          getServeClient()
            ?.rpc("config.set", {
              key: "agent.reasoning_effort",
              value: effort,
              session_id: gw.helixSessionId,
            })
            .catch(() => {});
        } else {
          window.electron?.helix
            ?.piSetThinkingLevelAll?.(effort)
            .catch?.(() => {});
        }
      }, 150);
    });
    return () => {
      unsub();
      if (reasoningFastTimer.current) clearTimeout(reasoningFastTimer.current);
    };
  }, []);

  // ── Bridge: helix-ui useProviderStore → Helix useHelixStore ───────────────
  // The user can switch the active model from the helix-ui ProviderSettings /
  // ModelSelector panels (which write to useProviderStore and push to Helix).
  // Those are a SEPARATE store from useHelixStore (the one the input-bar model
  // selector reads). Without this bridge the input bar keeps showing the old
  // model even after a backend-side switch. Mirror the active model (and its
  // owning provider's config) into useHelixStore whenever it changes out-of-band.
  useEffect(() => {
    if (!isElectron()) return;
    // On the FIRST fire (which is the helix-ui hydration), the Helix store has
    // already restored its own active model — and unlike helix-ui it knows about
    // fetched-only models. If helix-ui hydrated to a declared default (pro) while
    // Helix restored a fetched model (flash), don't let helix-ui clobber Helix.
    // Instead sync helix-ui to Helix so the two agree, then return.
    let firstFire = true;
    const unsub = useProviderStore.subscribe((state, prev) => {
      const model = state.activeModel;
      if (model === prev.activeModel) return;
      if (!model) return;
      const helix = useHelixStore.getState();
      if (firstFire) {
        firstFire = false;
        const helixModel = helix.apiConfig?.model;
        if (helixModel && helixModel !== model) {
          useProviderStore.getState().setActiveModel(helixModel);
          return;
        }
      }
      // Reuse the canonical resolver so the mirrored config matches a normal
      // in-panel switch (credentials + session invalidation handled there).
      const provider = state.providers.find((p) => p.models.includes(model));
      if (provider) {
        // Mirror into Helix store via onModelSwitched so activeModel/activeProviderId
        // and apiConfig all stay consistent and the stale session is cancelled.
        helix.onModelSwitched(model);
        // Keep the selected provider's credentials in sync too, in case the
        // helix-ui provider carries a different key/baseUrl.
        const existing = helix.providers.find((p) => p.models.includes(model));
        if (
          existing &&
          (existing.apiKey !== provider.apiKey ||
            existing.baseUrl !== provider.baseUrl)
        ) {
          useHelixStore.setState({
            providers: helix.providers.map((p) =>
              p.id === existing.id
                ? { ...p, apiKey: provider.apiKey, baseUrl: provider.baseUrl }
                : p,
            ),
          });
        }
        // onModelSwitched only updates the store. Mirror the input-bar switch
        // path (agent-flow-panel.syncConfigToBackend): cancel any in-flight
        // session, drop the cached id, and push the resolved config so the
        // backend picks up the new key immediately. Without this, an out-of-band
        // switch (helix-ui ModelSelector / settings) only takes effect on the
        // next sendPrompt via the configHash check, and a run in flight keeps
        // streaming against the old endpoint.
        const gw = useGatewayStore.getState();
        const sid = gw.helixSessionId;
        if (sid) {
          try {
            electronHelix.notify("session/cancel", { session_id: sid });
          } catch {}
        }
        gw.setHelixSessionId(null);
        const s = useHelixStore.getState();
        const cfg = s.apiConfig;
        // Key 不推送：凭据以 pi 侧文件（models.json/auth.json）为准，后端在
        // 未收到 key 时保留已存的。推缓存 key 会把轮换过的 key 覆盖回旧值。
        pushModelConfig({
          model: cfg.model,
          provider:
            cfg.provider && cfg.provider !== "__custom__"
              ? cfg.provider
              : "custom",
          baseUrl: cfg.baseUrl,
        });
      } else {
        // Model not declared in Helix providers (e.g. fetched list only) — at
        // least reflect it in apiConfig so the selector label updates, avoiding
        // a frozen "always same model" display. Also set activeModel so the
        // dropdown highlight and the backend-mirror guard (`activeModel ||
        // cur.model`) don't stay pinned to the previous model.
        useHelixStore.setState({
          activeModel: model,
          apiConfig: { ...useHelixStore.getState().apiConfig, model },
        });
      }
    });
    return () => {
      try {
        unsub();
      } catch {}
    };
  }, []);

  useEffect(() => {
    if (chatMessages.length > 0) {
      setShowSidebar(true);
    }
  }, [chatMessages.length]);

  // ── System tray: "最近对话" menu item ────────────────────────────────
  useEffect(() => {
    const unlisten = listen("tray:show-recent", () => {
      setShowSidebar(true);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // DiffPreview no longer auto-pops: per-file change stats (+green / -red) are
  // rendered inline in the conversation transcript (FileChangeSummary). The
  // top-right diff button still opens the review modal on demand.

  // Track window maximize/restore state via native events

  useEffect(() => {
    const win = (window as any).electron?.window;
    if (!win) return;
    win.isMaximized().then(setIsMaximized);
    const removeListener = win.onMaximizedChange((maximized: boolean) =>
      setIsMaximized(maximized),
    );
    return () => {
      try {
        removeListener?.();
      } catch {}
    };
  }, []);

  // ── Helix gateway connection status ──────────────────────────────────
  // The connection dot next to the Settings button lives in the always-mounted
  // sidebar, but detection used to only live inside useHelix(), which is
  // mounted lazily (settings / skill panels). That is why the badge stayed on
  // "connecting" until the settings panel was opened. Detect here at the top
  // level so the badge reflects reality from startup onward.
  useEffect(() => {
    if (!isElectron()) return;
    const helix = (window as any).electron?.helix;
    if (!helix?.status) return;
    let timer: any = null;
    let startupTimer: any = null;
    let stopped = false;

    // 安排下一次探测（同一时刻只保留一个 timer）。
    const scheduleProbe = (delay: number, retries: number) => {
      if (stopped) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      timer = setTimeout(() => {
        timer = null;
        void probe(retries);
      }, delay);
    };

    // 关键：连上之后也要保持低频心跳，而不是彻底停止探测。
    // 后端重启（例如设置里保存配置触发 respawn）时，gateway.ready 事件可能早于
    // 本订阅建立就被发出而丢失；一旦探测在"成功"时停止，又没有任何机制重启它，
    // 徽章就会永久停在"连接中"——尽管后端其实已经恢复、能够正常回复。
    const probe = async (retries = 0) => {
      if (stopped) return;
      let connected = false;
      try {
        const st = await helix.status();
        connected = !!st?.connected;
      } catch {
        connected = false;
      }
      if (stopped) return;
      if (connected) {
        useGatewayStore.getState().setHelixConnected(true);
        useGatewayStore.getState().setHelixError(null);
        useHelixStore.getState().setGatewayStatus("ready");
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        scheduleProbe(HEALTHY_HEARTBEAT_MS, 0);
      } else {
        useGatewayStore.getState().setHelixConnected(false);
        useHelixStore.getState().setGatewayStatus("connecting");
        // 未连上时用递增间隔重试：前 12 次 1.5s，之后 3s。
        scheduleProbe(retries < 12 ? 1500 : 3000, retries + 1);
      }
    };

    const unsubscribe = helix.onEvent?.((event: string, params?: any) => {
      if (event === "gateway.ready") {
        useGatewayStore.getState().setHelixConnected(true);
        useGatewayStore.getState().setHelixError(null);
        useHelixStore.getState().setGatewayStatus("ready");
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        scheduleProbe(HEALTHY_HEARTBEAT_MS, 0);
      } else if (event === "gateway.disconnected") {
        useGatewayStore.getState().setHelixConnected(false);
        useHelixStore.getState().setGatewayStatus("disconnected");
        scheduleProbe(1500, 0);
      } else if (event === "gateway.retry") {
        const phase = params?.phase as
          | "error"
          | "retrying"
          | "recovered"
          | undefined;
        if (phase === "recovered") {
          useGatewayStore.getState().setHelixConnected(true);
          useHelixStore.getState().setGatewayStatus("ready");
          scheduleProbe(HEALTHY_HEARTBEAT_MS, 0);
        } else {
          useGatewayStore.getState().setHelixConnected(false);
          useHelixStore.getState().setGatewayStatus("connecting");
          scheduleProbe(1500, 0);
        }
      }
    });
    void probe();
    // Startup safety timeout: if gateway never becomes ready within 60s,
    // transition to 'disconnected' so the user sees a retry button instead
    // of being stuck on the blocking overlay forever.
    startupTimer = setTimeout(() => {
      const current = useHelixStore.getState().gatewayStatus;
      if (current !== "ready") {
        useHelixStore.getState().setGatewayStatus("disconnected");
      }
    }, 60_000);
    return () => {
      stopped = true;
      try {
        unsubscribe?.();
      } catch {}
      if (timer) clearTimeout(timer);
      if (startupTimer) clearTimeout(startupTimer);
    };
  }, []);

  const handleMaximizeToggle = useCallback(async () => {
    try {
      const win = (window as any).electron?.window;
      if (!win) return;
      const currentMaximized = await win.isMaximized();
      if (currentMaximized) {
        await win.unmaximize();
      } else {
        await win.maximize();
      }
    } catch (e) {
      console.error("[toggle] error:", e);
    }
  }, []);

  const handleOpenLocation = useCallback(async () => {
    if (!isElectron()) {
      return;
    }
    // If a project directory is already selected, open it in File Explorer.
    // Only fall back to the folder picker when nothing is selected yet.
    if (selectedWorkDir) {
      try {
        await electronShell.openPath(selectedWorkDir);
      } catch (e) {
        console.error("[handleOpenLocation] openPath failed:", e);
      }
      return;
    }
    const { electronDialog } = await import("@/lib/electron-bridge");
    const dir = await electronDialog.openDirectory(
      selectedWorkDir || undefined,
    );
    if (!dir) return;
    try {
      await storeActions.setWorkDir(dir);
    } catch {
      storeActions.setSelectedWorkDir(dir);
    }
  }, [
    storeActions.setWorkDir,
    storeActions.setSelectedWorkDir,
    storeActions.showToast,
    selectedWorkDir,
  ]);

  const handleNewChat = useCallback(() => {
    useHelixStore.getState().flushSessionPersist();
    storeActions.clearChat();
    useHelixStore.getState().clearExecutionFlow();
    useHelixStore.getState().setCurrentSessionId(null);
  }, [storeActions.clearChat]);

  // ── System tray: "新建对话" menu item ──────────────────────────────
  useEffect(() => {
    const unlisten = listen("tray:new-conversation", () => {
      handleNewChat();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [handleNewChat]);

  // Window menu state
  const [windowMenuOpen, setWindowMenuOpen] = useState(false);
  const windowMenuButtonRef = useRef<HTMLButtonElement>(null);
  const windowMenuRef = useRef<HTMLDivElement>(null);

  // Help menu state
  const [helpMenuOpen, setHelpMenuOpen] = useState(false);
  const helpMenuButtonRef = useRef<HTMLButtonElement>(null);
  const helpMenuRef = useRef<HTMLDivElement>(null);
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getCurrentVersion().then((v) => v && setAppVersion(v));
  }, []);

  // Browser "more" menu state (the ••• button next to the browser toggle)
  const [browserMenuOpen, setBrowserMenuOpen] = useState(false);
  const browserMenuButtonRef = useRef<HTMLButtonElement>(null);
  const browserMenuRef = useRef<HTMLDivElement>(null);

  const ZOOM_STEP = 0.1;
  const zoomIn = useCallback(() => {
    const current = parseFloat(document.documentElement.style.zoom || "1");
    document.documentElement.style.zoom = Math.min(
      current + ZOOM_STEP,
      2,
    ).toString();
  }, []);
  const zoomOut = useCallback(() => {
    const current = parseFloat(document.documentElement.style.zoom || "1");
    document.documentElement.style.zoom = Math.max(
      current - ZOOM_STEP,
      0.5,
    ).toString();
  }, []);
  const zoomReset = useCallback(() => {
    document.documentElement.style.zoom = "1";
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  }, []);

  const toggleWindowMenu = useCallback(() => setWindowMenuOpen((v) => !v), []);
  const closeWindowMenu = useCallback(() => setWindowMenuOpen(false), []);

  // Click outside to close window menu
  useEffect(() => {
    if (!windowMenuOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        windowMenuButtonRef.current?.contains(target) ||
        windowMenuRef.current?.contains(target)
      ) {
        return;
      }
      setWindowMenuOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [windowMenuOpen]);

  // Click outside to close help menu
  useEffect(() => {
    if (!helpMenuOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        helpMenuButtonRef.current?.contains(target) ||
        helpMenuRef.current?.contains(target)
      ) {
        return;
      }
      setHelpMenuOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [helpMenuOpen]);

  // Click outside to close browser menu
  useEffect(() => {
    if (!browserMenuOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        browserMenuButtonRef.current?.contains(target) ||
        browserMenuRef.current?.contains(target)
      ) {
        return;
      }
      setBrowserMenuOpen(false);
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [browserMenuOpen]);

  // Window menu keyboard shortcuts
  useEffect(() => {
    const isInputFocused = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      );
    };
    const handler = (e: KeyboardEvent) => {
      if (isInputFocused(e.target)) return;
      if (e.key === "F11") {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      const isMod = e.ctrlKey || e.metaKey;
      if (!isMod) return;
      const shift = e.shiftKey;
      const alt = e.altKey;
      if (!shift && !alt && e.key.toLowerCase() === "b") {
        e.preventDefault();
        if (!showSidebarRef.current) {
          // If sidebar is hidden, show it as narrow strip
          setShowSidebarRef.current(true);
          setSidebarCollapsedRef.current(true);
        } else {
          // If sidebar is visible, toggle collapsed state
          setSidebarCollapsedRef.current((v) => !v);
        }
        return;
      }
      if (!shift && !alt && e.key.toLowerCase() === "l") {
        e.preventDefault();
        setShowSidebarRef.current((v) => !v);
        return;
      }
      if (!shift && !alt && e.key.toLowerCase() === "t") {
        e.preventDefault();
        (window as any).electron?.window?.newWindow();
        return;
      }
      if (shift && !alt && e.code === "Equal") {
        e.preventDefault();
        zoomIn();
        return;
      }
      if (!shift && !alt && e.code === "Minus") {
        e.preventDefault();
        zoomOut();
        return;
      }
      if (!shift && !alt && e.code === "Digit0") {
        e.preventDefault();
        zoomReset();
        return;
      }
      if (shift && !alt && e.code === "BracketLeft") {
        e.preventDefault();
        return;
      }
      if (shift && !alt && e.code === "BracketRight") {
        e.preventDefault();
        return;
      }
      // Ctrl+[ / Ctrl+] handled by keyboard-shortcuts.tsx (go-back / go-forward)
      if (!shift && alt && e.code === "KeyB") {
        e.preventDefault();
        storeActions.toggleSubAgentPanel();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [storeActions, zoomIn, zoomOut, zoomReset, toggleFullscreen]);

  // Start global scheduled task runner
  useEffect(() => {
    startScheduledTaskRunner();
  }, []);

  // ── Task list ───────────────────────────────────────────────────────────
  // 后端没有任务清单 RPC（helix:getTasks 是空桩），任务清单 = 前端已接收的
  // live todos（来自 session/update 的 todo/plan 负载）。

  const windowMenuItems: (WindowMenuItem | { divider: true })[] = useMemo(
    () => [
      {
        label: "新建窗口",
        shortcut: "Ctrl+Shift+N",
        action: () => {
          window.open(window.location.href, "_blank");
          closeWindowMenu();
        },
      },
      {
        label: "关闭窗口",
        shortcut: "Ctrl+Shift+W",
        action: () => {
          window.close();
          closeWindowMenu();
        },
      },
      { divider: true },
      {
        label: "折叠侧边栏",
        shortcut: "Ctrl+B",
        action: () => {
          if (!showSidebar) {
            setShowSidebar(true);
            setSidebarCollapsed(true);
          } else {
            setSidebarCollapsed((v) => !v);
          }
          closeWindowMenu();
        },
      },
      {
        label: "切换侧边栏",
        shortcut: "Ctrl+L",
        action: () => {
          setShowSidebar((v) => !v);
          closeWindowMenu();
        },
      },
      {
        label: "打开终端",
        shortcut: shortcutLabel("toggle-terminal", customShortcuts),
        action: () => {
          useHelixStore.setState({ isTerminalOpen: true });
          closeWindowMenu();
        },
      },
      {
        label: "切换文件树",
        shortcut: shortcutLabel("toggle-file-tree", customShortcuts),
        action: () => {
          if (storeActions.selectedWorkDir)
            storeActions.toggleDirectoryProject(storeActions.selectedWorkDir);
          closeWindowMenu();
        },
      },
      {
        label: "打开代码编辑器",
        action: () => {
          storeActions.setRightSidebarTab("code");
          closeWindowMenu();
        },
      },
      { divider: true },
      {
        label: "设置",
        shortcut: "Ctrl+,",
        action: () => {
          storeActions.toggleSettings("api");
          closeWindowMenu();
        },
      },
      {
        label: "查找",
        shortcut: shortcutLabel("search-chat", customShortcuts),
        action: () => {
          window.dispatchEvent(new CustomEvent("helix:conversation-search"));
          closeWindowMenu();
        },
      },
      {
        label: "后退",
        shortcut: shortcutLabel("go-back", customShortcuts),
        action: () => {
          storeActions.navigateHistory("back");
          closeWindowMenu();
        },
      },
      {
        label: "前进",
        shortcut: shortcutLabel("go-forward", customShortcuts),
        action: () => {
          storeActions.navigateHistory("forward");
          closeWindowMenu();
        },
      },
      { divider: true },
      {
        label: "切换全屏",
        shortcut: "F11",
        action: () => {
          toggleFullscreen();
          closeWindowMenu();
        },
      },
    ],
    [
      setShowSidebar,
      storeActions,
      toggleFullscreen,
      closeWindowMenu,
      customShortcuts,
    ],
  );

  const sidebarExpanded = showSidebar;
  const sidebarPixelWidth = sidebarCollapsed
    ? SIDEBAR_COLLAPSED
    : sidebarWidth * (uiFontSize / 14);
  const titlebarPixelWidth =
    showSidebar && !showSettings ? sidebarPixelWidth : SIDEBAR_COLLAPSED;

  return (
    <div className="helix-app-backdrop relative h-screen w-screen flex flex-row overflow-hidden">
      <KeyboardShortcuts />
      <CommandPalette />
      <ContextMenuProvider />
      <ToastContainer />

      {/* Two-region layout: the titlebar and navigation sidebar form the left
          region; the conversation/settings area owns the right region. */}
      <div
        className={`flex flex-col overflow-hidden bg-sidebar ${showSettings ? "hidden" : ""}`}
      >
        {/* Title bar — head of the left sidebar region */}
        <div
          id="helix-titlebar"
          className="helix-app-titlebar flex items-center justify-between h-10 px-3 shrink-0 select-none"
          style={{ width: titlebarPixelWidth }}
        >
          {/* Left: navigation buttons */}
          <div
            className="flex items-center gap-0.5"
            style={{ WebkitAppRegion: "no-drag" } as any}
          >
            {!showSettings && (
              <button
                onClick={() => setShowSidebar((v) => !v)}
                className={`p-1.5 rounded-lg transition-colors ${showSidebar ? "text-primary bg-primary/10" : "text-foreground/40 hover:text-foreground/80 hover:bg-accent/50"}`}
                data-tip="侧边栏"
              >
                <PanelLeft className="size-5" />
              </button>
            )}
            {!showSettings && (
              <button
                onClick={() => storeActions.navigateHistory("back")}
                disabled={navigationIndex <= 0}
                className="p-1.5 text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors disabled:opacity-30"
                data-tip="后退"
              >
                <ArrowLeft className="size-5" />
              </button>
            )}
            <button
              onClick={() => storeActions.navigateHistory("forward")}
              disabled={navigationIndex >= navigationHistory.length - 1}
              className="p-1.5 text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors disabled:opacity-30"
              data-tip="前进"
            >
              <ArrowRight className="size-5" />
            </button>
            <button
              ref={windowMenuButtonRef}
              onClick={toggleWindowMenu}
              className="px-2 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
              data-tip="窗口"
            >
              窗口
            </button>
            <button
              ref={helpMenuButtonRef}
              onClick={() => setHelpMenuOpen((v) => !v)}
              className="px-2 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
              data-tip="帮助"
            >
              帮助
            </button>
            {helpMenuOpen &&
              typeof window !== "undefined" &&
              createPortal(
                <div
                  className="fixed z-[100]"
                  style={{
                    top:
                      (helpMenuButtonRef.current?.getBoundingClientRect()
                        .bottom ?? 0) + 4,
                    left:
                      helpMenuButtonRef.current?.getBoundingClientRect().left ??
                      0,
                  }}
                >
                  <div
                    ref={helpMenuRef}
                    className="w-56 bg-card border border-border/80 rounded-lg shadow-xl py-1"
                  >
                    <div className="px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-muted-foreground/60">
                      版本 v{appVersion || "0.1.2"}
                    </div>
                    <button
                      className="w-full px-3 py-2 text-[length:var(--helix-transcript-size)] text-left hover:bg-accent/60 transition-colors flex items-center gap-2"
                      onClick={async () => {
                        setHelpMenuOpen(false);
                        try {
                          // 检查 pi agent + npm 插件的更新（npm registry），
                          // 不再查 Helix 应用自身——后端 agent 是外部 pi 包。
                          const res = await (
                            window as any
                          ).electron?.helix?.piCheckUpdates?.();
                          if (!res) {
                            useHelixStore.getState().showToast({
                              type: "error",
                              title: "检查更新失败",
                              description: "更新检查不可用",
                            });
                            return;
                          }
                          const pi = res.pi || {};
                          const outdated = (res.packages || []).filter(
                            (p: any) => p.hasUpdate,
                          );
                          if (pi.hasUpdate && pi.latest) {
                            useHelixStore.getState().showToast({
                              type: "info",
                              title: "pi 有新版本可用",
                              description: `v${pi.installed} → v${pi.latest}${
                                outdated.length > 0
                                  ? `，另有 ${outdated.length} 个插件可更新`
                                  : ""
                              }`,
                              duration: 8000,
                              onClick: () =>
                                window.open(
                                  "https://www.npmjs.com/package/@earendil-works/pi-coding-agent",
                                  "_blank",
                                ),
                            });
                          } else if (outdated.length > 0) {
                            const names = outdated
                              .slice(0, 3)
                              .map(
                                (p: any) =>
                                  `${p.name} v${p.installed} → v${p.latest}`,
                              )
                              .join("\n");
                            useHelixStore.getState().showToast({
                              type: "info",
                              title: `有 ${outdated.length} 个插件可更新`,
                              description:
                                names +
                                (outdated.length > 3
                                  ? `\n…等 ${outdated.length} 个`
                                  : ""),
                              duration: 10000,
                            });
                          } else if (pi.installed) {
                            useHelixStore.getState().showToast({
                              type: "success",
                              title: "已是最新版本",
                              description: `pi v${pi.installed}（含全部插件）`,
                            });
                          } else {
                            useHelixStore.getState().showToast({
                              type: "error",
                              title: "检查更新失败",
                              description: "未找到 pi 安装",
                            });
                          }
                        } catch (e) {
                          useHelixStore.getState().showToast({
                            type: "error",
                            title: "检查更新失败",
                            description:
                              e instanceof Error ? e.message : "网络异常",
                          });
                        }
                      }}
                    >
                      <FileText className="size-5" />
                      检查更新
                    </button>
                  </div>
                </div>,
                document.body,
              )}
            {windowMenuOpen &&
              typeof window !== "undefined" &&
              createPortal(
                <div
                  className="fixed z-[100]"
                  style={{
                    top:
                      (windowMenuButtonRef.current?.getBoundingClientRect()
                        .bottom ?? 0) + 4,
                    left:
                      windowMenuButtonRef.current?.getBoundingClientRect()
                        .left ?? 0,
                  }}
                >
                  <div
                    ref={windowMenuRef}
                    className="w-56 bg-card border border-border/80 rounded-lg shadow-xl py-1"
                  >
                    {windowMenuItems.map((item, i) =>
                      "divider" in item ? (
                        <div key={i} className="h-px bg-border/60 my-1" />
                      ) : (
                        <button
                          key={i}
                          onClick={item.action}
                          className="w-full flex items-center justify-between px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:bg-accent/60 transition-colors"
                        >
                          <span>{item.label}</span>
                          {item.shortcut && (
                            <span className="text-foreground/40 ml-4">
                              {item.shortcut}
                            </span>
                          )}
                        </button>
                      ),
                    )}
                  </div>
                </div>,
                document.body,
              )}
          </div>

          {/* Center: drag region (Tauri uses data-tauri-drag-region; the Electron
            -webkit-app-region CSS is a no-op on Tauri and leaves the window
            undraggable) */}
          <div className="flex-1 self-stretch" data-tauri-drag-region="" />
        </div>

        {/* Sidebar — hidden in settings mode (owned by ApiSettings there). */}
        {showSidebar && !showSettings && (
          <div
            className={`flex-1 shrink-0 overflow-hidden relative ${isDragging ? "" : "transition-[width] duration-200 ease-out"}`}
            style={{ width: sidebarPixelWidth }}
          >
            <div
              className="h-full overflow-hidden"
              style={{ width: sidebarPixelWidth }}
            >
              <Sidebar collapsed={sidebarCollapsed} />
            </div>

            {/* Resize handle — only visible when sidebar is expanded */}
            {!sidebarCollapsed && (
              <div
                className="absolute top-0 -right-1 w-2 h-full cursor-col-resize z-30 group"
                onMouseDown={handleDragStart}
              >
                {/* Visual grip line — hidden until hover */}
                <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-transparent group-hover:bg-border/40 transition-colors" />
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <GripVertical className="size-3 text-primary/60" />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Window controls — hoisted to the root (outside the left titlebar
          region) so the capsule stays visible in settings mode too, where the
          whole left region above is hidden. Pinned to the window's top-right
          corner via the relative `helix-app-backdrop` root. */}
      {/* Unified top-right icon row: conversation actions (任务清单 / 子 Agent /
          后台任务) + window controls (终端 / 更多操作 / min / max / close) all in
          ONE evenly-spaced flex. Conversation actions share the same gating as
          终端/更多操作 — hidden in settings & full-screen panel modes. */}
      <div className="absolute top-[2px] right-2 z-40 h-10 flex items-center gap-3">
        {!showSettings && !hideConversationActions && (
          <>
            {/* 统一工作面板：更改（含提交/推送）、任务清单、子 Agent 收进同一个下拉。 */}
            <div className="relative" ref={workPanelRef}>
              <button
                type="button"
                onClick={() => setWorkPanelOpen((o) => !o)}
                className={`relative flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-full border bg-card text-card-foreground shadow-sm select-none transition-colors ${
                  workPanelOpen
                    ? "border-primary/60 ring-1 ring-primary/20"
                    : "border-border/70 hover:border-border"
                }`}
                data-tip="工作面板"
              >
                {pendingPlanReview ? (
                  <>
                    <Pencil className="size-3.5 text-foreground/60 shrink-0" />
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/80">
                      计划
                    </span>
                    <span className="text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/50">
                      待批准
                    </span>
                  </>
                ) : delegations.length > 0 ? (
                  <>
                    <Users className="size-3.5 text-foreground/60 shrink-0" />
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/80">
                      子 Agent
                    </span>
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] tabular-nums font-medium text-foreground/60">
                      {delegations.length}
                    </span>
                  </>
                ) : helixTodos.length > 0 ? (
                  <>
                    <ListTodo className="size-3.5 text-foreground/60 shrink-0" />
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/80">
                      任务
                    </span>
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] tabular-nums font-medium text-foreground/60">
                      {helixTodos.length}
                    </span>
                  </>
                ) : gitChangeStat ? (
                  <>
                    <FilePlus className="size-3.5 text-foreground/60 shrink-0" />
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/80">
                      更改
                    </span>
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] tabular-nums font-medium text-emerald-600 dark:text-emerald-400">
                      +{gitChangeStat.added}
                    </span>
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] tabular-nums font-medium text-red-500 dark:text-red-400">
                      -{gitChangeStat.removed}
                    </span>
                  </>
                ) : (
                  <ListTodo className="size-[18px] text-foreground/60" />
                )}
              </button>
              {workPanelOpen && (
                <div className="absolute left-0 top-[calc(100%+6px)] z-50 w-80 max-h-[70vh] overflow-y-auto overflow-x-hidden min-w-0 flex flex-col rounded-xl border border-border/80 bg-card text-card-foreground shadow-xl">
                  {gitChangeStat && (
                    <section className="border-b border-border/70">
                      {/* 这里只给总体数字；整行可点 → 跳右侧栏「更改」看逐文件明细。 */}
                      <button
                        type="button"
                        onClick={() => {
                          storeActions.setRightSidebarTab("diff");
                          setWorkPanelOpen(false);
                        }}
                        className="w-full flex items-center gap-2 min-w-0 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
                        data-tip="查看更改明细"
                      >
                        <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-semibold">
                          更改
                        </span>
                        <span className="shrink-0 flex items-center gap-2 text-[calc(var(--helix-transcript-size)*0.7857)] tabular-nums">
                          <span className="text-emerald-600 dark:text-emerald-400">
                            +{gitChangeStat.added}
                          </span>
                          <span className="text-red-500 dark:text-red-400">
                            -{gitChangeStat.removed}
                          </span>
                        </span>
                        <ChevronRight className="size-3.5 shrink-0 text-foreground/40" />
                      </button>
                      <div className="px-3 pb-2">
                        <button
                          type="button"
                          onClick={() => {
                            setCommitMessage(
                              `chore: auto-commit (${new Date().toLocaleString("zh-CN")})`,
                            );
                            setWorkPanelOpen(false);
                            setCommitDialogOpen(true);
                          }}
                          disabled={isCommitting}
                          className="w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-lg border border-border/70 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/80 hover:bg-accent/60 disabled:opacity-50 transition-colors"
                        >
                          <Send className="size-4" />
                          提交并推送
                        </button>
                      </div>
                    </section>
                  )}
                  {pendingPlanReview && (
                    <section className="border-b border-border/70">
                      <div className="flex items-center gap-2 min-w-0 px-3 py-2">
                        <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-semibold">
                          计划 · 待批准
                        </span>
                        <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/50">
                          计划模式
                        </span>
                      </div>
                      <div className="px-3 pb-3">
                        <div className="max-h-48 overflow-y-auto rounded-lg border border-border/30 bg-muted/20 px-3 py-2 text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/80 whitespace-pre-wrap break-words">
                          {pendingPlanReview.content}
                        </div>
                        <p className="mt-1.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
                          底部「计划审批」浮条可选择 批准执行 / 继续调整
                        </p>
                      </div>
                    </section>
                  )}
                  <section className="border-b border-border/70">
                    <div className="flex items-center gap-2 min-w-0 px-3 py-2">
                      <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-semibold">
                        任务清单
                      </span>
                      <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/50">
                        {
                          helixTodos.filter((t) => t.status === "completed")
                            .length
                        }
                        /{helixTodos.length}
                      </span>
                    </div>
                    <ul className="py-1">
                      {helixTodos.map((todo) => (
                        <li
                          key={todo.id}
                          className="flex items-start gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)]"
                        >
                          {todo.status === "completed" ? (
                            <CheckCircle2 className="size-4 text-green-500 shrink-0 mt-0.5" />
                          ) : todo.status === "in_progress" ? (
                            <Loader2 className="size-4 text-primary shrink-0 mt-0.5 animate-spin" />
                          ) : todo.status === "cancelled" ? (
                            <XCircle className="size-4 text-muted-foreground shrink-0 mt-0.5" />
                          ) : (
                            <Circle className="size-4 text-foreground/40 shrink-0 mt-0.5" />
                          )}
                          <span
                            className={`min-w-0 break-words ${
                              todo.status === "completed"
                                ? "line-through text-foreground/50"
                                : todo.status === "cancelled"
                                  ? "line-through text-foreground/40"
                                  : "text-foreground/90"
                            }`}
                          >
                            {todo.content}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                  {isElectron() && (
                    <section>
                      <div className="flex items-center gap-2 min-w-0 px-3 py-2">
                        <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-semibold">
                          子 Agent
                        </span>
                        <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/50">
                          {delegations.length} 个
                        </span>
                      </div>
                      <div className="max-h-64 overflow-auto">
                        {/* 点某个 agent → 右侧栏打开它的工作内容（不再走「查看详情」）。 */}
                        {delegations.map((del) => (
                          <button
                            key={del.id}
                            type="button"
                            onClick={() => {
                              storeActions.openAgentView({
                                id: del.id,
                                name: del.id,
                              });
                              setWorkPanelOpen(false);
                            }}
                            className="w-full text-left px-3 py-2 border-t border-border/30 first:border-t-0 hover:bg-accent/60 transition-colors"
                            data-tip="在右侧栏查看工作内容"
                          >
                            <div className="flex items-center gap-2">
                              <Terminal className="size-3 text-primary shrink-0" />
                              <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-foreground/80">
                                {del.id}
                              </span>
                              <ChevronRight className="size-3.5 text-foreground/40 shrink-0" />
                            </div>
                            <div className="mt-1 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
                              {(del.tasks || []).length} 个任务
                            </div>
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              )}
            </div>
            {/* 提交弹窗：点「提交并推送」弹出，含提交信息输入框 + 提交 / 提交并推送 两个动作 */}
            {commitDialogOpen && typeof window !== "undefined" && (
              <>
                <div
                  className="fixed inset-0 bg-black/30 z-[300]"
                  onClick={() => !isCommitting && setCommitDialogOpen(false)}
                />
                <div className="fixed z-[310] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[480px] max-h-[80vh] bg-card rounded-xl border border-border/50 shadow-2xl flex flex-col overflow-hidden">
                  <div className="shrink-0 px-5 pt-5 pb-3 flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="text-[calc(var(--helix-transcript-size)*1.1429)] font-semibold text-foreground leading-tight">
                        提交更改
                      </h3>
                      <p className="mt-1 text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground tabular-nums">
                        {gitChangeStat?.files.length ?? 0} 个文件待提交 ·{" "}
                        <span className="text-emerald-600 dark:text-emerald-400">
                          +{gitChangeStat?.added ?? 0}
                        </span>{" "}
                        <span className="text-red-500 dark:text-red-400">
                          -{gitChangeStat?.removed ?? 0}
                        </span>
                      </p>
                    </div>
                    <button
                      onClick={() =>
                        !isCommitting && setCommitDialogOpen(false)
                      }
                      disabled={isCommitting}
                      className="shrink-0 p-1 rounded text-foreground/40 hover:text-foreground hover:bg-accent/50 transition-colors disabled:opacity-40"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  <div className="shrink-0 px-5 pb-4">
                    <label className="block text-[calc(var(--helix-transcript-size)*0.7857)] text-muted-foreground mb-1.5">
                      提交信息
                    </label>
                    <textarea
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                      rows={3}
                      autoFocus
                      className="w-full resize-none rounded-lg border border-border/30 bg-muted/20 px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground outline-none focus:border-primary/50 transition-colors"
                    />
                  </div>
                  <div className="shrink-0 px-5 pb-5 flex items-center justify-end gap-2.5">
                    <button
                      onClick={() => quickCommit(false, commitMessage)}
                      disabled={isCommitting}
                      className="px-4 py-2 rounded-lg text-[calc(var(--helix-transcript-size)*0.9286)] font-medium text-foreground/70 bg-muted/50 hover:bg-muted/80 transition-colors disabled:opacity-40 flex items-center gap-1.5"
                    >
                      {isCommitting ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <GitCommit className="size-4" />
                      )}
                      提交
                    </button>
                    <button
                      onClick={() => quickCommit(true, commitMessage)}
                      disabled={isCommitting}
                      className="px-4 py-2 rounded-lg text-[calc(var(--helix-transcript-size)*0.9286)] font-medium text-primary-foreground bg-primary hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    >
                      {isCommitting ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Send className="size-4" />
                      )}
                      提交并推送
                    </button>
                  </div>
                </div>
              </>
            )}
            {(runningBgTasks.length > 0 || bgTasksOpen) && (
              <div className="relative" ref={bgTasksRef}>
                <button
                  onClick={() => setBgTasksOpen((v) => !v)}
                  className={`relative p-1.5 rounded-lg transition-colors ${bgTasksOpen ? "text-primary bg-primary/10" : "text-foreground/50 hover:text-foreground hover:bg-accent/60"}`}
                  data-tip="后台任务"
                >
                  <Loader2 className="size-[18px]" />
                  {runningBgTasks.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-primary text-primary-foreground text-[calc(var(--helix-transcript-size)*0.6429)] font-medium flex items-center justify-center">
                      {runningBgTasks.length}
                    </span>
                  )}
                </button>
                {bgTasksOpen && (
                  <BackgroundTasksPanel
                    tasks={bgTasks}
                    activeSessionId={helixSessionId}
                    onClose={() => setBgTasksOpen(false)}
                    onRefresh={loadBgTasks}
                  />
                )}
              </div>
            )}
            <button
              onClick={() => storeActions.toggleTerminal()}
              className={`p-1.5 rounded-lg transition-colors ${isTerminalOpen ? "text-primary bg-primary/10" : "text-foreground/50 hover:text-foreground hover:bg-accent/60"}`}
              data-tip="终端"
            >
              <Terminal className="size-4" />
            </button>
            <button
              ref={browserMenuButtonRef}
              onClick={() => setBrowserMenuOpen((v) => !v)}
              className={`p-1.5 rounded-lg transition-colors ${browserMenuOpen ? "text-primary bg-primary/10" : "text-foreground/50 hover:text-foreground hover:bg-accent/60"}`}
              data-tip="更多操作"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </>
        )}
        <button
          onClick={() => (window as any).electron?.window?.minimize()}
          className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
          data-tip="最小化"
        >
          <Minus className="size-4" />
        </button>
        <button
          onClick={handleMaximizeToggle}
          className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
          data-tip={isMaximized ? "还原" : "最大化"}
        >
          {isMaximized ? (
            <Copy className="size-4" />
          ) : (
            <Square className="size-4" />
          )}
        </button>
        <button
          onClick={() => (window as any).electron?.window?.close()}
          className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-destructive/10 hover:text-destructive rounded-lg transition-colors"
          data-tip="关闭"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Right region: settings or conversation */}
      <div className="flex-1 flex overflow-hidden">
        {/* Floating cards container — settings mode owns its own sidebar +
            card and is rendered full-height (no inset); the main chat branch
            below applies its own mt/mb inset so the chat card floats. */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {showSettings ? (
            <div className="helix-surface flex-1 flex flex-col overflow-hidden min-h-0">
              <PanelSuspense>
                <ApiSettings
                  themeStyle={themeStyle}
                  onSelectThemeStyle={setThemeStyle}
                  sidebarWidth={sidebarWidth}
                  setSidebarWidth={setSidebarWidth}
                  saveSidebarWidth={saveSidebarWidth}
                  showSidebar={showSidebar}
                  setShowSidebar={setShowSidebar}
                  sidebarCollapsed={sidebarCollapsed}
                  setSidebarCollapsed={setSidebarCollapsed}
                />
              </PanelSuspense>
            </div>
          ) : (
            <div className="flex-1 min-h-0 flex flex-col mr-px ml-0 overflow-hidden">
              <div className="flex-1 min-h-0 flex flex-row relative">
                {/* Floating card — main content. Hidden when the code panel is in
            fullscreen (the right sidebar takes over the main area). */}
                <div
                  className={`helix-surface flex-1 flex flex-col overflow-hidden ${codeFullscreen ? "hidden" : ""}`}
                >
                  {/* Main area */}
                  <div className="relative flex-1 h-full flex flex-col overflow-hidden">
                    <div
                      className={`flex-1 flex flex-row overflow-hidden ${sidePanelOpen ? "hidden" : ""}`}
                    >
                      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
                        {/* Conversation header — only visible when an active conversation has messages */}
                        {chatMessages.length > 0 && !!currentSessionId && (
                          <div className="shrink-0 h-10 flex items-center justify-between gap-2 px-3 pr-44">
                            {!showSettings && !hideConversationActions && (
                              <div className="flex items-center gap-3 min-w-0 mt-[2px] ml-2">
                                {/* 项目外对话（activeSessionWorkDir 为空）不显示项目目录与分支 */}
                                {activeSessionWorkDir && (
                                  <button
                                    onClick={handleOpenLocation}
                                    className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/70 hover:text-foreground hover:bg-accent/60 px-2 py-1 rounded-lg transition-colors shrink-0"
                                    data-tip={
                                      selectedWorkDir
                                        ? "在资源管理器中打开"
                                        : "选择位置"
                                    }
                                  >
                                    <Folder className="size-4 text-muted-foreground" />
                                    <span className="max-w-[200px] truncate">
                                      {selectedWorkDir
                                        ? (() => {
                                            const n =
                                              selectedWorkDir
                                                .split(/[\/\\]/)
                                                .pop() || selectedWorkDir;
                                            return n.length > 8
                                              ? n.slice(0, 8) + "…"
                                              : n;
                                          })()
                                        : "未选择位置"}
                                    </span>
                                  </button>
                                )}
                                {branchPickerWorkDir && gitBranch && (
                                  <BranchPicker
                                    workDir={branchPickerWorkDir}
                                    currentBranch={gitBranch}
                                    onBranchChange={(b) => setGitBranch(b)}
                                    drop="down"
                                  />
                                )}
                              </div>
                            )}
                            <div className="flex items-center gap-1 shrink-0">
                              {browserMenuOpen &&
                                typeof window !== "undefined" &&
                                createPortal(
                                  <div
                                    className="fixed z-[100]"
                                    style={{
                                      top:
                                        (browserMenuButtonRef.current?.getBoundingClientRect()
                                          .bottom ?? 0) + 4,
                                      left: browserMenuButtonRef.current
                                        ? Math.max(
                                            8,
                                            browserMenuButtonRef.current.getBoundingClientRect()
                                              .right - 208,
                                          )
                                        : 0,
                                    }}
                                  >
                                    <div ref={browserMenuRef}>
                                      <MoreActionsMenu
                                        onToggleTab={(kind) => {
                                          if (rightSidebarTab !== kind)
                                            storeActions.setRightSidebarTab(
                                              kind,
                                            );
                                          setBrowserMenuOpen(false);
                                        }}
                                        onAddBrowser={() => {
                                          storeActions.requestAddBrowserPage();
                                          setBrowserMenuOpen(false);
                                        }}
                                      />
                                    </div>
                                  </div>,
                                  document.body,
                                )}
                            </div>
                          </div>
                        )}
                        <div className="flex-1 min-h-0 min-w-0 flex flex-col">
                          <AgentFlowPanel />
                        </div>
                      </div>
                    </div>
                  </div>
                  {showScheduledTasksPanel && (
                    <div className="helix-surface helix-surface-overlay z-20 rounded-2xl overflow-hidden flex flex-col">
                      <PanelSuspense>
                        <ScheduledTasksPanel />
                      </PanelSuspense>
                    </div>
                  )}
                  {showSkillPanel && (
                    <div className="helix-surface helix-surface-overlay z-20 rounded-2xl overflow-hidden flex flex-col">
                      <PanelSuspense>
                        <SkillPanel />
                      </PanelSuspense>
                    </div>
                  )}
                </div>
                {/* Floating card — right sidebar. Kept mounted at all times so switching
            tabs (and the browser <webview>) never rebuilds; visibility is toggled
            with the `hidden` class + width instead of a conditional mount, which
            removes the "flash / white-screen on first open and on every tab
            switch". */}
                <div
                  className={`relative ${codeFullscreen ? "flex-1 min-w-0" : "shrink-0"} ${rightSidebarTab && !(showSkillPanel || showScheduledTasksPanel || showRuntimePanel || showWorktreePanel || showSubAgentPanel) ? "" : "hidden"}`}
                  style={
                    codeFullscreen
                      ? undefined
                      : { width: rightSidebarTab ? rightSidebarWidth : 0 }
                  }
                >
                  {!codeFullscreen && (
                    <div
                      className="absolute top-0 -left-1 w-2 h-full cursor-col-resize z-30 group"
                      onMouseDown={handleRightDragStart}
                    >
                      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-transparent group-hover:bg-border/40 transition-colors" />
                    </div>
                  )}
                  <div className="helix-surface h-full rounded-2xl overflow-hidden">
                    <RightSidebar />
                  </div>
                </div>
                {showRuntimePanel && (
                  <div className="absolute inset-0 z-20">
                    <PanelSuspense>
                      <RuntimePanel
                        onClose={() => storeActions.toggleRuntimePanel()}
                      />
                    </PanelSuspense>
                  </div>
                )}
                {showWorktreePanel && (
                  <div className="absolute inset-0 z-20">
                    <PanelSuspense>
                      <WorktreePanel
                        onClose={() => storeActions.toggleWorktreePanel()}
                      />
                    </PanelSuspense>
                  </div>
                )}
                <div
                  className={`absolute inset-0 z-20 ${showSubAgentPanel ? "" : "hidden"}`}
                >
                  <PanelSuspense>
                    <DelegationsPanel
                      onClose={() => storeActions.toggleSubAgentPanel()}
                    />
                  </PanelSuspense>
                </div>
              </div>
              {/* Terminal: a bottom panel of the whole main area (NOT inside the main
              conversation card), so it stays visible when the code editor is in
              fullscreen — which hides the conversation card. */}
              <TerminalPanel onClose={storeActions.toggleTerminal} />
            </div>
          )}
        </div>
      </div>
      {/* Overlay panels */}
      <Suspense fallback={null}>
        {showSessionManager && (
          <SessionManager onClose={() => storeActions.toggleSessionManager()} />
        )}
        {showCustomizePanel && (
          <CustomizePanel onClose={() => storeActions.toggleCustomizePanel()} />
        )}
        {/* New surfaces */}
        {showActivityFeed && (
          <ActivityFeed onClose={() => storeActions.toggleActivityFeed()} />
        )}
        {showArtifactsBrowser && (
          <ArtifactsBrowser
            onClose={() => storeActions.toggleArtifactsBrowser()}
          />
        )}
        {restoreReady && <Onboarding />}
        <BootOverlay />
        <GlobalTooltip />
      </Suspense>
    </div>
  );
}

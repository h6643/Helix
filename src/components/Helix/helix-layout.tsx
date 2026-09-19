"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
import { createPortal } from "react-dom";
import { AgentFlowPanel } from "./agent-flow-panel";
import { BackgroundTasksPanel, type BgTask } from "./background-tasks-panel";
import { BranchPicker } from "./branch-picker";
import { CommandPalette } from "./command-palette";
import { ContextMenuProvider } from "./context-menu";
import { GlobalTooltip } from "./global-tooltip";
import { KeyboardShortcuts } from "./keyboard-shortcuts";
import { Sidebar } from "./sidebar";
import { ToastContainer } from "./toast-container";
import { getCurrentVersion } from "@/hooks/use-check-update";
import { useCheckUpdate } from "@/hooks/use-check-update";
import { useGitChangeStat } from "@/hooks/use-git-change-stat";
import {
  BrowserExecFrame,
  useBrowserAutomation,
} from "@/lib/browser-automation";
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
import { resolveBackendSid, resolveBackendSids } from "@/lib/session-map";
import { applyHelixPalette } from "@/lib/themes";
import { isSyntheticSubAgentToolRow } from "@/lib/tool-display-utils";
import { useGatewayStore } from "@/stores/gateway-store";
import { useHelixStore } from "@/stores/helix-store";

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
import { useProviderStore } from "@/stores/slices/provider-store";

// Local Suspense for the always-visible panel areas. Without a boundary the
// lazy panels' chunk load bubbles up to the root Suspense in main.tsx, which
// blanks the WHOLE app for its fallback and unmounts every component.
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
const RIGHT_SIDEBAR_DEFAULT = 280;
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
        } catch { /* empty */}
        return SIDEBAR_DEFAULT;
      }
      if (n >= SIDEBAR_MIN && n <= leftSidebarCap(RIGHT_SIDEBAR_DEFAULT))
        return n;
    }
  } catch { /* empty */}
  return SIDEBAR_DEFAULT;
}

function saveSidebarWidth(w: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(w));
  } catch { /* empty */}
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
  } catch { /* empty */}
  return Math.min(RIGHT_SIDEBAR_DEFAULT, cap);
}

function saveRightSidebarWidth(w: number) {
  try {
    localStorage.setItem(RIGHT_STORAGE_KEY, String(w));
  } catch { /* empty */}
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

  // External entrypoint: open a URL in the right-sidebar embedded browser.
  // Driven by the existing store action setPreviewRailUrl (which navigates the
  // preview rail + switches to the browser tab in one shot). Exposed on window
  // so the Tauri side / devtools can trigger it (mirrors the __helixActivity
  // global-hook pattern in activity-feed.tsx).
  //
  // The same effect also wires the pi-extension browser automation protocol:
  // poll_browser_requests emits `helix:browser-request` with the full payload
  // (op/url/reqId/params). navigate goes through the legacy open path (real
  // webview); read/click/type/press run against a same-origin page snapshot
  // (see lib/browser-automation.tsx) and the result is written back via the
  // browser_write_result command so the pi tool can resolve.
  const { enqueue: enqueueBrowserOp, frameHtml: browserExecHtml } =
    useBrowserAutomation();
  const enqueueBrowserOpRef = useRef(enqueueBrowserOp);
  enqueueBrowserOpRef.current = enqueueBrowserOp;
  useEffect(() => {
    const open = (url: string) => {
      if (!url) return;
      const s = useHelixStore.getState();
      s.setPreviewRailUrl(url);
      s.setRightSidebarTab("browser");
    };
    (window as any).__helixOpenBrowser = open;
    // Tauri event bridge: Rust commands (e.g. agent-triggered) emit this to
    // open a URL in the side browser without needing direct DOM access.
    let unlisten: (() => void) | undefined;
    let unlistenReq: (() => void) | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const { isTauri } = await import("@/lib/tauri-bridge");
        if (isTauri()) {
          unlisten = await listen("helix:open-browser", (e: any) =>
            open(String(e.payload?.url ?? "")),
          );
          // Automation requests from the pi extension (op + reqId + params).
          // navigate is ALSO emitted as helix:open-browser by Rust (back-compat)
          // and must not be double-processed here.
          unlistenReq = await listen(
            "helix:browser-request",
            async (e: any) => {
              const p: any = e.payload ?? {};
              if (p.op === "navigate") return; // legacy event already opened it
              const reqId = String(p.reqId ?? "");
              if (!reqId) return;
              // back/forward/refresh act on the real webview — dispatch through
              // the open path so the panel's URL flow stays authoritative; the
              // pi tool gets an immediate ack (no snapshot needed).
              if (p.op === "back" || p.op === "forward" || p.op === "refresh") {
                // The embedded <webview> exposes goBack/goForward/reload via the
                // browser panel's own ref; from here the store-level equivalents
                // are enough of an approximation for navigate-style ops.
                const { electronApp } = await import("@/lib/electron-bridge");
                electronApp.browserWriteResult?.(reqId, {
                  ok: true,
                  note: `${p.op} 已在当前浏览器页执行`,
                });
                return;
              }
              // read/click/type/press — snapshot executor. The op targets the
              // CURRENT browser page when the request carries no url.
              const snapshotUrl =
                (typeof p.url === "string" && p.url) || undefined;
              const activeUrl =
                snapshotUrl ??
                useHelixStore.getState().previewRailUrl ??
                undefined;
              if (!activeUrl) {
                const { electronApp } = await import("@/lib/electron-bridge");
                electronApp.browserWriteResult?.(reqId, {
                  ok: false,
                  error:
                    "当前没有打开的浏览器页面——先用 open_browser / browser_navigate 打开一个 URL",
                });
                return;
              }
              enqueueBrowserOpRef.current({
                op: p.op,
                url: activeUrl,
                reqId,
                params: p.params ?? {},
              });
            },
          );
          // Poll the pi extension's browser request queue. The Rust command
          // emits helix:browser-request (full payload) and the legacy
          // helix:open-browser for navigate ops, which the listener above picks up.
          try {
            const { electronApp } = await import("@/lib/electron-bridge");
            pollTimer = setInterval(async () => {
              try { await electronApp.pollBrowserRequests?.(); } catch { /* ignore */ }
            }, 800);
          } catch { /* poll is best-effort */ }
        }
      } catch {
        /* non-Tauri / no event bridge — window.__helixOpenBrowser still works */
      }
    })();
    return () => {
      delete (window as any).__helixOpenBrowser;
      unlisten?.();
      unlistenReq?.();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, []);

  useEffect(() => {
    setSidebarCollapsedRef.current = setSidebarCollapsed;
  }, [setSidebarCollapsed]);

  useEffect(() => {
    setShowSidebarRef.current = setShowSidebar;
  }, [setShowSidebar]);

  // ── Sidebar resize drag ──────────────────────────────────────────────
  const handleDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
    const onMove = (e: PointerEvent) => {
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
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [isDragging]);

  // ── Right sidebar resize drag ────────────────────────────────────────
  const handleRightDragStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
    const onMove = (e: PointerEvent) => {
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
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      cancelAnimationFrame(raf);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
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
  const pendingPlanReviewAll = useHelixStore((s) => s.pendingPlanReview);
  // 实时子代理（store.subAgents，由 subagent.* 事件写入）。pi-subagents 的
  // Agent 工具不写旧 delegate_task 磁盘目录，磁盘探测（hasDelegations）看不到
  // 它们 — 实时状态必须直接参与按钮显示条件。
  const subAgentsAll = useHelixStore((s) => s.subAgents);
  // ── 会话私有视图 ─────────────────────────────────────────────────────────
  // 工作面板的所有区块只展示当前对话的内容：subAgents 按 spawn 时快照的
  // sessionId 过滤（旧数据无该字段时回退为可见——升级瞬间不至于清空），
  // pendingPlanReview 按 sessionId 匹配当前对话（草稿对话用 __draft__ 键）。
  const DRAFT_KEY = "__draft__";
  const planKey = currentSessionId ?? DRAFT_KEY;
  const subAgents = useMemo(
    () =>
      subAgentsAll.filter(
        (a) => !a.sessionId || a.sessionId === currentSessionId,
      ),
    [subAgentsAll, currentSessionId],
  );
  const pendingPlanReview =
    pendingPlanReviewAll &&
    (pendingPlanReviewAll.sessionId === planKey ||
      !pendingPlanReviewAll.sessionId)
      ? pendingPlanReviewAll
      : null;
  // Stable action references — these never change so getState() is safe
  const storeActions = useMemo(() => useHelixStore.getState(), []);
  const [restoreReady, setRestoreReady] = useState(startupSyncDone);
  const [delegations, setDelegations] = useState<
    Array<{ id: string; tasks: Array<{ name: string; modified: number }> }>
  >([]);
  const [hasDelegations, setHasDelegations] = useState(false);
  // 后台任务（pi-background-tasks 扩展注册表）：面板打开时 3s 轮询，平时
  // 10s 慢轮询维持按钮徽标。数据经 Rust tasks_list 读共享 tasks.json。
  const [bgTasksAll, setBgTasks] = useState<BgTask[]>([]);
  const [bgTasksOpen, setBgTasksOpen] = useState(false);
  const bgTasksRef = useRef<HTMLDivElement>(null);
  const helixSessionId = useGatewayStore((s) => s.helixSessionId);
  const loadBgTasks = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const api = (window as any).electron as any;
      const res = await api?.backgroundTasks?.list?.();
      if (res?.ok) setBgTasks(res.tasks || []);
    } catch { /* empty */}
  }, []);
  useEffect(() => {
    if (!isElectron()) return;
    loadBgTasks();
    const interval = setInterval(loadBgTasks, bgTasksOpen ? 3000 : 10000);
    return () => clearInterval(interval);
  }, [bgTasksOpen, loadBgTasks]);
  // 后台任务按会话隔离：registry 里的 session_id 是 pi 后端 sid，与全局
  // helixSessionId（当前对话绑定的后端会话）比对。独立的后台任务面板不
  // 在这里过滤（它自己分「本会话 / 其他来源」，收全量 bgTasksAll）。
  // 工作面板下拉的后台任务区：仅本会话任务。其它会话 / unknown 的去右上
  // 角独立「后台任务」按钮看（那是全局视图）——工作面板是会话语境，混入
  // 别的会话的任务会被读成"子 Agent 里冒出了后台任务"。
  const workPanelBgTasks = useMemo(
    () =>
      helixSessionId
        ? bgTasksAll.filter((t) => t.session_id === helixSessionId).slice(0, 8)
        : [],
    [bgTasksAll, helixSessionId],
  );
  // 独立「后台任务」按钮的徽标：全局运行数（它是全局面板，非会话私有）。
  const runningBgTasks = useMemo(
    () => bgTasksAll.filter((t) => t.status === "running"),
    [bgTasksAll],
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
  const workPanelBtnRef = useRef<HTMLButtonElement>(null);
  const workPanelPortalRef = useRef<HTMLDivElement>(null);
  // 点击面板外部时关闭统一工作面板。
  useEffect(() => {
    if (!workPanelOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (
        workPanelRef.current &&
        !workPanelRef.current.contains(e.target as Node) &&
        workPanelPortalRef.current &&
        !workPanelPortalRef.current.contains(e.target as Node)
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
  // Check if delegations exist on mount — for button visibility.
  // 过滤键必须是 pi 后端 sid（delegation manifest.json 里存的是网关会话 id），
  // 而非前端会话 id——两者命名空间不同，传错会全部漏掉（旧 bug：跨会话共享）。
  // 无后端会话（草稿/未发消息的对话）→ 无委托，绝不能退化为列出全部。
  useEffect(() => {
    if (!isElectron()) return;
    let cancelled = false;
    const checkDelegations = async () => {
      try {
        // 会话的全部历史 sid：/clear、重启重建后磁盘委托仍留在旧 sid 名下。
        const sids = await resolveBackendSids(currentSessionId);
        console.info(
          "[SubAgentRehydrate] check: cid=",
          currentSessionId,
          "sids=",
          sids,
        );
        if (sids.length === 0) {
          if (!cancelled) setHasDelegations(false);
          return;
        }
        const api = (window as any).electron as any;
        const res = await api?.delegations?.list?.(sids);
        console.info(
          "[SubAgentRehydrate] disk:",
          (res?.delegations || []).length,
          "entries for sids",
          sids,
        );
        if (!cancelled && res?.ok) {
          setHasDelegations((res.delegations || []).length > 0);
          // 重启后实时卡片全丢——按磁盘记录重建（事件卡片已在 store 时
          // 按 id 去重跳过），让历史子 Agent 不随重启消失。
          useHelixStore
            .getState()
            .rehydrateSubAgentsFromDisk(
              currentSessionId,
              (res.delegations || []).map((d: any) => ({
                id: d.id,
                agentId: d.agent_id || undefined,
                goal: d.goal || undefined,
                prompt: d.prompt || undefined,
                status: d.status || undefined,
                summary: d.summary || undefined,
              })),
            );
        }
      } catch { /* empty */}
    };
    checkDelegations();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);

  // Load full delegations data on demand — only when work panel is opened.
  // 同上：按会话全部历史 sid 过滤，只显示当前对话的子 Agent 磁盘记录。
  const loadDelegations = useCallback(async () => {
    if (!isElectron()) return;
    try {
      const sids = await resolveBackendSids(
        useHelixStore.getState().currentSessionId,
      );
      if (sids.length === 0) {
        setDelegations([]);
        setHasDelegations(false);
        return;
      }
      const api = (window as any).electron as any;
      const res = await api?.delegations?.list?.(sids);
      if (res?.ok) {
        setDelegations(res.delegations || []);
        setHasDelegations((res.delegations || []).length > 0);
      }
    } catch { /* empty */}
  }, []);

  useEffect(() => {
    if (workPanelOpen) {
      loadDelegations();
    }
  }, [workPanelOpen, loadDelegations]);
  // 切换对话时立即按新会话的全部历史 sid 重新探测磁盘记录，胶囊可见性不留旧会话残影。
  useEffect(() => {
    if (!isElectron()) return;
    let cancelled = false;
    resolveBackendSids(currentSessionId)
      .then(async (sids) => {
        if (sids.length === 0) {
          if (!cancelled) {
            setDelegations([]);
            setHasDelegations(false);
          }
          return;
        }
        const api = (window as any).electron as any;
        const res = await api?.delegations?.list?.(sids);
        if (!cancelled && res?.ok) {
          setDelegations(res.delegations || []);
          setHasDelegations((res.delegations || []).length > 0);
          const before = useHelixStore.getState().subAgents.length;
          const diskAgents = (res.delegations || []).map((d: any) => ({
            id: d.id,
            agentId: d.agent_id || undefined,
            goal: d.goal || undefined,
            prompt: d.prompt || undefined,
            status: d.status || undefined,
            summary: d.summary || undefined,
          }));
          useHelixStore
            .getState()
            .rehydrateSubAgentsFromDisk(currentSessionId, diskAgents);
          // 重启后 pi 网关会话会换新 sid：本对话的旧 sid 名下磁盘子 agent
          // 记录（含 completed）必须重新挂到当前会话，否则「子 Agent」胶囊
          // 只在切换会话时才出现。上面的 rehydrate 已做这件事；这里只是
          // 补一个诊断，方便日后排查。
          console.info(
            "[SubAgentRehydrate] session-switch: disk=",
            diskAgents.length,
            "cards before=",
            before,
            "after=",
            useHelixStore.getState().subAgents.length,
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
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
          } catch { /* empty */}
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
      } catch { /* empty */}
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
      } catch { /* empty */}
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
        // 新网关进程（非同进程重连）：旧缓存的后端 sid 全部失效，bump epoch
        // 让 handleRun 的 session/resume 分支真正触发，而不是静默走缓存路径。
        if (params?.sameGateway !== true) {
          useGatewayStore.getState().bumpGatewayEpoch();
        }
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
      } catch { /* empty */}
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
        {/* Title bar — head of the left sidebar region. The whole bar is the
             window drag handle: the child buttons are covered by the
             `#helix-titlebar button` / `[role="button"]` no-drag rules, and the
             help/window menus are portal-rendered into <body> so they never sit
             inside this region. */}
        <div
          id="helix-titlebar"
          className="helix-app-titlebar flex items-center justify-between h-10 px-3 shrink-0 select-none"
          data-tauri-drag-region=""
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
                data-tauri-drag-region="false"
                className={`p-1.5 rounded-lg transition-colors ${showSidebar ? "text-primary bg-primary/10" : "text-foreground/40 hover:text-foreground/80 hover:bg-accent/50"}`}
                data-tip="侧边栏"
              >
                <PanelLeft className="size-5" />
              </button>
            )}
            {!showSettings && (
              <button
                onClick={() => storeActions.navigateHistory("back")}
                data-tauri-drag-region="false"
                disabled={navigationIndex <= 0}
                className="p-1.5 text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors disabled:opacity-30"
                data-tip="后退"
              >
                <ArrowLeft className="size-5" />
              </button>
            )}
            <button
              onClick={() => storeActions.navigateHistory("forward")}
              data-tauri-drag-region="false"
              disabled={navigationIndex >= navigationHistory.length - 1}
              className="p-1.5 text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors disabled:opacity-30"
              data-tip="前进"
            >
              <ArrowRight className="size-5" />
            </button>
            <button
              ref={windowMenuButtonRef}
              onClick={toggleWindowMenu}
              data-tauri-drag-region="false"
              className="px-2 py-1 text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/50 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
              data-tip="窗口"
            >
              窗口
            </button>
            <button
              ref={helpMenuButtonRef}
              onClick={() => setHelpMenuOpen((v) => !v)}
              data-tauri-drag-region="false"
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
                onPointerDown={handleDragStart}
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
      <div
        className="absolute top-[2px] right-2 z-40 h-10 flex items-center gap-3"
        data-tauri-drag-region=""
      >
        {!showSettings && !hideConversationActions && (
          <>
            {/* 统一工作面板：更改（含提交/推送）、任务清单、子 Agent 收进同一个下拉。仅在有内容时显示。 */}
            {(pendingPlanReview ||
              hasDelegations ||
              delegations.length > 0 ||
              subAgents.length > 0 ||
              helixTodos.length > 0 ||
              gitChangeStat) && (
              <div className="relative" ref={workPanelRef}>
                <button
                  type="button"
                  ref={workPanelBtnRef}
                  onClick={() => setWorkPanelOpen((o) => !o)}
                  data-tauri-drag-region="false"
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
                    <span className="text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-px rounded-full bg-primary/10 text-primary">
                      待批准
                    </span>
                  </>
                ) : subAgents.length > 0 ? (
                  <>
                    <Users className="size-3.5 text-foreground/60 shrink-0" />
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/80">
                      子 Agent
                    </span>
                    <span className="flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.8571)] tabular-nums font-medium text-foreground/60">
                      {subAgents.some((a) => a.status === "running") && (
                        <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                      )}
                      {subAgents.length}
                    </span>
                  </>
                ) : (hasDelegations && delegations.length > 0) ? (
                  <>
                    <Users className="size-3.5 text-foreground/60 shrink-0" />
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] font-medium text-foreground/80">
                      子 Agent
                    </span>
                    {delegations.length > 0 && (
                    <span className="text-[calc(var(--helix-transcript-size)*0.8571)] tabular-nums font-medium text-foreground/60">
                      {delegations.length}
                    </span>
                    )}
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
              {workPanelOpen && typeof window !== "undefined" && (() => {
                const btnRect = workPanelBtnRef.current?.getBoundingClientRect();
                const btnLeft = btnRect?.left ?? 0;
                const btnBottom = btnRect?.bottom ?? 0;
                const maxW = Math.min(320, window.innerWidth - btnLeft - 12);
                return createPortal(
                <div
                  ref={workPanelPortalRef}
                  className="fixed z-[100]"
                  style={{
                    top: btnBottom + 4,
                    left: btnLeft,
                    width: Math.max(200, maxW),
                  }}
                >
                <div className="w-full max-h-[70vh] overflow-y-auto overflow-x-hidden min-w-0 flex flex-col rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl animate-scale-in">
                  {gitChangeStat && (
                    <section className="p-2 border-b border-border/60">
                      {/* 这里只给总体数字；整行可点 → 跳右侧栏「更改」看逐文件明细。 */}
                      <button
                        type="button"
                        onClick={() => {
                          storeActions.setRightSidebarTab("diff");
                          setWorkPanelOpen(false);
                        }}
                        className="w-full flex items-center gap-2.5 min-w-0 px-2.5 py-2 text-left rounded-lg hover:bg-accent/50 transition-colors"
                        data-tip="查看更改明细"
                      >
                        <FilePlus className="size-4 shrink-0 text-foreground/50" />
                        <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-medium">
                          更改
                        </span>
                        <span className="shrink-0 flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] tabular-nums font-medium">
                          <span className="text-emerald-600 dark:text-emerald-400">
                            +{gitChangeStat.added}
                          </span>
                          <span className="text-red-500 dark:text-red-400">
                            -{gitChangeStat.removed}
                          </span>
                        </span>
                      </button>
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
                        className="mt-1 w-full inline-flex items-center justify-center gap-1.5 h-8 rounded-lg bg-primary/10 text-primary text-[calc(var(--helix-transcript-size)*0.8571)] font-medium hover:bg-primary/20 disabled:opacity-50 transition-colors"
                      >
                        <Send className="size-3.5" />
                        提交并推送
                      </button>
                    </section>
                  )}
                  {pendingPlanReview && (
                    <section className="p-2 border-b border-border/60">
                      <div className="flex items-center gap-2.5 min-w-0 px-2.5 py-2">
                        <Pencil className="size-4 shrink-0 text-foreground/50" />
                        <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-medium">
                          计划 · 待批准
                        </span>
                        <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                          计划模式
                        </span>
                      </div>
                      <div className="px-1.5 pb-1.5">
                        <div className="max-h-48 overflow-y-auto rounded-lg border border-border/30 bg-muted/30 px-3 py-2 text-[calc(var(--helix-transcript-size)*0.7857)] text-foreground/80 whitespace-pre-wrap break-words">
                          {pendingPlanReview.content}
                        </div>
                        <p className="mt-1.5 px-1 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
                          底部「计划审批」浮条可选择 批准执行 / 继续调整
                        </p>
                      </div>
                    </section>
                  )}
                  {helixTodos.length > 0 && (
                  <section className="p-2 border-b border-border/60">
                    {(() => {
                      const doneCount = helixTodos.filter(
                        (t) => t.status === "completed",
                      ).length;
                      const pct = Math.round(
                        (doneCount / helixTodos.length) * 100,
                      );
                      return (
                        <>
                          <div className="flex items-center gap-2.5 min-w-0 px-2.5 py-2">
                            <ListTodo className="size-4 shrink-0 text-foreground/50" />
                            <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-medium">
                              任务清单
                            </span>
                            <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] tabular-nums text-foreground/50">
                              {doneCount}/{helixTodos.length}
                            </span>
                          </div>
                          <div className="px-2.5 pb-2.5">
                            <div className="h-1 rounded-full bg-muted overflow-hidden">
                              <div
                                className="h-full rounded-full bg-primary transition-[width] duration-300"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                          <ul className="px-1 pb-1">
                            {helixTodos.map((todo) => (
                              <li
                                key={todo.id}
                                className="flex items-start gap-2 px-1.5 py-1.5 rounded-lg hover:bg-accent/40 transition-colors text-[calc(var(--helix-transcript-size)*0.8571)]"
                              >
                                {todo.status === "completed" ? (
                                  <CheckCircle2 className="size-4 text-emerald-500 shrink-0 mt-0.5" />
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
                        </>
                      );
                    })()}
                  </section>
                  )}
                  {(subAgents.length > 0 || isElectron()) &&
                    (subAgents.length > 0 || delegations.length > 0) && (
                    <section className="p-2">
                      {(() => {
                        // 磁盘重建卡已并入 subAgents；历史区只渲染剩余的
                        // delegation，计数同口径（否则列表 1 个、计数 2）。
                        const diskOnlyDelegations = delegations.filter(
                          (del) => !subAgents.some((sa) => sa.id === del.id),
                        );
                        const running = subAgents.filter(
                          (a) => a.status === "running",
                        ).length;
                        const total = subAgents.length + diskOnlyDelegations.length;
                        return (
                          <div className="flex items-center gap-2.5 min-w-0 px-2.5 py-2">
                            <Users className="size-4 shrink-0 text-foreground/50" />
                            <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-medium">
                              子 Agent
                            </span>
                            {running > 0 ? (
                              <span className="shrink-0 flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7857)] text-primary">
                                <span className="size-1.5 rounded-full bg-primary animate-pulse" />
                                {running} 运行
                                <span className="text-foreground/40">/</span>
                                <span className="tabular-nums text-foreground/50">
                                  {total}
                                </span>
                              </span>
                            ) : (
                              <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] tabular-nums text-foreground/50">
                                {total} 个
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      <div className="max-h-72 overflow-auto px-1.5">
                        {/* 实时区：store.subAgents（subagent.* 事件驱动），同步/后台
                            agent 都能显示，磁盘 delegations 作历史兜底。 */}
                        {subAgents.map((sa) => {
                          // 运行中/完成都列出最近的真实工具调用（合成的
                          // progress/background 行不显示，避免"progress"被
                          // 当成工具名）。顶部是提示词（description），下方
                          // 才是执行内容，符合"先给什么任务、再看干了什么"。
                          const rows = (sa.toolCalls || []).filter(
                            (tc) => !isSyntheticSubAgentToolRow(tc.toolName),
                          );
                          const recentRows = rows.slice(-3);
                          const toolCount = rows.length;
                          return (
                          <button
                            key={`live-${sa.id}`}
                            type="button"
                            onClick={() => {
                              storeActions.openAgentView({
                                id: sa.id,
                                name: sa.description || sa.name,
                              });
                              setWorkPanelOpen(false);
                            }}
                            className="w-full text-left px-2 py-2 rounded-lg hover:bg-accent/50 transition-colors"
                            data-tip="在右侧栏查看工作内容"
                          >
                            <div className="flex items-start gap-2">
                              {sa.status === "running" ? (
                                <Loader2 className="size-3.5 text-primary shrink-0 animate-spin mt-0.5" />
                              ) : sa.status === "failed" ? (
                                <XCircle className="size-3.5 text-destructive shrink-0 mt-0.5" />
                              ) : (
                                <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0 mt-0.5" />
                              )}
                              <div className="flex-1 min-w-0">
                                {/* 提示词（最上面）：给这个子 Agent 的任务描述 */}
                                <div
                                  className="text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/85 line-clamp-2"
                                  title={sa.description || sa.name}
                                >
                                  {sa.description || sa.name}
                                </div>
                                {/* 执行内容（下面）：最近几条真实工具调用 + 总数 */}
                                {(recentRows.length > 0 || sa.status === "running") && (
                                  <div className="mt-1 space-y-0.5">
                                    {recentRows.map((tc, i) => (
                                      <div
                                        key={i}
                                        className="flex items-center gap-1.5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground"
                                      >
                                        <span className="font-mono truncate">
                                          {tc.toolName}
                                        </span>
                                        <span
                                          className={
                                            "shrink-0 " +
                                            (tc.status === "running"
                                              ? "text-primary"
                                              : tc.status === "success"
                                                ? "text-emerald-500"
                                                : "text-destructive")
                                          }
                                        >
                                          {tc.status === "running"
                                            ? "…"
                                            : tc.status === "success"
                                              ? "✓"
                                              : "✗"}
                                        </span>
                                        {tc.params && (
                                          <span className="truncate min-w-0 flex-1 text-foreground/50">
                                            {tc.params}
                                          </span>
                                        )}
                                      </div>
                                    ))}
                                    {sa.status === "running" && recentRows.length === 0 && (
                                      <div className="text-[calc(var(--helix-transcript-size)*0.7143)] text-primary">
                                        等待第一个工具调用…
                                      </div>
                                    )}
                                    {toolCount > recentRows.length && (
                                      <div className="text-[calc(var(--helix-transcript-size)*0.7143)] text-foreground/40">
                                        共 {toolCount} 次工具调用
                                      </div>
                                    )}
                                  </div>
                                )}
                                {sa.status !== "running" && sa.result && (
                                  <div className="mt-1 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground line-clamp-2">
                                    {sa.result}
                                  </div>
                                )}
                              </div>
                              <ChevronRight className="size-3.5 text-foreground/30 shrink-0 mt-0.5" />
                            </div>
                          </button>
                          );
                        })}
                        {/* 历史区：磁盘 live 日志（重建卡已并入上方实时区，按 id 去重） */}
                        {delegations
                          .filter(
                            (del) => !subAgents.some((sa) => sa.id === del.id),
                          )
                          .map((del) => (
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
                            className="w-full text-left px-2 py-2 rounded-lg hover:bg-accent/50 transition-colors"
                            data-tip="在右侧栏查看工作内容"
                          >
                            <div className="flex items-center gap-2">
                              <Terminal className="size-3.5 text-primary/60 shrink-0" />
                              <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-foreground/70">
                                {del.id}
                              </span>
                              <ChevronRight className="size-3.5 text-foreground/30 shrink-0" />
                            </div>
                            <div className="mt-0.5 pl-5 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
                              {(del.tasks || []).length} 个任务
                            </div>
                          </button>
                        ))}
                      </div>
                    </section>
                    )}
                    {/* 后台任务区：独立 section，不属于「子 Agent」——它们是
                        pi-background-tasks 的 shell 进程，不是子代理。
                        仅本会话用 background 工具启动的任务；其它会话的在
                        右上角「后台任务」按钮的全局面板里。 */}
                    {workPanelBgTasks.length > 0 && (
                      <section className="p-2">
                        <div className="flex items-center gap-2.5 min-w-0 px-2.5 py-2">
                          <Terminal className="size-4 shrink-0 text-foreground/50" />
                          <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-medium">
                            后台任务
                          </span>
                          <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7857)] tabular-nums text-foreground/50">
                            {workPanelBgTasks.filter((t) => t.status === "running")
                              .length}{" "}
                            运行 / {workPanelBgTasks.length}
                          </span>
                        </div>
                        <div className="max-h-56 overflow-auto px-1.5">
                          {workPanelBgTasks.map((t) => (
                            <button
                              key={t.id}
                              type="button"
                              onClick={() => {
                                setBgTasksOpen(true);
                                setWorkPanelOpen(false);
                              }}
                              className="w-full text-left px-2 py-2 rounded-lg hover:bg-accent/50 transition-colors"
                              data-tip="在后台任务面板查看详情"
                            >
                              <div className="flex items-center gap-2">
                                {t.status === "running" ? (
                                  <Loader2 className="size-3.5 text-primary shrink-0 animate-spin" />
                                ) : t.status === "completed" ? (
                                  <CheckCircle2 className="size-3.5 text-emerald-500 shrink-0" />
                                ) : (
                                  <XCircle className="size-3.5 text-destructive shrink-0" />
                                )}
                                <span className="flex-1 min-w-0 truncate text-[calc(var(--helix-transcript-size)*0.8571)] font-mono text-foreground/80">
                                  {t.command}
                                </span>
                                <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] text-muted-foreground">
                                  {t.status}
                                </span>
                              </div>
                            </button>
                          ))}
                        </div>
                      </section>
                    )}
                </div>
                </div>,
                document.body,
              );
            })()}
            </div>
            )}
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
                  data-tauri-drag-region="false"
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
                    tasks={bgTasksAll}
                    activeSessionId={helixSessionId}
                    onClose={() => setBgTasksOpen(false)}
                    onRefresh={loadBgTasks}
                  />
                )}
              </div>
            )}
            <button
              onClick={() => storeActions.toggleTerminal()}
              data-tauri-drag-region="false"
              className={`p-1.5 rounded-lg transition-colors ${isTerminalOpen ? "text-primary bg-primary/10" : "text-foreground/50 hover:text-foreground hover:bg-accent/60"}`}
              data-tip="终端"
            >
              <Terminal className="size-4" />
            </button>
            <button
              ref={browserMenuButtonRef}
              onClick={() => setBrowserMenuOpen((v) => !v)}
              data-tauri-drag-region="false"
              className={`p-1.5 rounded-lg transition-colors ${browserMenuOpen ? "text-primary bg-primary/10" : "text-foreground/50 hover:text-foreground hover:bg-accent/60"}`}
              data-tip="更多操作"
            >
              <MoreHorizontal className="size-4" />
            </button>
          </>
        )}
        <button
          onClick={() => (window as any).electron?.window?.minimize()}
          data-tauri-drag-region="false"
          className="p-1.5 text-foreground/40 hover:text-foreground hover:bg-accent/60 rounded-lg transition-colors"
          data-tip="最小化"
        >
          <Minus className="size-4" />
        </button>
        <button
          onClick={handleMaximizeToggle}
          data-tauri-drag-region="false"
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
          data-tauri-drag-region="false"
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
                                                .split(/[/\\]/)
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
                      onPointerDown={handleRightDragStart}
                    >
                      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 bg-transparent group-hover:bg-border/40 transition-colors" />
                    </div>
                  )}
                  <div className="helix-surface h-full rounded-2xl overflow-hidden">
                    <PanelSuspense>
                      <RightSidebar />
                    </PanelSuspense>
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
        {/* BootOverlay 单独包一层：它自己的 chunk 到之前先铺主题底色，
            避免主界面先露出来、全屏玻璃面板后突然出现。 */}
        <Suspense fallback={<div className="fixed inset-0 z-[10000] bg-background" />}>
          <BootOverlay />
        </Suspense>
        <GlobalTooltip />
        {/* Hidden same-origin snapshot iframe used by the pi browser tools
            (browser_read/click/type/press) — mounted at the layout root so it
            stays alive regardless of which side panel is open. */}
        <BrowserExecFrame html={browserExecHtml} />
      </Suspense>
    </div>
  );
}

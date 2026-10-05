"use client";

import {
  Plus,
  Search,
  Clock,
  Puzzle,
  Settings,
  Loader2,
  Trash2,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Archive,
  Pin,
  RotateCcw,
  Cloud,
  Unplug,
  MoreVertical,
  Pencil,
  Copy,
  GitBranch,
  AlertTriangle,
} from "lucide-react";
import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { FileTreePanel } from "./file-tree-panel";
import { captureContextBreakdown } from "@/lib/context-capture";
import {
  isElectron,
  electronShell,
  electronDialog,
  helixApi,
} from "@/lib/electron-bridge";
import { timeAgo } from "@/lib/format";
import { persistence, type PersistedSession } from "@/lib/persist";
import {
  connectRemoteProject,
  disconnectRemoteProject,
  findServiceByRemoteWorkDir,
  isRemoteWorkDir,
  remoteAvailable,
  remoteProjectLabel,
  remoteProjectSubtitle,
  remoteWorkDirForService,
} from "@/lib/remote-projects";
import { resolveBackendSid, removeConversationIndex } from "@/lib/session-map";
import { mapBackendMessages } from "@/lib/session-resync";
import { useGatewayStore } from "@/stores/gateway-store";
import { useHelixStore, type ExternalService } from "@/stores/helix-store";

// Module-level in-flight dedup for session/prepare: the backend dedupes live
// instances but not in-flight restore calls, so two concurrent prepares for
// the same sid spawn two expensive restores. Share one promise per sid.
const prepareInFlight = new Map<string, Promise<unknown>>();
function inFlightPrepare(backendSid: string): Promise<unknown> {
  let p = prepareInFlight.get(backendSid);
  if (!p) {
    p = (async () => {
      try {
        await helixApi()?.send("session/prepare", { session_id: backendSid });
      } finally {
        prepareInFlight.delete(backendSid);
      }
    })();
    prepareInFlight.set(backendSid, p);
  }
  return p;
}

interface SidebarProps {
  onNewTask?: () => void;
  collapsed?: boolean;
}

interface SessionActionsMenuProps {
  isPinned?: boolean;
  isArchived?: boolean;
  onArchive?: () => void;
  onPin?: () => void;
  onDelete?: () => void;
  onRestore?: () => void;
  onRename?: () => void;
  onCopyId?: () => void;
  // 展开态受控：菜单有两个入口（hover 的「更多操作」按钮 + 对话行右键），
  // 状态必须住在父组件，否则右键无法驱动打开。
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function SessionActionsMenu({
  isPinned,
  isArchived,
  onArchive,
  onPin,
  onDelete,
  onRestore,
  onRename,
  onCopyId,
  open,
  onOpenChange,
}: SessionActionsMenuProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const MENU_HEIGHT_ESTIMATE = 180; // ~4–5 items × ~36px each + padding
    const spaceBelow = window.innerHeight - rect.bottom - 4;
    const spaceAbove = rect.top - 4;
    // Prefer opening downward; flip upward only when there isn't enough room.
    // When upward, anchor menu BOTTOM just above the button (no gap).
    const openUpward =
      spaceBelow < MENU_HEIGHT_ESTIMATE && spaceAbove > spaceBelow;
    setCoords({
      top: openUpward ? undefined : rect.bottom + 4,
      bottom: openUpward ? window.innerHeight - rect.top + 4 : undefined,
      right: window.innerWidth - rect.right,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        (buttonRef.current && buttonRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return;
      }
      onOpenChange(false);
    };
    const handleScroll = () => onOpenChange(false);
    document.addEventListener("mousedown", handle);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handle);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [open, onOpenChange, updatePosition]);

  return (
    <div className="absolute right-1 top-1/2 -translate-y-1/2">
      <button
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation();
          onOpenChange(!open);
        }}
        className="p-1 text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
        data-tip="更多操作"
      >
        <MoreVertical className="size-3.5" />
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            className="fixed z-[100]"
            style={{
              top: coords.top,
              bottom: coords.bottom,
              right: coords.right,
            }}
          >
            <div
              ref={menuRef}
              className="w-40 bg-card border border-border/80 rounded-lg shadow-xl py-1"
            >
              {onRename && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenChange(false);
                    onRename();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground hover:bg-accent/60"
                >
                  <Pencil className="size-3.5" />
                  重命名
                </button>
              )}
              {!isArchived && onArchive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenChange(false);
                    onArchive();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  <Archive className="size-3.5" />
                  归档
                </button>
              )}
              {!isArchived && onPin && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenChange(false);
                    onPin();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  <Pin
                    className={`size-3.5 ${isPinned ? "text-primary" : ""}`}
                  />
                  {isPinned ? "取消固定" : "固定"}
                </button>
              )}
              {isArchived && onRestore && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenChange(false);
                    onRestore();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  <RotateCcw className="size-3.5" />
                  恢复
                </button>
              )}
              {onCopyId && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenChange(false);
                    onCopyId();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  <Copy className="size-3.5" />
                  复制对话 ID
                </button>
              )}
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenChange(false);
                    onDelete();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-3.5" />
                  删除
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

interface ProjectActionsMenuProps {
  isPinned?: boolean;
  onPin?: () => void;
  onArchive?: () => void;
  onDelete?: () => void;
  onShowInExplorer?: () => void;
}

function ProjectActionsMenu({
  isPinned,
  onPin,
  onArchive,
  onDelete,
  onShowInExplorer,
}: ProjectActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [coords, setCoords] = useState<{
    top?: number;
    bottom?: number;
    right: number;
  } | null>(null);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const MENU_HEIGHT_ESTIMATE = 180; // ~4–5 items × ~36px each + padding
    const spaceBelow = window.innerHeight - rect.bottom - 4;
    const spaceAbove = rect.top - 4;
    // Prefer opening downward; flip upward only when there isn't enough room.
    // When upward, anchor menu BOTTOM just above the button (no gap).
    const openUpward =
      spaceBelow < MENU_HEIGHT_ESTIMATE && spaceAbove > spaceBelow;
    setCoords({
      top: openUpward ? undefined : rect.bottom + 4,
      bottom: openUpward ? window.innerHeight - rect.top + 4 : undefined,
      right: window.innerWidth - rect.right,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const handle = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        (buttonRef.current && buttonRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return;
      }
      setOpen(false);
    };
    const handleScroll = () => setOpen(false);
    document.addEventListener("mousedown", handle);
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleScroll);
    return () => {
      document.removeEventListener("mousedown", handle);
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleScroll);
    };
  }, [open, updatePosition]);

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="p-1 text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
        data-tip="更多操作"
      >
        <MoreVertical className="size-3.5" />
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            className="fixed z-[100]"
            style={{
              top: coords.top,
              bottom: coords.bottom,
              right: coords.right,
            }}
          >
            <div
              ref={menuRef}
              className="w-40 bg-card border border-border/80 rounded-lg shadow-xl py-1"
            >
              {onPin && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    onPin();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  <Pin
                    className={`size-3.5 ${isPinned ? "text-primary" : ""}`}
                  />
                  {isPinned ? "取消置顶" : "置顶"}
                </button>
              )}
              {onShowInExplorer && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    onShowInExplorer();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  <FolderOpen className="size-3.5" />
                  <span className="whitespace-nowrap">在资源管理器中显示</span>
                </button>
              )}
              {onArchive && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    onArchive();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  <Archive className="size-3.5" />
                  归档
                </button>
              )}
              {onDelete && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen(false);
                    onDelete();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[calc(var(--helix-transcript-size)*0.8571)] text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="size-3.5" />
                  删除
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/**
 * 「项目」列表的一行。本地行 `dir` 是本机绝对路径；远程行是
 * `remote://<user@host:port>` 虚拟键（见 lib/remote-projects.ts），**绝不能**把它
 * 传给任何本地 fs / git / setWorkDir 调用。
 */
interface SidebarProject {
  dir: string;
  label: string;
  kind: "local" | "remote";
  sessions: PersistedSession[];
  isPinned: boolean;
  /** 远程行对应的服务器；本地行为 undefined。 */
  service?: ExternalService;
  /** 远程行：当前 agent 是否就跑在这台上（后端隧道状态对账结果）。 */
  connected?: boolean;
}

export function Sidebar({ onNewTask, collapsed = false }: SidebarProps) {
  const {
    clearChat,
    toggleSettings,
    toggleSessionManager,
    showToast,
    setSelectedWorkDir,
    setWorkDir,
  } = useHelixStore(
    useShallow((s) => ({
      clearChat: s.clearChat,
      toggleSettings: s.toggleSettings,
      toggleSessionManager: s.toggleSessionManager,
      showToast: s.showToast,
      setSelectedWorkDir: s.setSelectedWorkDir,
      setWorkDir: s.setWorkDir,
    })),
  );
  const showScheduledTasksPanel = useHelixStore(
    (s) => s.showScheduledTasksPanel,
  );
  const showSkillPanel = useHelixStore((s) => s.showSkillPanel);
  const selectedWorkDir = useHelixStore((s) => s.selectedWorkDir);
  const directoryProjectDir = useHelixStore((s) => s.directoryProjectDir);
  const toggleDirectoryProject = useHelixStore((s) => s.toggleDirectoryProject);
  const setRightSidebarTab = useHelixStore((s) => s.setRightSidebarTab);
  // 远程服务器列表 = 「项目」里的远程行。连接态不在这里判：`remoteMode` 由
  // useRemoteTunnelReconcile（挂在 helix-layout）现查后端 tunnel status 后写入，
  // 侧边栏只读它的 serviceId，避免列表与实际连接各说各话。
  const externalServices = useHelixStore((s) => s.externalServices);
  const removeExternalService = useHelixStore((s) => s.removeExternalService);
  const openRemoteWizard = useHelixStore((s) => s.openRemoteWizard);
  const bumpRemoteStatusVersion = useHelixStore(
    (s) => s.bumpRemoteStatusVersion,
  );
  // 远程隧道状态：只用来给远程行判「连没连」（serviceId）。本地 fs/git 视图
  // （文件树浏览器、@ 候选、分支芯片）**不读它** —— 双通道下它们跟着当前对话
  // 的 workDir 走，见 agent-flow-panel 的 conversationIsRemote。
  const remoteMode = useHelixStore((s) => s.remoteMode);
  // 「项目」标题右侧 ＋ 的菜单（添加本地 / 远程项目），同一时刻最多开一个。
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  // 连接/断开是后端动作（要重启网关），期间该行显示 spinner 并禁点。
  const [remoteBusyId, setRemoteBusyId] = useState<string | null>(null);

  // Re-render every minute so the relative '上次使用' timestamps stay fresh
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNowTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const currentSessionId = useHelixStore((s) => s.currentSessionId);
  const sessionPendingApproval = useHelixStore((s) => s.sessionPendingApproval);
  const streamingDrafts = useHelixStore((s) => s.streamingDrafts);
  const helixConnected = useGatewayStore((s) => s.helixConnected);
  const [sessions, setSessions] = useState<PersistedSession[]>([]);
  const [persistedFolders, setPersistedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [pinnedProjectDirs, setPinnedProjectDirs] = useState<Set<string>>(
    new Set(),
  );
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<PersistedSession | null>(
    null,
  );
  const [deleteProjectDir, setDeleteProjectDir] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  // 对话操作菜单的展开目标（受控）：同一时刻最多展开一个。右键对话行或
  // hover 的「更多操作」按钮都能打开，所以 open 不能只存在菜单组件内部。
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  // 复制对话 id：取后端 sid（pi 会话 UUID，会话目录 / 日志都用它定位），
  // 这个对话还没绑定过后端会话时才退回前端会话 id。toast 带上 id 本体，
  // 复制结果一眼可核对。
  const copySessionId = useCallback(
    (id: string) => {
      void resolveBackendSid(id)
        .then((sid) => {
          if (!sid) {
            showToast({
              type: "warning",
              title: "该对话还没有后端会话 ID",
              description: "发送第一条消息后才会生成",
            });
            return null;
          }
          return navigator.clipboard.writeText(sid).then(() => sid);
        })
        .then((value) => {
          if (value) {
            showToast({
              type: "success",
              title: "已复制对话 ID",
              description: value,
            });
          }
        })
        .catch(() => showToast({ type: "error", title: "复制失败" }));
    },
    [showToast],
  );

  // 历史对话条分页：每页最多显示 20 条（项目内会话与独立对话各自分页）。
  const PAGE_SIZE = 20;
  const [projectPages, setProjectPages] = useState<Record<string, number>>({});
  const [conversationPage, setConversationPage] = useState(1);
  // 取某列表的有效页码（增删会话后页码可能越界，clamp 到 [1, totalPages]）。
  const clampPage = (page: number, total: number) =>
    Math.min(Math.max(1, page), Math.max(1, total));

  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set(),
  );
  // Bumped to force the full-area directory view's FileTreePanel to reload.
  const [dirReloadKey, setDirReloadKey] = useState(0);

  const sortSessions = useCallback(
    (list: PersistedSession[]) =>
      [...list].sort(
        (a, b) => (b.createdAt ?? b.savedAt) - (a.createdAt ?? a.savedAt),
      ),
    [],
  );

  const loadSessions = useCallback(async () => {
    try {
      const list = await persistence.loadSessions();
      setSessions(sortSessions(list));
    } catch (e) {
      console.error("Failed to load sessions:", e);
    }
  }, [sortSessions]);

  const loadPersistedFolders = useCallback(async () => {
    try {
      const folders = await persistence.getProjectFolders();
      setPersistedFolders(new Set(folders));
    } catch (e) {
      console.error("Failed to load persisted folders:", e);
    }
  }, []);

  const loadPinnedProjectFolders = useCallback(async () => {
    try {
      const folders = await persistence.getPinnedProjectFolders();
      setPinnedProjectDirs(new Set(folders));
    } catch (e) {
      console.error("Failed to load pinned project folders:", e);
    }
  }, []);

  useEffect(() => {
    Promise.all([
      loadSessions(),
      loadPersistedFolders(),
      loadPinnedProjectFolders(),
    ]).finally(() => setLoading(false));
  }, [loadSessions, loadPersistedFolders, loadPinnedProjectFolders]);

  const sessionSaveVersion = useHelixStore((s) => s.sessionSaveVersion);
  useEffect(() => {
    if (sessionSaveVersion > 0) loadSessions();
  }, [sessionSaveVersion, loadSessions]);

  // Expand currently selected project automatically
  useEffect(() => {
    if (selectedWorkDir) {
      setExpandedProjects((prev) => new Set([...prev, selectedWorkDir]));
    }
  }, [selectedWorkDir]);

  // Projects = unique workDirs from sessions + persisted folders + current selection
  //
  // 远程项目的对话用 `remote://<user@host:port>/<path>` 虚拟键当 workDir（目录在
  // 另一台机器上，本地没有对应路径）。它们**不进这个列表** —— 混进来会让 label
  // 变成一串乱码、点进去还会走本地 fs IPC。它们归下面「项目」里那台服务器的
  // 远程行（见 remoteBuckets）。
  const projects = useMemo(() => {
    const groups = new Map<string, PersistedSession[]>();
    for (const s of sessions) {
      if (s.isArchived) continue;
      if (!s.workDir || s.workDir === "/" || s.workDir === "\\") continue;
      if (isRemoteWorkDir(s.workDir)) continue;
      const list = groups.get(s.workDir) || [];
      list.push(s);
      groups.set(s.workDir, list);
    }
    // Ensure all persisted folders appear, even with no sessions
    for (const folder of persistedFolders) {
      if (isRemoteWorkDir(folder)) continue;
      if (!groups.has(folder)) {
        groups.set(folder, []);
      }
    }
    // Ensure pinned dirs appear even when empty
    for (const folder of pinnedProjectDirs) {
      if (!groups.has(folder)) {
        groups.set(folder, []);
      }
    }
    return Array.from(groups.entries())
      .map(([dir, list]) => {
        const sorted = [...list].sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
          return (b.createdAt ?? b.savedAt) - (a.createdAt ?? a.savedAt);
        });
        return {
          dir,
          label: dir.split(/[/\\\\]/).pop() || dir,
          sessions: sorted,
          isPinned: pinnedProjectDirs.has(dir),
        };
      })
      .sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return (
          (b.sessions[0]?.createdAt ?? b.sessions[0]?.savedAt ?? 0) -
          (a.sessions[0]?.createdAt ?? a.sessions[0]?.savedAt ?? 0)
        );
      });
  }, [sessions, persistedFolders, pinnedProjectDirs]);

  // ── 「项目」统一列表：本地目录 + 远程服务器 ─────────────────────────────
  // 远程对话的 workDir 是 `remote://<user@host:port>/<远端路径>` 虚拟键（目录在另
  // 一台机器上），按机器身份归拢到该服务器名下 —— 于是远程行和本地行一样能展开看
  // 对话，不必另开一个「远程项目」分段（两个列表就是两份真相）。
  // 对不上任何服务器的键（历史上用行 id 当身份、服务器被删过）进 orphan：它们仍然
  // 能在「对话」里打开。认不出主人 ≠ 不存在，静默丢掉用户的对话是不可接受的。
  const remoteBuckets = useMemo(() => {
    const byService = new Map<string, PersistedSession[]>();
    const orphan: PersistedSession[] = [];
    for (const s of sessions) {
      if (s.isArchived) continue;
      if (!isRemoteWorkDir(s.workDir)) continue;
      const svc = findServiceByRemoteWorkDir(externalServices, s.workDir);
      if (!svc) {
        orphan.push(s);
        continue;
      }
      const list = byService.get(svc.id) ?? [];
      list.push(s);
      byService.set(svc.id, list);
    }
    const sort = (list: PersistedSession[]) =>
      [...list].sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return (b.createdAt ?? b.savedAt) - (a.createdAt ?? a.savedAt);
      });
    return { byService, orphan: sort(orphan) };
  }, [sessions, externalServices]);

  // 语义差别仍然保留：远程工作区是**全局单例**，连哪台由 config.yaml 决定、切换会
  // 重启网关并打断正在跑的对话，所以点远程行只展开/收起，连接要显式按那个按钮。
  const projectGroups = useMemo<SidebarProject[]>(() => {
    const local: SidebarProject[] = projects.map((p) => ({
      ...p,
      kind: "local",
    }));
    const remote: SidebarProject[] = externalServices.map((svc) => ({
      dir: remoteWorkDirForService(svc),
      label: remoteProjectLabel(svc),
      kind: "remote",
      sessions: remoteBuckets.byService.get(svc.id) ?? [],
      isPinned: false,
      service: svc,
      connected: remoteMode?.serviceId === svc.id,
    }));
    const lastUsed = (g: SidebarProject) =>
      g.sessions[0]?.createdAt ?? g.sessions[0]?.savedAt ?? 0;
    return [...local, ...remote].sort((a, b) => {
      // 云端项目恒在最上面：整台 Helix 同时只连一台远端，它才是「当前项目」，
      // 不该被本地目录的活跃时间挤下去。
      if (a.kind !== b.kind) return a.kind === "remote" ? -1 : 1;
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return lastUsed(b) - lastUsed(a);
    });
  }, [projects, remoteBuckets, externalServices, remoteMode]);

  // Standalone conversations: 没有项目的对话 + 认不出服务器的远程对话。
  const conversations = useMemo(() => {
    const local = sessions.filter((s) => !s.isArchived && !s.workDir);
    return [...local, ...remoteBuckets.orphan].sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      return (b.createdAt ?? b.savedAt) - (a.createdAt ?? a.savedAt);
    });
  }, [sessions, remoteBuckets]);

  // Concurrent multi-session design: switching / creating conversations NEVER
  // interrupts a running agent. Each run streams into its own per-session
  // draft (streamingDrafts[sid]) and commits its reply with its own sessionId,
  // so navigation is purely a view change. (The old interruptIfRunning confirm
  // dialog was a relic of the single-active-run engine.)

  const handleNewTask = useCallback(async () => {
    useHelixStore.getState().flushSessionPersist();
    clearChat();
    useHelixStore.getState().clearExecutionFlow();
    // 显式点「新对话」→ 进入可输入的草稿（重启恢复不到会话时界面停在
    // 占位，必须这一步才真正进入可发消息状态）。
    useHelixStore.getState().setNoActiveConversation(false);
    useHelixStore.getState().setCurrentSessionId(null);
    // Returning to a conversation from the sidebar should dismiss the
    // full-area panels so the chat is visible again.
    const state = useHelixStore.getState();
    if (state.showScheduledTasksPanel || state.showSkillPanel) {
      useHelixStore.setState({
        showScheduledTasksPanel: false,
        showSkillPanel: false,
      });
    }
    onNewTask?.();
  }, [clearChat, onNewTask]);

  // New chat belonging to a specific project (used by the + button on each project row).
  const handleNewProjectChat = useCallback(
    async (dir: string) => {
      if (!dir || dir === "/" || dir === "\\") return;
      try {
        await useHelixStore.getState().flushSessionPersist();
        useHelixStore.getState().clearExecutionFlow();
        clearChat();
        useHelixStore.getState().setNoActiveConversation(false);
        useHelixStore.getState().setCurrentSessionId(null);
        // 远程项目行：`dir` 是 `remote://…` 虚拟键，**不是本机目录**。走下面任何
        // 一条本地通道都会炸：setWorkDir → 主进程 create_dir_all 把 `remote://…`
        // 当相对路径 join（Windows 下 `:` `/` 非法 → os error 123）；
        // saveProjectFolder → 远程键混进「本地项目」列表。
        // 远程草稿的项目身份只写 activeSessionWorkDir —— 发消息时 session/new 从
        // 那里读出 remote_cwd，落盘时 resolveSessionWorkDir 用它当 workDir。
        // 隧道不在这个函数里连：没连上的远程行走远程行的连接按钮。
        if (isRemoteWorkDir(dir)) {
          useHelixStore.getState().setSelectedWorkDir(null);
          useHelixStore.setState({ activeSessionWorkDir: dir });
          return;
        }
        if (isElectron()) {
          try {
            await setWorkDir(dir);
          } catch {
            // Fallback if the main-process call fails so the UI still lands in the project.
            setSelectedWorkDir(dir);
          }
        } else {
          setSelectedWorkDir(dir);
        }
        // Double-check: clearChat wipes selectedWorkDir, restore it to the target project.
        useHelixStore.getState().setSelectedWorkDir(dir);
        await persistence.saveProjectFolder(dir);
      } catch (e) {
        console.error("Failed to switch project for new chat:", e);
        showToast({ type: "error", title: "创建新对话失败" });
      }
    },
    [clearChat, setSelectedWorkDir, setWorkDir, showToast],
  );

  const handleLoadSession = useCallback(
    async (session: PersistedSession) => {
      try {
        const state = useHelixStore.getState();
        // Only persist the current session if it has already been saved at least once.
        // Otherwise, loading a historical session from a different project would cause
        // temporary unsaved messages to be saved under the current project.
        // Fire-and-forget: persistCurrentSessionNow captures a synchronous snapshot
        // at entry, so it stays correct even after we switch away below.
        if (state.currentSessionId) {
          void state.flushSessionPersist();
        }
        useHelixStore.getState().clearExecutionFlow();
        // NOTE: do NOT reset the Helix session here — under the concurrent
        // multi-session design each conversation owns its own Helix ACP session
        // (helixSessionMapRef in agent-flow-panel); resetting the legacy global
        // id would be meaningless at best and confusing at worst.
        // Same as above: navigating to a session must close the panels.
        if (state.showScheduledTasksPanel || state.showSkillPanel) {
          useHelixStore.setState({
            showScheduledTasksPanel: false,
            showSkillPanel: false,
          });
        }
        // Load just the target session (single IndexedDB read) instead of
        // fetching every session from disk just to pick one. Fall back to the
        // in-memory snapshot if the record is missing (e.g. just-deleted).
        const fresh = (await persistence.loadSession(session.id)) || session;
        // 恢复时丢弃 draft-partial 占位消息（与 navigateSession 一致）。并发设计
        // 下切换会话并不会中断后台 run——该占位只是持久化快照，若展示会与最终
        // 提交的完整回复重复，并误导显示"生成中断"。
        const seen = new Set<string>();
        const msgs = fresh.chatMessages
          .filter((msg) => {
            if (seen.has(msg.id)) return false;
            seen.add(msg.id);
            if (
              typeof msg.id === "string" &&
              msg.id.startsWith("draft-partial-")
            )
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
            // Tag with the owning session so concurrent sessions' messages can
            // coexist in the store without leaking across the per-session filter.
            sessionId: session.id,
          }));
        // 内存合并而非整体覆盖：后台 run 的 done 提交 + persistSessionNow 是
        // fire-and-forget，磁盘快照可能落后几百 ms——旧逻辑只保留"仍在运行"会话
        // 的消息，一个刚完成但还没落盘的回复会被磁盘快照覆盖掉（切回来输出消失
        // 的根因之一）。现在以磁盘快照为基底，本会话仍在内存的消息按 id 覆盖
        //（内存是 done 刚提交的新鲜副本），其他会话（无论是否还在运行）全部保留。
        const st2 = useHelixStore.getState();
        const byId = new Map<string, (typeof msgs)[number]>();
        for (const m of msgs) byId.set(m.id, m);
        for (const m of st2.chatMessages) {
          if (!m.sessionId || m.sessionId !== session.id) continue;
          if (typeof m.id === "string" && m.id.startsWith("draft-partial-"))
            continue;
          byId.set(m.id, m as (typeof msgs)[number]);
        }
        const merged = [
          ...st2.chatMessages.filter(
            (m) => m.sessionId && m.sessionId !== session.id,
          ),
          ...[...byId.values()],
        ];
        merged.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        useHelixStore.setState({
          chatMessages: merged,
          activeSessionWorkDir: fresh.workDir ?? null,
        });
        if (fresh.workDir) {
          // 远程项目的 workDir 是 `remote://<id>/<path>` 虚拟键，**不是本机
          // 目录**。把它喂给下面三个本地通道会直接踩坑：
          //   - saveProjectFolder → 进「本地项目」列表，下次渲染出一个乱码项目
          //   - setSelectedWorkDir / syncWorkDir → 主进程 create_dir_all 报
          //     os error 123（`:` 与 `/` 在 Windows 文件名里非法）
          // 远程对话的「所属项目」由 workDir 里的机器身份（`user@host:port`）表达，
          // 在「项目」列表里对应那台服务器那一行；这里只把它记成
          // activeSessionWorkDir，供 session/new 判定「不要发 cwd」等逻辑用。
          if (isRemoteWorkDir(fresh.workDir)) {
            useHelixStore.getState().setSelectedWorkDir(null);
          } else {
            await persistence.saveProjectFolder(fresh.workDir);
            // 加载对话后把 selectedWorkDir 也切到对话所属项目，让 Git 分支选择器
            // （agent-flow-panel 用 selectedWorkDir 作为 cwd）跟着对话走。只同步
            // selectedWorkDir，绝不走 setWorkDir——那会触发"切换项目"副作用。
            useHelixStore.getState().setSelectedWorkDir(fresh.workDir);
            // 对齐主进程 workDir：历史对话只改前端 selectedWorkDir，主进程会残留在旧
            // 项目 → 相对路径的 fs IPC（打开文件/diff 预览等）被拼到旧目录 → ENOENT。
            // 用轻量 syncWorkDir（不重启网关、不持久化），绝不能走 setWorkDir——那会
            // 触发“切换项目”副作用，打断正在运行的对话。
            try {
              await window.electron?.app?.syncWorkDir?.(fresh.workDir);
            } catch {
              /* best-effort */
            }
          }
        }
        useHelixStore.getState().setNoActiveConversation(false);
        useHelixStore.getState().setCurrentSessionId(session.id);
        // 切换对话时关闭右侧边栏：右侧面板（更改/代码/浏览器等）是上一个对话
        // 的上下文，切到新对话后保留旧内容会造成误导，统一收起。
        useHelixStore.getState().setRightSidebarTab(null);
        // Background resume warm-up: the backend's session instance may have
        // been reaped (idle) or never existed (app restart). Restoring it
        // costs spawn + switch_session (scales with conversation length —
        // tens of seconds for long sessions). Kicking it off here means the
        // user's first prompt finds the instance hot instead of paying the
        // whole restore inside "工作中".
        //
        // 两个 void 块都会对同一 backend sid 发 session/prepare（warm-up +
        // context-breakdown 刷新）；后端只去重 live 实例、不去重 in-flight，
        // 并发两次会白白 spawn 两个 restore（几十秒级别）。用模块级
        // in-flight 表去重：同一 sid 只有一个 prepare 在飞，其他调用者共享
        // 同一个 promise。
        const backendSid = await resolveBackendSid(session.id);
        if (backendSid) {
          const sharedPrepare = inFlightPrepare(backendSid);
          void sharedPrepare.catch(() => {}); // 吞掉 warm-up 的 best-effort 失败
        }
        // 切换对话时刷新上下文环快照：本地持久化的 used 是该对话上一次 run
        // 的实测值——恢复/重启用后不再增长，环会停在过期读数（显示 50k 而
        // 下一条 prompt 实际要重放 ~276k 的根因）。captureContextBreakdown
        // 向后端要真实下条 prompt 估算（含 restore-time trim 后的文件），
        // 按 authoritative 覆盖落盘，环读数恢复真实。等待 prepare 完成后拉取——restore
        // （含 trim switch）完成后 get_session_stats 才反映切换后的文件。
        void (async () => {
          try {
            const sid = backendSid;
            if (!sid) return;
            await inFlightPrepare(sid);
            await captureContextBreakdown(session.id, sid);
          } catch (e) {
            // best-effort context breakdown; the popover's 5s poll refreshes on open
            console.error("[sidebar] context-breakdown refresh failed:", e);
          }
        })();
        // Instant history when the local record has nothing rendered (e.g.
        // messages were never persisted / lost): tail the backend jsonl
        // directly — no pi process involved, O(last 512KB).
        if (msgs.length === 0) {
          void (async () => {
            try {
              const sid = await resolveBackendSid(session.id);
              if (!sid) return;
              const res = await helixApi()?.send("session/peek", {
                session_id: sid,
                count: 30,
              });
              const peekMsgs = Array.isArray(res?.messages) ? res.messages : [];
              if (peekMsgs.length === 0) return;
              // Only fill the view if the conversation is still the focused
              // one and still empty (the user may have navigated away).
              const st = useHelixStore.getState();
              if (st.currentSessionId !== session.id) return;
              const current = st.chatMessages.filter(
                (m) => m.sessionId === session.id,
              );
              if (current.length > 0) return;
              useHelixStore.setState((state) => ({
                chatMessages: [
                  ...state.chatMessages.filter(
                    (m) => m.sessionId && m.sessionId !== session.id,
                  ),
                  ...mapBackendMessages(peekMsgs, session.id),
                ],
              }));
            } catch {
              /* fall back to the first-prompt restore path */
            }
          })();
        }
      } catch (e) {
        console.error("Failed to load session:", e);
        showToast({ type: "error", title: "加载失败" });
      }
    },
    // Deliberately empty: this callback reads live state via useHelixStore.getState()
    // so it never goes stale; listing store getters here would churn identities on
    // every store update. Zustand store actions are stable references.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const handleDeleteSession = useCallback(
    async (id: string) => {
      const session = sessions.find((s) => s.id === id);
      if (session) setDeleteTarget(session);
    },
    [sessions],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await persistence.deleteSession(deleteTarget.id);
      // 同步清理磁盘反向索引，避免 conversation-index.json 只增不减
      await removeConversationIndex(deleteTarget.id);
      const remaining = await persistence.loadSessions();
      setSessions(sortSessions(remaining));
      const state = useHelixStore.getState();
      if (
        state.currentSessionId === deleteTarget.id ||
        remaining.length === 0
      ) {
        // Only clear chat state; preserve the current project so the project
        // item remains visible even after its last session is deleted.
        useHelixStore.setState({
          chatMessages: [],
          currentSessionId: null,
          activeSessionWorkDir: null,
        });
        if (remaining.length === 0) {
          useHelixStore.setState({ selectedWorkDir: null });
        }
        useHelixStore.getState().clearExecutionFlow();
        useGatewayStore.getState().setHelixSessionId(null);
      }
      setDeleteTarget(null);
    } catch (e) {
      console.error("Failed to delete session:", e);
    }
  }, [deleteTarget, sortSessions]);

  const handleToggleArchive = useCallback(
    async (id: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      try {
        await persistence.toggleSessionArchived(id);
        const remaining = await persistence.loadSessions();
        setSessions(sortSessions(remaining));
      } catch (e) {
        console.error("Failed to toggle archive:", e);
      }
    },
    [sortSessions],
  );

  const handleTogglePin = useCallback(
    async (id: string, e?: React.MouseEvent) => {
      e?.stopPropagation();
      try {
        await persistence.toggleSessionPinned(id);
        const remaining = await persistence.loadSessions();
        setSessions(sortSessions(remaining));
      } catch (e) {
        console.error("Failed to toggle pin:", e);
      }
    },
    [sortSessions],
  );

  const handleRevealInExplorer = useCallback(async (dir?: string | null) => {
    if (!dir) return;
    try {
      if (isElectron()) {
        await electronShell.openPath(dir);
      }
    } catch (e) {
      console.error("Failed to reveal in explorer:", e);
    }
  }, []);

  const handleCommitRename = useCallback(
    async (id: string, label: string) => {
      setRenamingId(null);
      const trimmed = label.trim();
      if (!trimmed) {
        const remaining = await persistence.loadSessions();
        setSessions(sortSessions(remaining));
        return;
      }
      try {
        await persistence.updateSessionLabel(id, trimmed);
        const remaining = await persistence.loadSessions();
        setSessions(sortSessions(remaining));
      } catch (e) {
        console.error("Failed to rename session:", e);
      }
    },
    [sortSessions],
  );

  // Listen for rename-session keyboard shortcut
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.sessionId) setRenamingId(detail.sessionId);
    };
    window.addEventListener("helix:rename-session", handler);
    return () => window.removeEventListener("helix:rename-session", handler);
  }, []);

  const handleSelectProject = useCallback(
    async (dir: string) => {
      if (!dir || dir === "/" || dir === "\\") return;
      try {
        setExpandedProjects((prev) => {
          const next = new Set(prev);
          if (next.has(dir)) next.delete(dir);
          else next.add(dir);
          return next;
        });
        // 草稿（没打开对话）跟着项目行走：把可能残留的远程草稿键清掉，否则
        // 「界面显示本地项目、新对话却按 remote:// 键 spawn」。打开着的对话不动
        // —— 它的 cwd 在 jsonl 头部就定死了，改它只会让界面说谎。
        if (!useHelixStore.getState().currentSessionId) {
          useHelixStore.setState({ activeSessionWorkDir: null });
        }
        await persistence.saveProjectFolder(dir);
        if (isElectron()) {
          await setWorkDir(dir);
        } else {
          setSelectedWorkDir(dir);
        }
      } catch (e) {
        console.error("Failed to select project:", e);
      }
    },
    [setWorkDir, setSelectedWorkDir],
  );

  // ＋ 菜单：点到菜单（含那颗 ＋）之外任意处就收起。
  useEffect(() => {
    if (!addMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (addMenuRef.current?.contains(e.target as Node)) return;
      setAddMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [addMenuOpen]);

  // 展开/收起某行的对话（远程行专用）。本地行走 handleSelectProject：它顺带把
  // selectedWorkDir 切过去，而远程行不能 —— 远程工作区是全局单例，改连哪台要
  // 重启网关、打断正在跑的对话，所以那件事必须留在显式的连接按钮上。
  const toggleProjectExpanded = useCallback((dir: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
  }, []);

  // 远程行：连接 / 断开。连上后 agent 就跑在那台机器上（config.yaml 的
  // pi.remote_rpc + pi.remote_cwd），网关会重启 —— 这是这个列表里唯一的
  // 破坏性动作，所以只有这一颗按钮会做它，点行名只展开对话。
  const handleRemoteToggle = useCallback(
    async (project: SidebarProject) => {
      const svc = project.service;
      if (!svc || remoteBusyId) return;
      if (project.connected) {
        setRemoteBusyId(svc.id);
        try {
          await disconnectRemoteProject();
          showToast({
            type: "success",
            title: "已断开远程项目",
            description: `${remoteProjectLabel(svc)} — agent 回到本机运行。`,
          });
        } catch (e) {
          showToast({
            type: "error",
            title: "断开失败",
            description: String(e),
          });
        } finally {
          setRemoteBusyId(null);
          bumpRemoteStatusVersion();
        }
        return;
      }
      if (!svc.remotePath) {
        // 没选过远端目录：回向导做体检 + 浏览，而不是拿 `~` 硬连（那会把 agent
        // 丢到远端 home，用户以为连上了却在错误的项目里跑）。
        openRemoteWizard({ serviceId: svc.id, step: 2 });
        return;
      }
      setRemoteBusyId(svc.id);
      try {
        const { localPort } = await connectRemoteProject(svc, svc.remotePath);
        showToast({
          type: "success",
          title: "已连接远程项目",
          description: `${remoteProjectLabel(svc)}${
            localPort ? `（隧道 127.0.0.1:${localPort}）` : ""
          } — agent 现在远端跑。`,
        });
      } catch (e) {
        showToast({ type: "error", title: "连接失败", description: String(e) });
      } finally {
        setRemoteBusyId(null);
        bumpRemoteStatusVersion();
      }
    },
    [
      bumpRemoteStatusVersion,
      openRemoteWizard,
      remoteBusyId,
      showToast,
    ],
  );

  const handleRemoteDelete = useCallback(
    (project: SidebarProject) => {
      const svc = project.service;
      if (!svc) return;
      const label = remoteProjectLabel(svc);
      if (!confirm(`确定删除远程项目「${label}」？`)) return;
      // 正连着这台时先断开，否则 config.yaml 里的 remote_rpc 还指着一条
      // 已经没有对应条目的隧道，下次启动会连到一个「幽灵远程」。
      if (project.connected) {
        void disconnectRemoteProject().catch(() => {});
      }
      removeExternalService(svc.id);
      bumpRemoteStatusVersion();
      showToast({ type: "success", title: "已删除远程项目", description: label });
    },
    [bumpRemoteStatusVersion, removeExternalService, showToast],
  );

  // ＋ → 添加本地项目：选一个已存在的本机目录当项目。双通道下这**不动**隧道：
  // 加一个本地项目跟「有一条远程隧道开着」是两件不相干的事，旧实现先 confirm 再
  // disconnectRemoteProject 是因为那时远程是全局单开关，选本地目录就等于放弃远程。
  const handleAddLocalProject = useCallback(async () => {
    setAddMenuOpen(false);
    if (!isElectron()) {
      showToast({ type: "warning", title: "浏览器预览模式不能选择目录" });
      return;
    }
    let dir: string | null = null;
    try {
      dir = await electronDialog.openDirectory(selectedWorkDir ?? undefined);
    } catch (e) {
      console.error("Failed to open directory picker:", e);
      showToast({ type: "error", title: "打开目录选择器失败" });
      return;
    }
    if (!dir) return;
    try {
      await persistence.saveProjectFolder(dir);
      void loadPersistedFolders();
      setExpandedProjects((prev) => new Set(prev).add(dir as string));
      useHelixStore.getState().setCurrentSessionId(null);
      useHelixStore.getState().setNoActiveConversation(false);
      await setWorkDir(dir);
    } catch (e) {
      console.error("Failed to add local project:", e);
      showToast({ type: "error", title: "添加本地项目失败" });
    }
  }, [loadPersistedFolders, selectedWorkDir, setWorkDir, showToast]);

  const handlePinProject = useCallback(
    async (dir: string) => {
      try {
        const pinned = await persistence.togglePinnedProjectFolder(dir);
        setPinnedProjectDirs((prev) => {
          const next = new Set(prev);
          if (pinned) next.add(dir);
          else next.delete(dir);
          return next;
        });
        showToast({
          type: "success",
          title: pinned ? "项目已置顶" : "已取消置顶",
        });
      } catch (e) {
        console.error("Failed to pin project:", e);
        showToast({ type: "error", title: "置顶失败" });
      }
    },
    [showToast],
  );

  const handleArchiveProject = useCallback(
    async (dir: string) => {
      try {
        await persistence.archiveSessionsByWorkDir(dir);
        const remaining = await persistence.loadSessions();
        setSessions(sortSessions(remaining));
      } catch (e) {
        console.error("Failed to archive project:", e);
        showToast({ type: "error", title: "归档失败" });
      }
    },
    [sortSessions, showToast],
  );

  const handleDeleteProject = useCallback((dir: string) => {
    setDeleteProjectDir(dir);
  }, []);

  const handleConfirmDeleteProject = useCallback(async () => {
    if (!deleteProjectDir) return;
    try {
      // 先取被删项目下的会话 id（deleteSessionsByWorkDir 删完就查不到了），
      // 用于随后清理内存里残留的消息与运行中草稿。
      const sessionsBefore = await persistence.loadSessions();
      const deletedIds = new Set(
        sessionsBefore
          .filter((s) => s.workDir === deleteProjectDir)
          .map((s) => s.id),
      );
      await persistence.deleteSessionsByWorkDir(deleteProjectDir);
      // 批量清理磁盘反向索引里的对应 conversation 条目
      await removeConversationIndex([...deletedIds]);
      await persistence.deleteProjectFolder(deleteProjectDir);
      // Drop the dir from pinned folders (if it was pinned) so it can't re-appear.
      const pinned = await persistence.getPinnedProjectFolders();
      if (pinned.includes(deleteProjectDir)) {
        await persistence.savePinnedProjectFolders(
          pinned.filter((d) => d !== deleteProjectDir),
        );
      }
      const remaining = await persistence.loadSessions();
      setSessions(sortSessions(remaining));
      // Re-sync the in-memory folder/pin sets from storage. Without this the
      // deleted dir stays in `persistedFolders`/`pinnedProjectDirs` and the
      // project keeps showing in the sidebar — so the delete looks like a no-op.
      setPersistedFolders(new Set(await persistence.getProjectFolders()));
      setPinnedProjectDirs(
        new Set(await persistence.getPinnedProjectFolders()),
      );
      setExpandedProjects((prev) => {
        const next = new Set(prev);
        next.delete(deleteProjectDir);
        return next;
      });
      if (selectedWorkDir === deleteProjectDir) {
        setSelectedWorkDir(null);
      }
      // 清理内存中仍指向被删项目的会话状态。磁盘会话已删，但内存里的
      // chatMessages / streamingDrafts 若还留着它们，后续点击其他对话触发的
      // flushSessionPersist（或后台 run 完成时 persistSessionById）会按
      // activeSessionWorkDir/selectedWorkDir 把这些会话重新写回磁盘——刚删除的
      // 项目因此"复活"。这里用上面删前取的 deletedIds 同步清掉被删项目下
      // 所有会话的消息 + 运行中草稿。
      const st = useHelixStore.getState();
      if (st.currentSessionId && deletedIds.has(st.currentSessionId)) {
        useHelixStore.getState().setCurrentSessionId(null);
        // 当前会话随项目一起被删：直接落在「新对话」草稿态（不占位）。
        useHelixStore.getState().setNoActiveConversation(false);
      }
      if (st.activeSessionWorkDir === deleteProjectDir) {
        useHelixStore.setState({ activeSessionWorkDir: null });
      }
      if (deletedIds.size > 0) {
        useHelixStore.setState((prev) => ({
          chatMessages: prev.chatMessages.filter(
            (m) => !deletedIds.has(m.sessionId || ""),
          ),
          streamingDrafts: Object.fromEntries(
            Object.entries(prev.streamingDrafts).filter(
              ([sid]) => !deletedIds.has(sid),
            ),
          ),
        }));
      }
    } catch (e) {
      console.error("Failed to delete project:", e);
      showToast({ type: "error", title: "删除项目失败" });
    } finally {
      setDeleteProjectDir(null);
    }
  }, [
    deleteProjectDir,
    selectedWorkDir,
    sortSessions,
    showToast,
    setSelectedWorkDir,
  ]);

  const topActions = [
    { id: "new", label: "新对话", icon: Plus, action: handleNewTask },
    {
      id: "search",
      label: "搜索",
      icon: Search,
      action: () => toggleSessionManager(),
    },
    {
      id: "scheduled",
      label: "计划",
      icon: Clock,
      action: () => {
        useHelixStore.setState((s) => ({
          showScheduledTasksPanel: !s.showScheduledTasksPanel,
          showSkillPanel: false,
        }));
      },
    },
    {
      id: "plugins",
      label: "插件",
      icon: Puzzle,
      action: () => {
        useHelixStore.setState((s) => ({
          showSkillPanel: !s.showSkillPanel,
          showScheduledTasksPanel: false,
        }));
      },
    },
  ];

  return (
    <div className="helix-sidebar h-full flex flex-col text-sidebar-foreground select-none">
      {/* Collapsed icon-only mode */}
      {collapsed ? (
        <div className="flex-1 flex flex-col items-center pt-3 pb-2 gap-1 overflow-y-auto">
          {topActions.map((item) => {
            const isActive =
              (item.id === "scheduled" && showScheduledTasksPanel) ||
              (item.id === "plugins" && showSkillPanel);
            return (
              <button
                key={item.id}
                onClick={() => item.action()}
                data-tip={item.label}
                className={`p-2.5 rounded-lg transition-colors outline-none ${
                  isActive
                    ? "bg-sidebar-accent/70 text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/40"
                }`}
              >
                <item.icon className="size-[18px]" />
              </button>
            );
          })}
          <div className="flex-1" />
          <button
            onClick={() => toggleSettings()}
            data-tip="设置"
            className="p-2.5 rounded-lg text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/40 transition-colors"
          >
            <Settings className="size-[18px]" />
            {isElectron() && (
              <span
                className={`block w-1.5 h-1.5 rounded-full mx-auto mt-1 ${helixConnected ? "bg-emerald-500" : "bg-amber-500 animate-pulse"}`}
              />
            )}
          </button>
        </div>
      ) : directoryProjectDir ? (
        /* Full-area directory explorer: takes over the ENTIRE left sidebar
           (not a small inset panel) while active. The header (back / name /
           refresh) and the search box both live inside FileTreePanel, with the
           search box rendered above the header.

           `directoryProjectDir` 恒为**本机路径**（只有本地项目行给「打开目录」
           按钮），所以它展示什么与隧道在不在无关 —— 双通道下远程对话照样可以
           浏览本地项目。 */
        <FileTreePanel
          rootDir={directoryProjectDir}
          reloadKey={dirReloadKey}
          onOpenFile={() => setRightSidebarTab("code")}
          onBack={() => toggleDirectoryProject(directoryProjectDir)}
          onRefresh={() => setDirReloadKey((k) => k + 1)}
        />
      ) : (
        <>
          {/* Top actions */}
          <div className="shrink-0 px-3 pt-2 pb-1.5">
            <div className="flex flex-col gap-0.5">
              {topActions.map((item) => {
                const isActive =
                  (item.id === "scheduled" && showScheduledTasksPanel) ||
                  (item.id === "plugins" && showSkillPanel);
                return (
                  <button
                    key={item.id}
                    onClick={() => item.action()}
                    className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg transition-colors outline-none ${
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                    }`}
                  >
                    <item.icon className="size-[18px]" />
                    <span className="text-[calc(var(--helix-transcript-size)*0.9286)]">
                      {item.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Unified scroll: single scrollbar covers projects + standalone conversations */}
          <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
            {/* 「项目」= 本地目录 + 远程服务器，一张列表一套行渲染。标题右侧的 ＋
                是唯一的添加入口（本地挑目录 / 远程走三步向导），行内不再挂「添加
                远程项目」占位行 —— 列表里每一行都是一个真实项目。 */}
            <div
              ref={addMenuRef}
              className="relative flex items-center px-4 pt-1.5 pb-0.5 group/section"
            >
              <span className="flex-1 text-[calc(var(--helix-transcript-size)*0.9286)] font-medium tracking-normal text-sidebar-foreground/50">
                项目
              </span>
              {/* ＋ 平时不占视觉（悬停到这一行才出现），打开菜单期间常驻——否则
                  鼠标从按钮移进菜单的瞬间它会消失。不可见时连点击一起关掉，避免
                  留一个看不见的命中区。 */}
              <button
                onClick={() => setAddMenuOpen((v) => !v)}
                className={`shrink-0 p-1 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-opacity ${
                  addMenuOpen
                    ? ""
                    : "opacity-0 pointer-events-none group-hover/section:opacity-100 group-hover/section:pointer-events-auto"
                }`}
                data-tip="添加项目"
              >
                <Plus className="size-3.5" />
              </button>
              {addMenuOpen && (
                <div className="absolute right-2 top-full z-[120] mt-0.5 w-40 bg-card border border-border/80 rounded-lg shadow-xl py-1">
                  <button
                    onClick={() => void handleAddLocalProject()}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
                  >
                    <FolderPlus className="size-3.5 shrink-0" />
                    添加本地项目
                  </button>
                  {remoteAvailable() && (
                    <button
                      onClick={() => {
                        setAddMenuOpen(false);
                        openRemoteWizard();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
                    >
                      <Cloud className="size-3.5 shrink-0" />
                      添加远程项目
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="px-2">
              {loading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="size-4 animate-spin text-sidebar-foreground/30" />
                </div>
              ) : projectGroups.length > 0 ? (
                <div className="space-y-1">
                  {projectGroups.map((project) => {
                    const isRemote = project.kind === "remote";
                    const svc = project.service;
                    const connected = !!project.connected;
                    const remoteBusy = !!svc && remoteBusyId === svc.id;
                    const isExpanded = expandedProjects.has(project.dir);
                    // 点击对话后项目不高亮：只有「未打开任何对话、正在浏览所选项目」时
                    // 才高亮该项目的目录行，避免点开对话后某项目行一直亮着。
                    const isSelectedProject =
                      !isRemote &&
                      !currentSessionId &&
                      selectedWorkDir === project.dir &&
                      // 计划/插件/看板等全屏面板打开时，项目不高亮——避免两处同时亮
                      !showScheduledTasksPanel &&
                      !showSkillPanel;
                    return (
                      <div
                        key={project.dir}
                        className="group rounded-lg overflow-hidden"
                      >
                        <div
                          className={`w-full flex items-center rounded-lg px-3 py-1.5 transition-colors ${
                            isSelectedProject
                              ? "bg-sidebar-accent text-sidebar-accent-foreground"
                              : connected
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : "text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/90"
                          }`}
                        >
                          <div
                            onClick={() =>
                              isRemote
                                ? toggleProjectExpanded(project.dir)
                                : handleSelectProject(project.dir)
                            }
                            className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                          >
                            {isSelectedProject && (
                              <div className="w-[3px] h-4 bg-primary rounded-full shrink-0 -ml-1.5 mr-0.5" />
                            )}
                            {isRemote ? (
                              <Cloud
                                className={`size-3.5 shrink-0 ${connected ? "" : "text-sidebar-foreground/30"}`}
                              />
                            ) : (
                              <Folder
                                className={`size-3.5 shrink-0 ${isSelectedProject ? "text-primary" : "text-sidebar-foreground/30"}`}
                              />
                            )}
                            <span
                              className="text-[calc(var(--helix-transcript-size)*0.8929)] truncate flex-1"
                              data-tip={
                                isRemote && svc
                                  ? `${remoteProjectSubtitle(svc)}${
                                      svc.remotePath ? ` · ${svc.remotePath}` : ""
                                    }`
                                  : project.label
                              }
                            >
                              {project.label.length > 12
                                ? project.label.slice(0, 12) + "…"
                                : project.label}
                            </span>
                            {/* 连着 = 整行已经变绿，不必再写一遍「已连接」。
                                没选过目录是另一回事：它说的是这台还没配好，
                                点连接会先进向导挑目录。 */}
                            {isRemote && !connected && !svc?.remotePath && (
                              <span className="shrink-0 text-[calc(var(--helix-transcript-size)*0.7143)] text-sidebar-foreground/30">
                                未选目录
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                            {isRemote ? (
                              <>
                                {connected && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleNewProjectChat(project.dir);
                                    }}
                                    className="shrink-0 p-1 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
                                    data-tip="新建对话"
                                  >
                                    <Plus className="size-3.5" />
                                  </button>
                                )}
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleRemoteToggle(project);
                                  }}
                                  disabled={remoteBusy}
                                  className={`shrink-0 p-1 rounded-lg transition-colors ${
                                    connected
                                      ? "text-red-500/70 hover:text-red-500 hover:bg-red-500/10"
                                      : "text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
                                  } disabled:opacity-50`}
                                  data-tip={
                                    connected
                                      ? "断开（网关会重启）"
                                      : svc?.remotePath
                                        ? `连接（${svc.remotePath}）`
                                        : "去向导选择远端目录"
                                  }
                                >
                                  {remoteBusy ? (
                                    <Loader2 className="size-3.5 animate-spin" />
                                  ) : connected ? (
                                    <Unplug className="size-3.5" />
                                  ) : (
                                    <Cloud className="size-3.5" />
                                  )}
                                </button>
                                <ProjectActionsMenu
                                  onDelete={() =>
                                    handleRemoteDelete(project)
                                  }
                                />
                              </>
                            ) : (
                              <>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleNewProjectChat(project.dir);
                                  }}
                                  className="shrink-0 p-1 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
                                  data-tip="新建对话"
                                >
                                  <Plus className="size-3.5" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleDirectoryProject(project.dir);
                                  }}
                                  className={`shrink-0 p-1 rounded-lg transition-colors ${directoryProjectDir === project.dir ? "text-primary bg-primary/10" : "text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"}`}
                                  data-tip="打开目录"
                                >
                                  <FolderTree className="size-3.5" />
                                </button>
                                <ProjectActionsMenu
                                  isPinned={project.isPinned}
                                  onPin={() => handlePinProject(project.dir)}
                                  onArchive={() =>
                                    handleArchiveProject(project.dir)
                                  }
                                  onDelete={() =>
                                    handleDeleteProject(project.dir)
                                  }
                                  onShowInExplorer={() =>
                                    handleRevealInExplorer(project.dir)
                                  }
                                />
                              </>
                            )}
                          </div>
                        </div>
                        {isExpanded && (
                          <div>
                            {project.sessions.length === 0 ? (
                              <div className="px-4 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-sidebar-foreground/30">
                                暂无对话
                              </div>
                            ) : (
                              (() => {
                                const totalPages = Math.max(
                                  1,
                                  Math.ceil(
                                    project.sessions.length / PAGE_SIZE,
                                  ),
                                );
                                const page = clampPage(
                                  projectPages[project.dir] ?? 1,
                                  totalPages,
                                );
                                const pageStart = (page - 1) * PAGE_SIZE;
                                const pageSessions = project.sessions.slice(
                                  pageStart,
                                  pageStart + PAGE_SIZE,
                                );
                                return (
                                  <>
                                    {pageSessions.map(
                                      (session, sessionIdx) => (
                                        <div
                                          key={session.id}
                                          draggable
                                          onDragStart={(e) => {
                                            e.dataTransfer.setData(
                                              "text/session-reorder",
                                              JSON.stringify({
                                                sessionId: session.id,
                                                fromDir: project.dir,
                                                fromIdx:
                                                  pageStart + sessionIdx,
                                              }),
                                            );
                                          }}
                                          onDragOver={(e) => {
                                            const data =
                                              e.dataTransfer.types.includes(
                                                "text/session-reorder",
                                              );
                                            if (data) {
                                              e.preventDefault();
                                              e.stopPropagation();
                                            }
                                          }}
                                          onDrop={async (e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            const raw =
                                              e.dataTransfer.getData(
                                                "text/session-reorder",
                                              );
                                            if (!raw) return;
                                            let draggedId: string;
                                            try {
                                              ({ sessionId: draggedId } =
                                                JSON.parse(raw));
                                            } catch {
                                              // malformed drag payload — nothing to reorder
                                              return;
                                            }
                                            if (draggedId === session.id)
                                              return;
                                            // Reorder: move dragged session before this one
                                            const updated =
                                              project.sessions.filter(
                                                (s) => s.id !== draggedId,
                                              );
                                            const dragged =
                                              project.sessions.find(
                                                (s) => s.id === draggedId,
                                              );
                                            if (dragged) {
                                              const targetIdx =
                                                updated.findIndex(
                                                  (s) => s.id === session.id,
                                                );
                                              updated.splice(
                                                targetIdx,
                                                0,
                                                dragged,
                                              );
                                              // Update order in persistence by re-saving with createdAt shuffle
                                              try {
                                                await persistence.reorderSessions(
                                                  updated.map((s) => s.id),
                                                );
                                              } catch {
                                                // best-effort reorder; ignore persistence failure
                                              }
                                            }
                                          }}
                                          onClick={() =>
                                            handleLoadSession(session)
                                          }
                                          className={`relative w-full group flex items-center gap-2 px-4 py-2 cursor-pointer transition-colors ${
                                            currentSessionId === session.id
                                              ? "bg-primary/10 text-primary"
                                              : "text-sidebar-foreground/50 hover:bg-sidebar-accent/30 hover:text-sidebar-foreground/80"
                                          }`}
                                          onContextMenu={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setSessionMenuId(session.id);
                                          }}
                                        >
                                          {streamingDrafts[session.id]
                                            ?.isAgentRunning ? (
                                            <div className="w-4 flex items-center justify-center shrink-0">
                                              <span className="size-2.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                                            </div>
                                          ) : (
                                            <div className="w-4 shrink-0" />
                                          )}
                                          <div className="flex-1 min-w-0">
                                            {renamingId === session.id ? (
                                              <input
                                                autoFocus
                                                defaultValue={session.label}
                                                onClick={(e) =>
                                                  e.stopPropagation()
                                                }
                                                onBlur={(e) =>
                                                  handleCommitRename(
                                                    session.id,
                                                    e.target.value,
                                                  )
                                                }
                                                onKeyDown={(e) => {
                                                  if (e.key === "Enter") {
                                                    e.preventDefault();
                                                    handleCommitRename(
                                                      session.id,
                                                      (
                                                        e.target as HTMLInputElement
                                                      ).value,
                                                    );
                                                  } else if (
                                                    e.key === "Escape"
                                                  ) {
                                                    setRenamingId(null);
                                                  }
                                                }}
                                                className="text-[calc(var(--helix-transcript-size)*0.8571)] w-full bg-background outline-none border border-primary rounded px-1 py-0.5"
                                              />
                                            ) : (
                                              <div className="flex items-center gap-1.5 min-w-0">
                                                {session.branchName && (
                                                  <span className="shrink-0 inline-flex items-center gap-0.5 px-1 py-px rounded text-[calc(var(--helix-transcript-size)*0.6429)] font-medium bg-blue-500/10 text-blue-500 dark:text-blue-400">
                                                    <GitBranch className="size-2" />
                                                    {session.branchName}
                                                  </span>
                                                )}
                                                <p
                                                  className="text-[calc(var(--helix-transcript-size)*0.8571)] truncate flex-1"
                                                  data-tip="双击重命名"
                                                  onDoubleClick={(e) => {
                                                    e.stopPropagation();
                                                    setRenamingId(session.id);
                                                  }}
                                                >
                                                  {session.label.length > 14
                                                    ? session.label.slice(
                                                        0,
                                                        14,
                                                      ) + "…"
                                                    : session.label}
                                                </p>
                                              </div>
                                            )}
                                          </div>
                                          {sessionPendingApproval[
                                            session.id
                                          ] && (
                                            <span
                                              className="shrink-0 size-2 rounded-full bg-amber-500"
                                              data-tip="需要确认"
                                            />
                                          )}
                                          <span
                                            className="ml-auto shrink-0 text-right text-[calc(var(--helix-transcript-size)*0.7143)] text-sidebar-foreground/40 transition-opacity group-hover:opacity-0"
                                            data-tip={`上次使用：${new Date(session.savedAt).toLocaleString("zh-CN")}`}
                                          >
                                            {timeAgo(session.savedAt)}
                                          </span>
                                          <SessionActionsMenu
                                            isPinned={session.isPinned}
                                            open={sessionMenuId === session.id}
                                            onOpenChange={(v) =>
                                              setSessionMenuId(
                                                v ? session.id : null,
                                              )
                                            }
                                            onCopyId={() =>
                                              copySessionId(session.id)
                                            }
                                            onArchive={() =>
                                              handleToggleArchive(session.id)
                                            }
                                            onPin={() =>
                                              handleTogglePin(session.id)
                                            }
                                            onDelete={() =>
                                              handleDeleteSession(session.id)
                                            }
                                            onRename={() =>
                                              setRenamingId(session.id)
                                            }
                                          />
                                        </div>
                                      ),
                                    )}
                                    {/* 项目内会话分页控件 */}
                                    {project.sessions.length > PAGE_SIZE && (
                                      <div className="flex items-center justify-center gap-1 pt-1">
                                        <button
                                          type="button"
                                          disabled={page <= 1}
                                          onClick={() =>
                                            setProjectPages((prev) => ({
                                              ...prev,
                                              [project.dir]: page - 1,
                                            }))
                                          }
                                          className="px-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-sidebar-foreground/50 hover:text-sidebar-foreground disabled:opacity-30 disabled:hover:text-sidebar-foreground/50 rounded transition-colors"
                                        >
                                          上一页
                                        </button>
                                        <span className="px-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-sidebar-foreground/40">
                                          {page} / {totalPages}
                                        </span>
                                        <button
                                          type="button"
                                          disabled={page >= totalPages}
                                          onClick={() =>
                                            setProjectPages((prev) => ({
                                              ...prev,
                                              [project.dir]: page + 1,
                                            }))
                                          }
                                          className="px-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-sidebar-foreground/50 hover:text-sidebar-foreground disabled:opacity-30 disabled:hover:text-sidebar-foreground/50 rounded transition-colors"
                                        >
                                          下一页
                                        </button>
                                      </div>
                                    )}
                                  </>
                                );
                              })()
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="px-3 py-2 text-[calc(var(--helix-transcript-size)*0.9286)] text-sidebar-foreground/30">
                  暂无项目
                </div>
              )}
            </div>

            {/* Conversations */}
            {conversations.length > 0 && (
              <>
                <div className="px-4 pt-1.5 pb-0.5 text-[calc(var(--helix-transcript-size)*0.7857)] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
                  对话
                </div>
                <div className="px-3 pb-1.5">
                  <div className="space-y-0.5">
                    {conversations
                      .slice(
                        (conversationPage - 1) * PAGE_SIZE,
                        conversationPage * PAGE_SIZE,
                      )
                      .map((session) => (
                        <div
                          key={session.id}
                          onClick={() => handleLoadSession(session)}
                          className={`relative w-full group flex items-center gap-2 px-3 py-2 rounded-lg transition-colors cursor-pointer ${
                            currentSessionId === session.id
                              ? "bg-primary/10 text-primary"
                              : "text-sidebar-foreground/70 hover:bg-sidebar-accent/40"
                          }`}
                          onContextMenu={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            setSessionMenuId(session.id);
                          }}
                        >
                          {streamingDrafts[session.id]?.isAgentRunning ? (
                            <div className="w-4 flex items-center justify-center shrink-0">
                              <span className="size-2.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                            </div>
                          ) : (
                            <div className="w-4 shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            {renamingId === session.id ? (
                              <input
                                autoFocus
                                defaultValue={session.label}
                                onClick={(e) => e.stopPropagation()}
                                onBlur={(e) =>
                                  handleCommitRename(session.id, e.target.value)
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    handleCommitRename(
                                      session.id,
                                      (e.target as HTMLInputElement).value,
                                    );
                                  } else if (e.key === "Escape") {
                                    setRenamingId(null);
                                  }
                                }}
                                className="text-[calc(var(--helix-transcript-size)*0.9286)] w-full bg-background outline-none border border-primary rounded px-1 py-0.5"
                              />
                            ) : (
                              <p
                                className="text-[calc(var(--helix-transcript-size)*0.9286)] truncate"
                                data-tip="双击重命名"
                                onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  setRenamingId(session.id);
                                }}
                              >
                                {session.label.length > 14
                                  ? session.label.slice(0, 14) + "…"
                                  : session.label}
                              </p>
                            )}
                          </div>
                          {sessionPendingApproval[session.id] && (
                            <span
                              className="shrink-0 size-2 rounded-full bg-amber-500"
                              data-tip="需要确认"
                            />
                          )}
                          <span
                            className="ml-auto shrink-0 text-right text-[calc(var(--helix-transcript-size)*0.7143)] text-sidebar-foreground/40 transition-opacity group-hover:opacity-0"
                            data-tip={`上次使用：${new Date(session.savedAt).toLocaleString("zh-CN")}`}
                          >
                            {timeAgo(session.savedAt)}
                          </span>
                          <SessionActionsMenu
                            isPinned={session.isPinned}
                            open={sessionMenuId === session.id}
                            onOpenChange={(v) =>
                              setSessionMenuId(v ? session.id : null)
                            }
                            onCopyId={() => copySessionId(session.id)}
                            onArchive={() => handleToggleArchive(session.id)}
                            onPin={() => handleTogglePin(session.id)}
                            onDelete={() => handleDeleteSession(session.id)}
                            onRename={() => setRenamingId(session.id)}
                          />
                        </div>
                      ))}
                  </div>
                  {/* 独立对话分页控件 */}
                  {conversations.length > PAGE_SIZE && (
                    <div className="flex items-center justify-center gap-1 pt-1.5">
                      <button
                        type="button"
                        disabled={conversationPage <= 1}
                        onClick={() => setConversationPage((p) => p - 1)}
                        className="px-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-sidebar-foreground/50 hover:text-sidebar-foreground disabled:opacity-30 disabled:hover:text-sidebar-foreground/50 rounded transition-colors"
                      >
                        上一页
                      </button>
                      <span className="px-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-sidebar-foreground/40">
                        {conversationPage} /{" "}
                        {Math.ceil(conversations.length / PAGE_SIZE)}
                      </span>
                      <button
                        type="button"
                        disabled={
                          conversationPage >=
                          Math.ceil(conversations.length / PAGE_SIZE)
                        }
                        onClick={() => setConversationPage((p) => p + 1)}
                        className="px-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-sidebar-foreground/50 hover:text-sidebar-foreground disabled:opacity-30 disabled:hover:text-sidebar-foreground/50 rounded transition-colors"
                      >
                        下一页
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
          <div className="px-2 py-1.5 shrink-0 space-y-0.5">
            <button
              onClick={() => toggleSettings()}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8929)] text-sidebar-foreground/60 hover:text-sidebar-foreground/90 hover:bg-sidebar-accent/40 rounded-lg transition-colors"
            >
              <Settings className="size-4 shrink-0" />
              <span>设置</span>
              {isElectron() && (
                <span
                  className={`ml-auto flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.7143)] ${helixConnected ? "text-emerald-500" : "text-amber-500"}`}
                >
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${helixConnected ? "bg-emerald-500" : "bg-amber-500 animate-pulse"}`}
                  />
                  {helixConnected ? "已连接" : "连接中"}
                </span>
              )}
            </button>
          </div>
        </>
      )}
      {/* Delete confirmation dialog */}
      {deleteTarget &&
        createPortal(
          <div className="fixed inset-0 z-[10000] flex items-center justify-center animate-fade-in">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setDeleteTarget(null)}
            />
            <div className="relative bg-popover border border-border/40 rounded-2xl shadow-2xl w-96 mx-4 p-6 space-y-4 animate-scale-in">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                  <AlertTriangle className="size-5 text-destructive" />
                </div>
                <div>
                  <h3 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
                    删除对话
                  </h3>
                  <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground mt-1">
                    确定要删除「{deleteTarget.label}」吗？此操作不可撤销。
                  </p>
                </div>
              </div>
              <div className="flex justify-between gap-2">
                <button
                  onClick={handleConfirmDelete}
                  className="px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] text-destructive-foreground bg-destructive hover:bg-destructive/90 rounded-lg transition-colors"
                >
                  删除
                </button>
                <button
                  onClick={() => setDeleteTarget(null)}
                  className="px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground/70 hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      {deleteProjectDir &&
        createPortal(
          <div className="fixed inset-0 z-[10000] flex items-center justify-center animate-fade-in">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setDeleteProjectDir(null)}
            />
            <div className="relative bg-popover border border-border/40 rounded-2xl shadow-2xl w-96 mx-4 p-6 space-y-4 animate-scale-in">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                  <AlertTriangle className="size-5 text-destructive" />
                </div>
                <div>
                  <h3 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">
                    删除项目
                  </h3>
                  <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground mt-1">
                    确定要删除「
                    {deleteProjectDir.split(/[/\\\\]/).pop() ||
                      deleteProjectDir}
                    」及该项目下的所有对话吗？此操作不可撤销。
                  </p>
                </div>
              </div>
              <div className="flex justify-between gap-2">
                <button
                  onClick={handleConfirmDeleteProject}
                  className="px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] text-destructive-foreground bg-destructive hover:bg-destructive/90 rounded-lg transition-colors"
                >
                  删除
                </button>
                <button
                  onClick={() => setDeleteProjectDir(null)}
                  className="px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.9286)] text-foreground/70 hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                >
                  取消
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

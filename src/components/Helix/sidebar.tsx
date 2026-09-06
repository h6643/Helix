'use client'

import {
  Plus,
  Search,
  Clock,
  Puzzle,
  Settings,
  Brain,
  Loader2,
  Trash2,
  Folder,
  FolderOpen,
  FolderTree,
  Archive,
  Pin,
  Sparkles,
  RotateCcw,
  MoreVertical,
  Pencil,
  GitBranch,
  AlertTriangle,
  PanelLeft,
  Users,
} from 'lucide-react'
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { isElectron, electronDialog, electronShell } from '@/lib/electron-bridge'
import { persistence, type PersistedSession } from '@/lib/persist'
import { timeAgo } from '@/lib/format'
import { useHelixStore } from '@/stores/helix-store'
import { useGatewayStore } from '@/stores/gateway-store'
import { FileTreePanel } from './file-tree-panel'

interface SidebarProps {
  onNewTask?: () => void
  collapsed?: boolean
  onToggle?: () => void
}

interface SessionActionsMenuProps {
  isPinned?: boolean
  isArchived?: boolean
  onArchive?: () => void
  onPin?: () => void
  onDelete?: () => void
  onRestore?: () => void
  onRename?: () => void
}

function SessionActionsMenu({ isPinned, isArchived, onArchive, onPin, onDelete, onRestore, onRename }: SessionActionsMenuProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ top?: number; bottom?: number; right: number } | null>(null)

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const MENU_HEIGHT_ESTIMATE = 180 // ~4–5 items × ~36px each + padding
    const spaceBelow = window.innerHeight - rect.bottom - 4
    const spaceAbove = rect.top - 4
    // Prefer opening downward; flip upward only when there isn't enough room.
    // When upward, anchor menu BOTTOM just above the button (no gap).
    const openUpward = spaceBelow < MENU_HEIGHT_ESTIMATE && spaceAbove > spaceBelow
    setCoords({
      top: openUpward ? undefined : rect.bottom + 4,
      bottom: openUpward ? window.innerHeight - rect.top + 4 : undefined,
      right: window.innerWidth - rect.right,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    updatePosition()
    const handle = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        (buttonRef.current && buttonRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return
      }
      setOpen(false)
    }
    const handleScroll = () => setOpen(false)
    document.addEventListener('mousedown', handle)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleScroll)
    return () => {
      document.removeEventListener('mousedown', handle)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleScroll)
    }
  }, [open, updatePosition])

  return (
    <div className="absolute right-1 top-1/2 -translate-y-1/2">
      <button
        ref={buttonRef}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        className="p-1 text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
        data-tip="更多操作"
      >
        <MoreVertical className="size-3.5" />
      </button>
      {open && coords && createPortal(
        <div className="fixed z-[100]" style={{ top: coords.top, bottom: coords.bottom, right: coords.right }}>
          <div ref={menuRef} className="w-40 bg-card border border-border/80 rounded-lg shadow-xl py-1">
            {onRename && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onRename() }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground hover:bg-accent/60"
              >
                <Pencil className="size-3.5" />
                重命名
              </button>
            )}
            {!isArchived && onArchive && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onArchive() }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <Archive className="size-3.5" />
                归档
              </button>
            )}
            {!isArchived && onPin && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onPin() }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <Pin className={`size-3.5 ${isPinned ? 'text-primary' : ''}`} />
                {isPinned ? '取消固定' : '固定'}
              </button>
            )}
            {isArchived && onRestore && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onRestore() }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <RotateCcw className="size-3.5" />
                恢复
              </button>
            )}
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete() }}
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
  )
}

interface ProjectActionsMenuProps {
  isPinned?: boolean
  onPin?: () => void
  onArchive?: () => void
  onDelete?: () => void
  onShowInExplorer?: () => void
}

function ProjectActionsMenu({ isPinned, onPin, onArchive, onDelete, onShowInExplorer }: ProjectActionsMenuProps) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState<{ top?: number; bottom?: number; right: number } | null>(null)

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    const MENU_HEIGHT_ESTIMATE = 180 // ~4–5 items × ~36px each + padding
    const spaceBelow = window.innerHeight - rect.bottom - 4
    const spaceAbove = rect.top - 4
    // Prefer opening downward; flip upward only when there isn't enough room.
    // When upward, anchor menu BOTTOM just above the button (no gap).
    const openUpward = spaceBelow < MENU_HEIGHT_ESTIMATE && spaceAbove > spaceBelow
    setCoords({
      top: openUpward ? undefined : rect.bottom + 4,
      bottom: openUpward ? window.innerHeight - rect.top + 4 : undefined,
      right: window.innerWidth - rect.right,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    updatePosition()
    const handle = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        (buttonRef.current && buttonRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      ) {
        return
      }
      setOpen(false)
    }
    const handleScroll = () => setOpen(false)
    document.addEventListener('mousedown', handle)
    window.addEventListener('scroll', handleScroll, true)
    window.addEventListener('resize', handleScroll)
    return () => {
      document.removeEventListener('mousedown', handle)
      window.removeEventListener('scroll', handleScroll, true)
      window.removeEventListener('resize', handleScroll)
    }
  }, [open, updatePosition])

  return (
    <div className="relative shrink-0">
      <button
        ref={buttonRef}
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v) }}
        className="p-1 text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 rounded-lg transition-colors opacity-0 group-hover:opacity-100 focus:opacity-100"
        data-tip="更多操作"
      >
        <MoreVertical className="size-3.5" />
      </button>
      {open && coords && createPortal(
        <div className="fixed z-[100]" style={{ top: coords.top, bottom: coords.bottom, right: coords.right }}>
          <div ref={menuRef} className="w-40 bg-card border border-border/80 rounded-lg shadow-xl py-1">
            {onPin && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onPin() }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <Pin className={`size-3.5 ${isPinned ? 'text-primary' : ''}`} />
                {isPinned ? '取消置顶' : '置顶'}
              </button>
            )}
            {onShowInExplorer && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onShowInExplorer() }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <FolderOpen className="size-3.5" />
                <span className="whitespace-nowrap">在资源管理器中显示</span>
              </button>
            )}
            {onArchive && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onArchive() }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-foreground/80 hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <Archive className="size-3.5" />
                归档
              </button>
            )}
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete() }}
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
  )
}

export function Sidebar({ onNewTask, collapsed = false, onToggle }: SidebarProps) {
  const {
    clearChat,
    clearExecutionFlow,
    flushSessionPersist,
    setCurrentSessionId,
    pushNavigation,
    toggleSettings,
    toggleScheduledTasksPanel,
    toggleSkillPanel,
    toggleSessionManager,
    showToast,
    setSelectedWorkDir,
    setWorkDir,
  } = useHelixStore(
    useShallow((s) => ({
      clearChat: s.clearChat,
      clearExecutionFlow: s.clearExecutionFlow,
      flushSessionPersist: s.flushSessionPersist,
      setCurrentSessionId: s.setCurrentSessionId,
      pushNavigation: s.pushNavigation,
      toggleSettings: s.toggleSettings,
      toggleScheduledTasksPanel: s.toggleScheduledTasksPanel,
      toggleSkillPanel: s.toggleSkillPanel,
      toggleSessionManager: s.toggleSessionManager,
      showToast: s.showToast,
      setSelectedWorkDir: s.setSelectedWorkDir,
      setWorkDir: s.setWorkDir,
                            })),
  )
  const showScheduledTasksPanel = useHelixStore((s) => s.showScheduledTasksPanel)
          const showSkillPanel = useHelixStore((s) => s.showSkillPanel)
  const selectedWorkDir = useHelixStore((s) => s.selectedWorkDir)
  const directoryProjectDir = useHelixStore((s) => s.directoryProjectDir)
  const toggleDirectoryProject = useHelixStore((s) => s.toggleDirectoryProject)
  const setRightSidebarTab = useHelixStore((s) => s.setRightSidebarTab)

  // Re-render every minute so the relative '上次使用' timestamps stay fresh
  const [, setNowTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setNowTick((n) => n + 1), 60_000)
    return () => clearInterval(timer)
  }, [])

  const currentSessionId = useHelixStore(s => s.currentSessionId)
  const sessionPendingApproval = useHelixStore(s => s.sessionPendingApproval)
  const streamingDrafts = useHelixStore(s => s.streamingDrafts)
  const helixConnected = useGatewayStore(s => s.helixConnected)
  const [sessions, setSessions] = useState<PersistedSession[]>([])
  const [persistedFolders, setPersistedFolders] = useState<Set<string>>(new Set())
  const [pinnedProjectDirs, setPinnedProjectDirs] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<PersistedSession | null>(null)
  const [deleteProjectDir, setDeleteProjectDir] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)

  // 历史对话条分页：每页最多显示 20 条（项目内会话与独立对话各自分页）。
  const PAGE_SIZE = 20
  const [projectPages, setProjectPages] = useState<Record<string, number>>({})
  const [conversationPage, setConversationPage] = useState(1)
  // 取某列表的有效页码（增删会话后页码可能越界，clamp 到 [1, totalPages]）。
  const clampPage = (page: number, total: number) => Math.min(Math.max(1, page), Math.max(1, total))

  const [, setFavRefresh] = useState(0)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [recentCollapsed, setRecentCollapsed] = useState(false)
  const [recentHovered, setRecentHovered] = useState(false)
  // Bumped to force the full-area directory view's FileTreePanel to reload.
  const [dirReloadKey, setDirReloadKey] = useState(0)

  const sortSessions = useCallback(
    (list: PersistedSession[]) =>
      [...list].sort((a, b) => (b.createdAt ?? b.savedAt) - (a.createdAt ?? a.savedAt)),
    []
  )

  const loadSessions = useCallback(async () => {
    try {
      const list = await persistence.loadSessions()
      setSessions(sortSessions(list))
    } catch (e) {
      console.error('Failed to load sessions:', e)
    }
  }, [sortSessions])

  const loadPersistedFolders = useCallback(async () => {
    try {
      const folders = await persistence.getProjectFolders()
      setPersistedFolders(new Set(folders))
    } catch (e) {
      console.error('Failed to load persisted folders:', e)
    }
  }, [])

  const loadPinnedProjectFolders = useCallback(async () => {
    try {
      const folders = await persistence.getPinnedProjectFolders()
      setPinnedProjectDirs(new Set(folders))
    } catch (e) {
      console.error('Failed to load pinned project folders:', e)
    }
  }, [])

  useEffect(() => {
    Promise.all([loadSessions(), loadPersistedFolders(), loadPinnedProjectFolders()]).finally(() => setLoading(false))
  }, [loadSessions, loadPersistedFolders, loadPinnedProjectFolders])

  const sessionSaveVersion = useHelixStore(s => s.sessionSaveVersion)
  useEffect(() => {
    if (sessionSaveVersion > 0) loadSessions()
  }, [sessionSaveVersion, loadSessions])

  // Expand currently selected project automatically
  useEffect(() => {
    if (selectedWorkDir) {
      setExpandedProjects(prev => new Set([...prev, selectedWorkDir]))
    }
  }, [selectedWorkDir])

  // Projects = unique workDirs from sessions + persisted folders + current selection
  const projects = useMemo(() => {
    const groups = new Map<string, PersistedSession[]>()
    for (const s of sessions) {
      if (s.isArchived) continue
      if (!s.workDir || s.workDir === '/' || s.workDir === '\\') continue
      const list = groups.get(s.workDir) || []
      list.push(s)
      groups.set(s.workDir, list)
    }
    // Ensure all persisted folders appear, even with no sessions
    for (const folder of persistedFolders) {
      if (!groups.has(folder)) {
        groups.set(folder, [])
      }
    }
    // Ensure pinned dirs appear even when empty
    for (const folder of pinnedProjectDirs) {
      if (!groups.has(folder)) {
        groups.set(folder, [])
      }
    }
    return Array.from(groups.entries())
      .map(([dir, list]) => {
        const sorted = [...list].sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
          return (b.createdAt ?? b.savedAt) - (a.createdAt ?? a.savedAt)
        })
        return {
          dir,
          label: dir.split(/[/\\\\]/).pop() || dir,
          sessions: sorted,
          isPinned: pinnedProjectDirs.has(dir),
        }
      })
      .sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
        return (b.sessions[0]?.createdAt ?? b.sessions[0]?.savedAt ?? 0) - (a.sessions[0]?.createdAt ?? a.sessions[0]?.savedAt ?? 0)
      })
  }, [sessions, persistedFolders, pinnedProjectDirs])

  // Standalone conversations (no workDir only)
  const conversations = useMemo(() => {
    return sessions
      .filter(s => !s.isArchived && !s.workDir)
      .sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
        return (b.createdAt ?? b.savedAt) - (a.createdAt ?? a.savedAt)
      })
  }, [sessions])

  // Concurrent multi-session design: switching / creating conversations NEVER
  // interrupts a running agent. Each run streams into its own per-session
  // draft (streamingDrafts[sid]) and commits its reply with its own sessionId,
  // so navigation is purely a view change. (The old interruptIfRunning confirm
  // dialog was a relic of the single-active-run engine.)

  const handleNewTask = useCallback(async () => {
    useHelixStore.getState().flushSessionPersist()
    clearChat()
    useHelixStore.getState().clearExecutionFlow()
    useHelixStore.getState().setCurrentSessionId(null)
    // Returning to a conversation from the sidebar should dismiss the
    // full-area panels so the chat is visible again.
    const state = useHelixStore.getState()
    if (state.showScheduledTasksPanel || state.showSkillPanel) {
      useHelixStore.setState({ showScheduledTasksPanel: false, showSkillPanel: false })
    }
    onNewTask?.()
  }, [clearChat, onNewTask])

  // New chat belonging to a specific project (used by the + button on each project row).
  const handleNewProjectChat = useCallback(async (dir: string) => {
    if (!dir || dir === '/' || dir === '\\') return
    try {
      await useHelixStore.getState().flushSessionPersist()
      useHelixStore.getState().clearExecutionFlow()
      clearChat()
      if (isElectron()) {
        try {
          await setWorkDir(dir)
        } catch {
          // Fallback if the main-process call fails so the UI still lands in the project.
          setSelectedWorkDir(dir)
        }
      } else {
        setSelectedWorkDir(dir)
      }
      // Double-check: clearChat wipes selectedWorkDir, restore it to the target project.
      useHelixStore.getState().setSelectedWorkDir(dir)
      useHelixStore.getState().setCurrentSessionId(null)
      await persistence.saveProjectFolder(dir)
    } catch (e) {
      console.error('Failed to switch project for new chat:', e)
      showToast({ type: 'error', title: '创建新对话失败' })
    }
  }, [clearChat, setSelectedWorkDir, setWorkDir, showToast])

  const handleLoadSession = useCallback(async (session: PersistedSession) => {
    try {
      const state = useHelixStore.getState()
      // Only persist the current session if it has already been saved at least once.
      // Otherwise, loading a historical session from a different project would cause
      // temporary unsaved messages to be saved under the current project.
      // Fire-and-forget: persistCurrentSessionNow captures a synchronous snapshot
      // at entry, so it stays correct even after we switch away below.
      if (state.currentSessionId) {
        void state.flushSessionPersist()
      }
      useHelixStore.getState().clearExecutionFlow()
      // NOTE: do NOT reset the Helix session here — under the concurrent
      // multi-session design each conversation owns its own Helix ACP session
      // (helixSessionMapRef in agent-flow-panel); resetting the legacy global
      // id would be meaningless at best and confusing at worst.
      // Same as above: navigating to a session must close the panels.
    if (state.showScheduledTasksPanel || state.showSkillPanel) {
      useHelixStore.setState({ showScheduledTasksPanel: false, showSkillPanel: false })
    }
      // Load just the target session (single IndexedDB read) instead of
      // fetching every session from disk just to pick one. Fall back to the
      // in-memory snapshot if the record is missing (e.g. just-deleted).
      const fresh = (await persistence.loadSession(session.id)) || session
      // 恢复时丢弃 draft-partial 占位消息（与 navigateSession 一致）。并发设计
      // 下切换会话并不会中断后台 run——该占位只是持久化快照，若展示会与最终
      // 提交的完整回复重复，并误导显示"生成中断"。
      const seen = new Set<string>()
      const msgs = fresh.chatMessages
        .filter(msg => {
          if (seen.has(msg.id)) return false
          seen.add(msg.id)
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
        fileChanges: msg.fileChanges,
        blocks: msg.blocks,
        // Tag with the owning session so concurrent sessions' messages can
        // coexist in the store without leaking across the per-session filter.
        sessionId: session.id,
      }))
      // Preserve in-memory messages of sessions that are STILL RUNNING in the
      // background — wholesale replacement would drop their user prompt and
      // leave the eventual `done` commit orphaned in an empty conversation.
      const st2 = useHelixStore.getState()
      const runningSids = new Set(
        Object.entries(st2.streamingDrafts)
          .filter(([, d]) => d.isAgentRunning)
          .map(([k]) => k),
      )
      const preserved = st2.chatMessages.filter(
        m => m.sessionId && m.sessionId !== session.id && runningSids.has(m.sessionId),
      )
      const loadedIds = new Set(msgs.map(m => m.id))
      useHelixStore.setState({
        chatMessages: [...msgs, ...preserved.filter(m => !loadedIds.has(m.id))],
        activeSessionWorkDir: fresh.workDir ?? null,
      })
      if (fresh.workDir) {
        await persistence.saveProjectFolder(fresh.workDir)
        // 加载对话后把 selectedWorkDir 也切到对话所属项目，让 Git 分支选择器
        // （agent-flow-panel 用 selectedWorkDir 作为 cwd）跟着对话走。只同步
        // selectedWorkDir，绝不走 setWorkDir——那会触发"切换项目"副作用。
        useHelixStore.getState().setSelectedWorkDir(fresh.workDir)
        // 对齐主进程 workDir：历史对话只改前端 selectedWorkDir，主进程会残留在旧
        // 项目 → 相对路径的 fs IPC（打开文件/diff 预览等）被拼到旧目录 → ENOENT。
        // 用轻量 syncWorkDir（不重启网关、不持久化），绝不能走 setWorkDir——那会
        // 触发“切换项目”副作用，打断正在运行的对话。
        try { await (window as any).electron?.app?.syncWorkDir?.(fresh.workDir) } catch { /* best-effort */ }
      }
      useHelixStore.getState().setCurrentSessionId(session.id)
      pushNavigation({ type: 'chat', sessionId: session.id })
    } catch (e) {
      console.error('Failed to load session:', e)
      showToast({ type: 'error', title: '加载失败' })
    }
  }, [showToast])

  const handleDeleteSession = useCallback(async (id: string) => {
    const session = sessions.find(s => s.id === id)
    if (session) setDeleteTarget(session)
  }, [sessions])

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    try {
      await persistence.deleteSession(deleteTarget.id)
      const remaining = await persistence.loadSessions()
      setSessions(sortSessions(remaining))
      const state = useHelixStore.getState()
      if (state.currentSessionId === deleteTarget.id || remaining.length === 0) {
        // Only clear chat state; preserve the current project so the project
        // item remains visible even after its last session is deleted.
        useHelixStore.setState({
          chatMessages: [],
          currentSessionId: null,
          activeSessionWorkDir: null,
        })
        if (remaining.length === 0) {
          useHelixStore.setState({ selectedWorkDir: null })
        }
        useHelixStore.getState().clearExecutionFlow()
        useGatewayStore.getState().setHelixSessionId(null)
      }
      setDeleteTarget(null)
    } catch (e) {
      console.error('Failed to delete session:', e)
    }
  }, [deleteTarget, showToast, sortSessions])

  const handleToggleArchive = useCallback(async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    try {
      await persistence.toggleSessionArchived(id)
      const remaining = await persistence.loadSessions()
      setSessions(sortSessions(remaining))
    } catch (e) {
      console.error('Failed to toggle archive:', e)
    }
  }, [sortSessions])

  const handleTogglePin = useCallback(async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation()
    try {
      await persistence.toggleSessionPinned(id)
      const remaining = await persistence.loadSessions()
      setSessions(sortSessions(remaining))
    } catch (e) {
      console.error('Failed to toggle pin:', e)
    }
  }, [sortSessions])

  const handleRevealInExplorer = useCallback(async (dir?: string | null) => {
    if (!dir) return
    try {
      if (isElectron()) {
        await electronShell.openPath(dir)
      }
    } catch (e) {
      console.error('Failed to reveal in explorer:', e)
    }
  }, [])

  const handleCommitRename = useCallback(async (id: string, label: string) => {
    setRenamingId(null)
    const trimmed = label.trim()
    if (!trimmed) {
      const remaining = await persistence.loadSessions()
      setSessions(sortSessions(remaining))
      return
    }
    try {
      await persistence.updateSessionLabel(id, trimmed)
      const remaining = await persistence.loadSessions()
      setSessions(sortSessions(remaining))
    } catch (e) {
      console.error('Failed to rename session:', e)
    }
  }, [sortSessions])

  // Listen for rename-session keyboard shortcut
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.sessionId) setRenamingId(detail.sessionId)
    }
    window.addEventListener('helix:rename-session', handler)
    return () => window.removeEventListener('helix:rename-session', handler)
  }, [])

  const handleSelectProject = useCallback(async (dir: string) => {
    if (!dir || dir === '/' || dir === '\\') return
    try {
      setExpandedProjects(prev => {
        const next = new Set(prev)
        if (next.has(dir)) next.delete(dir)
        else next.add(dir)
        return next
      })
      await persistence.saveProjectFolder(dir)
      if (isElectron()) {
        await setWorkDir(dir)
      } else {
        setSelectedWorkDir(dir)
      }
    } catch (e) {
      console.error('Failed to select project:', e)
    }
  }, [setWorkDir, setSelectedWorkDir])

  const handlePinProject = useCallback(async (dir: string) => {
    try {
      const pinned = await persistence.togglePinnedProjectFolder(dir)
      setPinnedProjectDirs(prev => {
        const next = new Set(prev)
        if (pinned) next.add(dir)
        else next.delete(dir)
        return next
      })
      showToast({ type: 'success', title: pinned ? '项目已置顶' : '已取消置顶' })
    } catch (e) {
      console.error('Failed to pin project:', e)
      showToast({ type: 'error', title: '置顶失败' })
    }
  }, [showToast])

  const handleArchiveProject = useCallback(async (dir: string) => {
    try {
      const count = await persistence.archiveSessionsByWorkDir(dir)
      const remaining = await persistence.loadSessions()
      setSessions(sortSessions(remaining))
    } catch (e) {
      console.error('Failed to archive project:', e)
      showToast({ type: 'error', title: '归档失败' })
    }
  }, [sortSessions, showToast])

  const handleDeleteProject = useCallback((dir: string) => {
    setDeleteProjectDir(dir)
  }, [])

  const handleConfirmDeleteProject = useCallback(async () => {
    if (!deleteProjectDir) return
    try {
      // 先取被删项目下的会话 id（deleteSessionsByWorkDir 删完就查不到了），
      // 用于随后清理内存里残留的消息与运行中草稿。
      const sessionsBefore = await persistence.loadSessions()
      const deletedIds = new Set(
        sessionsBefore.filter((s) => s.workDir === deleteProjectDir).map((s) => s.id),
      )
      const count = await persistence.deleteSessionsByWorkDir(deleteProjectDir)
      await persistence.deleteProjectFolder(deleteProjectDir)
      // Drop the dir from pinned folders (if it was pinned) so it can't re-appear.
      const pinned = await persistence.getPinnedProjectFolders()
      if (pinned.includes(deleteProjectDir)) {
        await persistence.savePinnedProjectFolders(pinned.filter((d) => d !== deleteProjectDir))
      }
      const remaining = await persistence.loadSessions()
      setSessions(sortSessions(remaining))
      // Re-sync the in-memory folder/pin sets from storage. Without this the
      // deleted dir stays in `persistedFolders`/`pinnedProjectDirs` and the
      // project keeps showing in the sidebar — so the delete looks like a no-op.
      setPersistedFolders(new Set(await persistence.getProjectFolders()))
      setPinnedProjectDirs(new Set(await persistence.getPinnedProjectFolders()))
      setExpandedProjects((prev) => {
        const next = new Set(prev)
        next.delete(deleteProjectDir)
        return next
      })
      if (selectedWorkDir === deleteProjectDir) {
        setSelectedWorkDir(null)
      }
      // 清理内存中仍指向被删项目的会话状态。磁盘会话已删，但内存里的
      // chatMessages / streamingDrafts 若还留着它们，后续点击其他对话触发的
      // flushSessionPersist（或后台 run 完成时 persistSessionById）会按
      // activeSessionWorkDir/selectedWorkDir 把这些会话重新写回磁盘——刚删除的
      // 项目因此"复活"。这里用上面删前取的 deletedIds 同步清掉被删项目下
      // 所有会话的消息 + 运行中草稿。
      const st = useHelixStore.getState()
      if (st.currentSessionId && deletedIds.has(st.currentSessionId)) {
        useHelixStore.getState().setCurrentSessionId(null)
      }
      if (st.activeSessionWorkDir === deleteProjectDir) {
        useHelixStore.setState({ activeSessionWorkDir: null })
      }
      if (deletedIds.size > 0) {
        useHelixStore.setState((prev) => ({
          chatMessages: prev.chatMessages.filter((m) => !deletedIds.has(m.sessionId || '')),
          streamingDrafts: Object.fromEntries(
            Object.entries(prev.streamingDrafts).filter(([sid]) => !deletedIds.has(sid)),
          ),
        }))
      }
    } catch (e) {
      console.error('Failed to delete project:', e)
      showToast({ type: 'error', title: '删除项目失败' })
    } finally {
      setDeleteProjectDir(null)
    }
  }, [deleteProjectDir, selectedWorkDir, sortSessions, showToast, setSelectedWorkDir])

  const topActions = [
    { id: 'new', label: '新对话', icon: Plus, action: handleNewTask },
    { id: 'search', label: '搜索', icon: Search, action: () => toggleSessionManager() },
    { id: 'scheduled', label: '计划', icon: Clock, action: () => {
        if (!showScheduledTasksPanel && showSkillPanel) toggleSkillPanel()
        toggleScheduledTasksPanel()
      }
    },
    { id: 'plugins', label: '插件', icon: Puzzle, action: () => {
        if (!showSkillPanel && showScheduledTasksPanel) toggleScheduledTasksPanel()
        toggleSkillPanel()
      }
    },
  ]

  return (
    <div className="h-full flex flex-col text-sidebar-foreground select-none">
      {/* Collapsed icon-only mode */}
      {collapsed ? (
        <div className="flex-1 flex flex-col items-center pt-3 pb-2 gap-1 overflow-y-auto">
          {topActions.map(item => {
            const isActive =
              (item.id === 'scheduled' && showScheduledTasksPanel) ||
              (item.id === 'plugins' && showSkillPanel)
            return (
              <button
                key={item.id}
                onClick={() => item.action()}
                data-tip={item.label}
                className={`p-2.5 rounded-lg transition-colors outline-none ${
                  isActive
                    ? 'bg-sidebar-accent/70 text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/40'
                }`}
              >
                <item.icon className="size-[18px]" />
              </button>
            )
          })}
          <div className="flex-1" />
          <button
            onClick={() => toggleSettings()}
            data-tip="设置"
            className="p-2.5 rounded-lg text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/40 transition-colors"
          >
            <Settings className="size-[18px]" />
            {isElectron() && (
              <span className={`block w-1.5 h-1.5 rounded-full mx-auto mt-1 ${helixConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
            )}
          </button>
        </div>
      ) : directoryProjectDir ? (
        /* Full-area directory explorer: takes over the ENTIRE left sidebar
           (not a small inset panel) while active. The header (back / name /
           refresh) and the search box both live inside FileTreePanel, with the
           search box rendered above the header. */
        <FileTreePanel
          rootDir={directoryProjectDir}
          reloadKey={dirReloadKey}
          onOpenFile={() => setRightSidebarTab('code')}
          onBack={() => toggleDirectoryProject(directoryProjectDir)}
          onRefresh={() => setDirReloadKey(k => k + 1)}
        />
      ) : (
      <>
      {/* Top actions */}
      <div className="shrink-0 px-3 pt-2 pb-1.5">
        <div className="flex flex-col gap-0.5">
          {topActions.map(item => {
            const isActive =
              (item.id === 'scheduled' && showScheduledTasksPanel) ||
              (item.id === 'plugins' && showSkillPanel)
            return (
              <button
                key={item.id}
                onClick={() => item.action()}
                className={`flex items-center gap-2.5 px-3 py-1.5 rounded-lg transition-colors outline-none ${
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50'
                }`}
              >
                <item.icon className="size-[18px]" />
                <span className="text-[calc(var(--helix-transcript-size)*0.9286)]">{item.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      {/* Unified scroll: single scrollbar covers projects + standalone conversations */}
      <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="flex items-center px-4 pt-1.5 pb-0.5 group/section">
          <button
            onClick={() => setRecentCollapsed(prev => !prev)}
            className="flex items-center gap-1 flex-1 text-[calc(var(--helix-transcript-size)*0.9286)] font-medium tracking-normal text-sidebar-foreground/50 hover:text-sidebar-foreground/70 transition-colors"
          >
            <svg className={`size-3 transition-transform ${recentCollapsed ? '' : 'rotate-90'}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m9 18 6-6-6-6"/></svg>
            <span>最近</span>
          </button>
        </div>
        
{!recentCollapsed && (
        <div className="px-2">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="size-4 animate-spin text-sidebar-foreground/30" />
            </div>
          ) : projects.length > 0 ? (
            <div className="space-y-1">
              {projects.map(project => {
                const isExpanded = expandedProjects.has(project.dir)
                // 点击对话后项目不高亮：只有「未打开任何对话、正在浏览所选项目」时
                // 才高亮该项目的目录行，避免点开对话后某项目行一直亮着。
                const isSelectedProject =
                  !currentSessionId &&
                  selectedWorkDir === project.dir &&
                  // 计划/插件/看板等全屏面板打开时，项目不高亮——避免两处同时亮
                  !showScheduledTasksPanel &&
                  !showSkillPanel
                return (
                  <div key={project.dir} className="group rounded-lg overflow-hidden">
                    <div
                      className={`w-full flex items-center rounded-lg px-3 py-1.5 transition-colors ${
                        isSelectedProject
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground/90'
                      }`}
                    >
                      <div
                        onClick={() => handleSelectProject(project.dir)}
                        className="flex items-center gap-2 flex-1 cursor-pointer"
                      >
                        {isSelectedProject && <div className="w-[3px] h-4 bg-primary rounded-full shrink-0 -ml-1.5 mr-0.5" />}
                        <Folder className={`size-3.5 shrink-0 ${isSelectedProject ? 'text-primary' : 'text-sidebar-foreground/30'}`} />
                        <span className="text-[calc(var(--helix-transcript-size)*0.8929)] truncate flex-1" title={project.label}>{project.label.length > 12 ? project.label.slice(0, 12) + '…' : project.label}</span>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleNewProjectChat(project.dir) }}
                          className="shrink-0 p-1 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
                          data-tip="新建对话"
                        >
                          <Plus className="size-3.5" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleDirectoryProject(project.dir) }}
                          className={`shrink-0 p-1 rounded-lg transition-colors ${directoryProjectDir === project.dir ? 'text-primary bg-primary/10' : 'text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50'}`}
                          data-tip="打开目录"
                        >
                          <FolderTree className="size-3.5" />
                        </button>
                        <ProjectActionsMenu
                          isPinned={project.isPinned}
                          onPin={() => handlePinProject(project.dir)}
                          onArchive={() => handleArchiveProject(project.dir)}
                          onDelete={() => handleDeleteProject(project.dir)}
                          onShowInExplorer={() => handleRevealInExplorer(project.dir)}
                        />
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
                          const totalPages = Math.max(1, Math.ceil(project.sessions.length / PAGE_SIZE))
                          const page = clampPage(projectPages[project.dir] ?? 1, totalPages)
                          const pageStart = (page - 1) * PAGE_SIZE
                          const pageSessions = project.sessions.slice(pageStart, pageStart + PAGE_SIZE)
                          return (
                            <>
                        {pageSessions.map((session, sessionIdx) => (
                          <div
                            key={session.id}
                            draggable
                            onDragStart={(e) => {
                              e.dataTransfer.setData('text/session-reorder', JSON.stringify({ sessionId: session.id, fromDir: project.dir, fromIdx: pageStart + sessionIdx }))
                            }}
                            onDragOver={(e) => {
                              const data = e.dataTransfer.types.includes('text/session-reorder')
                              if (data) { e.preventDefault(); e.stopPropagation() }
                            }}
                            onDrop={async (e) => {
                              e.preventDefault(); e.stopPropagation()
                              const raw = e.dataTransfer.getData('text/session-reorder')
                              if (!raw) return
                              const { sessionId: draggedId } = JSON.parse(raw)
                              if (draggedId === session.id) return
                              // Reorder: move dragged session before this one
                              const updated = project.sessions.filter((s: any) => s.id !== draggedId)
                              const dragged = project.sessions.find((s: any) => s.id === draggedId)
                              if (dragged) {
                                const targetIdx = updated.findIndex((s: any) => s.id === session.id)
                                updated.splice(targetIdx, 0, dragged)
                                // Update order in persistence by re-saving with createdAt shuffle
                                try { await persistence.reorderSessions(project.dir, updated.map((s: any) => s.id)) } catch {}
                              }
                            }}
                            onClick={() => handleLoadSession(session)}
                            className={`relative w-full group flex items-center gap-2 px-4 py-1 cursor-pointer transition-colors ${
                              currentSessionId === session.id
                                ? 'bg-primary/10 text-primary'
                                : 'text-sidebar-foreground/50 hover:bg-sidebar-accent/30 hover:text-sidebar-foreground/80'
                            }`}
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
                                  onBlur={(e) => handleCommitRename(session.id, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); handleCommitRename(session.id, (e.target as HTMLInputElement).value) }
                                    else if (e.key === 'Escape') { setRenamingId(null) }
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
                                    onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(session.id) }}
                                  >{session.label.length > 14 ? session.label.slice(0, 14) + '…' : session.label}</p>
                                </div>
                              )}
                            </div>
                            {sessionPendingApproval[session.id] && (
                              <span className="shrink-0 size-2 rounded-full bg-amber-500" data-tip="需要确认" />
                            )}
                            <span
                              className="ml-auto shrink-0 text-right text-[calc(var(--helix-transcript-size)*0.7143)] text-sidebar-foreground/40 transition-opacity group-hover:opacity-0"
                              data-tip={`上次使用：${new Date(session.savedAt).toLocaleString('zh-CN')}`}
                            >{timeAgo(session.savedAt)}</span>
                            <SessionActionsMenu
                              isPinned={session.isPinned}
                              onArchive={() => handleToggleArchive(session.id)}
                              onPin={() => handleTogglePin(session.id)}
                              onDelete={() => handleDeleteSession(session.id)}
                              onRename={() => setRenamingId(session.id)}
                            />
                          </div>
                        ))}
                            {/* 项目内会话分页控件 */}
                            {project.sessions.length > PAGE_SIZE && (
                              <div className="flex items-center justify-center gap-1 pt-1">
                                <button
                                  type="button"
                                  disabled={page <= 1}
                                  onClick={() => setProjectPages(prev => ({ ...prev, [project.dir]: page - 1 }))}
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
                                  onClick={() => setProjectPages(prev => ({ ...prev, [project.dir]: page + 1 }))}
                                  className="px-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-sidebar-foreground/50 hover:text-sidebar-foreground disabled:opacity-30 disabled:hover:text-sidebar-foreground/50 rounded transition-colors"
                                >
                                  下一页
                                </button>
                              </div>
                            )}
                            </>
                          )
                        })())}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="px-3 py-2 text-[calc(var(--helix-transcript-size)*0.9286)] text-sidebar-foreground/30">
              暂无项目
            </div>
          )}
        </div>
        )}

        {/* Conversations */}
        {conversations.length > 0 && (
          <>
            <div className="px-4 pt-1.5 pb-0.5 text-[calc(var(--helix-transcript-size)*0.7857)] font-semibold uppercase tracking-wider text-sidebar-foreground/40">
              对话
            </div>
            <div className="px-3 pb-1.5">
              <div className="space-y-0.5">
                {conversations
                  .slice((conversationPage - 1) * PAGE_SIZE, conversationPage * PAGE_SIZE)
                  .map(session => (
                  <div
                    key={session.id}
                    onClick={() => handleLoadSession(session)}
                    className={`relative w-full group flex items-center gap-2 px-3 py-1 rounded-lg transition-colors cursor-pointer ${
                      currentSessionId === session.id
                        ? 'bg-primary/10 text-primary'
                        : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/40'
                    }`}
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
                          onBlur={(e) => handleCommitRename(session.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); handleCommitRename(session.id, (e.target as HTMLInputElement).value) }
                            else if (e.key === 'Escape') { setRenamingId(null) }
                          }}
                          className="text-[calc(var(--helix-transcript-size)*0.9286)] w-full bg-background outline-none border border-primary rounded px-1 py-0.5"
                        />
                      ) : (
                        <p
                          className="text-[calc(var(--helix-transcript-size)*0.9286)] truncate"
                          data-tip="双击重命名"
                          onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(session.id) }}
                        >{session.label.length > 14 ? session.label.slice(0, 14) + '…' : session.label}</p>
                      )}
                    </div>
                    {sessionPendingApproval[session.id] && (
                      <span className="shrink-0 size-2 rounded-full bg-amber-500" data-tip="需要确认" />
                    )}
                    <span
                      className="ml-auto shrink-0 text-right text-[calc(var(--helix-transcript-size)*0.7143)] text-sidebar-foreground/40 transition-opacity group-hover:opacity-0"
                      data-tip={`上次使用：${new Date(session.savedAt).toLocaleString('zh-CN')}`}
                    >{timeAgo(session.savedAt)}</span>
                    <SessionActionsMenu
                      isPinned={session.isPinned}
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
                    onClick={() => setConversationPage(p => p - 1)}
                    className="px-2 py-0.5 text-[calc(var(--helix-transcript-size)*0.8571)] text-sidebar-foreground/50 hover:text-sidebar-foreground disabled:opacity-30 disabled:hover:text-sidebar-foreground/50 rounded transition-colors"
                  >
                    上一页
                  </button>
                  <span className="px-1 text-[calc(var(--helix-transcript-size)*0.8571)] text-sidebar-foreground/40">
                    {conversationPage} / {Math.ceil(conversations.length / PAGE_SIZE)}
                  </span>
                  <button
                    type="button"
                    disabled={conversationPage >= Math.ceil(conversations.length / PAGE_SIZE)}
                    onClick={() => setConversationPage(p => p + 1)}
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
            <span className={`ml-auto flex items-center gap-1 text-[calc(var(--helix-transcript-size)*0.7143)] ${helixConnected ? 'text-emerald-500' : 'text-amber-500'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${helixConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
              {helixConnected ? '已连接' : '连接中'}
            </span>
          )}
        </button>
      </div>
      </>)}
      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center animate-fade-in">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDeleteTarget(null)} />
          <div className="relative bg-popover border border-border/40 rounded-2xl shadow-2xl w-96 mx-4 p-6 space-y-4 animate-scale-in">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                <AlertTriangle className="size-5 text-destructive" />
              </div>
              <div>
                <h3 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">删除对话</h3>
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
        </div>
      )}
      {deleteProjectDir && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDeleteProjectDir(null)} />
          <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-96 mx-4 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center shrink-0">
                <AlertTriangle className="size-5 text-destructive" />
              </div>
              <div>
                <h3 className="text-[length:var(--helix-transcript-size)] font-semibold text-foreground">删除项目</h3>
                <p className="text-[length:var(--helix-transcript-size)] text-muted-foreground mt-1">
                  确定要删除「{deleteProjectDir.split(/[/\\\\]/).pop() || deleteProjectDir}」及该项目下的所有对话吗？此操作不可撤销。
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
        </div>
      )}
    </div>
  )
}

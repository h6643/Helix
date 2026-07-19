'use client'

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
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
  Archive,
  Pin,
  Sparkles,
  RotateCcw,
  MoreVertical,
  Pencil,
  AlertTriangle,
  PanelLeft,
} from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { useShallow } from 'zustand/react/shallow'
import { useHermesStore } from '@/stores/hermes-store'
import { isElectron, electronDialog, electronShell } from '@/lib/electron-bridge'
import { persistence, type PersistedSession } from '@/lib/persist'

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
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null)

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    setCoords({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
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
        title="更多操作"
      >
        <MoreVertical className="size-3.5" />
      </button>
      {open && coords && createPortal(
        <div className="fixed z-[100]" style={{ top: coords.top, right: coords.right }}>
          <div ref={menuRef} className="w-40 bg-card border border-border/80 rounded-lg shadow-xl py-1">
            {onRename && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onRename() }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-foreground hover:bg-accent/60"
              >
                <Pencil className="size-3.5" />
                重命名
              </button>
            )}
            {!isArchived && onArchive && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onArchive() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-accent/60"
              >
                <Archive className="size-3.5" />
                归档
              </button>
            )}
            {!isArchived && onPin && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onPin() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-accent/60"
              >
                <Pin className={`size-3.5 ${isPinned ? 'text-primary' : ''}`} />
                {isPinned ? '取消固定' : '固定'}
              </button>
            )}
            {isArchived && onRestore && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onRestore() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-accent/60"
              >
                <RotateCcw className="size-3.5" />
                恢复
              </button>
            )}
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 hover:bg-red-500/10"
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
  const [coords, setCoords] = useState<{ top: number; right: number } | null>(null)

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return
    const rect = buttonRef.current.getBoundingClientRect()
    setCoords({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
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
        title="更多操作"
      >
        <MoreVertical className="size-3.5" />
      </button>
      {open && coords && createPortal(
        <div className="fixed z-[100]" style={{ top: coords.top, right: coords.right }}>
          <div ref={menuRef} className="w-40 bg-card border border-border/80 rounded-lg shadow-xl py-1">
            {onPin && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onPin() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-accent/60"
              >
                <Pin className={`size-3.5 ${isPinned ? 'text-primary' : ''}`} />
                {isPinned ? '取消置顶' : '置顶'}
              </button>
            )}
            {onShowInExplorer && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onShowInExplorer() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-accent/60"
              >
                <FolderOpen className="size-3.5" />
                <span className="whitespace-nowrap">在资源管理器中显示</span>
              </button>
            )}
            {onArchive && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onArchive() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-foreground hover:bg-accent/60"
              >
                <Archive className="size-3.5" />
                归档
              </button>
            )}
            {onDelete && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete() }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 hover:bg-red-500/10"
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
    persistToStorage,
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
      persistToStorage: s.persistToStorage,
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

  const currentSessionId = useHelixStore(s => s.currentSessionId)
  const streamingDrafts = useHelixStore(s => s.streamingDrafts)
  const hermesConnected = useHermesStore(s => s.hermesConnected)
  const [sessions, setSessions] = useState<PersistedSession[]>([])
  const [persistedFolders, setPersistedFolders] = useState<Set<string>>(new Set())
  const [pinnedProjectDirs, setPinnedProjectDirs] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<PersistedSession | null>(null)
  const [deleteProjectDir, setDeleteProjectDir] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set())
  const [recentCollapsed, setRecentCollapsed] = useState(false)
  const [recentHovered, setRecentHovered] = useState(false)

  const sortSessions = useCallback(
    (list: PersistedSession[]) =>
      [...list].sort((a, b) => b.savedAt - a.savedAt),
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
      // B: the active working directory (app's own cwd, defaults to the project
      // root) is the current context, not a deletable "project" — exclude it so
      // it doesn't reappear in the list on every startup.
      .filter(([dir]) => dir !== selectedWorkDir)
      .map(([dir, list]) => {
        const sorted = [...list].sort((a, b) => {
          if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
          return b.savedAt - a.savedAt
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
        return (b.sessions[0]?.savedAt || 0) - (a.sessions[0]?.savedAt || 0)
      })
  }, [sessions, persistedFolders, pinnedProjectDirs, selectedWorkDir])

  // Standalone conversations (no workDir) + the active working directory's
  // sessions (kept visible here since the work dir is no longer a listed project)
  const conversations = useMemo(() => {
    return sessions
      .filter(s => !s.isArchived && (!s.workDir || s.workDir === selectedWorkDir))
      .sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
        return b.savedAt - a.savedAt
      })
  }, [sessions, selectedWorkDir])

  const handleNewTask = useCallback(() => {
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
      showToast({ type: 'success', title: '已创建新对话' })
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
      if (state.currentSessionId) {
        await state.flushSessionPersist()
      }
      useHelixStore.getState().clearExecutionFlow()
      useHermesStore.getState().setHermesSessionId(null)
      // Same as above: navigating to a session must close the panels.
      if (state.showScheduledTasksPanel || state.showSkillPanel) {
        useHelixStore.setState({ showScheduledTasksPanel: false, showSkillPanel: false })
      }
      const all = await persistence.loadSessions()
      const fresh = all.find(s => s.id === session.id) || session
      const msgs = fresh.chatMessages.map(msg => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
        images: msg.images,
        timestamp: msg.timestamp,
        reasoning: msg.reasoning,
        steps: msg.steps,
      }))
      useHelixStore.setState({
        chatMessages: msgs,
        selectedWorkDir: fresh.workDir || null,
        activeSessionWorkDir: fresh.workDir ?? null,
      })
      if (fresh.workDir) {
        await persistence.saveProjectFolder(fresh.workDir)
      }
      useHelixStore.getState().setCurrentSessionId(session.id)
      pushNavigation({ type: 'chat', sessionId: session.id })
      await persistToStorage()
    } catch (e) {
      console.error('Failed to load session:', e)
      showToast({ type: 'error', title: '加载失败' })
    }
  }, [showToast, persistToStorage])

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
        useHermesStore.getState().setHermesSessionId(null)
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
      showToast({ type: 'success', title: `已归档 ${count} 个对话` })
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
      const count = await persistence.deleteSessionsByWorkDir(deleteProjectDir)
      await persistence.deleteProjectFolder(deleteProjectDir)
      const remaining = await persistence.loadSessions()
      setSessions(sortSessions(remaining))
      if (selectedWorkDir === deleteProjectDir) {
        setSelectedWorkDir(null)
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
    <div className="h-full flex flex-col bg-sidebar text-sidebar-foreground select-none">
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
                title={item.label}
                className={`p-2.5 rounded-lg transition-colors outline-none ${
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
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
            title="设置"
            className="p-2.5 rounded-lg text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/40 transition-colors"
          >
            <Settings className="size-[18px]" />
            {isElectron() && (
              <span className={`block w-1.5 h-1.5 rounded-full mx-auto mt-1 ${hermesConnected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`} />
            )}
          </button>
        </div>
      ) : (
      <>
      {/* Top actions */}
      <div className="shrink-0 px-3 pt-3 pb-2">
        <div className="flex flex-col gap-0">
          {topActions.map(item => {
            const isActive =
              (item.id === 'scheduled' && showScheduledTasksPanel) ||
              (item.id === 'plugins' && showSkillPanel)
            return (
              <button
                key={item.id}
                onClick={() => item.action()}
                className={`flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors outline-none ${
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50'
                }`}
              >
                <item.icon className="size-[18px]" />
                <span className="text-[13px]">{item.label}</span>
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        <div className="flex items-center px-4 pt-3 pb-1.5 group/section">
          <button
            onClick={() => setRecentCollapsed(prev => !prev)}
            onMouseEnter={() => {}}
            onMouseLeave={() => {}}
            className="flex items-center gap-1 flex-1 text-[13px] font-medium text-sidebar-foreground/50 hover:text-sidebar-foreground/70 transition-colors"
          >
            <span>最近</span>
          </button>
        </div>
        {!recentCollapsed && (
        <div className="px-2 overflow-y-auto min-h-0 [scrollbar-gutter:stable]">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-4 animate-spin text-sidebar-foreground/30" />
            </div>
          ) : projects.length > 0 ? (
            <div className="space-y-1">
              {projects.map(project => {
                const isExpanded = expandedProjects.has(project.dir)
                const isSelectedProject = selectedWorkDir === project.dir
                return (
                  <div key={project.dir} className="group rounded-lg overflow-hidden">
                    <div
                      className={`w-full flex items-center rounded-lg px-3 py-2 transition-colors ${
                        isSelectedProject
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/40'
                      }`}
                    >
                      <div
                        onClick={() => handleSelectProject(project.dir)}
                        className="flex items-center gap-2 flex-1 cursor-pointer"
                      >
                        <Folder className={`size-4 shrink-0 ${isSelectedProject ? 'text-primary' : 'text-sidebar-foreground/40'}`} />
                        <span className="text-[13px] truncate flex-1">{project.label}</span>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleNewProjectChat(project.dir) }}
                          className="shrink-0 p-1 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors"
                          title="在该项目下新建对话"
                        >
                          <Plus className="size-3.5" />
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
                      <div className="border-t border-border/20">
                        {project.sessions.length === 0 ? (
                          <div className="px-3 py-1.5 text-[12px] text-sidebar-foreground/30">
                            无对话
                          </div>
                        ) : (
                        project.sessions.map(session => (
                          <div
                            key={session.id}
                            onClick={() => handleLoadSession(session)}
                            className={`w-full group flex items-center gap-2 px-4 py-1 cursor-pointer transition-colors ${
                              currentSessionId === session.id
                                ? 'bg-primary/10 text-primary'
                                : 'text-sidebar-foreground/50 hover:bg-sidebar-accent/30 hover:text-sidebar-foreground/80'
                            }`}
                          >
                            {streamingDrafts[session.id]?.isAgentRunning ? (
                              <div className="w-4 flex items-center justify-center shrink-0">
                                <span className="size-2.5 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
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
                                  className="text-[12px] w-full bg-background outline-none border border-primary rounded px-1 py-0.5"
                                />
                              ) : (
                                <p
                          className="text-[12px] truncate"
                          title="双击重命名"
                          onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(session.id) }}
                        >{session.label}</p>
                              )}
                            </div>
                            
                            <SessionActionsMenu
                              isPinned={session.isPinned}
                              onArchive={() => handleToggleArchive(session.id)}
                              onPin={() => handleTogglePin(session.id)}
                              onDelete={() => handleDeleteSession(session.id)}
                              onRename={() => setRenamingId(session.id)}
                            />
                          </div>
                        )))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          ) : (
            <div className="px-3 py-2 text-[13px] text-sidebar-foreground/30">
              暂无项目
            </div>
          )}
        </div>
        )}

        {/* Conversations */}
        {conversations.length > 0 && (
          <>
            <div className="px-3 pt-2 pb-0 text-[11px] font-medium text-sidebar-foreground/35">
              对话
            </div>
            <div className="px-3 overflow-y-auto pb-2 [scrollbar-gutter:stable]">
              <div className="space-y-0.5">
                {conversations.map(session => (
                  <div
                    key={session.id}
                    onClick={() => handleLoadSession(session)}
                    className={`w-full group flex items-center gap-2 px-3 py-1 rounded-lg transition-colors cursor-pointer ${
                      currentSessionId === session.id
                        ? 'bg-primary/10 text-primary'
                        : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/40'
                    }`}
                  >
                    {streamingDrafts[session.id]?.isAgentRunning ? (
                      <div className="w-4 flex items-center justify-center shrink-0">
                        <span className="size-2.5 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
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
                          className="text-[13px] w-full bg-background outline-none border border-primary rounded px-1 py-0.5"
                        />
                      ) : (
                        <p
                          className="text-[13px] truncate"
                          title="双击重命名"
                          onDoubleClick={(e) => { e.stopPropagation(); setRenamingId(session.id) }}
                        >{session.label}</p>
                      )}
                    </div>
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
            </div>
          </>
        )}

      </div>
      <div className="px-2 py-2 border-t border-border/40 shrink-0 space-y-0.5">
        <button
          onClick={() => toggleSettings()}
          className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[13px] text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 rounded-lg transition-colors"
        >
          <Settings className="size-4 shrink-0" />
          <span>设置</span>
          {isElectron() && (
            <span className={`ml-auto flex items-center gap-1 text-[10px] ${hermesConnected ? 'text-green-500' : 'text-yellow-500'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${hermesConnected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`} />
              {hermesConnected ? '已连接' : '连接中'}
            </span>
          )}
        </button>
      </div>
      </>)}
      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDeleteTarget(null)} />
          <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-96 mx-4 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-red-50 dark:bg-red-950/50 flex items-center justify-center shrink-0">
                <AlertTriangle className="size-5 text-red-500" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">删除对话</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  确定要删除「{deleteTarget.label}」吗？此操作不可撤销。
                </p>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <button
                onClick={handleConfirmDelete}
                className="px-3 py-1.5 text-[13px] text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
              >
                删除
              </button>
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-3 py-1.5 text-[13px] text-foreground/70 hover:text-foreground hover:bg-accent rounded-lg transition-colors"
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
              <div className="w-10 h-10 rounded-full bg-red-50 dark:bg-red-950/50 flex items-center justify-center shrink-0">
                <AlertTriangle className="size-5 text-red-500" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">删除项目</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  确定要删除「{deleteProjectDir.split(/[/\\\\]/).pop() || deleteProjectDir}」及该项目下的所有对话吗？此操作不可撤销。
                </p>
              </div>
            </div>
            <div className="flex justify-between gap-2">
              <button
                onClick={handleConfirmDeleteProject}
                className="px-3 py-1.5 text-[13px] text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors"
              >
                删除
              </button>
              <button
                onClick={() => setDeleteProjectDir(null)}
                className="px-3 py-1.5 text-[13px] text-foreground/70 hover:text-foreground hover:bg-accent rounded-lg transition-colors"
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

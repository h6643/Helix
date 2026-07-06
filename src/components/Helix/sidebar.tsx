'use client'

import React, { useState, useCallback, useEffect } from 'react'
import {
  Plus,
  ChevronDown,
  Sparkles,
  Box,
  Clock,
  Settings,
  MessageSquare,
  Palette,
  Loader2,
  Trash2,
  Minus,
  Square,
  X,
  Archive,
  AlertTriangle,
} from 'lucide-react'
import { useHelixStore } from '@/stores/helix-store'
import { persistence, type PersistedSession } from '@/lib/persist'
import { timeAgo } from '@/lib/format'
import { Button } from '@/components/ui/button'

interface SidebarProps {
  onNewTask?: () => void
}

export function Sidebar({ onNewTask }: SidebarProps) {
  const {
    clearChat,
    toggleSettings,
    toggleScheduledTasksPanel,
    toggleArtifactsPanel,
    toggleCustomizePanel,
    showToast,
  } = useHelixStore()

  const [activeSection, setActiveSection] = useState<'new' | 'artifacts' | 'scheduled' | 'customize'>('new')
  const currentSessionId = useHelixStore(s => s.currentSessionId)
  const [sessions, setSessions] = useState<PersistedSession[]>([])
  const [loading, setLoading] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<PersistedSession | null>(null)

  const loadSessions = useCallback(async () => {
    try {
      const list = await persistence.loadSessions()
      setSessions(list.sort((a, b) => b.savedAt - a.savedAt))
    } catch (e) {
      console.error('Failed to load sessions:', e)
    }
  }, [])

  useEffect(() => {
    loadSessions().finally(() => setLoading(false))
  }, [loadSessions])

  // Refresh session list when auto-saved
  const sessionSaveVersion = useHelixStore(s => s.sessionSaveVersion)
  useEffect(() => {
    if (sessionSaveVersion > 0) loadSessions()
  }, [sessionSaveVersion, loadSessions])

  const handleNewTask = useCallback(() => {
    clearChat()
    useHelixStore.getState().clearExecutionFlow()
    useHelixStore.setState({ currentSessionId: null })
    onNewTask?.()
  }, [clearChat, showToast, onNewTask])

  const handleLoadSession = useCallback(async (session: PersistedSession) => {
    try {
      useHelixStore.getState().clearExecutionFlow()
      const msgs = session.chatMessages.map(msg => ({
        id: msg.id,
        role: msg.role as 'user' | 'assistant' | 'system',
        content: msg.content,
        timestamp: msg.timestamp,
      }))
      useHelixStore.setState({ chatMessages: msgs, currentSessionId: session.id, selectedWorkDir: session.workDir || null })
      setActiveSection('new')
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
      setSessions(remaining.sort((a, b) => b.savedAt - a.savedAt))
      const state = useHelixStore.getState()
      if (state.currentSessionId === deleteTarget.id) {
        state.clearChat()
        useHelixStore.getState().clearExecutionFlow()
        useHelixStore.setState({ currentSessionId: null })
      } else if (remaining.length === 0) {
        state.clearChat()
        useHelixStore.getState().clearExecutionFlow()
        useHelixStore.setState({ currentSessionId: null })
      }
      setDeleteTarget(null)
      showToast({ type: 'success', title: '已删除' })
    } catch (e) {
      console.error('Failed to delete session:', e)
    }
  }, [deleteTarget, showToast])

  const handleArchiveSession = useCallback(async (session: PersistedSession) => {
    try {
      await persistence.saveSession({
        ...session,
        isArchived: true,
      })
      showToast({ type: 'success', title: '已归档', description: session.label })
      await loadSessions()
    } catch (e) {
      console.error('Failed to archive session:', e)
      showToast({ type: 'error', title: '归档失败' })
    }
  }, [loadSessions, showToast])

  const menuItems = [
    { id: 'new' as const, label: '新任务', icon: Plus, action: handleNewTask },
    { id: 'artifacts' as const, label: '制品', icon: Box, action: toggleArtifactsPanel },
    { id: 'scheduled' as const, label: '定时任务', icon: Clock, action: toggleScheduledTasksPanel },
    { id: 'customize' as const, label: '自定义', icon: Palette, action: toggleCustomizePanel },
  ]

  return (
    <div className="h-full flex flex-col bg-sidebar text-sidebar-foreground">
      {/* Menu Items */}
      <div className="px-2 py-2.5 space-y-0.5 shrink-0">
        {menuItems.map(item => (
          <button
            key={item.id}
            onClick={() => {
              setActiveSection(item.id)
              if (item.action) item.action()
            }}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm rounded-lg transition-colors ${
              activeSection === item.id
                ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                : 'text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50'
            }`}
          >
            <item.icon className="size-4 shrink-0" />
            {item.label}
          </button>
        ))}
      </div>

      {/* Recent conversations */}
      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="px-4 pt-1 pb-1.5 shrink-0">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/40">最近对话</span>
        </div>
        <div className="px-2 overflow-y-auto flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-4 animate-spin text-sidebar-foreground/30" />
            </div>
          ) : sessions.length > 0 ? (
            <div className="space-y-0.5">
              {sessions.map(session => (
                <div
                  key={session.id}
                  onClick={() => handleLoadSession(session)}
                  className={`group flex items-center gap-2 px-3 py-2 rounded-lg transition-colors cursor-pointer ${
                    currentSessionId === session.id
                      ? 'bg-primary/10 border border-primary/20 text-primary font-medium'
                      : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 border border-transparent'
                  }`}
                >
                  <MessageSquare className={`size-4 shrink-0 ${currentSessionId === session.id ? 'text-primary' : 'text-sidebar-foreground/30'}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{session.label}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <p className="text-[10px] text-sidebar-foreground/30">{timeAgo(session.savedAt)}</p>
                      {session.workDir && (
                        <span className="text-[10px] text-primary/50 truncate max-w-24">
                          {session.workDir.split(/[/\\]/).pop()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all shrink-0">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleArchiveSession(session)
                      }}
                      className="p-1 rounded text-sidebar-foreground/30 hover:text-amber-500 hover:bg-amber-500/10 transition-all"
                      title="归档"
                    >
                      <Archive className="size-3" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        handleDeleteSession(session.id)
                      }}
                      className="p-1 rounded text-sidebar-foreground/30 hover:text-red-500 hover:bg-red-500/10 transition-all"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-8 text-center text-xs text-sidebar-foreground/30">
              暂无对话记录
            </div>
          )}
        </div>
      </div>

      {/* Settings - pinned to bottom */}
      <div className="px-2 py-2.5 border-t border-border/40 shrink-0">
        <button
          onClick={toggleSettings}
          className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 rounded-lg transition-colors"
        >
          <Settings className="size-4 shrink-0" />
          <span>设置</span>
        </button>
      </div>

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
              <Button
                variant="destructive"
                size="sm"
                onClick={handleConfirmDelete}
                className="gap-1.5"
              >
                <Trash2 className="size-3" />
                删除
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDeleteTarget(null)}
              >
                取消
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
